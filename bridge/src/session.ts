import { query, type Options, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "./clock";
import type { Ledger } from "./ledger";
import { withNotices } from "./prompts";
import type { Persist } from "./store";
import type { AccountState, Actor, EnvelopeId, Initiator, Lifecycle, Notice, Owned, ParkReason, Pending, SessionState } from "./world";

// The turn runner for one actor, and the only writer of its SessionState and of AccountState. Owner: U2.
//
// U2 replaces the body with the lifecycle of world.ts as a pure step() plus a thin SDK shell: a durable inbox,
// the replay rule, transient retry, the usage-limit and daily-cap parks, Stop, and the 3-denials breaker.
// The scaffold body keeps today's behavior: an in-memory queue, one envelope per turn, and a crash drops the queue.

export function claudeExecutable(): string | null {
  return process.env.CLAUDIOBOT_CLAUDE ?? Bun.which("claude");
}

/**
 * How a turn, or an envelope that never became one, ended. Exactly one TurnEnd per envelope that leaves the queue,
 * so a routine run is settled exactly once.
 * - done: the turn ran to a result, success or an error subtype.
 * - stopped: Stop landed while it ran. The interrupt's error_during_execution result maps here, never to done/failed.
 * - dropped: Stop removed it from the queue before it started. Only unattended envelopes are dropped.
 * - failed: removed without a usable result: a crash after output, a terminal error, the poison limit, no budget.
 * - deferred: still queued and will run later (retry backoff or a park). Not an ending; a routine run stays running.
 */
export type TurnEnd =
  | { kind: "done"; result: SDKResultMessage }
  | { kind: "stopped" }
  | { kind: "dropped" }
  | { kind: "failed"; error: string }
  | { kind: "deferred"; until: string; why: "retry" | ParkReason };

export type Session = Tickable & {
  /** Queues one envelope; persisted before the SDK sees it. ahead puts it before everything queued (an approval continuation). */
  push(input: { text: string; initiator: Initiator; ahead: boolean }): void;
  /** Adds a line to the top of the next envelope this actor runs. Spends no turn. */
  notice(text: string): void;
  /** The gate held or denied a call in the current turn. The third in one turn moves to stopping and leaves a note. */
  denied(): void;
  /**
   * Stop: working → stopping, where the gate denies every call; the next result, or the 15 s deadline, ends the turn
   * as stopped. Queued unattended envelopes are dropped, each with a notice; the user's own envelopes still run.
   * Resolves false when nothing was running.
   */
  interrupt(): Promise<boolean>;
  close(): void;
  /** A turn is running, or envelopes wait and the session is not parked. */
  readonly working: boolean;
  /** The envelope in flight. The gate reads its initiator. */
  readonly current: Pending | null;
  readonly lifecycle: Owned<Lifecycle>;
};

export type SessionSpec = {
  actor: Actor;
  /** The record's slice. This module is its only writer. */
  state: Owned<SessionState>;
  /** Shared by every session: a usage-limit rejection parks them all. */
  account: Owned<AccountState>;
  /** Read at every query start: resume from state.id, and hooks: gate.hooks(actor). */
  options: () => Options;
  /** headroom() before each start; add() at each result. */
  ledger: Ledger;
  onMessage: (m: SDKMessage, turn: Pending) => void;
  onTurnEnd: (turn: Pending, end: TurnEnd) => void;
  /** Something the actor's status derives from changed (working, lifecycle, park). */
  onChange: () => void;
  /** A line for the owning bot's chat: the daily cap is reached, or a turn was stopped after 3 held calls. */
  note: (text: string) => void;
  persist: Persist;
  query?: typeof query;
  now?: () => Date;
};

const own = (state: Owned<SessionState>) => state as unknown as SessionState;

export function createSession(spec: SessionSpec): Session {
  const run = spec.query ?? query;
  const now = spec.now ?? (() => new Date());
  let queue: Pending[] = [];
  let notices: Notice[] = [];
  let current: Pending | null = null;
  let startedAt = "";
  let live: Query | null = null;
  let generation = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const working = () => current !== null || queue.length > 0;
  const nudge = () => wake?.();

  // Holding the next message until the turn's result keeps one envelope per turn, so working is exact.
  async function* input(gen: number): AsyncGenerator<SDKUserMessage> {
    while (!closed && gen === generation) {
      if (current === null && queue.length > 0) {
        current = queue.shift()!;
        startedAt = now().toISOString();
        const text = withNotices(current.text, notices);
        notices = [];
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }

  function crash(error: string) {
    const turn = current ?? queue[0] ?? null;
    generation++;
    live = null;
    current = null;
    queue = [];
    nudge();
    spec.onChange();
    if (turn) spec.onTurnEnd(turn, { kind: "failed", error });
  }

  function start() {
    const executable = claudeExecutable();
    if (!executable) return crash("claude was not found on PATH. Set CLAUDIOBOT_CLAUDE.");
    const gen = ++generation;
    let stderr = "";
    const q = run({
      prompt: input(gen),
      options: { ...spec.options(), pathToClaudeCodeExecutable: executable, stderr: (d) => (stderr = (stderr + d).slice(-2000)) },
    });
    live = q;
    (async () => {
      try {
        for await (const message of q) {
          if (message.session_id && message.session_id !== spec.state.id) {
            own(spec.state).id = message.session_id;
            spec.persist();
          }
          const turn = current;
          if (turn) spec.onMessage(message, turn);
          if (message.type !== "result" || !turn) continue;
          spec.ledger.add({ actor: spec.actor, sessionId: message.session_id, initiator: turn.initiator, cumulativeUsd: message.total_cost_usd });
          current = null;
          spec.onTurnEnd(turn, { kind: "done", result: message });
          if (queue.length === 0) spec.onChange();
          nudge();
        }
        if (!closed && gen === generation) throw new Error("Claude Code exited");
      } catch (e) {
        if (!closed && gen === generation) crash(`${(e as Error).message}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
      }
    })();
  }

  return {
    push({ text, initiator, ahead }) {
      if (closed) return;
      const was = working();
      const pending: Pending = { id: `e_${crypto.randomUUID()}` as EnvelopeId, at: now().toISOString(), text, initiator, attempts: 0 };
      if (ahead) queue.unshift(pending);
      else queue.push(pending);
      if (!was) spec.onChange();
      if (live) nudge();
      else start();
    },
    notice(text) {
      notices.push({ at: now().toISOString(), text });
    },
    denied() {},
    async interrupt() {
      throw new Error("not implemented");
    },
    tick() {},
    nextDeadline: () => null,
    close() {
      closed = true;
      nudge();
      live?.close();
      live = null;
    },
    get working() {
      return working();
    },
    get current() {
      return current;
    },
    get lifecycle(): Owned<Lifecycle> {
      return current === null ? { kind: "idle" } : { kind: "working", turn: { pending: current.id, startedAt, output: false, denials: 0 } };
    },
  };
}
