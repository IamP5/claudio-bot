import {
  query,
  type Options,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "./clock";
import type { Headroom, Ledger } from "./ledger";
import { notices as noticeText, withNotices, type SessionInput } from "./prompts";
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

/** null unless the configured path, or claude on PATH, is an executable file: the SDK only finds out after spawning. */
export function claudeExecutable(): string | null {
  return Bun.which(process.env.CLAUDIOBOT_CLAUDE ?? "claude");
}

export const STOP_DEADLINE_MS = 15_000;
export const RETRY_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
/** The first start plus one retry per backoff step. A replay after a restart is a start too. */
export const MAX_STARTS = RETRY_BACKOFF_MS.length + 1;
/**
 * Waits after a query could not be opened at all: no executable, or options() or the gate's hooks threw. Nothing
 * reached Claude, so no attempt is used and nothing else queued is touched. The last wait repeats until a query opens.
 */
export const START_RETRY_MS = [30_000, 60_000, 120_000, 300_000] as const;
export const DENIALS_PER_TURN = 3;
/** A turn with no SDK message for this long is noted in the owning bot's chat, once per turn. It keeps running. */
export const STALL_MS = 30 * 60_000;
/**
 * A query with no turn in flight and no message for this long is closed, so its claude process exits; the next turn
 * resumes the session on a new one. It counts from the last message, so output after a turn keeps the process. It is
 * well inside the prompt cache's hour, so a resume reads the cache like the closed query would have.
 */
export const IDLE_MS = 15 * 60_000;
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
const stallNote = (name: string) => `${name} has been silent for 30 minutes; you can press Stop.`;
export const startFailedNote = (error: string) =>
  `Claude Code could not start: ${error.replace(/\.?\s*$/, ".")} Queued messages are kept, and it keeps trying.`;
const restartedNotice = (envelopeText: string) =>
  `[The bridge restarted during your turn on: ${envelopeText.split("\n")[0]} It may be partly done; check before redoing it.]`;

/** Pending has no field for an approval continuation, so its id carries it. Only push() mints ids. */
const CONTINUATION = "c_";

/**
 * Stop drops a routine's scheduled fire and a message from another bot: nobody waits on either. An agent's report and an
 * approval continuation stay, whatever their initiator, because the bot needs the report and the user just answered.
 */
const droppedByStop = (p: Pending): boolean =>
  (p.settles !== null && !attended(p.initiator)) || (p.initiator.kind === "bot" && !p.id.startsWith(CONTINUATION));

const DROPS_NAMED = 3;
/** One notice per Stop, however much it dropped, so the notices on the next envelope stay short. */
function droppedNotice(userName: string, texts: readonly string[]): string {
  if (texts.length === 1) return noticeText.droppedByStop(userName, texts[0]!);
  const named = texts.slice(0, DROPS_NAMED).map((t) => t.split("\n")[0]).join("; ");
  const rest = texts.length - DROPS_NAMED;
  return `[${userName} pressed Stop, so ${texts.length} queued messages never ran: ${named}${rest > 0 ? `; and ${rest} more` : ""}]`;
}

const SECRETS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9_+-]{40,}/g,
];
const SECRET_FIELD = /\b((?:api[_-]?key|token|secret|password|passwd|auth)[A-Za-z_-]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi;

/** Claude Code's stderr can echo keys from the environment or a config file, and its tail goes to the bot's chat. */
export function redactSecrets(text: string): string {
  return SECRETS.reduce((out, re) => out.replace(re, "[redacted]"), text).replace(SECRET_FIELD, "$1[redacted]");
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
  | { kind: "stopped"; by: "user" | "breaker" }
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
  | { kind: "push"; pending: Pending; ahead: boolean }
  | { kind: "notice"; notice: Notice }
  /** Start the next admissible envelope, if any. Every transition that frees the session also pumps. */
  | { kind: "pump" }
  /** The first assistant message of the turn in flight. */
  | { kind: "output" }
  | { kind: "denied" }
  | { kind: "end"; outcome: Outcome }
  /** The query for the turn just started could not be opened, so nothing reached Claude. */
  | { kind: "unstarted"; error: string }
  | { kind: "stop" }
  /** Deadlines are due, or a hold may have lifted: a daily-cap park re-checks headroom on every tick. */
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
export type StepContext = { now: Date; headroom: (initiator: Initiator) => Headroom; userName: string };

const turnOf = (life: Lifecycle): ActiveTurn | null => (life.kind === "working" || life.kind === "stopping" ? life.turn : null);

/**
 * The lifecycle, total over (Lifecycle x Event) and pure. Invariants it keeps:
 * - The envelope in flight is pending[0]; an `ahead` push goes right behind it.
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
      if (c.parkedUntil !== null && !due(c.parkedUntil)) return hold("usage_limit", c.parkedUntil);
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
        end(next, { kind: "failed", error: BUDGET_USED });
        continue;
      }
      if (capped) return;
      hold("daily_cap", room.until);
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
    case "tick": {
      if (c.parkedUntil !== null && due(c.parkedUntil)) c.parkedUntil = null;
      const life = s.lifecycle;
      if (life.kind === "stopping" && due(life.deadline)) {
        fx.push({ kind: "kill" });
        finish(life.turn, { kind: "stopped", by: stoppedBy(life.turn) });
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
export type Signals = {
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

export type Session = Tickable & {
  /** Queues one envelope; persisted before the SDK sees it. ahead puts it before everything queued (an approval continuation). */
  push(input: SessionInput): void;
  /** Adds a line to the top of the next envelope this actor runs. Spends no turn. */
  notice(text: string): void;
  /** The gate held or denied a call in the current turn. The third in one turn moves to stopping and leaves a note. */
  denied(): void;
  /**
   * Stop: working → stopping, where the gate denies every call; the next result, or the 15 s deadline, ends the turn
   * as stopped. A head waiting in backoff ends as stopped at once. Queued routine fires and bot messages are dropped,
   * with one notice; everything else queued still runs after the stopped turn ends, or when the park lifts. Resolves
   * false only when nothing runs and nothing waits.
   */
  interrupt(): Promise<boolean>;
  /** The ledger's answer may have changed (update_bot set dailyCapUsd): a daily-cap park asks headroom again now. */
  recheck(): void;
  /** Recovered TurnEnds not yet told are told before it closes. */
  close(): void;
  /** A turn is running or retrying, or envelopes wait and nothing holds them. */
  readonly working: boolean;
  /** Why queued work is held while nothing runs; null when something runs or nothing waits. */
  readonly parkedFor: ParkReason | null;
  /** Claude Code could not be started on the last try and the session waits to try again. working stays true meanwhile. */
  readonly unavailable: boolean;
  /** The envelope in flight. The gate reads its initiator. */
  readonly current: Pending | null;
  readonly lifecycle: Owned<Lifecycle>;
};

export type SessionSpec = {
  actor: Actor;
  /** The record's slice. This module is its only writer. */
  state: Owned<SessionState>;
  /** Shared by every session: a usage-limit rejection of the whole account parks them all. */
  account: Owned<AccountState>;
  /** Read at every query start: resume from state.id, and hooks: gate.hooks(actor). */
  options: () => Options;
  /** headroom() before each start, dailyLeft() as a query opens for an unattended turn, add() at each result. */
  ledger: Ledger;
  /** Every SDK message of the live query, with the turn in flight; late output between turns comes with null. */
  onMessage: (m: SDKMessage, turn: Pending | null) => void;
  onTurnEnd: (turn: Pending, end: TurnEnd) => void;
  /** Something the actor's status derives from changed (working, lifecycle, park). */
  onChange: () => void;
  /** A line for the owning bot's chat: the daily cap is reached, a turn was stopped after 3 held calls, or Claude Code could not start. */
  note: (text: string) => void;
  persist: Persist;
  /** Named in the notice an envelope dropped by Stop leaves. */
  userName?: string;
  /** Who the stall note names, read when it is left so a rename shows. Default "Claude Code". */
  name?: () => string;
  /**
   * Nothing runs, nothing is queued and no query is open. Asked at every tick while so. An owner of many sessions may
   * close and forget this one: a new session over the same state resumes it.
   */
  onDormant?: () => void;
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
  /** Opened for an unattended turn, with maxBudgetUsd at most what was left of the daily cap. */
  capped: boolean;
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
  // When the live query last said anything or was sent a turn, and whether the turn in flight was told it is silent.
  let heardAt = 0;
  let stallNoted = false;

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
    const t = step(before, ev, { now, headroom: (i) => headroom(i, now), userName });
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
        return guard("interrupt", () => void live?.q.interrupt().catch((err) => log(`session ${label}: interrupt failed: ${errorText(err)}`)));
      case "kill":
        return closeLive();
      case "note":
        return guard("note", () => spec.note(e.text));
    }
  }

  /**
   * maxBudgetUsd is fixed when a query opens and counts the spend since then, and the SDK stops a turn at it. So an
   * unattended turn gets a query of its own, capped at what is left of the daily cap as it starts, and an attended turn
   * never runs on such a query: the cap does not hold it. A runaway unattended turn stops at the cap, not at its end.
   */
  function send(p: Pending, text: string) {
    const unattended = !attended(p.initiator);
    if (live && (unattended || live.capped)) closeLive();
    let l: Live;
    try {
      l = live ?? open(unattended);
    } catch (e) {
      return dispatch({ kind: "unstarted", error: redactSecrets(errorText(e)) });
    }
    signals = noSignals();
    heardAt = clock().getTime();
    stallNoted = false;
    l.send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  /** The stall note while a turn runs; closing the query while none does. */
  function watchDeadline(): number | null {
    const kind = spec.state.lifecycle.kind;
    if (!live || kind === "stopping") return null;
    if (kind === "working") return stallNoted ? null : heardAt + STALL_MS;
    return heardAt + IDLE_MS;
  }

  function watch(now: Date) {
    if (closed) return;
    const due = watchDeadline();
    if (due !== null && now.getTime() >= due) {
      if (spec.state.lifecycle.kind !== "working") closeLive();
      else {
        stallNoted = true;
        guard("note", () => spec.note(stallNote(spec.name?.() ?? "Claude Code")));
      }
    }
    if (!live && spec.state.lifecycle.kind === "idle" && spec.state.pending.length === 0) guard("onDormant", () => spec.onDormant?.());
  }

  function open(unattended: boolean): Live {
    const path = executable();
    if (!path) throw new Error("claude was not found on PATH, or CLAUDIOBOT_CLAUDE does not name an executable");
    const options = spec.options();
    // Above 0: the headroom check let this turn start, and it sees the same spend.
    const cap = unattended ? spec.ledger.dailyLeft(spec.actor.botId) : null;
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
    const q = run({
      prompt: input(),
      options: {
        ...options,
        ...(cap !== null && { maxBudgetUsd: Math.min(cap, options.maxBudgetUsd ?? cap) }),
        pathToClaudeCodeExecutable: path,
        stderr: (d) => (stderr = (stderr + d).slice(-2000)),
      },
    });
    const l: Live = {
      gen,
      q,
      fresh: !options.resume,
      capped: cap !== null,
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
    const tail = l.stderr();
    if (current()) dispatch({ kind: "end", outcome: { kind: "transient", error: redactSecrets(tail ? `${error}\n${tail}` : error) } });
  }

  function receive(m: SDKMessage, l: Live) {
    heardAt = clock().getTime();
    if (m.session_id && m.session_id !== spec.state.id) {
      own(spec.state).id = m.session_id;
      guard("persist", () => spec.persist());
    }
    if (m.type === "assistant" && m.error) signals.apiError = m.error;
    else if (m.type === "assistant" && turnOf(spec.state.lifecycle as Lifecycle)?.output === false) dispatch({ kind: "output" });
    // A plan rejection that extra usage covers does not stop the turn, so it is no usage limit.
    if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected" && m.rate_limit_info.isUsingOverage !== true) {
      const info = m.rate_limit_info;
      signals.rejected = true;
      signals.resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : null;
      signals.limitType = info.rateLimitType ?? null;
    }
    guard("onMessage", () => spec.onMessage(m, current()));
    if (m.type !== "result") return;
    const turn = current();
    const fresh = l.fresh;
    l.fresh = false;
    guard("ledger.add", () =>
      spec.ledger.add({ actor: spec.actor, sessionId: m.session_id, initiator: turn?.initiator ?? SYSTEM, cumulativeUsd: m.total_cost_usd, fresh }),
    );
    const outcome = classify(m, signals, clock());
    signals = noSignals();
    if (turn) dispatch({ kind: "end", outcome });
  }

  const bootStatus = status();
  let recovered: Effect[] | null = transition({ kind: "recover" }, clock());
  function tellRecovered() {
    const fx = recovered;
    recovered = null;
    for (const e of fx ?? []) perform(e);
  }
  // The caller registers the session before any callback fires, so the recovered TurnEnds wait for the first dispatch,
  // close(), or this microtask, whichever comes first.
  queueMicrotask(() => dispatch({ kind: "pump" }, clock(), bootStatus));

  return {
    push(input) {
      if (closed) return;
      const id = `${input.ahead ? CONTINUATION : "e_"}${crypto.randomUUID()}` as EnvelopeId;
      const pending: Pending = { id, at: clock().toISOString(), text: input.text, initiator: input.initiator, settles: input.settles, attempts: 0 };
      dispatch({ kind: "push", pending, ahead: input.ahead });
    },
    notice(text) {
      dispatch({ kind: "notice", notice: { at: clock().toISOString(), text } });
    },
    denied() {
      dispatch({ kind: "denied" });
    },
    async interrupt() {
      const kind = spec.state.lifecycle.kind;
      const running = kind === "working" || kind === "stopping" || kind === "backoff";
      if (closed || (!running && spec.state.pending.length === 0)) return false;
      dispatch({ kind: "stop" });
      return true;
    },
    recheck() {
      dispatch({ kind: "tick" });
    },
    tick(now) {
      dispatch({ kind: "tick" }, now);
      watch(now);
    },
    nextDeadline() {
      const life = spec.state.lifecycle;
      const own =
        life.kind === "stopping" ? life.deadline : life.kind === "backoff" || life.kind === "parked" ? life.until : waiting() ? spec.account.parkedUntil : null;
      const watched = watchDeadline();
      const mine = watched === null ? null : new Date(watched).toISOString();
      return own === null || (mine !== null && mine < own) ? mine : own;
    },
    close() {
      if (closed) return;
      tellRecovered();
      closed = true;
      closeLive();
    },
    get working() {
      return isWorking();
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
