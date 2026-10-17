import {
  query,
  type Options,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "./clock";
import type { Headroom, Ledger } from "./ledger";
import { notices as noticeText, withNotices } from "./prompts";
import type { Persist } from "./store";
import {
  actorKey,
  attended,
  type AccountState,
  type ActiveTurn,
  type Actor,
  type EnvelopeId,
  type Initiator,
  type Lifecycle,
  type Notice,
  type Owned,
  type ParkReason,
  type Pending,
  type SessionState,
} from "./world";

// The turn runner for one actor, and the only writer of its SessionState and of AccountState. Owner: U2.
// step() is the whole lifecycle as a pure function; createSession() is the shell that feeds it SDK and caller events
// and carries out its effects.

export function claudeExecutable(): string | null {
  return process.env.CLAUDIOBOT_CLAUDE ?? Bun.which("claude");
}

export const STOP_DEADLINE_MS = 15_000;
export const RETRY_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
/** The first start plus one retry per backoff step. A replay after a restart is a start too. */
export const MAX_STARTS = RETRY_BACKOFF_MS.length + 1;
export const DENIALS_PER_TURN = 3;
export const USAGE_PARK_SLACK_MS = 30_000;
/** A usage-limit error that came without a reset time parks this long, then tries again. */
export const USAGE_PARK_FALLBACK_MS = 5 * 60_000;
const TRANSIENT_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set(["overloaded", "server_error", "unknown"]);

export const CAP_NOTE = "Daily cap reached. Your messages still run; routines and other background work wait until tomorrow.";
export const BREAKER_NOTE = `Stopped this turn after ${DENIALS_PER_TURN} held or denied tool calls.`;
export const RESTARTED_ERROR = "The bridge restarted during this turn.";
const restartedNotice = (envelopeText: string) =>
  `[The bridge restarted during your turn on: ${envelopeText.split("\n")[0]} It may be partly done; check before redoing it.]`;

/**
 * How a turn, or an envelope that never became one, ended. Exactly one TurnEnd per envelope that leaves the queue,
 * so a routine run is settled exactly once.
 * - done: the turn ran to a result, success or an error subtype.
 * - stopped: Stop landed while it ran (by "user"), or the 3-denials breaker did (by "breaker"). The interrupt's
 *   error_during_execution result maps here, never to done/failed, and is never retried.
 * - dropped: Stop removed it from the queue before it started. Only unattended envelopes are dropped.
 * - failed: removed without a usable result: a crash after output, a terminal error, the poison limit, no budget.
 * - deferred: still queued and will run later (retry backoff or a park). Not an ending; a routine run stays running.
 *   Told once per park.
 */
export type TurnEnd =
  | { kind: "done"; result: SDKResultMessage }
  | { kind: "stopped"; by: "user" | "breaker" }
  | { kind: "dropped" }
  | { kind: "failed"; error: string }
  | { kind: "deferred"; until: string; why: "retry" | ParkReason };

/** How the turn in flight ended, as the shell read it at the SDK boundary. */
export type Outcome =
  | { kind: "result"; result: SDKResultMessage }
  | { kind: "transient"; error: string }
  | { kind: "usage_limit"; error: string; until: string }
  | { kind: "terminal"; error: string };

export type Event =
  | { kind: "push"; pending: Pending; ahead: boolean }
  | { kind: "notice"; notice: Notice }
  /** Start the next admissible envelope, if any. Every transition that frees the session also pumps. */
  | { kind: "pump" }
  /** The first assistant message of the turn in flight. */
  | { kind: "output" }
  | { kind: "denied" }
  | { kind: "end"; outcome: Outcome }
  | { kind: "stop" }
  | { kind: "tick" }
  | { kind: "recover" };

export type Effect =
  | { kind: "send"; pending: Pending; text: string }
  | { kind: "end"; pending: Pending; end: TurnEnd }
  | { kind: "interrupt" }
  | { kind: "kill" }
  | { kind: "note"; text: string };

/** Lives in memory only; a restart starts from freshMemo(). */
export type Memo = {
  /**
   * How many notices at the front of session.notices the turn in flight carried. They are dropped once it has output
   * or ends, and kept when it is requeued, so a retry carries them again. After a restart they are all still there.
   * Meaningless while no turn is in flight; begin() sets it.
   */
  carried: number;
  /** The cap note was left and the cap has not cleared since. */
  capNoted: boolean;
  /** The last deferred end told, so each park is reported once. */
  told: string | null;
};

export const freshMemo = (): Memo => ({ carried: 0, capNoted: false, told: null });

export type Core = { session: SessionState; parkedUntil: string | null; memo: Memo };
export type StepContext = { now: Date; headroom: (initiator: Initiator) => Headroom; userName: string };

const turnOf = (life: Lifecycle): ActiveTurn | null => (life.kind === "working" || life.kind === "stopping" ? life.turn : null);

/**
 * The lifecycle, total over (Lifecycle x Event) and pure. Invariants it keeps:
 * - The envelope in flight is pending[0]; an `ahead` push goes right behind it.
 * - Only idle (or an expired backoff/park, or a daily_cap park for an attended envelope) starts a turn, so nothing
 *   is sent while stopping.
 * - Every envelope removed from pending gets exactly one non-deferred end.
 */
export function step(core: Core, ev: Event, ctx: StepContext): { core: Core; effects: Effect[] } {
  const c = structuredClone(core);
  const s = c.session;
  const fx: Effect[] = [];
  const now = ctx.now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const due = (deadline: string) => Date.parse(deadline) <= now;

  const end = (p: Pending, e: TurnEnd) => {
    if (e.kind === "deferred") {
      const key = `${p.id}|${e.why}|${e.until}`;
      if (c.memo.told === key) return;
      c.memo.told = key;
    }
    fx.push({ kind: "end", pending: p, end: e });
  };

  const remove = (id: EnvelopeId): Pending | null => {
    const i = s.pending.findIndex((p) => p.id === id);
    return i === -1 ? null : s.pending.splice(i, 1)[0]!;
  };

  const dropCarried = () => {
    s.notices.splice(0, c.memo.carried);
    c.memo.carried = 0;
  };

  const stoppedBy = (t: ActiveTurn): "user" | "breaker" => (t.denials >= DENIALS_PER_TURN ? "breaker" : "user");

  function finish(t: ActiveTurn, e: TurnEnd) {
    const p = remove(t.pending);
    dropCarried();
    s.lifecycle = { kind: "idle" };
    if (p) end(p, e);
  }

  function parkAccount(until: string) {
    if (c.parkedUntil === null || due(c.parkedUntil) || until > c.parkedUntil) c.parkedUntil = until;
  }

  function dropUnattended(keep: EnvelopeId | null) {
    for (const p of [...s.pending]) {
      if (p.id === keep || attended(p.initiator)) continue;
      remove(p.id);
      s.notices.push({ at: iso(now), text: noticeText.droppedByStop(ctx.userName, p.text) });
      end(p, { kind: "dropped" });
    }
  }

  function begin(p: Pending, capReached: boolean) {
    const started: Pending = { ...p, attempts: p.attempts + 1 };
    s.pending.splice(s.pending.indexOf(p), 1);
    s.pending.unshift(started);
    s.lifecycle = { kind: "working", turn: { pending: p.id, startedAt: iso(now), output: false, denials: 0 } };
    c.memo.carried = s.notices.length;
    fx.push({ kind: "send", pending: started, text: withNotices(started.text, s.notices) });
    if (!capReached) c.memo.capNoted = false;
    else if (!c.memo.capNoted) {
      c.memo.capNoted = true;
      fx.push({ kind: "note", text: CAP_NOTE });
    }
  }

  function pump() {
    for (;;) {
      const life = s.lifecycle;
      if (life.kind === "working" || life.kind === "stopping") return;
      if (s.pending.length === 0) {
        s.lifecycle = { kind: "idle" };
        return;
      }
      if ((life.kind === "backoff" || (life.kind === "parked" && life.reason === "usage_limit")) && !due(life.until)) return;
      if (c.parkedUntil !== null && !due(c.parkedUntil)) {
        s.lifecycle = { kind: "parked", reason: "usage_limit", until: c.parkedUntil };
        end(s.pending[0]!, { kind: "deferred", until: c.parkedUntil, why: "usage_limit" });
        return;
      }
      const capped = life.kind === "parked" && life.reason === "daily_cap" && !due(life.until);
      const next = capped ? s.pending.find((p) => attended(p.initiator)) : s.pending[0];
      if (!next) return;
      if (next.attempts >= MAX_STARTS) {
        remove(next.id);
        end(next, { kind: "failed", error: `Gave up after ${next.attempts} attempts.` });
        continue;
      }
      const room = ctx.headroom(next.initiator);
      if (room.ok) return begin(next, room.capReached);
      if (room.reason === "agent_budget") {
        remove(next.id);
        end(next, { kind: "failed", error: "The agent's budget is used up." });
        continue;
      }
      if (capped) return;
      s.lifecycle = { kind: "parked", reason: "daily_cap", until: room.until };
      end(next, { kind: "deferred", until: room.until, why: "daily_cap" });
    }
  }

  function ended(o: Outcome) {
    const t = turnOf(s.lifecycle);
    if (!t) return;
    if (o.kind === "usage_limit") parkAccount(o.until);
    if (s.lifecycle.kind === "stopping") return finish(t, { kind: "stopped", by: stoppedBy(t) });
    const p = s.pending.find((x) => x.id === t.pending);
    if (!p) {
      s.lifecycle = { kind: "idle" };
      return;
    }
    switch (o.kind) {
      case "result":
        return finish(t, { kind: "done", result: o.result });
      case "terminal":
        return finish(t, { kind: "failed", error: o.error });
      case "transient": {
        const wait = RETRY_BACKOFF_MS[p.attempts - 1];
        if (t.output) return finish(t, { kind: "failed", error: o.error });
        if (wait === undefined) return finish(t, { kind: "failed", error: `${o.error} (gave up after ${p.attempts} attempts)` });
        const until = iso(now + wait);
        s.lifecycle = { kind: "backoff", until, attempt: p.attempts };
        return end(p, { kind: "deferred", until, why: "retry" });
      }
      case "usage_limit": {
        if (t.output) return finish(t, { kind: "failed", error: o.error });
        // Not the envelope's fault, so the start does not count toward its poison limit.
        const held: Pending = { ...p, attempts: p.attempts - 1 };
        const until = c.parkedUntil!;
        s.pending[s.pending.indexOf(p)] = held;
        s.lifecycle = { kind: "parked", reason: "usage_limit", until };
        return end(held, { kind: "deferred", until, why: "usage_limit" });
      }
    }
  }

  switch (ev.kind) {
    case "push": {
      const busy = turnOf(s.lifecycle) !== null;
      if (ev.ahead) s.pending.splice(busy ? 1 : 0, 0, ev.pending);
      else s.pending.push(ev.pending);
      pump();
      break;
    }
    case "notice":
      s.notices.push(ev.notice);
      break;
    case "pump":
      pump();
      break;
    case "output": {
      const t = turnOf(s.lifecycle);
      if (t && !t.output) {
        t.output = true;
        dropCarried();
      }
      break;
    }
    case "denied": {
      const life = s.lifecycle;
      if (life.kind !== "working") break;
      life.turn.denials++;
      if (life.turn.denials < DENIALS_PER_TURN) break;
      s.lifecycle = { kind: "stopping", turn: life.turn, deadline: iso(now + STOP_DEADLINE_MS) };
      fx.push({ kind: "interrupt" }, { kind: "note", text: BREAKER_NOTE });
      break;
    }
    case "end":
      ended(ev.outcome);
      pump();
      break;
    case "stop": {
      const life = s.lifecycle;
      if (life.kind === "working") {
        s.lifecycle = { kind: "stopping", turn: life.turn, deadline: iso(now + STOP_DEADLINE_MS) };
        fx.push({ kind: "interrupt" });
        dropUnattended(life.turn.pending);
      } else if (life.kind === "backoff") {
        const head = s.pending.shift();
        s.lifecycle = { kind: "idle" };
        if (head) end(head, { kind: "stopped", by: "user" });
        dropUnattended(null);
        pump();
      }
      break;
    }
    case "tick": {
      if (c.parkedUntil !== null && due(c.parkedUntil)) c.parkedUntil = null;
      const life = s.lifecycle;
      if (life.kind === "stopping" && due(life.deadline)) {
        fx.push({ kind: "kill" });
        finish(life.turn, { kind: "stopped", by: stoppedBy(life.turn) });
      } else if ((life.kind === "backoff" || life.kind === "parked") && due(life.until)) {
        s.lifecycle = { kind: "idle" };
      }
      pump();
      break;
    }
    case "recover": {
      c.memo = freshMemo();
      const life = s.lifecycle;
      if (life.kind === "working" && !life.turn.output) s.lifecycle = { kind: "idle" };
      else if (life.kind === "working") {
        const p = s.pending.find((x) => x.id === life.turn.pending);
        finish(life.turn, { kind: "failed", error: RESTARTED_ERROR });
        if (p) s.notices.push({ at: iso(now), text: restartedNotice(p.text) });
      } else if (life.kind === "stopping") finish(life.turn, { kind: "stopped", by: stoppedBy(life.turn) });
      break;
    }
  }
  return { core: c, effects: fx };
}

/** What the SDK said during the turn, before its result. */
export type Signals = { rejected: boolean; resetsAt: number | null; apiError: SDKAssistantMessageError | null };
export const noSignals = (): Signals => ({ rejected: false, resetsAt: null, apiError: null });

/**
 * SDK → Outcome. An API error ends the turn as subtype success with is_error true; the assistant message's `error`
 * names it. A rejected SDKRateLimitEvent (resetsAt in epoch seconds) or a rate_limit error is the usage limit.
 */
export function classify(r: SDKResultMessage, s: Signals, now: Date): Outcome {
  if (r.subtype === "success" && !r.is_error) return { kind: "result", result: r };
  const error = (r.subtype === "success" ? r.result.trim() : r.errors.join("; ")) || s.apiError || r.subtype;
  if (s.rejected || s.apiError === "rate_limit") {
    const reset = s.resetsAt === null ? now.getTime() + USAGE_PARK_FALLBACK_MS : Math.max(s.resetsAt * 1000, now.getTime());
    return { kind: "usage_limit", error, until: new Date(reset + USAGE_PARK_SLACK_MS).toISOString() };
  }
  if (r.subtype !== "success") return { kind: "result", result: r };
  if ((s.apiError !== null && TRANSIENT_ERRORS.has(s.apiError)) || (r.api_error_status ?? 0) >= 500) return { kind: "transient", error };
  return { kind: "terminal", error };
}

export type Session = Tickable & {
  /**
   * Queues one envelope; persisted before the SDK sees it. ahead puts it before everything queued (an approval
   * continuation). Every Pending field other than id, at and attempts comes from the caller and is carried untouched.
   */
  push(input: Omit<Pending, "id" | "at" | "attempts"> & { ahead: boolean }): void;
  /** Adds a line to the top of the next envelope this actor runs. Spends no turn. */
  notice(text: string): void;
  /** The gate held or denied a call in the current turn. The third in one turn moves to stopping and leaves a note. */
  denied(): void;
  /**
   * Stop: working → stopping, where the gate denies every call; the next result, or the 15 s deadline, ends the turn
   * as stopped. A head waiting in backoff ends as stopped at once. Queued unattended envelopes are dropped, each with a
   * notice; the user's own envelopes still run after the stopped turn ends. Resolves false when nothing was running.
   */
  interrupt(): Promise<boolean>;
  close(): void;
  /** A turn is running or retrying, or envelopes wait and nothing holds them. */
  readonly working: boolean;
  /** Why queued work is held while nothing runs; null when something runs or nothing waits. */
  readonly parkedFor: ParkReason | null;
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
  /** Every SDK message of the live query, with the turn in flight; late output between turns comes with null. */
  onMessage: (m: SDKMessage, turn: Pending | null) => void;
  onTurnEnd: (turn: Pending, end: TurnEnd) => void;
  /** Something the actor's status derives from changed (working, lifecycle, park). */
  onChange: () => void;
  /** A line for the owning bot's chat: the daily cap is reached, or a turn was stopped after 3 held calls. */
  note: (text: string) => void;
  persist: Persist;
  /** Named in the notice an envelope dropped by Stop leaves. */
  userName?: string;
  log?: (line: string) => void;
  query?: typeof query;
  executable?: () => string | null;
  now?: () => Date;
};

type Live = {
  gen: number;
  q: Query;
  /** The query started without a resume id, so its first result is the session's whole cost. */
  fresh: boolean;
  send(m: SDKUserMessage): void;
  release(): void;
  stderr(): string;
};

const SYSTEM: Initiator = { kind: "system" };
const own = (state: Owned<SessionState>) => state as unknown as SessionState;
const ownAccount = (account: Owned<AccountState>) => account as unknown as AccountState;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSession(spec: SessionSpec): Session {
  const run = spec.query ?? query;
  const clock = spec.now ?? (() => new Date());
  const log = spec.log ?? ((line: string) => console.error(line));
  const executable = spec.executable ?? claudeExecutable;
  const userName = spec.userName ?? "The user";
  const label = actorKey(spec.actor);
  let memo = freshMemo();
  let live: Live | null = null;
  let generation = 0;
  let closed = false;
  let signals = noSignals();

  const guard = (what: string, f: () => void) => {
    try {
      f();
    } catch (e) {
      log(`session ${label}: ${what} threw: ${errorText(e)}`);
    }
  };

  function headroom(initiator: Initiator): Headroom {
    try {
      return spec.ledger.headroom(spec.actor, initiator);
    } catch (e) {
      log(`session ${label}: headroom threw: ${errorText(e)}`);
      return { ok: true, capReached: false };
    }
  }

  const accountParked = () => spec.account.parkedUntil !== null && spec.account.parkedUntil > clock().toISOString();
  const waiting = () => spec.state.lifecycle.kind === "idle" && spec.state.pending.length > 0;

  function current(): Pending | null {
    const t = turnOf(spec.state.lifecycle as Lifecycle);
    return t ? (spec.state.pending.find((p) => p.id === t.pending) ?? null) : null;
  }

  function isWorking(): boolean {
    const kind = spec.state.lifecycle.kind;
    return kind === "working" || kind === "stopping" || kind === "backoff" || (waiting() && !accountParked());
  }

  function parkedFor(): ParkReason | null {
    const life = spec.state.lifecycle;
    if (life.kind === "parked") return life.reason;
    return waiting() && accountParked() ? "usage_limit" : null;
  }

  const status = () => `${isWorking()}|${spec.state.lifecycle.kind}|${parkedFor()}`;

  function transition(ev: Event, now: Date): Effect[] {
    const before = { session: structuredClone(spec.state) as SessionState, parkedUntil: spec.account.parkedUntil, memo };
    const t = step(before, ev, { now, headroom, userName });
    const state = own(spec.state);
    const changed =
      JSON.stringify([before.session, before.parkedUntil]) !== JSON.stringify([t.core.session, t.core.parkedUntil]);
    state.pending = t.core.session.pending;
    state.lifecycle = t.core.session.lifecycle;
    state.notices = t.core.session.notices;
    ownAccount(spec.account).parkedUntil = t.core.parkedUntil;
    memo = t.core.memo;
    if (changed) guard("persist", () => spec.persist("now"));
    return t.effects;
  }

  function dispatch(ev: Event, now = clock()) {
    if (closed) return;
    const was = status();
    for (const e of transition(ev, now)) perform(e);
    if (!closed && status() !== was) guard("onChange", () => spec.onChange());
  }

  function perform(e: Effect) {
    switch (e.kind) {
      case "send":
        return send(e.text);
      case "end":
        return guard("onTurnEnd", () => spec.onTurnEnd(e.pending, e.end));
      case "interrupt":
        return guard("interrupt", () => void live?.q.interrupt().catch((err) => log(`session ${label}: interrupt failed: ${errorText(err)}`)));
      case "kill":
        return closeLive();
      case "note":
        return guard("note", () => spec.note(e.text));
    }
  }

  function send(text: string) {
    let l: Live;
    try {
      l = live ?? open();
    } catch (e) {
      return dispatch({ kind: "end", outcome: { kind: "terminal", error: errorText(e) } });
    }
    signals = noSignals();
    l.send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  function open(): Live {
    const path = executable();
    if (!path) throw new Error("claude was not found on PATH. Set CLAUDIOBOT_CLAUDE.");
    const options = spec.options();
    const fresh = spec.state.id === null;
    const gen = ++generation;
    const inbox: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    let stderr = "";
    // One message per turn: the next is handed over only after this turn's result, so the SDK never queues a second.
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (gen === generation && !closed) {
        const next = inbox.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    }
    const q = run({ prompt: input(), options: { ...options, pathToClaudeCodeExecutable: path, stderr: (d) => (stderr = (stderr + d).slice(-2000)) } });
    const l: Live = {
      gen,
      q,
      fresh,
      send(m) {
        inbox.push(m);
        wake?.();
      },
      release: () => wake?.(),
      stderr: () => stderr.trim(),
    };
    live = l;
    void consume(l);
    return l;
  }

  function closeLive() {
    const l = live;
    if (!l) return;
    live = null;
    generation++;
    l.release();
    guard("close", () => l.q.close());
  }

  async function consume(l: Live) {
    let error = "Claude Code exited";
    try {
      for await (const m of l.q) {
        if (l.gen !== generation || closed) return;
        guard(`handling ${m.type}`, () => receive(m, l));
      }
    } catch (e) {
      error = errorText(e);
    }
    if (l.gen !== generation || closed) return;
    closeLive();
    if (current()) dispatch({ kind: "end", outcome: { kind: "transient", error: l.stderr() ? `${error}\n${l.stderr()}` : error } });
  }

  function receive(m: SDKMessage, l: Live) {
    if (m.session_id && m.session_id !== spec.state.id) {
      own(spec.state).id = m.session_id;
      guard("persist", () => spec.persist());
    }
    if (m.type === "assistant" && m.error) signals.apiError = m.error;
    else if (m.type === "assistant" && turnOf(spec.state.lifecycle as Lifecycle)?.output === false) dispatch({ kind: "output" });
    if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
      signals.rejected = true;
      signals.resetsAt = m.rate_limit_info.resetsAt ?? null;
    }
    guard("onMessage", () => spec.onMessage(m, current()));
    if (m.type !== "result") return;
    const turn = current();
    // A variable, not a literal: the ledger's add input gains `fresh` in U3, and until then it rides along untyped.
    const usage = { actor: spec.actor, sessionId: m.session_id, initiator: turn?.initiator ?? SYSTEM, cumulativeUsd: m.total_cost_usd, fresh: l.fresh };
    l.fresh = false;
    guard("ledger.add", () => spec.ledger.add(usage));
    const outcome = classify(m, signals, clock());
    signals = noSignals();
    if (turn) dispatch({ kind: "end", outcome });
  }

  const recovered = transition({ kind: "recover" }, clock());
  // The caller registers the session before any callback fires; a push in the meantime pumps by itself.
  queueMicrotask(() => {
    if (closed) return;
    for (const e of recovered) perform(e);
    dispatch({ kind: "pump" });
  });

  return {
    push(input) {
      if (closed) return;
      const { ahead, ...fields } = input;
      const pending: Pending = { ...fields, id: `e_${crypto.randomUUID()}` as EnvelopeId, at: clock().toISOString(), attempts: 0 };
      dispatch({ kind: "push", pending, ahead });
    },
    notice(text) {
      dispatch({ kind: "notice", notice: { at: clock().toISOString(), text } });
    },
    denied() {
      dispatch({ kind: "denied" });
    },
    async interrupt() {
      const kind = spec.state.lifecycle.kind;
      if (closed || (kind !== "working" && kind !== "stopping" && kind !== "backoff")) return false;
      dispatch({ kind: "stop" });
      return true;
    },
    tick(now) {
      dispatch({ kind: "tick" }, now);
    },
    nextDeadline() {
      const life = spec.state.lifecycle;
      if (life.kind === "stopping") return life.deadline;
      if (life.kind === "backoff" || life.kind === "parked") return life.until;
      return waiting() ? spec.account.parkedUntil : null;
    },
    close() {
      closed = true;
      closeLive();
    },
    get working() {
      return isWorking();
    },
    get parkedFor() {
      return parkedFor();
    },
    get current() {
      return current();
    },
    get lifecycle(): Owned<Lifecycle> {
      return spec.state.lifecycle;
    },
  };
}
