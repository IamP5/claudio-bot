import { spawn } from "node:child_process";
import type {
  query,
  Options,
  Query,
  SDKAssistantMessageError,
  SDKBackgroundTasksChangedMessage,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "./clock";
import type { Headroom, Ledger } from "./ledger";
import { notices as noticeText, withNotices, type SessionInput } from "./prompts";
import { evalArg, groupAlive, psText, shellGroups, shellLeaders, taskRun, type TaskRun } from "./procs";
import type { NoticeReason, SessionControls, StopTarget, TaskId } from "./protocol";
import { sandboxFailure } from "./sandbox";
import type { Persist } from "./store";
import { emptyTasks, liveTasks, lostNotice, observe, wakes, type Activity, type Tasks } from "./tasks";
import { displayName, errorText, fewNames, maskSecrets } from "./text";
import {
  attended,
  driverKey,
  own,
  type AccountState,
  type ActiveTurn,
  type Driver,
  type EnvelopeId,
  type Initiator,
  type Lifecycle,
  type Notice,
  type Owned,
  type ParkReason,
  type Pending,
  type SessionState,
} from "./world";

// The turn runner for one actor, and the only writer of its SessionState and of AccountState.
// step() is the whole lifecycle as a pure function; createSession() is the shell that feeds it SDK and caller events
// and carries out its effects.

/** null unless the configured path, or claude on PATH, is an executable file: the SDK only finds out after spawning. */
export function claudeExecutable(): string | null {
  return Bun.which(process.env.CLAUDIOBOT_CLAUDE ?? "claude");
}

export const STOP_DEADLINE_MS = 15_000;
const RETRY_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
/** The first start plus one retry per backoff step. A replay after a restart is a start too. */
export const MAX_STARTS = RETRY_BACKOFF_MS.length + 1;
/**
 * Waits after a query could not be opened at all: no executable, or options() or the gate's hooks threw. Nothing
 * reached Claude, so no attempt is used and nothing else queued is touched. The last wait repeats until a query opens.
 */
export const START_RETRY_MS = [30_000, 60_000, 120_000, 300_000] as const;
const DENIALS_PER_TURN = 3;
/** A turn with no SDK message for this long is noted in the owning bot's chat, once per turn. It keeps running. */
const STALL_MS = 30 * 60_000;
/**
 * A query with no turn in flight and no message for this long is closed, so its claude process exits; the next turn
 * resumes the session on a new one. It counts from the last message, so output after a turn keeps the process. It is
 * well inside the prompt cache's hour, so a resume reads the cache like the closed query would have.
 */
const IDLE_MS = 15 * 60_000;
/**
 * Closing a query ends its background subagents and leaves its commands running with no one to report them, so a turn
 * that needs a new query waits this long at most for the live one's work to finish. Then the work is stopped, with a
 * note once Claude Code confirms it, and the turn runs.
 */
export const BACKGROUND_WAIT_MS = 10 * 60_000;
/**
 * A task_notification means Claude Code will start a turn of its own to report the task, right after the turn it runs
 * or at once when it runs none. A close waits this long for that turn's init frame, so it does not cut the turn off,
 * and a CLI that never wakes holds a turn no longer than this. Claude Code starts the turn locally, before any request:
 * 40 ms after the notification in test/transcripts/background-wake-handoff.ndjson, so this leaves room for a loaded Mac.
 */
export const WAKE_WAIT_MS = 30_000;
const DESCRIPTION_MAX = 80;
/** When the ledger cannot answer, an unattended start waits this long; an attended one runs. */
export const HEADROOM_RETRY_MS = 60_000;
export const USAGE_PARK_SLACK_MS = 30_000;
/** A rejection that came without a usable reset time parks this long, then tries again. */
export const USAGE_PARK_FALLBACK_MS = 5 * 60_000;
/** No usage park outlasts this, whatever resetsAt says. The longest plan window is 7 days. */
export const USAGE_PARK_MAX_MS = 8 * 86_400_000;
const TRANSIENT_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set(["overloaded", "server_error", "unknown", "rate_limit"]);
/**
 * Rejected limits that block one model, not the account (the CLI itself calls these "model" limits), so they park
 * only the session that hit them. five_hour (the session window), seven_day (the weekly window), overage (the spend
 * cap on extra usage) and a rejection without a type (older CLIs) block every request on the account, so they park
 * every session.
 */
const MODEL_LIMITS: ReadonlySet<string> = new Set(["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]);

export const CAP_NOTE = "Daily cap reached. Your messages still run; routines and other background work wait until tomorrow.";
export const BREAKER_NOTE = `Stopped this turn after ${DENIALS_PER_TURN} held or denied tool calls.`;
export const RESTARTED_ERROR = "The bridge restarted during this turn.";
export const GONE_ERROR = "This session's transcript is gone: Claude Code no longer has it.";
const stallNote = (name: string) => `${name} has been silent for 30 minutes; you can press Stop.`;
const startFailedNote = (error: string) =>
  `Claude Code could not start: ${error.replace(/\.?\s*$/, ".")} Queued messages are kept, and it keeps trying.`;
const forgottenNote = (name: string) =>
  `${name}'s earlier conversation was cleared by Claude Code, so it starts a new one. Its notes and memory are kept.`;
const FORGOTTEN_NOTICE =
  "[Your earlier conversation history is gone: Claude Code deleted it. Your notes and the facts about the user are kept; ask if you need something from before.]";
/** What Claude Code says when --resume names a transcript it has deleted (after cleanupPeriodDays, or by hand). */
const forgotten = (text: string, id: string) => text.includes(`No conversation found with session ID: ${id}`);
/** What Claude Code says when a query asks to start a session under an id that already has a transcript. */
const inUse = (text: string, id: string) => text.includes(`Session ID ${id} is already in use`);
const tasksOf = (tasks: readonly Background[]) =>
  fewNames(
    tasks.map((t) => t.description ?? t.id),
    (names) => names.join("; "),
    "; ",
  );
/** Why a query's background work lost its Claude Code: the bridge restarted, or Claude Code exited. */
export type GoneCause = "restart" | "exit";
/** What became of a gone query's background work and foreground commands, by what the Mac still runs. */
export type Fate = { stopped: Background[]; running: Background[]; unknown: Background[] };
/** names: the tasks as the thread names them; by default their descriptions. */
export const goneNote = (name: string, cause: GoneCause, kind: keyof Fate, tasks: readonly Background[], names = tasksOf(tasks)): string => {
  const restart = cause === "restart";
  const work = tasks.some((t) => t.foreground) ? "work" : "background work";
  switch (kind) {
    case "stopped":
      return restart ? `The bridge restarted, so ${name}'s ${work} stopped: ${names}.` : `${name}'s ${work} stopped: ${names}.`;
    case "running":
      return `${restart ? `The bridge restarted, and ${name}` : `${name} exited, and`} no longer follows its ${work}, which still runs on this Mac: ${names}.`;
    case "unknown":
      return `${restart ? `The bridge restarted, and ${name}'s` : `${name} exited, and its`} ${work} may still run on this Mac: ${names}.`;
  }
};
/**
 * A command (or other shell task) outlives Claude Code while its shell still writes to its output file, and stopped
 * once no process of its group runs. Subagents run inside Claude Code, so they stopped once its process is gone. Without
 * one of those facts the bridge cannot tell.
 */
const FATE_OF_RUN = { runs: "running", gone: "stopped", unsure: "unknown", unread: "unknown" } as const;
/** A process table that could not be read is read again this much later, while the bridge still looks. */
const GONE_LOOK_AGAIN_MS = 1_000;
async function fateOf(tasks: readonly Background[], run: (group: number, id: string) => Promise<TaskRun>, looking: () => boolean): Promise<Fate> {
  const fate: Fate = { stopped: [], running: [], unknown: [] };
  const read = async (group: number, id: string): Promise<TaskRun> => {
    for (;;) {
      const r = await run(group, id);
      if (r !== "unread" || !looking()) return r;
      await new Promise((resolve) => setTimeout(resolve, GONE_LOOK_AGAIN_MS));
    }
  };
  const kinds = await Promise.all(
    tasks.map(async (t): Promise<keyof Fate> => {
      if (typeof t.group === "number") return FATE_OF_RUN[await read(t.group, t.id)];
      if (typeof t.loose === "number") return groupAlive(t.loose) ? "unknown" : "stopped";
      return t.kind === "agent" && t.claude !== undefined && !groupAlive(t.claude) ? "stopped" : "unknown";
    }),
  );
  tasks.forEach((t, i) => fate[kinds[i]!].push(t));
  return fate;
}
/** A Claude Code that exits on its own stops its commands first; the bridge looks at what still runs this much later. */
export const EXIT_SETTLE_MS = 1_000;
/** How long the bridge looks at what a gone query's background work became before it says it cannot tell. */
export const GONE_LOOK_MAX_MS = 60_000;
/** How many times the bridge looks up the shells of a query's background commands before it gives up on one. */
const SHELL_SEARCHES = 3;
const SHELL_SEARCH_AGAIN_MS = 1_000;
/** How long after a command's call its shell may start, a permission card's wait aside, and still be taken as its own. */
const SHELL_START_SLACK_MS = 30_000;
const compactedNote = (name: string) => `${name}'s conversation was compacted to make room; older details are summarized now.`;
const restartedNotice = (envelopeText: string) =>
  `[The bridge restarted during your turn on: ${envelopeText.split("\n")[0]} It may be partly done; check before redoing it.]`;

/**
 * Stop drops a routine's scheduled fire and a message from another bot: nobody waits on either. An agent's report and an
 * approval continuation stay, whatever their initiator, because the bot needs the report and the user just answered.
 */
const droppedByStop = (p: Pending): boolean =>
  (p.settles !== null && !attended(p.initiator)) || (p.initiator.kind === "bot" && p.kind !== "continuation");

const DROPS_NAMED = 3;
/** One notice per Stop, however much it dropped, so the notices on the next envelope stay short. */
function droppedNotice(userName: string, texts: readonly string[]): string {
  if (texts.length === 1) return noticeText.droppedByStop(userName, texts[0]!);
  const named = texts.slice(0, DROPS_NAMED).map((t) => t.split("\n")[0]).join("; ");
  const rest = texts.length - DROPS_NAMED;
  return `[${userName} pressed Stop, so ${texts.length} queued messages never ran: ${named}${rest > 0 ? `; and ${rest} more` : ""}]`;
}

/**
 * How a turn, or an envelope that never became one, ended. Exactly one TurnEnd per envelope that leaves the queue,
 * so a routine run is settled exactly once. The removal is persisted before its TurnEnd is told, so a crash between
 * the two loses the TurnEnd and leaves the routine run running for the scheduler's boot sweep to settle.
 * - done: the turn ran to a result, success or an error subtype. A success that lands while stopping is done too, so
 *   the turn's final report is kept.
 * - stopped: Stop landed while it ran (by "user"), or the 3-denials breaker did (by "breaker"). The interrupt's
 *   error_during_execution result maps here, never to done/failed, and is never retried.
 * - dropped: Stop removed it from the queue before it started: a routine's scheduled fire or a message from a bot.
 * - failed: removed without a usable result: a crash after output, a terminal error, the poison limit, no budget.
 * - deferred: still queued and will run later (a retry, a start that could not open, or a park). Not an ending; a
 *   routine run stays running. Told once per park, however often its deadline moves.
 */
export type TurnEnd =
  | { kind: "done"; result: SDKResultMessage }
  /** killed: Claude Code never confirmed the stop, so the bridge closed it; commands it ran in the foreground may live on. */
  | { kind: "stopped"; by: "user" | "breaker"; killed?: true }
  | { kind: "dropped" }
  | { kind: "failed"; error: string }
  | { kind: "deferred"; until: string; why: Deferral };

type Deferral = "retry" | ParkReason;

const BUDGET_USED = "The agent's budget is used up.";

/** The turn ended because a budget ran out: the agent's, before it started, or the query's maxBudgetUsd during it. */
export const usedBudget = (end: TurnEnd): boolean =>
  (end.kind === "failed" && end.error === BUDGET_USED) || (end.kind === "done" && end.result.subtype === "error_max_budget_usd");

/** How the turn in flight ended, as the shell read it at the SDK boundary. */
export type Outcome =
  | { kind: "result"; result: SDKResultMessage }
  | { kind: "transient"; error: string }
  /** account: every session waits (AccountState). session: only this one does, because another model may still run. */
  | { kind: "usage_limit"; error: string; until: string; scope: "account" | "session" }
  | { kind: "terminal"; error: string };

export type Event =
  | { kind: "push"; pending: Pending }
  | { kind: "notice"; notice: Notice }
  /** Start the next admissible envelope, if any. Every transition that frees the session also pumps. */
  | { kind: "pump" }
  /** The first assistant message of the turn in flight. */
  | { kind: "output" }
  | { kind: "denied" }
  | { kind: "end"; outcome: Outcome }
  /** Output no turn claims (a background task's wake turn) hit an account-wide usage limit: the account parks all the same. */
  | { kind: "limit"; until: string }
  /** The query for the turn just started could not be opened, so nothing reached Claude. */
  | { kind: "unstarted"; error: string }
  /** The query resumed a session Claude Code no longer has, before any output: start over on a fresh one. */
  | { kind: "forgotten" }
  /** The query asked to start a session whose id Claude Code already has, before any output: send it again, resuming. */
  | { kind: "claimed" }
  /** What held the queue head's start has gone: a start waiting out its retry goes now. */
  | { kind: "retry" }
  | { kind: "stop" }
  /** The user withdrew a queued message before it ran. */
  | { kind: "unqueue"; clientId: string }
  /** Deadlines are due, or a hold may have lifted: a daily-cap park re-checks headroom on every tick. */
  | { kind: "tick" }
  | { kind: "recover" };

export type Effect =
  | { kind: "send"; pending: Pending; text: string }
  | { kind: "end"; pending: Pending; end: TurnEnd }
  | { kind: "interrupt" }
  | { kind: "kill" }
  | { kind: "note"; text: string; reason?: NoticeReason };

/** Lives in memory only; a restart starts from freshMemo(). */
type Memo = {
  /**
   * How many notices at the front of session.notices the turn in flight carried. They are dropped once the model has
   * seen them (the turn had output or reached a result) and kept when it ends before that, so the next start carries
   * them again. After a restart they are all still there. Meaningless while no turn is in flight; begin() sets it.
   */
  carried: number;
  /** The cap note was left and the cap has not cleared since. */
  capNoted: boolean;
  /** Per queued envelope, the deferral last told for it. Starting the envelope or removing it clears its entry. */
  told: Record<string, Deferral>;
  /** Queries in a row that could not be opened. A query that reaches any end resets it. */
  startFailures: number;
};

export const freshMemo = (): Memo => ({ carried: 0, capNoted: false, told: {}, startFailures: 0 });

export type Core = { session: SessionState; parkedUntil: string | null; memo: Memo };
/** quiet: notices are dropped instead of riding on the turn's text (the user's own session, whose transcript the app shows). */
type StepContext = { now: Date; headroom: (initiator: Initiator) => Headroom; userName: string; quiet?: boolean };

const turnOf = (life: Lifecycle): ActiveTurn | null => (life.kind === "working" || life.kind === "stopping" ? life.turn : null);

/** A Stop Claude Code has not confirmed yet, as the thread's controls carry it. */
export const stopPending = (life: Lifecycle): Pick<SessionControls, "stopping"> =>
  life.kind === "stopping" ? { stopping: { at: new Date(Date.parse(life.deadline) - STOP_DEADLINE_MS).toISOString(), deadline: life.deadline } } : {};

/**
 * The lifecycle, total over (Lifecycle x Event) and pure. Invariants it keeps:
 * - The envelope in flight is pending[0]; a continuation goes right behind it.
 * - Only idle (or an expired backoff/park, or a daily_cap park for an attended envelope) starts a turn, so nothing
 *   is sent while stopping.
 * - Every envelope removed from pending gets exactly one non-deferred end.
 * - The lifecycle is parked exactly while the queue head is held.
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
      if (c.memo.told[p.id] === e.why) return;
      c.memo.told[p.id] = e.why;
    } else delete c.memo.told[p.id];
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
    if (t.output || e.kind === "done") dropCarried();
    c.memo.carried = 0;
    s.lifecycle = { kind: "idle" };
    if (p) end(p, e);
  }

  /** Puts the turn in flight back at the head as if it never started: the start it was counted for reached no one. */
  function requeue(t: ActiveTurn): Pending | null {
    c.memo.carried = 0;
    s.lifecycle = { kind: "idle" };
    const i = s.pending.findIndex((p) => p.id === t.pending);
    if (i === -1) return null;
    const held: Pending = { ...s.pending[i]!, attempts: s.pending[i]!.attempts - 1 };
    s.pending[i] = held;
    return held;
  }

  function hold(reason: ParkReason, until: string) {
    s.lifecycle = { kind: "parked", reason, until };
    end(s.pending[0]!, { kind: "deferred", until, why: reason });
  }

  function parkAccount(until: string) {
    if (c.parkedUntil === null || due(c.parkedUntil) || until > c.parkedUntil) c.parkedUntil = until;
  }

  function dropOnStop(keep: EnvelopeId | null) {
    const dropped = s.pending.filter((p) => p.id !== keep && droppedByStop(p));
    if (dropped.length === 0) return;
    s.pending = s.pending.filter((p) => !dropped.includes(p));
    s.notices.push({ at: iso(now), text: droppedNotice(ctx.userName, dropped.map((p) => p.text)) });
    for (const p of dropped) end(p, { kind: "dropped" });
  }

  function begin(p: Pending, capReached: boolean) {
    const started: Pending = { ...p, attempts: p.attempts + 1 };
    s.pending.splice(s.pending.indexOf(p), 1);
    s.pending.unshift(started);
    delete c.memo.told[p.id];
    s.lifecycle = { kind: "working", turn: { pending: p.id, startedAt: iso(now), output: false, denials: 0 } };
    c.memo.carried = s.notices.length;
    fx.push({ kind: "send", pending: started, text: ctx.quiet ? started.text : withNotices(started.text, s.notices) });
    if (!capReached) c.memo.capNoted = false;
    else if (!c.memo.capNoted) {
      c.memo.capNoted = true;
      fx.push({ kind: "note", text: CAP_NOTE });
    }
  }

  function pump() {
    // The ledger's word for this pass, not due(until): a cap end the ledger reports as already past would otherwise
    // read as lifted and re-ask it forever.
    let capHeld = false;
    for (;;) {
      const life = s.lifecycle;
      if (life.kind === "working" || life.kind === "stopping") return;
      if (s.pending.length === 0) {
        s.lifecycle = { kind: "idle" };
        return;
      }
      if ((life.kind === "backoff" || (life.kind === "parked" && life.reason === "usage_limit")) && !due(life.until)) return;
      if (c.parkedUntil !== null && !due(c.parkedUntil)) return hold("usage_limit", c.parkedUntil);
      const capped = capHeld || (life.kind === "parked" && life.reason === "daily_cap" && !due(life.until));
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
        end(next, { kind: "failed", error: BUDGET_USED });
        continue;
      }
      if (capped) return;
      hold("daily_cap", room.until);
      capHeld = true;
    }
  }

  function ended(o: Outcome) {
    const t = turnOf(s.lifecycle);
    if (!t) return;
    c.memo.startFailures = 0;
    if (o.kind === "usage_limit" && o.scope === "account") parkAccount(o.until);
    const p = s.pending.find((x) => x.id === t.pending);
    if (!p) {
      s.lifecycle = { kind: "idle" };
      return;
    }
    if (s.lifecycle.kind === "stopping") {
      const success = o.kind === "result" && o.result.subtype === "success";
      finish(t, success ? { kind: "done", result: o.result } : { kind: "stopped", by: stoppedBy(t) });
    } else {
      switch (o.kind) {
        case "result":
          finish(t, { kind: "done", result: o.result });
          break;
        case "terminal":
          finish(t, { kind: "failed", error: o.error });
          break;
        case "transient": {
          const wait = RETRY_BACKOFF_MS[p.attempts - 1];
          if (t.output) finish(t, { kind: "failed", error: o.error });
          else if (wait === undefined) finish(t, { kind: "failed", error: `${o.error} (gave up after ${p.attempts} attempts)` });
          else {
            const until = iso(now + wait);
            s.lifecycle = { kind: "backoff", until, attempt: p.attempts };
            end(p, { kind: "deferred", until, why: "retry" });
          }
          break;
        }
        case "usage_limit":
          // Not the envelope's fault, so a start with no output does not count toward its poison limit.
          if (t.output) finish(t, { kind: "failed", error: o.error });
          else requeue(t);
          break;
      }
    }
    if (o.kind === "usage_limit" && o.scope === "session" && s.pending.length > 0) hold("usage_limit", o.until);
  }

  switch (ev.kind) {
    case "push": {
      const busy = turnOf(s.lifecycle) !== null;
      if (ev.pending.kind === "continuation") s.pending.splice(busy ? 1 : 0, 0, ev.pending);
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
    case "limit":
      parkAccount(ev.until);
      pump();
      break;
    case "unstarted": {
      const t = turnOf(s.lifecycle);
      if (!t) break;
      const held = requeue(t);
      const failures = ++c.memo.startFailures;
      if (held) {
        const until = iso(now + START_RETRY_MS[Math.min(failures, START_RETRY_MS.length) - 1]!);
        s.lifecycle = { kind: "backoff", until, attempt: held.attempts };
        end(held, { kind: "deferred", until, why: "retry" });
      }
      // Told at the first failure of a streak: a missing claude does not fix itself.
      if (failures === 1) fx.push({ kind: "note", text: startFailedNote(ev.error) });
      pump();
      break;
    }
    case "forgotten": {
      const t = turnOf(s.lifecycle);
      if (!t) break;
      s.id = null;
      // Nothing reached the model, so the start is given back; the fresh session is told its history is gone.
      if (s.lifecycle.kind === "stopping") finish(t, { kind: "stopped", by: stoppedBy(t) });
      else requeue(t);
      s.notices.unshift({ at: iso(now), text: FORGOTTEN_NOTICE });
      pump();
      break;
    }
    case "retry":
      if (s.lifecycle.kind === "backoff") s.lifecycle = { kind: "idle" };
      pump();
      break;
    case "claimed": {
      const t = turnOf(s.lifecycle);
      if (!t) break;
      if (s.lifecycle.kind === "stopping") finish(t, { kind: "stopped", by: stoppedBy(t) });
      else requeue(t);
      pump();
      break;
    }
    case "stop": {
      const life = s.lifecycle;
      if (life.kind === "working") {
        s.lifecycle = { kind: "stopping", turn: life.turn, deadline: iso(now + STOP_DEADLINE_MS) };
        fx.push({ kind: "interrupt" });
        dropOnStop(life.turn.pending);
      } else if (life.kind === "backoff") {
        const head = s.pending.shift();
        s.lifecycle = { kind: "idle" };
        if (head) end(head, { kind: "stopped", by: "user" });
        dropOnStop(null);
        pump();
      } else if (life.kind === "parked" || life.kind === "idle") {
        dropOnStop(null);
        pump();
      }
      break;
    }
    case "unqueue": {
      const inFlight = turnOf(s.lifecycle)?.pending;
      const i = s.pending.findIndex((p) => p.clientId === ev.clientId && p.id !== inFlight);
      if (i === -1) break;
      const p = s.pending.splice(i, 1)[0]!;
      // A held head that goes takes its hold with it; pump holds the next one again if it must.
      if (i === 0 && (s.lifecycle.kind === "backoff" || s.lifecycle.kind === "parked")) s.lifecycle = { kind: "idle" };
      end(p, { kind: "dropped" });
      pump();
      break;
    }
    case "tick": {
      if (c.parkedUntil !== null && due(c.parkedUntil)) c.parkedUntil = null;
      const life = s.lifecycle;
      if (life.kind === "stopping" && due(life.deadline)) {
        fx.push({ kind: "kill" });
        finish(life.turn, { kind: "stopped", by: stoppedBy(life.turn), killed: true });
      } else if (life.kind === "backoff" && due(life.until)) {
        s.lifecycle = { kind: "idle" };
      } else if (life.kind === "parked" && (life.reason === "daily_cap" || due(life.until))) {
        // The cap may have been raised or the ledger healed; pump asks headroom again and re-parks if still held.
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
type Signals = {
  /** A rate_limit_event rejected a request that extra usage did not cover. */
  rejected: boolean;
  /** That event's resetsAt as sent; classify() decides whether it is usable. */
  resetsAt: number | null;
  limitType: NonNullable<SDKRateLimitInfo["rateLimitType"]> | null;
  apiError: SDKAssistantMessageError | null;
};
export const noSignals = (): Signals => ({ rejected: false, resetsAt: null, limitType: null, apiError: null });

/** resetsAt is epoch seconds; a value above 1e12 can only be milliseconds. */
const resetMs = (resetsAt: number | null): number | null =>
  resetsAt === null || !Number.isFinite(resetsAt) ? null : resetsAt > 1e12 ? resetsAt : resetsAt * 1000;

/**
 * SDK → Outcome. Pure, and it never throws, whatever resetsAt holds.
 * - An API error ends the turn as subtype success with is_error true; the assistant message's `error` names it.
 * - Only a rejected SDKRateLimitEvent is the usage limit, because only it says which limit and when it resets. A 429
 *   or a rate_limit error without one is a throttle or a capacity refusal, so it is transient.
 * - The park ends 30 s after the reset, never before now plus the slack and never more than 8 days out.
 */
export function classify(r: SDKResultMessage, s: Signals, now: Date): Outcome {
  if (r.subtype === "success" && !r.is_error) return { kind: "result", result: r };
  const error = (r.subtype === "success" ? r.result.trim() : r.errors.join("; ")) || s.apiError || r.subtype;
  if (s.rejected) {
    const t = now.getTime();
    const reset = resetMs(s.resetsAt) ?? t + USAGE_PARK_FALLBACK_MS;
    const until = Math.min(Math.max(reset, t) + USAGE_PARK_SLACK_MS, t + USAGE_PARK_MAX_MS);
    const scope = s.limitType !== null && MODEL_LIMITS.has(s.limitType) ? "session" : "account";
    return { kind: "usage_limit", error, until: new Date(until).toISOString(), scope };
  }
  if (r.subtype !== "success") return { kind: "result", result: r };
  const status = r.api_error_status ?? 0;
  if ((s.apiError !== null && TRANSIENT_ERRORS.has(s.apiError)) || status === 429 || status >= 500) return { kind: "transient", error };
  return { kind: "terminal", error };
}

const LIMIT_NAMES: Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string> = {
  five_hour: "Session limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_overage_included: "Weekly limit",
  overage: "Extra usage limit",
};

/** The warnings already noted, by limit and reset. Shared by every session: the limits are the account's. */
const warned = new Set<string>();

/** "Weekly limit at 90%, resets Tue 09:00.", once per limit and reset; null when already told or nothing says how far. */
function limitWarning(info: SDKRateLimitInfo): string | null {
  const at = info.surpassedThreshold ?? info.utilization;
  const key = `${info.rateLimitType}|${info.resetsAt}`;
  if (at === undefined || warned.has(key)) return null;
  warned.add(key);
  const name = info.rateLimitType ? LIMIT_NAMES[info.rateLimitType] : "Usage limit";
  const reset = resetMs(info.resetsAt ?? null);
  const when =
    reset === null ? "" : `, resets ${new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  return `${name} at ${Math.round(at <= 1 ? at * 100 : at)}%${when}.`;
}

/** Claude Code process groups still alive. The bridge's shutdown exits before the SDK's close grace runs out. */
const groups = new Set<number>();
/** The pids of the Claude Code processes this bridge runs, so the live-process registry can tell them from others. */
export const ownPids = (): ReadonlySet<number> => groups;
process.once("exit", () => {
  for (const pid of groups) killGroup(pid);
});

function killGroup(pid: number) {
  if (!groups.delete(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") console.error(`killing Claude Code's process group ${pid} failed: ${errorText(e)}`);
  }
}

/**
 * Spawns Claude Code in a process group of its own and kills the whole group when Claude Code exits or the query's
 * signal aborts, so the MCP servers and shells it started do not outlive it. The SDK reads stderr only from a process
 * it spawned itself, so this one hands it over. `exited` is called once Claude Code has exited, or at once when it
 * never started.
 */
export function spawnGroup(o: SpawnOptions, stderr: (data: string) => void, exited: () => void): SpawnedProcess & { pid?: number } {
  const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  child.stderr.on("data", (d) => stderr(String(d)));
  const pid = child.pid;
  if (pid === undefined) {
    exited();
    return child;
  }
  groups.add(pid);
  const kill = () => killGroup(pid);
  child.once("exit", () => {
    kill();
    exited();
  });
  if (o.signal.aborted) kill();
  else o.signal.addEventListener("abort", kill, { once: true });
  return child;
}

export type Session = Tickable & {
  /** Queues one envelope; persisted before the SDK sees it. A continuation goes before everything queued. */
  push(input: SessionInput): void;
  /** Adds a line to the top of the next envelope this actor runs. Spends no turn. */
  notice(text: string): void;
  /** The gate held or denied a call in the current turn. The third in one turn moves to stopping and leaves a note. */
  denied(): void;
  /**
   * Stop: working → stopping, where the gate denies every call; the next result, or the 15 s deadline, ends the turn
   * as stopped. A head waiting in backoff ends as stopped at once. Queued routine fires and bot messages are dropped,
   * with one notice; everything else queued still runs after the stopped turn ends, or when the park lifts. Every
   * background task of the live query is stopped, and each stop waits up to STOP_TASK_WAIT_MS for Claude Code to take
   * it. target "turn" leaves the background tasks running; {task} stops that one task alone. ran is false only when
   * nothing it names runs or waits; refused lists the tasks Claude Code refused to stop, late those it has not
   * confirmed within the wait.
   */
  interrupt(target?: StopTarget): Promise<StopReport>;
  /** Withdraws the queued envelope the phone sent under clientId, before it runs. False when none waits. */
  unqueue(clientId: string): boolean;
  /** What runs on the live query: the foreground turn, a wake turn included, and Claude Code's tasks. */
  activity(): Activity;
  /** The ledger's answer may have changed (update_bot set dailyCapUsd): a daily-cap park asks headroom again now. */
  recheck(): void;
  /** What held a start (blocked) has gone: a turn waiting out its start retry goes now. */
  retry(): void;
  /** options() would now give something else: the live query closes now, or when the turn it serves ends. */
  reopen(): void;
  /** The live query's controls (MCP status and toggles, the commands it offers), or null while no query is open. */
  mcp(): Pick<Query, "mcpServerStatus" | "toggleMcpServer" | "supportedCommands"> | null;
  /** The live query's model and mode, which change at once; null while no query is open. */
  controls(): Pick<Query, "setModel" | "setPermissionMode" | "supportedModels"> | null;
  /** Recovered TurnEnds not yet told are told before it closes. */
  close(): void;
  /** A turn is running or retrying, or envelopes wait and nothing holds them. */
  readonly working: boolean;
  /** Why queued work is held while nothing runs; null when something runs or nothing waits. */
  readonly parkedFor: ParkReason | null;
  /** Claude Code announced a turn of its own that has not begun: the work it reports may still show as running. */
  readonly wakeDue: boolean;
  /** What became of a gone query's background work is still being looked up: none of it is known to have ended. */
  readonly settling: boolean;
  /** Claude Code could not be started on the last try and the session waits to try again. working stays true meanwhile. */
  readonly unavailable: boolean;
  /** The envelope in flight. The gate reads its initiator. */
  readonly current: Pending | null;
  readonly lifecycle: Owned<Lifecycle>;
};

/** woken: the stop reached a turn Claude Code began on its own, whose end onWakeEnd tells. */
export type StopReport = { ran: boolean; refused: TaskId[]; late: TaskId[]; woken: boolean };

function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(late), ms);
    void p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

/** How long a Stop waits for Claude Code to stop one task before it reports the task as not stopped. */
export const STOP_TASK_WAIT_MS = 5_000;

export type SessionSpec = {
  actor: Driver;
  /** The record's slice. This module is its only writer. */
  state: Owned<SessionState>;
  /** Shared by every session: a usage-limit rejection of the whole account parks them all. */
  account: Owned<AccountState>;
  /** Read at every query start: resume from state.id, and hooks: gate.hooks(actor). */
  options: () => Options;
  /**
   * Read before each turn is sent: context that changes between turns (the facts about the user). A resumed Claude Code
   * session keeps the system prompt it started with, so this rides on the turn's message, and only when it differs
   * from what this session last sent.
   */
  context?: () => string;
  /**
   * Read before each turn is sent: who the actor is (name, user, persona, job). A resumed session keeps the system prompt
   * it started with, so this rides on the first turn after it changes. A new session starts from the current system
   * prompt, so its first turn only records it.
   */
  brief?: () => string;
  /** headroom() before each start, dailyLeft() as a query opens for an unattended turn, add() at each result. */
  ledger: Ledger;
  /** Every SDK message of the live query, with the turn in flight; late output between turns comes with null. */
  onMessage: (m: SDKMessage, turn: Pending | null) => void;
  onTurnEnd: (turn: Pending, end: TurnEnd) => void;
  /** Something the actor's status derives from changed (working, lifecycle, park). */
  onChange: () => void;
  /**
   * A line for the owning bot's chat: the daily cap is reached, a turn was stopped after 3 held calls, Claude Code could
   * not start, or a background task ended without a word from Claude Code (reason "task").
   */
  note: (text: string, reason?: NoticeReason) => void;
  /** activity() changed: a turn, a task or a main-thread call started or ended. Progress alone is not told. */
  onActivity?: () => void;
  persist: Persist;
  /** Named in the notice an envelope dropped by Stop leaves. */
  userName?: string;
  /** Who the stall note names, read when it is left so a rename shows. Default "Claude Code". */
  name?: () => string;
  /** An approval continuation's turn is being sent on an open query, so the gate starts its grant's short window now. */
  continuing?: () => void;
  /**
   * Nothing runs, nothing is queued and no query is open. Asked at every tick while so. An owner of many sessions may
   * close and forget this one: a new session over the same state resumes it.
   */
  onDormant?: () => void;
  /**
   * When a resumed session turns out gone ("No conversation found"): restart, a new session that is told its history is
   * gone (a bot's or an agent's), or fail, the turn ends failed and nothing starts in its place (the user's own
   * session, which must never be silently replaced). Default restart.
   */
  forgotten?: "restart" | "fail";
  /** How long a query with nothing to do stays open. Default 15 minutes. */
  idleMs?: number;
  /** By task id, the process group of each background shell of Claude Code's process `pid` (null: none spawned). Default shellGroups. */
  shells?: (pid: number | null) => Promise<Map<string, number>>;
  /** The group-leading processes Claude Code's process `pid` started, with their command lines. Default shellLeaders. */
  leaders?: (pid: number | null) => Promise<{ group: number; command: string; started?: number }[]>;
  /** Whether a saved process group still runs the background command with this task id. Default taskRun. */
  taskRun?: (group: number, id: string) => Promise<TaskRun>;
  /**
   * What became of a query's background work once its Claude Code is gone, checked against the process table. An owner
   * given this says so itself (and may follow the commands that still run); without one, notes say it.
   */
  gone?: (fate: Fate, cause: GoneCause) => void;
  /** How a turn Claude Code began on its own ended after a Stop reached it: stopped, or finished before the stop landed. */
  onWakeEnd?: (how: "stopped" | "finished") => void;
  /**
   * Read before a turn is sent: why it must wait (another live Claude Code is busy on the session), or null. A wait
   * keeps the turn queued and retries it as a start that could not open does.
   */
  blocked?: () => string | null;
  /** false: the bridge's notices never ride on a turn's text, which here is the user's own words. Default true. */
  notices?: boolean;
  log?: (line: string) => void;
  /** The SDK's query in the bridge; a fake in tests. Required, so no test falls back to the real CLI. */
  query: typeof query;
  /** Starts Claude Code's process for a query; a fake in tests. Default spawnGroup. */
  spawn?: typeof spawnGroup;
  executable?: () => string | null;
  now?: () => Date;
};

type Live = {
  gen: number;
  q: Query;
  /** The query started without a resume id, so its first result is the session's whole cost. */
  fresh: boolean;
  /** Opened for an unattended turn, with maxBudgetUsd at most what was left of the daily cap. */
  capped: boolean;
  /** Closed once the turn it serves ends, so the next turn opens a query with fresh options and a fresh sandbox. */
  stale: boolean;
  /** A tool result said the sandbox could not start, and the owner was told once for this query. */
  sandboxNoted: boolean;
  /** The session id the query resumed, null for a fresh one. */
  resumed: string | null;
  /** The id a fresh query asked Claude Code to create the session under (Options.sessionId), null when it let it pick. */
  claimed: string | null;
  /** A turn on this query has ended, so a later "No conversation found" is not about its resume. */
  answered: boolean;
  /** Its live background tasks, as the last background_tasks_changed listed them, ambient ones left out. */
  background: Background[];
  /** The process group of each background command's shell, by task id, once found. */
  groups: Map<string, number>;
  /** The group of the one shell whose command line holds a command whose output file could not be found, by task id. */
  loose: Map<string, number>;
  /** For a command left unpaired, the groups of Claude Code's shells that may run it, by task id (see pairLoose). */
  shells: Map<string, number[]>;
  /** Searches of the process table for each task's group so far, and whether one is under way. */
  searches: Map<string, number>;
  searching: boolean;
  /** Claude Code's process id; null until it is spawned, or when it never was. */
  pid(): number | null;
  /** A Stop reached a turn Claude Code began on its own; past this time with no such turn running, it is taken as stopped. */
  wakeStop: number | null;
  /**
   * Whose turn Claude Code is running, from the init frame each of its turns starts with: true for ours, false for one a
   * background task woke, null while no init has echoed a uuid on this query (an older CLI). Only a turn's first
   * assistant message echoes, so the frames after it go by this.
   */
  ours: boolean | null;
  /** Claude Code's own turn on this query, which closing it would cut off. */
  cli: Cli;
  /** Background tasks Claude Code confirmed it stopped, with a note, so closing it does not note them again. */
  stopped: Set<string>;
  /** Every task Claude Code runs on it, foreground ones too. */
  tasks: Tasks;
  heardAt: number | null;
  /** Claude Code's process has exited, or none was spawned: nothing of this query can still touch the session. */
  gone(): boolean;
  send(m: SDKUserMessage): void;
  release(): void;
  stderr(): string;
};

/**
 * What Claude Code is doing on a query on its own account, background tasks aside. running: from a turn's init frame
 * to its result, ours or one a background task woke; `wake` when a task_notification came meanwhile and no later tool
 * result carried it into the turn, so a wake turn may follow. due: a wake turn may start; past `until` it is taken as
 * never coming. A due turn is not shown as running: Claude Code may only queue the notification and never start it
 * (CLI 2.1.305, after a task the user stopped), so the session works only from the turn's init frame.
 */
type Cli = { kind: "idle" } | { kind: "running"; wake: boolean; at: number } | { kind: "due"; until: number };

const IDLE: Cli = { kind: "idle" };
/** A wake turn was announced and has not started. */
const wakeAhead = (c: Cli) => c.kind === "due" || (c.kind === "running" && c.wake);

/** Closing the query now would cut work off: its background tasks, or a turn Claude Code runs or is about to run. */
const busy = (l: Live) => l.background.length > 0 || l.cli.kind !== "idle";
/** When the turn Claude Code runs on its own started; null when it runs none. */
const cliTurnAt = (c: Cli): number | null => (c.kind === "running" ? c.at : null);

/** A background task of the live query, by what a note would name it. */
type Background = NonNullable<SessionState["background"]>[number];

/**
 * What of the query can outlive its Claude Code: its background tasks, and the commands it runs in the foreground,
 * which Claude Code runs in shells of their own as it does background ones (CLI 2.1.305), so they outlive it alike.
 * The foreground ones only for an owner that follows what outlives (SessionSpec.gone): a bot's turn says its own end.
 */
function outliving(l: Live, withForeground: boolean): Background[] {
  const foreground = !withForeground ? [] : liveTasks(l.tasks).filter((t) => t.kind === "command" && !t.background && !l.background.some((b) => b.id === t.id));
  return [...l.background, ...foreground.map((t) => ({ id: t.id, description: t.label, foreground: true as const }))];
}

const SYSTEM: Initiator = { kind: "system" };

const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);

/** The reason, when a failed tool result says the sandbox could not start. */
function sandboxDownIn(m: SDKMessage): string | null {
  if (m.type !== "user" || typeof m.message.content === "string") return null;
  for (const block of m.message.content) {
    if (block.type !== "tool_result" || block.is_error !== true) continue;
    const text = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const reason = sandboxFailure(text);
    if (reason !== null) return reason;
  }
  return null;
}

export function createSession(spec: SessionSpec): Session {
  const run = spec.query;
  const clock = spec.now ?? (() => new Date());
  const log = spec.log ?? ((line: string) => console.error(line));
  const executable = spec.executable ?? claudeExecutable;
  const spawnProcess = spec.spawn ?? spawnGroup;
  const shells = spec.shells ?? ((pid: number | null) => (pid === null ? Promise.resolve(new Map<string, number>()) : shellGroups(pid)));
  const leaders = spec.leaders ?? ((pid: number | null) => (pid === null ? Promise.resolve([]) : shellLeaders(pid)));
  const foreground = spec.gone !== undefined;
  const userName = spec.userName ?? "The user";
  const label = driverKey(spec.actor);
  const idleMs = spec.idleMs ?? IDLE_MS;
  let memo = freshMemo();
  let live: Live | null = null;
  let generation = 0;
  let closed = false;
  let signals = noSignals();
  // When the live query last said anything or was sent a turn, and whether the turn in flight was told it is silent.
  let heardAt = 0;
  let stallNoted = false;
  /** The uuid the turn in flight was sent with; null until it is sent. Claude Code echoes it on the turn's replies. */
  let sentUuid: string | null = null;
  /**
   * The turn in flight, not yet sent, because the query it needs cannot open yet (see advance). At `until` its wait for
   * the live query runs out: the first time, the query's background tasks are stopped and it gets WAKE_WAIT_MS more
   * to report them (`stopping`); the second time, the query is closed whatever still runs.
   */
  let held: { p: Pending; text: string; until: number; stopping: boolean } | null = null;
  /**
   * The last closed query, until its process has exited. No query opens while it runs: two processes on one session
   * write its transcript at once, and the new one misses the cost total the old one saves as it exits, so the ledger
   * cannot charge the new query's turns.
   */
  let closing: Live | null = null;
  /** The look at what a gone query's background work became, due once Claude Code has had time to stop its commands. */
  let exitCheck: { timer: ReturnType<typeof setTimeout>; run: () => void } | null = null;
  /** Reports of a gone query's background work still looking at the process table. */
  let reporting = 0;

  /** Claude Code said the id the options name for a new session is taken: from now on that id is resumed. */
  let takenId: string | null = null;

  /** What the turn in flight carries, recorded as sent once the model answers it, so a turn that never ran sends it again. */
  let carried: SessionState["sent"] | null = null;

  /** The turn's text with the brief and the context on top when they changed since session `id` last got them. */
  function withContext(text: string, fresh: boolean): string {
    const was = fresh ? {} : (spec.state.sent ?? {});
    let context: string | null = null;
    let brief: string | null = null;
    guard("context", () => void (context = spec.context?.() ?? ""));
    guard("brief", () => void (brief = spec.brief?.() ?? ""));
    const sent = { ...was };
    const top: string[] = [];
    if (brief !== null && digest(brief) !== was.brief) {
      if (!fresh && brief !== "") top.push(brief);
      sent.brief = digest(brief);
    }
    if (context !== null && digest(context) !== (was.context ?? digest(""))) {
      top.push(context === "" ? noticeText.contextCleared : context);
      sent.context = digest(context);
    }
    carried = JSON.stringify(sent) !== JSON.stringify(spec.state.sent ?? {}) ? sent : null;
    return [...top, text].join("\n\n");
  }

  /** Claude Code expands a command only from the last text block, and only when it starts with "/". */
  function contentOf(p: Pending, text: string, fresh: boolean): SDKUserMessage["message"]["content"] {
    if (p.kind !== "command") return withContext(text, fresh);
    const top = withContext(text.slice(0, text.length - p.text.length).trim(), fresh).trim();
    return top === "" ? p.text : [{ type: "text", text: top }, { type: "text", text: p.text }];
  }

  function accepted() {
    if (carried === null) return;
    own<SessionState>(spec.state).sent = carried;
    carried = null;
    guard("persist", () => spec.persist());
  }

  const guard = (what: string, f: () => void) => {
    try {
      f();
    } catch (e) {
      log(`session ${label}: ${what} threw: ${errorText(e)}`);
    }
  };

  function headroom(initiator: Initiator, now: Date): Headroom {
    try {
      return spec.ledger.headroom(spec.actor, initiator);
    } catch (e) {
      log(`session ${label}: headroom threw: ${errorText(e)}`);
      // Someone at the phone is never blocked by a broken ledger; unattended work waits rather than spend past a cap unseen.
      if (attended(initiator)) return { ok: true, capReached: false };
      return { ok: false, reason: "daily_cap", until: new Date(now.getTime() + HEADROOM_RETRY_MS).toISOString() };
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
    const t = step(before, ev, { now, headroom: (i) => headroom(i, now), userName, quiet: spec.notices === false });
    const state = own<SessionState>(spec.state);
    const changed =
      JSON.stringify([before.session, before.parkedUntil]) !== JSON.stringify([t.core.session, t.core.parkedUntil]);
    state.id = t.core.session.id;
    state.pending = t.core.session.pending;
    state.lifecycle = t.core.session.lifecycle;
    state.notices = t.core.session.notices;
    own<AccountState>(spec.account).parkedUntil = t.core.parkedUntil;
    memo = t.core.memo;
    if (changed) guard("persist", () => spec.persist("now"));
    return t.effects;
  }

  function dispatch(ev: Event, now = clock(), was = status()) {
    if (closed) return;
    tellRecovered();
    for (const e of transition(ev, now)) perform(e);
    if (!closed && status() !== was) guard("onChange", () => spec.onChange());
  }

  function perform(e: Effect) {
    switch (e.kind) {
      case "send":
        return send(e.pending, e.text);
      case "end":
        return guard("onTurnEnd", () => spec.onTurnEnd(e.pending, e.end));
      case "interrupt":
        // Nothing reached Claude, so there is nothing to interrupt: the turn ends here, as stopped.
        if (held) {
          held = null;
          return dispatch({ kind: "end", outcome: { kind: "transient", error: "Stopped before it was sent." } });
        }
        return guard("interrupt", () => void live?.q.interrupt().catch((err) => log(`session ${label}: interrupt failed: ${errorText(err)}`)));
      case "kill":
        return closeLive();
      case "note":
        return guard("note", () => spec.note(e.text, e.reason));
    }
  }

  /**
   * maxBudgetUsd is fixed when a query opens and counts the spend since then, and the SDK stops a turn at it. So an
   * unattended turn gets a query of its own, capped at what is left of the daily cap as it starts, and an attended turn
   * never runs on such a query: the cap does not hold it. A runaway unattended turn stops at the cap, not at its end.
   * Closing a query cuts off its background work and any turn Claude Code runs on its own, so a turn that needs a new
   * query while the live one is busy is held until it is not, or for BACKGROUND_WAIT_MS. An attended turn runs on a
   * stale busy query rather than wait: the new options can wait, the user should not.
   */
  function send(p: Pending, text: string) {
    sentUuid = null;
    held = { p, text, until: clock().getTime() + BACKGROUND_WAIT_MS, stopping: false };
    advance(false);
  }

  /**
   * Sends the held turn once nothing it waits on remains: the live query's work when the turn needs a new query (unless
   * `force`), and the last closed query's process. Called again by whatever ends one of those.
   */
  function advance(force: boolean) {
    const h = held;
    if (!h || closed) return;
    const unattended = !attended(h.p.initiator);
    if (live) {
      const replace = unattended || live.capped;
      if (replace && busy(live) && !force) return;
      if (replace || (live.stale && !busy(live))) closeLive();
    }
    if (!live && closing) return;
    held = null;
    deliver(h.p, h.text, unattended);
  }

  /** The held turn waited BACKGROUND_WAIT_MS: stop the work and give the query time to report it, then close it. */
  function expire(h: NonNullable<typeof held>) {
    const l = live;
    if (h.stopping || !l || !busy(l)) return advance(true);
    h.stopping = true;
    h.until = clock().getTime() + WAKE_WAIT_MS;
    const tasks = [...l.background];
    if (tasks.length === 0) return;
    void Promise.all(tasks.map((t) => stopTask(l, t.id as TaskId))).then((took) => {
      const stopped = tasks.filter((_, i) => took[i]);
      for (const t of stopped) l.stopped.add(t.id);
      if (stopped.length > 0) guard("note", () => spec.note(goneNote(spec.name?.() ?? "Claude Code", "exit", "stopped", stopped)));
    });
  }

  /** Marked before asking, since Claude Code can report the stop before the call returns. */
  async function stopTask(l: Live, id: TaskId): Promise<boolean> {
    l.tasks.stopped.add(id);
    try {
      await l.q.stopTask(id);
      return true;
    } catch (err) {
      l.tasks.stopped.delete(id);
      log(`session ${label}: stopTask failed: ${errorText(err)}`);
      return false;
    }
  }

  function activity(): Activity {
    const l = live;
    const own = turnOf(spec.state.lifecycle as Lifecycle);
    const cli = l?.cli ?? IDLE;
    const at = cliTurnAt(cli);
    const turn = own ? { startedAt: own.startedAt, wake: false } : at !== null ? { startedAt: new Date(at).toISOString(), wake: true } : null;
    if (!l) return { turn, tasks: [], all: new Map(), calls: [], heardAt: null };
    return { turn, tasks: liveTasks(l.tasks), all: l.tasks.all, calls: [...l.tasks.calls.values()], heardAt: l.heardAt === null ? null : new Date(l.heardAt).toISOString() };
  }

  const activityKey = () => {
    const cli = live?.cli ?? IDLE;
    const t = live?.tasks;
    const busy = t !== undefined && (t.calls.size > 0 || [...t.all.values()].some((x) => !x.ended));
    return `${busy ? t.rev : "rest"} ${cliTurnAt(cli) ?? ""} ${turnOf(spec.state.lifecycle as Lifecycle)?.startedAt ?? ""}`;
  };

  const told = () => guard("onActivity", () => spec.onActivity?.());

  function deliver(p: Pending, text: string, unattended: boolean) {
    let wait: string | null = null;
    guard("blocked", () => void (wait = spec.blocked?.() ?? null));
    if (wait !== null) return dispatch({ kind: "unstarted", error: wait });
    let l: Live;
    try {
      l = live ?? open(unattended);
    } catch (e) {
      return dispatch({ kind: "unstarted", error: maskSecrets(errorText(e)) });
    }
    signals = noSignals();
    heardAt = clock().getTime();
    stallNoted = false;
    if (p.kind === "continuation") guard("continuing", () => spec.continuing?.());
    const uuid = crypto.randomUUID();
    sentUuid = uuid;
    l.send({ type: "user", message: { role: "user", content: contentOf(p, text, l.fresh) }, parent_tool_use_id: null, uuid });
  }

  /**
   * The end of a held turn's wait; the stall note while a turn runs; closing the query while nothing runs on it; giving
   * up on a wake turn that was announced and never started.
   */
  function watchDeadline(): number | null {
    if (!live) return null;
    const wake = live.cli.kind === "due" ? live.cli.until : null;
    const kind = spec.state.lifecycle.kind;
    const own =
      kind === "stopping" ? null : held ? held.until : kind === "working" ? (stallNoted ? null : heardAt + STALL_MS) : busy(live) ? null : heardAt + idleMs;
    return wake === null ? own : own === null ? wake : Math.min(wake, own);
  }

  function watch(now: Date) {
    if (closed) return;
    const l = live;
    if (l && l.cli.kind === "due" && now.getTime() >= l.cli.until) {
      l.cli = IDLE;
      told();
      settle(l);
    }
    if (l && l.wakeStop !== null && l.cli.kind !== "running" && now.getTime() >= l.wakeStop) wakeEnded(l, "stopped");
    const due = watchDeadline();
    if (due !== null && now.getTime() >= due) {
      if (held) expire(held);
      else if (spec.state.lifecycle.kind !== "working") closeLive();
      else {
        stallNoted = true;
        guard("note", () => spec.note(stallNote(spec.name?.() ?? "Claude Code")));
      }
    }
    if (!live && !closing && spec.state.lifecycle.kind === "idle" && spec.state.pending.length === 0) guard("onDormant", () => spec.onDormant?.());
  }

  function open(unattended: boolean): Live {
    const path = executable();
    if (!path) throw new Error("claude was not found on PATH, or CLAUDIOBOT_CLAUDE does not name an executable");
    const asked = spec.options();
    const { sessionId: _claim, title: _title, ...resumable } = asked;
    const options: Options = takenId !== null && asked.sessionId === takenId ? { ...resumable, resume: takenId } : asked;
    // Above 0 when the bot has a cap: the headroom check let this turn start, and it sees the same spend. Null: no cap.
    const cap = unattended && spec.actor.kind !== "own" ? spec.ledger.dailyLeft(spec.actor.botId) : null;
    const gen = ++generation;
    const inbox: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    let stderr = "";
    const tail = (d: string) => void (stderr = (stderr + d).slice(-2000));
    let spawned = false;
    let pid: number | null = null;
    let exited = false;
    const exit = () => {
      exited = true;
      if (closing?.gen !== gen) return;
      closing = null;
      advance(false);
    };
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
    const q = run({
      prompt: input(),
      options: {
        ...options,
        ...(cap !== null && { maxBudgetUsd: Math.min(cap, options.maxBudgetUsd ?? cap) }),
        pathToClaudeCodeExecutable: path,
        stderr: tail,
        spawnClaudeCodeProcess: (o) => {
          spawned = true;
          const child = spawnProcess(o, tail, exit);
          pid = child.pid ?? null;
          return child;
        },
      },
    });
    const l: Live = {
      gen,
      q,
      fresh: !options.resume,
      resumed: options.resume ?? null,
      claimed: options.resume ? null : (options.sessionId ?? null),
      answered: false,
      capped: cap !== null,
      stale: false,
      sandboxNoted: false,
      background: [],
      groups: new Map(),
      loose: new Map(),
      shells: new Map(),
      searches: new Map(),
      searching: false,
      pid: () => pid,
      wakeStop: null,
      ours: null,
      cli: IDLE,
      stopped: new Set(),
      tasks: emptyTasks(),
      heardAt: null,
      gone: () => exited || !spawned,
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
    const was = activityKey();
    live = null;
    if (activityKey() !== was) told();
    generation++;
    l.release();
    guard("close", () => l.q.close());
    if (!l.gone()) closing = l;
    if (l.wakeStop !== null) wakeEnded(l, "stopped");
    // close() leaves them on disk for the next start to check.
    const work = outliving(l, foreground);
    if (closed || work.length === 0) return;
    const ids = new Set(work.map((b) => b.id));
    const look = () => {
      exitCheck = null;
      const left = savedBackground(l).filter((b) => !l.stopped.has(b.id));
      // A query opened since has saved its own background work over these.
      if (live === null) remember((spec.state.background ?? []).filter((b) => !ids.has(b.id)));
      if (left.length > 0) void reportGone(left, "exit");
    };
    if (l.stopped.size >= ids.size) return look();
    exitCheck = { timer: setTimeout(look, EXIT_SETTLE_MS), run: look };
  }

  /** What of the live query can outlive it, as saved: what the thread shows of each, and what runs it once found. */
  function savedBackground(l: Live): Background[] {
    const pid = l.pid();
    return outliving(l, foreground).map((b) => {
      const t = l.tasks.all.get(b.id as TaskId);
      const group = l.groups.get(b.id);
      const loose = group === undefined ? l.loose.get(b.id) : undefined;
      const command = group === undefined && loose === undefined && t?.kind === "command" && t.stepId !== null ? l.tasks.raw.get(t.stepId) : undefined;
      const shells = command === undefined ? undefined : l.shells.get(b.id);
      return {
        ...b,
        ...(t && { kind: t.kind, label: t.label, startedAt: t.startedAt, ...(t.stepId !== null && { stepId: t.stepId }) }),
        ...(group !== undefined && { group }),
        ...(loose !== undefined && { loose }),
        ...(command !== undefined && { command }),
        ...(shells !== undefined && { shells }),
        ...(t?.kind === "agent" && pid !== null && { claude: pid }),
      };
    });
  }

  /** Says what became of a gone query's background work, from the process table: the owner does, or notes do. */
  async function reportGone(tasks: Background[], cause: GoneCause) {
    // A look that never answers (a wedged lsof) is given up on: the work may still run, and is looked at again later.
    // A process table that could not be read is read again until then, so a moment's failure still tells what runs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let looking = true;
    const cantTell = new Promise<Fate>((resolve) => {
      timer = setTimeout(() => {
        looking = false;
        resolve({ stopped: [], running: [], unknown: [...tasks] });
      }, GONE_LOOK_MAX_MS);
    });
    reporting++;
    try {
      const fate = await Promise.race([fateOf(tasks, spec.taskRun ?? taskRun, () => looking), cantTell]);
      if (spec.gone) return guard("gone", () => spec.gone!(fate, cause));
      for (const kind of ["stopped", "running", "unknown"] as const)
        if (fate[kind].length > 0) guard("note", () => spec.note(goneNote(spec.name?.() ?? "Claude Code", cause, kind, fate[kind]), cause === "restart" ? "restart" : undefined));
    } finally {
      clearTimeout(timer);
      reporting--;
      guard("onChange", () => spec.onChange());
    }
  }

  /** Saves what of the live query can outlive it, and looks up the shell of each command not yet found, a few times each. */
  function saveBackground(l: Live) {
    remember(savedBackground(l));
    const missing = () =>
      outliving(l, foreground).filter((b) => !l.groups.has(b.id) && l.tasks.all.get(b.id as TaskId)?.kind !== "agent" && (l.searches.get(b.id) ?? 0) < SHELL_SEARCHES);
    const now = missing();
    if (l.searching || now.length === 0) return;
    l.searching = true;
    for (const b of now) l.searches.set(b.id, (l.searches.get(b.id) ?? 0) + 1);
    const pid = l.pid();
    Promise.all([shells(pid), leaders(pid)]).then(
      ([found, shellsOf]) => {
        l.searching = false;
        const work = outliving(l, foreground);
        for (const [id, group] of found) if (work.some((b) => b.id === id)) l.groups.set(id, group);
        pairLoose(l, shellsOf);
        if (live !== l) return;
        remember(savedBackground(l));
        if (missing().length > 0) setTimeout(() => live === l && saveBackground(l), SHELL_SEARCH_AGAIN_MS);
      },
      (e) => {
        l.searching = false;
        log(`session ${label}: finding background shells failed: ${errorText(e)}`);
      },
    );
  }

  /**
   * A command whose shell sent its output elsewhere before the bridge looked has no output file to find it by. When
   * exactly one of Claude Code's shells runs exactly the command Claude Code was given, as ps writes it, and no other
   * task has it, that shell is taken as the command's, loosely: to see it end, never to signal it. Two shells alike, two
   * tasks given the same command (the second's shell may not have started yet), or no shell exact, stay unpaired.
   */
  function pairLoose(l: Live, shellsOf: readonly { group: number; command: string; started?: number }[]) {
    const taken = new Set([...l.groups.values(), ...l.loose.values()]);
    const runs = shellsOf.map((s) => ({ group: s.group, command: evalArg(s.command) }));
    const work = outliving(l, foreground).map((b) => {
      const t = l.tasks.all.get(b.id as TaskId);
      return { b, given: t?.kind === "command" && t.stepId !== null ? l.tasks.raw.get(t.stepId) : undefined };
    });
    for (const { b, given } of work) {
      if (l.groups.has(b.id) || l.loose.has(b.id) || given === undefined) continue;
      if (work.filter((w) => w.given === given).length > 1) continue;
      const hits = runs.filter((r) => r.command === psText(given));
      if (hits.length !== 1 || taken.has(hits[0]!.group)) continue;
      l.loose.set(b.id, hits[0]!.group);
      taken.add(hits[0]!.group);
    }
    // A command left unpaired is watched through Claude Code's own shells that run exactly its text, recorded only
    // while there is one such shell for each live task given that text, so each task's own shell is among them. A task
    // takes only shells that started by its call plus SHELL_START_SLACK_MS: a later run of the same text is not its own.
    const unpaired = work.filter((w) => w.given !== undefined && !l.groups.has(w.b.id) && !l.loose.has(w.b.id));
    for (const given of new Set(unpaired.map((w) => w.given!))) {
      const hits = shellsOf.filter((s) => evalArg(s.command) === psText(given));
      if (hits.length !== work.filter((w) => w.given === given).length) continue;
      for (const { b } of unpaired.filter((w) => w.given === given)) {
        const call = Date.parse(l.tasks.all.get(b.id as TaskId)?.startedAt ?? "");
        const own = hits.filter((h) => h.started === undefined || h.started <= call + SHELL_START_SLACK_MS).map((h) => h.group);
        if (own.length > 0) l.shells.set(b.id, [...new Set([...(l.shells.get(b.id) ?? []), ...own])]);
      }
    }
  }

  /** The turn Claude Code began on its own that a Stop reached has ended. */
  function wakeEnded(l: Live, how: "stopped" | "finished") {
    l.wakeStop = null;
    guard("onWakeEnd", () => spec.onWakeEnd?.(how));
  }

  function remember(tasks: Background[]) {
    const state = own<SessionState>(spec.state);
    if (JSON.stringify(state.background ?? []) === JSON.stringify(tasks)) return;
    if (tasks.length > 0) state.background = tasks;
    else delete state.background;
    guard("persist", () => spec.persist());
  }

  function track(l: Live, tasks: SDKBackgroundTasksChangedMessage["tasks"]) {
    l.background = tasks
      .filter((t) => t.ambient !== true)
      .map((t) => ({ id: t.task_id, ...(t.description && { description: displayName(maskSecrets(t.description), DESCRIPTION_MAX) }) }));
    saveBackground(l);
    settle(l);
  }

  /** What waited on the live query's work goes ahead once it is done: a held turn, or a stale query's close. */
  function settle(l: Live) {
    if (live !== l) return;
    if (held) advance(false);
    else if (l.stale && !busy(l) && turnOf(spec.state.lifecycle as Lifecycle) === null) closeLive();
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
    if (held) return advance(false);
    const tail = l.stderr();
    const text = tail ? `${error}\n${tail}` : error;
    if (!current()) return;
    if (forgot(text, l) || taken(text, l)) return;
    if (!startedSandbox(text)) dispatch({ kind: "end", outcome: { kind: "transient", error: maskSecrets(text) } });
  }

  /**
   * A query that ended because its sandbox could not start is a configuration failure: no command ran, so the envelope
   * goes back to the head and waits the long start backoff. The bridge never retries without the sandbox.
   */
  function startedSandbox(text: string): boolean {
    const reason = sandboxFailure(text);
    if (reason === null || turnOf(spec.state.lifecycle as Lifecycle)?.output !== false) return false;
    closeLive();
    dispatch({ kind: "unstarted", error: `the sandbox could not start (${reason})` });
    return true;
  }

  /** A fresh query's id was taken before any output: the turn goes again on a query that resumes it. */
  function taken(text: string, l: Live): boolean {
    if (l.claimed === null || l.answered || !inUse(text, l.claimed) || turnOf(spec.state.lifecycle as Lifecycle)?.output !== false) return false;
    takenId = l.claimed;
    closeLive();
    dispatch({ kind: "claimed" });
    return true;
  }

  /**
   * A resumed query found its session gone before any output: the session id is cleared and the turn starts over, or,
   * for a session that must not be replaced, the turn fails.
   */
  function forgot(text: string, l: Live): boolean {
    if (l.resumed === null || l.answered || !forgotten(text, l.resumed) || turnOf(spec.state.lifecycle as Lifecycle)?.output !== false) return false;
    closeLive();
    if (spec.forgotten === "fail") {
      dispatch({ kind: "end", outcome: { kind: "terminal", error: GONE_ERROR } });
      return true;
    }
    dispatch({ kind: "forgotten" });
    guard("note", () => spec.note(forgottenNote(spec.name?.() ?? "Claude Code")));
    return true;
  }

  function receive(m: SDKMessage, l: Live) {
    heardAt = clock().getTime();
    if (m.session_id && m.session_id !== spec.state.id) {
      own<SessionState>(spec.state).id = m.session_id;
      guard("persist", () => spec.persist());
    }
    const turn = answers(m, l) ? current() : null;
    const wakeRan = l.cli.kind === "running";
    // Claude Code takes a stop it reads before the turn it aims at begins as a stop of nothing (it was paused, or slow
    // to read its input), then runs the turn. So the stop goes again as that turn begins.
    const stopMissed = l.ours === true ? spec.state.lifecycle.kind === "stopping" : l.wakeStop !== null;
    if (m.type === "system" && m.subtype === "init" && stopMissed)
      guard("interrupt", () => void l.q.interrupt().catch((err) => log(`session ${label}: interrupt failed: ${errorText(err)}`)));
    const was = activityKey();
    if (m.type === "system" && m.subtype === "init") l.cli = { kind: "running", wake: l.ours === true && wakeAhead(l.cli), at: heardAt };
    // Claude Code wakes for a background task that ended or that the bridge stopped, not for one it stopped itself.
    else if (m.type === "system" && m.subtype === "task_notification" && wakes(l.tasks, m.task_id as TaskId, m.status)) {
      l.cli = l.cli.kind === "running" ? { ...l.cli, wake: true } : { kind: "due", until: heardAt + WAKE_WAIT_MS };
    } else if (m.type === "result" && l.cli.kind === "running") l.cli = l.cli.wake ? { kind: "due", until: heardAt + WAKE_WAIT_MS } : IDLE;
    else if (l.cli.kind === "running" && l.cli.wake && m.type === "user" && m.parent_tool_use_id === null && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === "tool_result")) {
      // The next request carries the queued notification into this turn, so no wake turn follows for it.
      l.cli = { ...l.cli, wake: false };
    }
    l.heardAt = heardAt;
    for (const lost of observe(l.tasks, m, new Date(heardAt).toISOString())) guard("note", () => spec.note(lostNotice(lost), "task"));
    const changedTasks = activityKey() !== was;
    if (changedTasks) told();
    if (m.type === "assistant" && m.error) signals.apiError = m.error;
    else if (m.type === "assistant" && turn !== null && turnOf(spec.state.lifecycle as Lifecycle)?.output === false) {
      accepted();
      dispatch({ kind: "output" });
    }
    const down = sandboxDownIn(m);
    if (down !== null && !l.sandboxNoted) {
      // Every Bash call fails while the sandbox is down; a new query tries to start it again. Not a gate denial.
      l.sandboxNoted = true;
      l.stale = true;
      guard("note", () => spec.note(`${spec.name?.() ?? "Claude Code"} cannot run commands: the sandbox could not start (${down}).`));
    }
    if (m.type === "rate_limit_event") rateLimited(m.rate_limit_info);
    if (m.type === "system" && m.subtype === "compact_boundary" && m.compact_metadata.trigger === "auto")
      guard("note", () => spec.note(compactedNote(spec.name?.() ?? "Claude Code")));
    if (m.type === "system" && m.subtype === "background_tasks_changed") track(l, m.tasks);
    else if (changedTasks || (m.type === "system" && m.subtype === "task_started")) saveBackground(l);
    guard("onMessage", () => spec.onMessage(m, turn));
    if (m.type !== "result") return;
    const fresh = l.fresh;
    l.fresh = false;
    guard("ledger.add", () =>
      spec.ledger.add({ actor: spec.actor, sessionId: m.session_id, initiator: turn?.initiator ?? SYSTEM, cumulativeUsd: m.total_cost_usd, fresh }),
    );
    const outcome = classify(m, signals, clock());
    signals = noSignals();
    if (!turn) {
      if (outcome.kind === "usage_limit" && outcome.scope === "account") dispatch({ kind: "limit", until: outcome.until });
      if (wakeRan && l.wakeStop !== null) wakeEnded(l, m.subtype === "success" && !m.is_error ? "finished" : "stopped");
      return settle(l);
    }
    const failed = m.subtype !== "success" || m.is_error;
    const said = m.subtype === "success" ? m.result : m.errors.join("\n");
    if (failed && (forgot(said, l) || taken(said, l))) return;
    l.answered = true;
    if (failed && startedSandbox(said)) return;
    if (!failed) accepted();
    dispatch({ kind: "end", outcome });
    settle(l);
  }

  /**
   * Whether an assistant message or a result belongs to the turn in flight, not to a turn a background task woke.
   * Claude Code echoes the uuids of the user messages a turn consumed on the turn's init frame, its first assistant
   * message and its result; a woken turn echoes none. With no echo at all (older CLIs), only a result that names a
   * task notification as its origin is another turn's.
   */
  function answers(m: SDKMessage, l: Live): boolean {
    const echo = "user_message_uuids" in m && m.user_message_uuids ? m.user_message_uuids : "user_message_uuid" in m && m.user_message_uuid ? [m.user_message_uuid] : undefined;
    if (m.type === "system" && m.subtype === "init") l.ours = echo !== undefined ? sentUuid !== null && echo.includes(sentUuid) : l.ours === null ? null : false;
    if (m.type !== "assistant" && m.type !== "result") return true;
    if (sentUuid === null) return false;
    if (echo !== undefined) return echo.includes(sentUuid);
    if (l.ours !== null) return l.ours;
    return m.type !== "result" || m.origin?.kind !== "task-notification";
  }

  function rateLimited(info: SDKRateLimitInfo) {
    const type = info.rateLimitType ?? null;
    // Extra usage that covers the request lets the turn go on, so the rejection is no usage limit.
    const covered = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" || info.isUsingOverage === true || info.overageInUse === true;
    if (info.status === "rejected" && !covered) {
      signals = { ...signals, rejected: true, resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null, limitType: type };
    } else if (info.status !== "rejected" && signals.rejected && type === signals.limitType) {
      signals = { ...signals, rejected: false, resetsAt: null, limitType: null };
    }
    const warning = info.status === "allowed_warning" ? limitWarning(info) : null;
    if (warning !== null) guard("note", () => spec.note(warning));
  }

  const bootStatus = status();
  let recovered: Effect[] | null = transition({ kind: "recover" }, clock());
  let lost: Background[] = [...(spec.state.background ?? [])];
  if (lost.length > 0) remember([]);
  function tellRecovered() {
    const fx = recovered;
    recovered = null;
    for (const e of fx ?? []) perform(e);
    const left = lost;
    if (left.length > 0) void reportGone(left, "restart");
    lost = [];
  }
  // The caller registers the session before any callback fires, so the recovered TurnEnds wait for the first dispatch,
  // close(), or this microtask, whichever comes first.
  queueMicrotask(() => dispatch({ kind: "pump" }, clock(), bootStatus));

  return {
    push(input) {
      if (closed) return;
      const pending: Pending = { id: `e_${crypto.randomUUID()}` as EnvelopeId, at: clock().toISOString(), ...input, attempts: 0 };
      dispatch({ kind: "push", pending });
    },
    notice(text) {
      dispatch({ kind: "notice", notice: { at: clock().toISOString(), text } });
    },
    denied() {
      dispatch({ kind: "denied" });
    },
    async interrupt(target = "all") {
      const none: StopReport = { ran: false, refused: [], late: [], woken: false };
      if (closed) return none;
      const l = live;
      const stopOne = async (id: TaskId) => ({ id, took: await within<boolean | null>(stopTask(l!, id), STOP_TASK_WAIT_MS, null) });
      const report = async (ran: boolean, stops: ReturnType<typeof stopOne>[], woken = false): Promise<StopReport> => {
        const done = await Promise.all(stops);
        return { ran, refused: done.filter((s) => s.took === false).map((s) => s.id), late: done.filter((s) => s.took === null).map((s) => s.id), woken };
      };
      if (typeof target === "object") {
        if (l === null || !liveTasks(l.tasks).some((t) => t.id === target.task)) return none;
        return report(true, [stopOne(target.task)]);
      }
      const stops = (l && target === "all" ? l.background : []).map((t) => stopOne(t.id as TaskId));
      // A wake turn, running or announced, has no lifecycle turn to stop; only the query can interrupt it.
      const woken = l !== null && l.cli.kind !== "idle" && turnOf(spec.state.lifecycle as Lifecycle) === null;
      if (woken) {
        l.wakeStop = clock().getTime() + WAKE_WAIT_MS;
        if (l.cli.kind === "due") {
          l.cli = IDLE;
          told();
        }
        guard("interrupt", () => void l.q.interrupt().catch((err) => log(`session ${label}: interrupt failed: ${errorText(err)}`)));
      }
      const kind = spec.state.lifecycle.kind;
      const running = kind === "working" || kind === "stopping" || kind === "backoff";
      const waits = running || spec.state.pending.length > 0;
      if (waits) dispatch({ kind: "stop" });
      return report(waits || woken || stops.length > 0, stops, woken);
    },
    unqueue(clientId) {
      const inFlight = turnOf(spec.state.lifecycle as Lifecycle)?.pending;
      if (closed || !spec.state.pending.some((p) => p.clientId === clientId && p.id !== inFlight)) return false;
      dispatch({ kind: "unqueue", clientId });
      return true;
    },
    recheck() {
      dispatch({ kind: "tick" });
    },
    retry() {
      dispatch({ kind: "retry" });
    },
    mcp: () => live?.q ?? null,
    controls: () => live?.q ?? null,
    reopen() {
      if (!live) return;
      live.stale = true;
      settle(live);
    },
    tick(now) {
      dispatch({ kind: "tick" }, now);
      watch(now);
    },
    nextDeadline() {
      const life = spec.state.lifecycle;
      const lifecycleAt =
        life.kind === "stopping" ? life.deadline : life.kind === "backoff" || life.kind === "parked" ? life.until : waiting() ? spec.account.parkedUntil : null;
      const stopAt = live && live.wakeStop !== null && live.cli.kind !== "running" ? live.wakeStop : null;
      const watched = [watchDeadline(), stopAt].reduce<number | null>((min, d) => (d !== null && (min === null || d < min) ? d : min), null);
      const watchAt = watched === null ? null : new Date(watched).toISOString();
      return lifecycleAt === null || (watchAt !== null && watchAt < lifecycleAt) ? watchAt : lifecycleAt;
    },
    close() {
      if (closed) return;
      tellRecovered();
      closed = true;
      closeLive();
      if (exitCheck) {
        clearTimeout(exitCheck.timer);
        exitCheck.run();
      }
    },
    get working() {
      return isWorking();
    },
    activity,
    get wakeDue() {
      return live?.cli.kind === "due";
    },
    get settling() {
      return exitCheck !== null || reporting > 0 || lost.length > 0;
    },
    get parkedFor() {
      return parkedFor();
    },
    get unavailable() {
      return memo.startFailures > 0 && spec.state.lifecycle.kind === "backoff";
    },
    get current() {
      return current();
    },
    get lifecycle(): Owned<Lifecycle> {
      return spec.state.lifecycle;
    },
  };
}
