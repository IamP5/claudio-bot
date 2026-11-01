import type { CanUseTool, HookCallbackMatcher, Options, PermissionResult, PermissionUpdate, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Driven } from "./catalog";
import type { Tickable } from "./clock";
import { failClosed, resolveReal, toCall, toHookOutput } from "./gate";
import type { Ledger } from "./ledger";
import { detailOf, floors, type Scope } from "./policy";
import { groupAlive } from "./procs";
import { endOutlived, followed, OUTLIVED_LOOK_MS, outlivedSteps, outlivedTask, runOf, settled, withOutlived, type Outlived } from "./outlived";
import {
  PHONE_MODES,
  type AskQuestion,
  type ItemId,
  type MessageId,
  type NoticeReason,
  type PermissionChoice,
  type PermissionMessage,
  type PermissionMode,
  type PhoneMode,
  type SessionControls,
  type SessionId,
  type SessionItem,
  type SessionOutcome,
  type StopTarget,
  type TaskId,
} from "./protocol";
import type { Result } from "./result";
import { refused } from "./result";
import { createSession, goneNote, RESTARTED_ERROR, stopPending, type Fate, type GoneCause, type Session, type SessionSpec, type StopReport, type TurnEnd } from "./session";
import type { SessionEnd } from "./push";
import type { Persist } from "./store";
import { RESTING, rowRun, runControls, runningSteps, runs, type Activity, type StepPatch, type Task } from "./tasks";
import { displayName, errorText, fewNames, maskSecrets } from "./text";
import { stepLabel } from "./transcript";
import { emptySession, newMessageId, ownCardId, ownCardOpen, type BackgroundTask, type Cut, type Lifecycle, type OwnCard, type OwnDrive, type SessionRecord, type World } from "./world";

// The drivers of sessions the user drives from the phone: one session.ts Session per id, opened in the transcript's
// cwd with the user's own Claude Code settings. What Claude Code asks (a permission, AskUserQuestion, ExitPlanMode)
// waits as a card in the thread until the phone answers it; a PreToolUse hook adds only the policy's floors.

export type OwnDeps = {
  world: World;
  userName: string;
  ledger: Ledger;
  persist: Persist;
  claude: Pick<SessionSpec, "query" | "executable" | "shells" | "leaders" | "taskRun">;
  /** The mode and model the transcript last ran with, when it has them. */
  last(id: SessionId): { mode: PermissionMode | null; model: string | null };
  transcriptExists(id: SessionId, cwd: string): boolean;
  /** Why a turn must wait now: another live Claude Code is busy on the id. */
  blocked(id: SessionId): string | null;
  /** Another live Claude Code has the id open, busy or idle at its prompt; its background work may still run. */
  elsewhere(id: SessionId): boolean;
  /** The user's settings.permissions.defaultMode, when it is one the phone may use. */
  defaultMode(): PhoneMode | null;
  scope(cwd: string): Scope;
  /** Something a row or a thread shows changed: status, cards, queue, controls. */
  changed(id: SessionId): void;
  done(id: SessionId): void;
  /** A card opened: the push says only that a session needs the user. */
  notify?(id: SessionId, cardId: MessageId): void;
  /** A run came to rest finished or failed at `at` and stayed at rest, or a bridge restart cut it off; never after a stop of the user's. */
  ended?(id: SessionId, end: SessionEnd, at: string): void;
  /** How long a card waits for an answer; OWN_CARD_TTL_MS when absent. */
  cardTtlMs?: number;
  /** Every message of the live query, for the streaming text. */
  observe?(id: SessionId, m: Parameters<SessionSpec["onMessage"]>[0]): void;
  /** The reply that was streaming when the live query died, taken off the live text: null when none was. */
  cutOff?(id: SessionId): { itemId: ItemId; text: string } | null;
  /** Extra query options (the streaming text needs partial messages). */
  options?: Partial<Options>;
  now(): Date;
  log(line: string): void;
};

export type Own = Tickable & {
  /** The phone sends to the session: queued, after a Stop when interrupt. */
  send(rec: SessionRecord, text: string, clientId: string, interrupt: boolean): Promise<Result>;
  /** Stops what target names and says so in the thread. Refused when nothing it names runs, or a task did not stop. */
  stop(rec: SessionRecord, target?: StopTarget): Promise<Result>;
  decide(rec: SessionRecord, cardId: MessageId, choice: PermissionChoice): Result;
  answer(rec: SessionRecord, cardId: MessageId, answers: Record<string, string> | null): Result;
  /** Withdraws a queued message by its clientId before it runs. */
  unqueue(rec: SessionRecord, clientId: string): Result;
  /** Applies the change to the live query first and keeps only what Claude Code took. */
  set(rec: SessionRecord, patch: { model?: string | null; mode?: PhoneMode }): Promise<Result>;
  /** What the thread shows on top of the transcript: cards, the user's queued messages, notices. */
  overlay(rec: SessionRecord): SessionItem[];
  controls(rec: SessionRecord): SessionControls;
  status(rec: SessionRecord): Driven;
  /** How the thread shows transcript steps the live query knows more about, by tool_use id. */
  steps(rec: SessionRecord): Map<string, StepPatch>;
  /** When work was cut off, oldest first: the last stop, failure or restart once no turn from before it runs, and the session's rest. */
  cuts(rec: SessionRecord): Cut[];
  /** The live query of a session that another process now works on closes, so the bridge yields. */
  yieldTo(id: SessionId): void;
  /** The other process let go: a turn that waited on it goes now. */
  unblock(id: SessionId): void;
  /** At start, before any phone connects: every open card is expired. */
  resume(): void;
  /** Once the index is read: sessions with queued input start. */
  restart(): void;
  close(): void;
};

/** A card left this long unanswered is denied, with a notice. The same as the gate's permission cards. */
export const OWN_CARD_TTL_MS = 2 * 3_600_000;
/**
 * A run that came to rest is told ended once it stayed at rest this long, with no wake turn announced and nothing of
 * a gone query still being looked up: a background task that ends a moment before the turn it wakes rests it twice.
 */
export const END_SETTLE_MS = 5_000;
/** An own session's query with nothing to do closes after this; an agent's stays 15 minutes. */
export const OWN_IDLE_MS = 10 * 60_000;
const SETTLED_KEPT = 20;
/** A notice stays this long, and one that says how the run held now ended stays while that ending holds. */
const NOTICES_KEPT_MS = 24 * 3_600_000;
const NOTICES_MAX = 200;
const ENDING_REASONS: ReadonlySet<NoticeReason | undefined> = new Set(["failure", "stop", "restart"]);
const PROMPTS_KEPT = 5;
const STOPPED_STEPS_KEPT = 20;
/** A Stop of a task the user stopped this recently is the same Stop, sent again or queued behind the first. */
const RESTOP_MS = 60_000;
const LINE_MAX = 160;

const NOTHING_RUNS = "Nothing is running.";
const STOPPED_BY_YOU = "Stopped by you";
const FORCED_END = "Claude Code didn't answer Stop, so the bridge ended it. Your next message starts it again.";
const PROMPT_NAMED = 60;
const RESTARTED = "The bridge restarted";
const UNSEEN_END = "It ended without a result";
const CANT_TELL = "Can't tell whether this still runs on your Mac";
/** How soon, then how much less often, the bridge looks again whether a command it cannot tell about still runs. */
const UNSURE_LOOK_MS = 30_000;
const UNSURE_LOOK_MAX_MS = 10 * 60_000;
/** What the SDK says when Claude Code's process ends under a query. */
const DIED = /^Claude Code process (exited|terminated)/;

const line = (text: string) => displayName(maskSecrets(text.split("\n")[0] ?? ""), LINE_MAX);
const listed = (parts: readonly string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const KIND_WORD: Record<Task["kind"], string> = { agent: "agent", command: "command", other: "task" };
const taskName = (t: Task) => `${KIND_WORD[t.kind]} "${t.label}"`;
/** A stopped run's outcome, as its row reads it: what stopped, not that a turn did. */
const stoppedWhat = (tasks: readonly Task[]) => {
  const of = (kind: Task["kind"]) => tasks.filter((t) => t.kind === kind).length;
  return (["agent", "command", "other"] as const).flatMap((k) => (of(k) > 0 ? [counted(of(k), KIND_WORD[k])] : []));
};
const stoppedText = (early: boolean, tasks: readonly Task[]) => {
  if (early) return `${STOPPED_BY_YOU} before Claude replied`;
  const what = stoppedWhat(tasks);
  return what.length > 0 ? `${STOPPED_BY_YOU}: ${what.join(", ")}` : STOPPED_BY_YOU;
};
/** What a failed or lost outcome reads once the user stopped what it left running. */
const STOP_ADDED = " · you stopped ";
/** A refusal the phone shows under its composer: at most two commands, each cut short between words (a masked secret
 *  stays whole), then how many more. */
const fewOf = (tasks: readonly Task[]) => {
  const cut = (word: string) => {
    const head = word.slice(0, 39);
    const open = head.lastIndexOf("«");
    if (open < 0 || head.includes("»", open)) return head;
    return open > 0 ? head.slice(0, open) : word.slice(0, word.indexOf("»") + 1);
  };
  const names = tasks.map((t) => {
    const words = displayName(t.label, LINE_MAX).match(/(?:«[^»]*»|[^\s«])+/g) ?? [];
    if (words.length === 0) return `an unnamed ${KIND_WORD[t.kind]}`;
    let name = "";
    for (const word of words) {
      const longer = name ? `${name} ${word}` : word;
      if (longer.length > 39) return `${name || cut(word)}…`;
      name = longer;
    }
    return name;
  });
  return names.length <= 2 ? listed(names) : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
};

const waited = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? counted(ms / 3_600_000, "hour") : counted(Math.max(1, Math.round(ms / 60_000)), "minute"));

/** A card nobody answered in time, named by what it asked, which was refused. */
function expiredText(c: OwnCard, ttl: number): string {
  const after = `waited ${waited(ttl)} unanswered, so it was denied. You did not say no.`;
  if (c.kind === "ask") return `Claude's question ${after}`;
  if (c.kind === "plan") return `Claude's plan ${after}`;
  const { tool, label, detail } = c.card;
  const what = displayName(maskSecrets(label === tool && detail ? `${tool}: ${detail.split("\n")[0]}` : label), 80);
  return `The request to allow "${what}" ${after}`;
}

/** What the model menu offers. Claude Code resolves these aliases to the newest model of each family. */
export const MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function questionsOf(input: Record<string, unknown>): AskQuestion[] {
  return (Array.isArray(input.questions) ? input.questions.filter(isRecord) : []).map((q) => ({
    question: str(q.question) ?? "",
    header: str(q.header) ?? "",
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options.filter(isRecord) : []).map((o) => ({ label: str(o.label) ?? "", description: str(o.description) ?? "" })),
  }));
}

const phoneMode = (m: PermissionMode | null | undefined): PhoneMode | null => (m && (PHONE_MODES as readonly string[]).includes(m) ? (m as PhoneMode) : null);

/** The floors run as for an agent: no home of its own inside the bridge's, no USER.md. */
const FLOOR_ACTOR = { kind: "agent", botId: "", agentId: "" } as const;

/** stopped: the user stopped what asked. closed: the query that asked ended (Claude Code exited) before anyone answered. */
type Reply =
  | { kind: "choice"; choice: PermissionChoice }
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "dismissed" }
  | { kind: "expired" }
  | { kind: "stopped" }
  | { kind: "closed" };

const cardIdOf = ownCardId;
const isOpen = ownCardOpen;

/** How a turn a Stop reached ended: by the stop, on its own before the stop landed, or by a failure. */
type TurnEnding = "stopped" | "finished" | "failed";

/**
 * A Stop that reached a turn, until Claude Code ends that turn. envelope: whose turn it is, null for a turn Claude Code
 * began on its own. said: tasks Claude Code confirmed stopped, said with the turn. covered: foreground tasks that end
 * with the turn, so stopped only if the turn is. whole: a stop of everything that landed whole, which cuts off every
 * step. asking: Stops of it still waiting on Claude Code's answer. killed: Claude Code never confirmed it, so the bridge
 * closed Claude Code, which leaves its foreground commands running for the process table to tell about.
 */
type TurnStop = {
  envelope: string | null;
  /** What the user sent for the turn, null for a turn Claude Code began on its own. */
  prompt: string | null;
  early: boolean;
  at: string;
  said: Task[];
  covered: Task[];
  whole: boolean;
  asking: number;
  ended?: TurnEnding;
  killed?: true;
};

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The SDK's words for a request its query closed under, as the user reads them. */
const plainSdkError = (text: string) => (/Query closed before response received/i.test(text) ? "Claude Code stopped before it answered. Try again." : text);
const addNew = (to: Task[], tasks: readonly Task[]) => to.push(...tasks.filter((t) => !to.some((x) => x.id === t.id)));

export function createOwn(deps: OwnDeps): Own {
  const drivers = new Map<SessionId, Session>();
  /** The live query's wait on each open card. A card without one (after a restart) can only expire. */
  const waiting = new Map<MessageId, (r: Reply) => void>();
  /** Sessions whose last start waited on another Claude Code, so its letting go starts them at once. */
  const held = new Set<SessionId>();
  /** Sessions whose run is under way: what a send starts, wake turns and background tasks included, until nothing runs. */
  const underway = new Set<SessionId>();
  /** Sessions the user stopped something on in this run. */
  const stoppedBy = new Set<SessionId>();
  /** The first line of the run's last reply: the row's line when the run finishes. */
  const lastReply = new Map<SessionId, string>();
  /** Subagent cards a task stop covers: when their query gives up on them, the user's stop closed them. */
  const stopping = new Set<MessageId>();
  /**
   * Task stops Claude Code had not confirmed within the wait; each counts as the user's once the task is gone. ofRun:
   * the Stop was of the turn or of everything, so it is the run's outcome too.
   */
  const awaiting = new Map<SessionId, { task: Task; ofRun: boolean }[]>();
  const turnStops = new Map<SessionId, TurnStop>();
  /** Foreground commands of a turn whose Stop ended with the bridge closing Claude Code, and when that Stop was: the process table says which stopped. */
  const leftByKill = new Map<SessionId, { tasks: Task[]; at: string }>();
  /** Tasks a Stop is ending right now: a second Stop of one leaves the saying to the first. */
  const beingStopped = new Map<SessionId, Map<TaskId, Task>>();
  /** When the user's Stop last ended each task, so a Stop of it that comes after is not refused. */
  const stoppedAt = new Map<SessionId, Map<TaskId, number>>();
  /** The live tasks each session had when last looked at, and those of the last to go that the user's stop ended. */
  const seen = new Map<SessionId, Task[]>();
  const endedByStop = new Map<SessionId, Task[]>();
  let nextOutlivedLook = 0;
  const lookingAtOutlived = new Set<SessionId>();
  /** When each session last came to rest; one that has not run since the bridge started rests since then. */
  const rested = new Map<SessionId, string>();
  /** Runs that came to rest, by when, until their ending is told or a new run takes over. */
  const ending = new Map<SessionId, number>();
  /**
   * Claude Code died under a turn (it exited, or a bridge restart took it): an ending of its own, told once what outlived
   * it is known, whatever still runs. notice: the thread's one notice of it, which then names what still runs.
   */
  const deaths = new Map<SessionId, { end: "failed" | "lost"; at: string; notice: ItemId; head: string; error: string | null }>();
  /** The outcome time of each session's last ending told, so a later rest of the same run is not told again. */
  const told = new Map<SessionId, string>();
  /** Sessions whose run left steps the bridge cannot tell about and cannot look at again. */
  const unsureRun = new Set<SessionId>();
  /** Queued messages the user withdrew, so asking again says so. */
  const withdrawn = new Map<SessionId, string[]>();
  /** The turn in flight on each session and when Claude Code took its message, which is where the message shows. */
  const taken = new Map<SessionId, { turn: string; at: string }>();

  const now = () => deps.now().toISOString();
  const bootAt = now();
  const driveOf = (rec: SessionRecord): OwnDrive => {
    if (!rec.own) throw new Error(`${rec.id} is not driven from the phone`);
    return rec.own;
  };
  const cards = (rec: SessionRecord) => driveOf(rec).cards;
  const allOutlived = (rec: SessionRecord): Outlived[] => rec.own?.outlived ?? [];
  const outlivedOf = (rec: SessionRecord): Outlived[] => followed(allOutlived(rec));
  const activityOf = (rec: SessionRecord): Activity => withOutlived(drivers.get(rec.id)?.activity() ?? RESTING, allOutlived(rec), bootAt);
  const nameOf = (o: Outlived) => taskName(outlivedTask(o, bootAt));

  const working = (rec: SessionRecord) => (drivers.get(rec.id)?.working ?? false) || runs(activityOf(rec));
  /** Work the bridge cannot tell has ended: the run is not over while it may still run, though nothing shows working. */
  const unsure = (rec: SessionRecord) => allOutlived(rec).some((o) => o.over === "unsure") || (unsureRun.has(rec.id) && (rec.own?.unsure?.length ?? 0) > 0);

  /** A new run starts: how the last one ended no longer shows. */
  function begin(rec: SessionRecord) {
    const drive = driveOf(rec);
    delete drive.outcome;
    delete drive.endedTurn;
    stoppedBy.delete(rec.id);
    endedByStop.delete(rec.id);
    lastReply.delete(rec.id);
    unsureRun.delete(rec.id);
    delete drive.unchecked;
    deps.persist("now");
  }

  /**
   * Something the thread or the row shows changed. A turn of another envelope than the one the last ending ended (a
   * queued message) begins a new run. A run that just came to rest records how it ended, unless a stop or a failure
   * already did; a task that ends a moment before the wake turn it announces rests it twice.
   */
  function changed(id: SessionId) {
    const rec = deps.world.sessions.get(id);
    const drive = rec?.own;
    if (rec && drive) {
      confirmLate(rec);
      noteEnds(rec);
      const life = drive.session.lifecycle;
      const turn = life.kind === "working" || life.kind === "stopping" ? life.turn.pending : null;
      if (life.kind === "working" || life.kind === "stopping") taken.set(id, { turn: life.turn.pending, at: life.turn.startedAt });
      if (drive.outcome && drive.outcome.kind !== "finished" && turn !== null && turn !== drive.endedTurn) begin(rec);
      if (working(rec)) {
        underway.add(id);
        rested.delete(id);
      } else {
        if (!rested.has(id)) rested.set(id, now());
        if (unsure(rec)) underway.add(id);
        // A stop not yet said is the run's ending, so the run's rest waits for it.
        else if (!turnStops.has(id) && underway.delete(id)) {
          if (!drive.outcome || drive.outcome.kind === "finished") {
            // The last work to end was the user's stop of it, so the run ends as stopped, never as finished.
            const byStop = endedByStop.get(id) ?? [];
            drive.outcome = stoppedBy.has(id)
              ? { kind: "stopped", text: STOPPED_BY_YOU, at: now() }
              : byStop.length > 0
                ? { kind: "stopped", text: stoppedText(false, byStop), at: now() }
                : { kind: "finished", text: lastReply.get(id) ?? "Finished", at: now() };
            deps.persist("now");
          }
          ending.set(id, deps.now().getTime());
        }
      }
    }
    deps.changed(id);
  }

  /**
   * The tasks the user stopped are the user's doing: their steps read stopped. ofRun: the Stop was of the turn or of
   * everything, so the run reads stopped too; a stop of one task leaves the turn as it ended.
   */
  function markStopped(rec: SessionRecord, tasks: readonly Task[], ofRun: boolean) {
    if (tasks.length === 0) return;
    if (ofRun) stoppedBy.add(rec.id);
    const at = deps.now().getTime();
    const times = stoppedAt.get(rec.id) ?? new Map<TaskId, number>();
    for (const [id, when] of times) if (at - when >= RESTOP_MS) times.delete(id);
    for (const t of tasks) times.set(t.id, at);
    stoppedAt.set(rec.id, times);
    const drive = driveOf(rec);
    const steps = tasks.flatMap((t) => (t.stepId === null ? [] : [t.stepId]));
    if (steps.length > 0) drive.stoppedSteps = [...(drive.stoppedSteps ?? []), ...steps].slice(-STOPPED_STEPS_KEPT);
    deps.persist("now");
  }

  /**
   * A task stop Claude Code confirmed late lands once the task is gone from the live query: stopped, or finished first
   * when Claude Code said it completed. Tasks gone with the query itself are not the stop's doing; the process table
   * tells what became of them.
   */
  function confirmLate(rec: SessionRecord) {
    const late = awaiting.get(rec.id);
    if (!late) return;
    const a = activityOf(rec);
    const live = new Set(a.tasks.map((t) => t.id));
    const gone = late.filter((w) => !live.has(w.task.id));
    if (gone.length === 0) return;
    const left = late.filter((w) => live.has(w.task.id));
    if (left.length > 0) awaiting.set(rec.id, left);
    else awaiting.delete(rec.id);
    if (a.heardAt === null) return;
    const finished = gone.filter((w) => a.all.get(w.task.id)?.told === true);
    const stopped = gone.filter((w) => !finished.includes(w));
    markStopped(rec, stopped.filter((w) => w.ofRun).map((w) => w.task), true);
    markStopped(rec, stopped.filter((w) => !w.ofRun).map((w) => w.task), false);
    for (const c of [...cards(rec)]) if (c.kind === "permission" && c.agent && isOpen(c) && stopping.has(cardIdOf(c)) && !live.has(c.agent.id as TaskId)) settle(rec, cardIdOf(c), { kind: "stopped" });
    if (stopped.length > 0) notice(rec.id, `${STOPPED_BY_YOU}: ${fewNames(stopped.map((w) => taskName(w.task)), listed)}.`, "info", "stop");
    if (finished.length > 0) notice(rec.id, `${upper(fewNames(finished.map((w) => taskName(w.task)), listed))} finished before your stop reached it.`, "info", "stop");
  }

  /** Which of the tasks that just went were ended by a stop of the user's: the run's last ending, until a turn ends. */
  function noteEnds(rec: SessionRecord) {
    const a = activityOf(rec);
    const gone = (seen.get(rec.id) ?? []).filter((t) => !a.tasks.some((x) => x.id === t.id));
    seen.set(rec.id, a.tasks);
    if (gone.length === 0) return;
    const mine = (t: Task) => (beingStopped.get(rec.id)?.has(t.id) || stoppedAt.get(rec.id)?.has(t.id)) && a.all.get(t.id)?.told !== true;
    endedByStop.set(rec.id, gone.filter(mine));
  }

  /** Tasks a Stop now under way asked to end that are gone, and that Claude Code did not say completed: the stop ended them. */
  function landing(rec: SessionRecord): Task[] {
    const a = activityOf(rec);
    return [...(beingStopped.get(rec.id)?.values() ?? [])].filter((t) => !a.tasks.some((x) => x.id === t.id) && a.all.get(t.id)?.told !== true);
  }

  /** How the turn a Stop reached ended. The thread says so once no Stop of it still waits on Claude Code's answer. */
  function observed(rec: SessionRecord, stop: TurnStop, how: TurnEnding) {
    stop.ended = how;
    if (stop.asking === 0) sayTurnStop(rec, stop);
  }

  /** What a Stop of the turn did, once the turn ended: the turn and what stopped with it, or that the turn finished first. */
  function sayTurnStop(rec: SessionRecord, stop: TurnStop) {
    if (turnStops.get(rec.id) === stop) turnStops.delete(rec.id);
    const stopped = stop.ended === "stopped";
    const covered = stop.killed ? stop.covered.filter((t) => t.kind !== "command") : stop.covered;
    if (stop.killed && covered.length < stop.covered.length) leftByKill.set(rec.id, { tasks: stop.covered.filter((t) => t.kind === "command"), at: stop.at });
    if (stopped) markStopped(rec, covered, true);
    const tasks = [...stop.said, ...(stopped ? covered : [])];
    // Said where the Stop was, so it sits above a message sent or queued after it, which starts as the turn ends.
    const at = stop.at;
    if (stop.ended === "finished") notice(rec.id, "Claude finished this turn before your stop reached it.", "info", "stop", at);
    const parts = [...(stopped ? ["the turn"] : []), ...tasks.map(taskName)];
    if (parts.length === 0) return;
    const early = stop.early && stopped && tasks.length === 0;
    const named = stop.prompt === null ? "" : ` to "${displayName(maskSecrets(stop.prompt), PROMPT_NAMED)}"`;
    notice(rec.id, early ? `${STOPPED_BY_YOU} before Claude replied${named}.` : `${STOPPED_BY_YOU}: ${fewNames(parts, listed)}.`, "info", "stop", at);
    if (stop.killed && stopped) notice(rec.id, FORCED_END, "info", "stop", at);
    if (stop.ended === "failed") return;
    stoppedRun(rec, { early, tasks, at: stop.at, envelope: stop.envelope, whole: stop.whole });
    changed(rec.id);
  }

  /** A turn a Stop reached ended as the bridge restarted: whether Claude Code took the stop first is not known. */
  function sayRecoveredStop(rec: SessionRecord, envelope: string) {
    notice(rec.id, "The bridge restarted before Claude Code confirmed your stop. The turn ended.", "info", "stop");
    stoppedRun(rec, { early: false, tasks: [], at: now(), envelope, whole: false });
  }

  /** The run ends as the user's stop: what it stopped, and with a stop of everything that all landed, a cut of every step. */
  function stoppedRun(rec: SessionRecord, o: { early: boolean; tasks: readonly Task[]; at: string; envelope: string | null; whole: boolean }) {
    end(rec, { kind: "stopped", text: stoppedText(o.early, o.tasks), at: o.at }, o.envelope, o.whole ? { state: "stopped", cause: STOPPED_BY_YOU } : undefined, o.tasks);
  }

  /**
   * What became of a gone query's background work and foreground commands, from the process table. Only background
   * work that stopped is the restart's cut; a foreground command that stopped went with its turn, which says so itself.
   * A command that still runs is followed, and one the bridge cannot check is said to maybe still run.
   */
  function lost(rec: SessionRecord, fate: Fate, cause: GoneCause) {
    const left = leftByKill.get(rec.id);
    leftByKill.delete(rec.id);
    const ended = (left?.tasks ?? []).filter((t) => fate.stopped.some((s) => s.id === t.id));
    if (ended.length > 0) {
      markStopped(rec, ended, true);
      notice(rec.id, `${STOPPED_BY_YOU}: ${fewNames(ended.map(taskName), listed)}.`, "info", "stop", left?.at);
    }
    const stopped = fate.stopped.filter((t) => !t.foreground);
    if (stopped.length > 0) {
      const text = goneNote("Claude Code", cause, "stopped", stopped);
      if (cause === "restart") lose(rec, text, null);
      else notice(rec.id, text);
    }
    if (fate.unknown.length > 0) {
      // One with a process group is looked at again, so its end can be said; one without stays as the bridge cannot tell.
      const looked = (t: BackgroundTask) => typeof t.group === "number" || typeof t.loose === "number";
      const grouped = fate.unknown
        .filter((t) => looked(t) && !allOutlived(rec).some((o) => o.id === t.id))
        .map((t): Outlived => ({ ...t, group: (t.group ?? t.loose)! }));
      driveOf(rec).outlived = settled([...allOutlived(rec), ...grouped], grouped.map((t) => t.id), "unsure");
      markUnsure(rec, fate.unknown.filter((t) => !looked(t)));
      notice(rec.id, goneNote("Claude Code", cause, "unknown", fate.unknown), "info", cause === "restart" ? "restart" : undefined);
    }
    adopt(rec, fate.running, cause);
  }

  /** Background work the bridge cannot check and cannot look at again: its steps say the bridge cannot tell. */
  function markUnsure(rec: SessionRecord, tasks: readonly BackgroundTask[]) {
    if (tasks.length === 0) return;
    const drive = driveOf(rec);
    unsureRun.add(rec.id);
    drive.unchecked = true;
    drive.unsure = [...(drive.unsure ?? []), ...tasks.map((t) => t.stepId ?? `task:${t.id}`)].slice(-STOPPED_STEPS_KEPT);
    deps.persist("now");
  }

  /** The bridge no longer follows these outlived commands; `over` says why. */
  function letGo(rec: SessionRecord, ids: readonly string[], over: NonNullable<Outlived["over"]>) {
    if (ids.length === 0) return;
    driveOf(rec).outlived = settled(allOutlived(rec), ids, over);
    deps.persist("now");
  }

  const pick = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);

  function adopt(rec: SessionRecord, tasks: readonly BackgroundTask[], cause: GoneCause) {
    const add = tasks.filter((t): t is Outlived => t.group !== undefined && !allOutlived(rec).some((o) => o.id === t.id));
    if (add.length === 0) return;
    driveOf(rec).outlived = [...allOutlived(rec), ...add];
    deps.persist("now");
    const said = (tasks: readonly Outlived[]) => `still ${pick(tasks.length, "runs", "run")} on this Mac. Stop ends ${pick(tasks.length, "it", "them")}.`;
    const death = deaths.get(rec.id);
    if (death && driveOf(rec).notices?.some((n) => n.id === death.notice)) {
      // One notice per death: what happened, what still runs, and the next steps in order.
      const left = followed(allOutlived(rec));
      const next = `Send a message to start Claude Code again; the ${pick(left.length, "command keeps", "commands keep")} running until you stop ${pick(left.length, "it", "them")}.`;
      const text = `${death.head} ${upper(fewNames(left.map(nameOf), listed))} ${said(left)} ${next}${death.error === null ? "" : `\n${death.error}`}`;
      driveOf(rec).notices = driveOf(rec).notices!.map((n) => (n.id === death.notice ? { ...n, text } : n));
      deps.persist("now");
      return changed(rec.id);
    }
    const names = fewNames(add.map(nameOf), listed);
    const runs = said(add);
    notice(
      rec.id,
      cause === "restart" ? `The bridge restarted, and Claude Code no longer follows ${names}, which ${runs}` : `Claude Code is no longer running, but ${names} ${runs}`,
      "info",
      cause === "restart" ? "restart" : "task",
    );
  }

  /**
   * A Stop that finds nothing it can stop, while background work the bridge cannot tell about may still run (all of
   * it, or the task `one` names): it says so rather than that nothing runs.
   */
  function cantStop(rec: SessionRecord, one: TaskId | null): string | null {
    const unsure = allOutlived(rec).filter((o) => o.over === "unsure" && (one === null || o.id === one));
    const unnamed = one === null ? rec.own?.unchecked === true : (rec.own?.unsure ?? []).includes(`task:${one}`);
    if (unsure.length === 0 && !unnamed) return null;
    const what = unsure.length > 0 ? fewNames(unsure.map(nameOf), listed) : "its background work";
    return `The bridge can't tell whether ${what} still ${unsure.length > 1 ? "run" : "runs"} on your Mac, so it has nothing it can stop.`;
  }

  const endedText = (tasks: readonly Outlived[]) =>
    `${upper(fewNames(tasks.map(nameOf), listed))} ended. Claude Code no longer followed ${pick(tasks.length, "it", "them")}, so how ${pick(tasks.length, "it", "they")} ended is not known.`;
  const unsureText = (names: string, n: number) =>
    `The bridge can no longer tell that ${names} ${pick(n, "is still the command", "are still the commands")} it followed, so it no longer shows ${pick(n, "it", "them")}. ${pick(n, "It", "They")} may still run on this Mac.`;

  /** When each command the bridge cannot tell about is next looked at, and the wait after that. */
  const unsureLooks = new Map<string, { at: number; gap: number }>();
  const unsureDue = (rec: SessionRecord, o: Outlived, at: number) => {
    const key = `${rec.id}:${o.id}`;
    const look = unsureLooks.get(key) ?? { at: at + UNSURE_LOOK_MS, gap: UNSURE_LOOK_MS };
    if (at < look.at) {
      unsureLooks.set(key, look);
      return false;
    }
    const gap = Math.min(look.gap * 2, UNSURE_LOOK_MAX_MS);
    unsureLooks.set(key, { at: at + gap, gap });
    return true;
  };

  /**
   * Followed commands that ended on their own since the last look (nobody saw how), or that the bridge can no longer
   * prove are the command; and, less often, commands it cannot tell about whose group is gone. One a Stop is ending,
   * the Stop says. A process table it cannot read changes nothing. A failure is logged and undone, so the next look
   * says it again: a background poll never takes the bridge down.
   */
  async function lookOutlived(rec: SessionRecord) {
    if (lookingAtOutlived.has(rec.id)) return;
    lookingAtOutlived.add(rec.id);
    const free = (o: Outlived) => !(beingStopped.get(rec.id)?.has(o.id as TaskId) ?? false);
    const drive = driveOf(rec);
    const before = { outlived: drive.outlived, notices: drive.notices };
    try {
      const watched = outlivedOf(rec).filter(free);
      const runs = await Promise.all(watched.map(runOf));
      const now = (kind: string) => watched.filter((o, i) => runs[i] === kind && free(o) && outlivedOf(rec).some((x) => x.id === o.id));
      const at = deps.now().getTime();
      const unsureGone = allOutlived(rec).filter((o) => o.over === "unsure" && unsureDue(rec, o, at) && !groupAlive(o.group));
      for (const o of unsureGone) unsureLooks.delete(`${rec.id}:${o.id}`);
      const ended = [...now("gone"), ...unsureGone];
      const unsure = now("unsure");
      Object.assign(before, { outlived: drive.outlived, notices: drive.notices });
      if (ended.length === 0 && unsure.length === 0) return;
      letGo(rec, ended.map((o) => o.id), "ended");
      letGo(rec, unsure.map((o) => o.id), "unsure");
      if (ended.length > 0) notice(rec.id, endedText(ended), "info", "task");
      if (unsure.length > 0) notice(rec.id, unsureText(fewNames(unsure.map(nameOf), listed), unsure.length), "info", "task");
    } catch (e) {
      drive.outlived = before.outlived;
      drive.notices = before.notices;
      deps.log(`own ${rec.id}: looking at outlived commands failed: ${errorText(e)}`);
    } finally {
      lookingAtOutlived.delete(rec.id);
    }
  }

  /** at: where it sits in the thread, now when absent. Returns the notice's id. */
  function notice(id: SessionId, text: string, tone: "info" | "error" = "info", reason?: NoticeReason, at = now()): ItemId | null {
    const drive = deps.world.sessions.get(id)?.own;
    if (!drive) return null;
    const item = { kind: "notice", id: `n_${crypto.randomUUID()}` as ItemId, at, text, tone, ...(reason && { reason }) } as const;
    const since = new Date(deps.now().getTime() - NOTICES_KEPT_MS).toISOString();
    const outcome = drive.outcome;
    const holds = (n: typeof item | NonNullable<OwnDrive["notices"]>[number]) => outcome !== undefined && ENDING_REASONS.has(n.reason) && n.at >= outcome.at;
    const kept = [...(drive.notices ?? []), item].filter((n) => n.at >= since || holds(n));
    const over = kept.length - NOTICES_MAX;
    const dropped = new Set(kept.filter((n) => !holds(n)).slice(0, Math.max(0, over)));
    drive.notices = kept.filter((n) => !dropped.has(n));
    deps.persist("now");
    changed(id);
    return item.id;
  }

  /**
   * turn: the envelope whose turn this ended, if any. A stop of what a failure or a restart left running never hides
   * that failure: the stop is added to its outcome, which keeps its kind, time and cut.
   */
  function end(rec: SessionRecord, outcome: SessionOutcome, turn: string | null, cut?: Omit<Cut, "at">, stopped?: readonly Task[]) {
    const drive = driveOf(rec);
    const prev = drive.outcome;
    if (outcome.kind === "stopped" && (prev?.kind === "failed" || prev?.kind === "lost")) {
      const what = stoppedWhat(stopped ?? []);
      drive.outcome = { ...prev, text: `${prev.text.split(STOP_ADDED)[0]}${STOP_ADDED}${what.length > 0 ? `its ${what.join(", ")}` : "what was left"}` };
      deps.persist("now");
      return;
    }
    drive.outcome = outcome;
    if (turn === null) delete drive.endedTurn;
    else drive.endedTurn = turn;
    if (cut) drive.cut = { at: outcome.at, ...cut };
    deps.persist("now");
  }

  /** The run failed. Claude Code exiting is said in words, with what to do next, and the raw error under it. */
  function fail(rec: SessionRecord, error: string, turn: string) {
    if (error === RESTARTED_ERROR) return lose(rec, error, turn);
    const at = now();
    if (DIED.test(error)) {
      const cause = `Claude Code stopped unexpectedly (${line(error).replace(/^Claude Code process /, "")})`;
      end(rec, { kind: "failed", text: cause, at }, turn, { state: "error", cause });
      // The reply it was writing stays as far as it got, right above the notice; Claude Code never writes it down.
      const cut = deps.cutOff?.(rec.id) ?? null;
      if (cut) {
        const drive = driveOf(rec);
        drive.cutOff = [...(drive.cutOff ?? []).filter((r) => r.id !== cut.itemId), { id: cut.itemId, at, text: cut.text }].slice(-PROMPTS_KEPT);
      }
      const head = `Claude Code stopped unexpectedly${cut ? " while writing this reply" : ""}.`;
      const id = notice(rec.id, `${head} Send a message to start it again.\n${maskSecrets(error)}`, "error", "failure", at);
      if (id !== null) deaths.set(rec.id, { end: "failed", at, notice: id, head, error: maskSecrets(error) });
      return;
    }
    end(rec, { kind: "failed", text: line(error), at }, turn, { state: "error", cause: line(error) });
    notice(rec.id, maskSecrets(error), "error", "failure");
  }

  /**
   * A bridge restart cut the run off. A turn it cut is told to the user even if nothing was there to see it, before the
   * outcome is saved, so a crash between the two never loses it. Background work found gone after a restart is not
   * told: it may have ended on its own while the bridge was down.
   */
  function lose(rec: SessionRecord, text: string, turn: string | null) {
    const at = now();
    // The restart already ended this run; what else it cut off is said, but the run keeps the one ending.
    if (turn === null && deaths.has(rec.id)) return void notice(rec.id, text, "info", "restart");
    end(rec, { kind: "lost", text: line(text), at }, turn, { state: "stopped", cause: RESTARTED });
    const id = notice(rec.id, text, "info", "restart", at);
    if (turn !== null && id !== null) deaths.set(rec.id, { end: "lost", at, notice: id, head: text, error: null });
  }

  /** A prompt a stop ended stays in the thread, whether or not Claude Code wrote it down. */
  function keep(rec: SessionRecord, p: { id: string; clientId?: string; at: string; text: string }) {
    if (p.clientId === undefined) return;
    const drive = driveOf(rec);
    const id = p.clientId as ItemId;
    const took = taken.get(rec.id);
    drive.kept = [...(drive.kept ?? []).filter((k) => k.id !== id), { id, at: took?.turn === p.id ? took.at : p.at, text: p.text }].slice(-PROMPTS_KEPT);
    deps.persist("now");
  }

  /** Keeps the open cards and the newest settled ones. */
  function prune(rec: SessionRecord) {
    const list = cards(rec);
    const settled = list.filter((c) => !isOpen(c));
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT)));
    list.splice(0, list.length, ...list.filter((c) => !drop.has(c)));
  }

  /** Opens a card and waits for its answer, its expiry, or the query giving up on it. Saved before it shows. */
  function hold(rec: SessionRecord, card: OwnCard, signal: AbortSignal): Promise<Reply> {
    const id = cardIdOf(card);
    cards(rec).push(card);
    deps.persist("now");
    changed(rec.id);
    deps.notify?.(rec.id, id);
    return new Promise<Reply>((resolve) => {
      const done = (r: Reply) => {
        waiting.delete(id);
        signal.removeEventListener("abort", aborted);
        resolve(r);
      };
      // A card its query gives up on was ended by the user's task stop, or its process died.
      const aborted = () => {
        settle(rec, id, { kind: stopping.delete(id) ? "stopped" : "closed" });
      };
      waiting.set(id, done);
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    });
  }

  /** First answer wins. The card records it, and the live query hears it. */
  function settle(rec: SessionRecord, cardId: MessageId, reply: Reply): Result {
    const card = rec.own?.cards.find((c) => cardIdOf(c) === cardId);
    if (!card) return refused("Unknown card");
    if (!isOpen(card)) return refused(card.kind === "permission" && card.card.answer === "expired" ? "That request expired" : "That card was already answered");
    switch (card.kind) {
      case "permission":
        if (reply.kind === "answers" || reply.kind === "dismissed") return refused("A permission card takes a choice");
        card.card = { ...card.card, answer: reply.kind === "choice" ? reply.choice : reply.kind };
        if (reply.kind === "choice" && (reply.choice === "once" || reply.choice === "always")) card.allowedAt = now();
        break;
      case "ask":
        if (reply.kind === "choice") return refused("A question takes answers");
        card.answers = reply.kind === "answers" ? reply.answers : reply.kind === "dismissed" || reply.kind === "stopped" ? reply.kind : "expired";
        break;
      case "plan":
        if (reply.kind === "answers" || reply.kind === "dismissed") return refused("A plan takes a choice");
        card.state = reply.kind === "stopped" ? "stopped" : reply.kind !== "choice" ? "expired" : reply.choice === "once" || reply.choice === "always" ? "approved" : "rejected";
        break;
    }
    prune(rec);
    deps.persist();
    stopping.delete(cardId);
    waiting.get(cardId)?.(reply);
    changed(rec.id);
    return { ok: true };
  }

  const ttl = deps.cardTtlMs ?? OWN_CARD_TTL_MS;
  const expiresAt = () => new Date(deps.now().getTime() + ttl).toISOString();

  function canUseTool(rec: SessionRecord): CanUseTool {
    return async (tool, input, o): Promise<PermissionResult> => {
      try {
        if (tool === "AskUserQuestion") {
          const card: OwnCard = { kind: "ask", cardId: newMessageId(), toolUseId: o.toolUseID, at: now(), expiresAt: expiresAt(), questions: questionsOf(input), answers: null };
          const r = await hold(rec, card, o.signal);
          if (r.kind === "answers") return { behavior: "allow", updatedInput: { ...input, answers: r.answers } };
          return { behavior: "deny", message: r.kind === "dismissed" ? `${deps.userName} dismissed the question without answering.` : r.kind === "stopped" ? `${deps.userName} stopped the session. It did not run.` : `The question expired unanswered; ${deps.userName} did not say no.` };
        }
        if (tool === "ExitPlanMode") {
          const drive = driveOf(rec);
          const before = phoneMode(drive.mode) ?? deps.defaultMode() ?? "default";
          const card: OwnCard = { kind: "plan", cardId: newMessageId(), toolUseId: o.toolUseID, at: now(), expiresAt: expiresAt(), text: str(input.plan) ?? "", state: "proposed", modeBefore: before === "plan" ? "default" : before };
          const r = await hold(rec, card, o.signal);
          if (r.kind === "choice" && (r.choice === "once" || r.choice === "always")) {
            drive.mode = card.modeBefore as PhoneMode;
            deps.persist();
            void drivers.get(rec.id)?.controls()?.setPermissionMode(card.modeBefore).catch((e) => deps.log(`own ${rec.id}: setPermissionMode failed: ${errorText(e)}`));
            return { behavior: "allow", updatedInput: input };
          }
          return { behavior: "deny", message: r.kind === "expired" ? `The plan expired unanswered; ${deps.userName} did not say no. Keep planning.` : `${deps.userName} wants you to keep planning. Revise the plan.` };
        }
        const suggestions = o.suggestions ?? [];
        const message: PermissionMessage = {
          kind: "permission",
          id: newMessageId(),
          at: now(),
          from: null,
          tool,
          label: o.title?.trim() || o.displayName?.trim() || tool,
          detail: detailOf({ tool, input, cwd: driveOf(rec).cwd, toolUseId: o.toolUseID, subagent: null, mcpServer: o.mcpServer ?? null }),
          always: suggestions.length > 0 && o.suppressAlwaysAllowRule !== true ? alwaysText(suggestions) : "",
          answer: null,
          expiresAt: expiresAt(),
        };
        const task = o.agentID ? drivers.get(rec.id)?.activity().all.get(o.agentID as TaskId) : undefined;
        const agent = o.agentID ? { id: o.agentID, label: task?.label ?? null, stepId: task?.stepId ?? null } : null;
        const r = await hold(rec, { kind: "permission", card: message, toolUseId: o.toolUseID, suggestions, ...(agent && { agent }) }, o.signal);
        if (r.kind === "stopped") return { behavior: "deny", message: `${deps.userName} stopped the session. It did not run.` };
        if (r.kind !== "choice") return { behavior: "deny", message: `The request expired unanswered; ${deps.userName} did not say no. It did not run.` };
        switch (r.choice) {
          case "once":
            return { behavior: "allow", updatedInput: input };
          case "always":
            return {
              behavior: "allow",
              updatedInput: input,
              ...(message.always !== "" && { updatedPermissions: suggestions.map((s): PermissionUpdate => ({ ...s, destination: "session" })) }),
            };
          case "deny":
            return { behavior: "deny", message: `${deps.userName} denied this. It did not run.` };
          case "never":
            return { behavior: "deny", message: `${deps.userName} denied this and stopped the turn. It did not run.`, interrupt: true };
        }
      } catch (e) {
        deps.log(`own ${rec.id}: canUseTool failed: ${errorText(e)}`);
        return { behavior: "deny", message: "The bridge could not ask about this call, so it did not run." };
      }
    };
  }

  function floorsHook(rec: SessionRecord): HookCallbackMatcher {
    return {
      hooks: [
        failClosed(
          (input: PreToolUseHookInput) => {
            const parsed = toCall(input);
            if (!parsed.ok) return {};
            const scope = deps.scope(driveOf(rec).cwd);
            const d = floors(parsed.call, {
              actor: FLOOR_ACTOR as never,
              initiator: { kind: "user" },
              scope,
              rules: [],
              grants: [],
              headroom: { ok: true, capReached: false },
              callsToday: {},
              connectorsOff: [],
              now: now(),
              realpath: resolveReal,
            });
            return d === null ? {} : toHookOutput(d, null, deps.userName);
          },
          (_, error) => deps.log(`own ${rec.id}: floors failed: ${error}`),
        ),
      ],
    };
  }

  const modeOf = (rec: SessionRecord): PhoneMode => phoneMode(rec.own?.mode) ?? phoneMode(deps.last(rec.id).mode) ?? deps.defaultMode() ?? "default";

  function driver(rec: SessionRecord): Session {
    const existing = drivers.get(rec.id);
    if (existing) return existing;
    const drive = driveOf(rec);
    const id = rec.id;
    const session = createSession({
      actor: { kind: "own", sessionId: id },
      state: drive.session,
      account: deps.world.account,
      ledger: deps.ledger,
      persist: deps.persist,
      userName: deps.userName,
      name: () => "Claude Code",
      log: deps.log,
      ...deps.claude,
      forgotten: "fail",
      notices: false,
      idleMs: OWN_IDLE_MS,
      gone: (fate, cause) => lost(rec, fate, cause),
      onWakeEnd: (how) => {
        const stop = turnStops.get(id);
        if (stop?.envelope === null && !stop.ended) observed(rec, stop, how);
      },
      now: deps.now,
      blocked: () => {
        const wait = deps.blocked(id);
        if (wait !== null) held.add(id);
        return wait;
      },
      options: (): Options => {
        const model = drive.model ?? deps.last(id).model ?? undefined;
        return {
          cwd: drive.cwd,
          // Only a session the phone made may be created under its id; one it took on resumes, and fails if Claude Code lost it.
          ...(!drive.created || deps.transcriptExists(id, drive.cwd) ? { resume: id } : { sessionId: id }),
          // The user's own regime, as in the Claude app: their settings, their prompts, no bridge sandbox.
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: modeOf(rec),
          ...(model !== undefined && { model }),
          canUseTool: canUseTool(rec),
          hooks: { PreToolUse: [floorsHook(rec)] },
          // The bridge's own settings (its push topic among them) stay out: these sessions run no sandbox to hide them.
          env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUD(IO|E)BOT_/.test(k))),
          ...deps.options,
        };
      },
      onMessage: (m) => {
        // Each turn's result, a wake turn's included, is its last reply. The turn rests a moment before its result is
        // read, so a finished outcome already set takes it then.
        if (m.type === "result" && m.subtype === "success" && line(m.result) !== "") {
          const reply = line(m.result);
          lastReply.set(id, reply);
          const drive = driveOf(rec);
          if (drive.outcome?.kind === "finished" && drive.outcome.text !== reply) {
            drive.outcome = { ...drive.outcome, text: reply };
            deps.persist("now");
          }
        }
        deps.observe?.(id, m);
      },
      onTurnEnd(pending, end: TurnEnd) {
        if (end.kind === "deferred") return;
        // The turn of another envelope than the one the last ending ended was a new run, even if no change showed it start.
        const drive = driveOf(rec);
        if (drive.outcome && drive.outcome.kind !== "finished" && pending.id !== drive.endedTurn) begin(rec);
        // A turn that ended without Claude's reply keeps the prompt, whether or not Claude Code wrote it down.
        if (end.kind === "stopped" || end.kind === "failed" || (end.kind === "done" && end.result.subtype !== "success")) keep(rec, pending);
        if (end.kind === "failed") fail(rec, end.error, pending.id);
        else if (end.kind === "done" && end.result.subtype !== "success") fail(rec, `Claude Code stopped with an error: ${end.result.errors.join("; ") || end.result.subtype}`, pending.id);
        else if (end.kind === "done") {
          endedByStop.delete(id);
          deps.done(id);
        }
        const stop = turnStops.get(id);
        const how: TurnEnding =
          end.kind === "stopped" ? (end.by === "user" ? "stopped" : "failed") : end.kind === "done" && end.result.subtype === "success" ? "finished" : "failed";
        if (stop?.envelope === pending.id) {
          if (end.kind === "stopped" && end.killed) stop.killed = true;
          observed(rec, stop, how);
        }
        else if (end.kind === "stopped" && end.by === "user") sayRecoveredStop(rec, pending.id);
        changed(id);
      },
      onChange: () => changed(id),
      onActivity: () => changed(id),
      note: (text, reason) => {
        // A start held by another Claude Code is what the composer already says; the retry note would only repeat it.
        if (deps.blocked(id) !== null && text.startsWith("Claude Code could not start")) return;
        if (reason === "restart") lose(rec, text, null);
        else notice(id, text, "info", reason);
      },
      onDormant() {
        drivers.delete(id);
        session.close();
      },
    });
    drivers.set(id, session);
    return session;
  }

  /** A task and the subagents above it, nearest first. */
  function chain(a: Activity, id: TaskId): Task[] {
    const out: Task[] = [];
    for (let t = a.all.get(id); t && !out.includes(t); t = t.parent === null ? undefined : a.all.get(t.parent)) out.push(t);
    return out;
  }

  /** Whether stopping target ends this task: it is the task or runs under it, or a turn stop reaches its foreground work. */
  const ends = (a: Activity, target: StopTarget, id: TaskId): boolean =>
    target === "all" ? true : typeof target === "object" ? chain(a, id).some((t) => t.id === target.task) : !chain(a, id).some((t) => t.background || t.outlived);

  /**
   * Stop closes the turn's cards, then interrupts. A subagent's card closes with its task, once Claude Code takes the
   * stop. A command that outlived its Claude Code is ended by the bridge itself. The thread says what stopped once it
   * has: a task as Claude Code (or the Mac) confirms it, the turn as Claude Code ends it. It also says what Claude Code
   * refused to stop and what it has not confirmed yet. A stop of everything or of the turn is the run's outcome, and a
   * stop of everything that all landed cuts off every step.
   */
  async function stopRun(rec: SessionRecord, target: StopTarget): Promise<Result> {
    const s = drivers.get(rec.id);
    const a = activityOf(rec);
    const one = typeof target === "object" ? target.task : null;
    const restop = one !== null && deps.now().getTime() - (stoppedAt.get(rec.id)?.get(one) ?? -Infinity) < RESTOP_MS;
    if (one !== null && !a.tasks.some((t) => t.id === one)) return restop ? { ok: true } : refused(cantStop(rec, one) ?? "That task is not running.");
    const inFlight = beingStopped.get(rec.id) ?? new Map<TaskId, Task>();
    if (one !== null && inFlight.has(one)) return { ok: true };
    const named = a.tasks.filter((t) => ends(a, target, t.id) && !inFlight.has(t.id));
    const alone = outlivedOf(rec).filter((o) => named.some((t) => t.id === o.id));
    if (!s && alone.length === 0) return refused(cantStop(rec, one) ?? NOTHING_RUNS);
    const at = now();
    const drive = driveOf(rec);
    const life = drive.session.lifecycle;
    const early = life.kind === "working" && !life.turn.output;
    const envelope = life.kind === "working" || life.kind === "stopping" ? life.turn.pending : life.kind === "backoff" ? (drive.session.pending[0]?.id ?? null) : null;
    const turn = s !== undefined && one === null && (a.turn !== null || envelope !== null);
    const tasksCards = cards(rec).filter((c) => isOpen(c) && c.kind === "permission" && c.agent !== undefined && ends(a, target, c.agent.id as TaskId));
    if (one === null) for (const c of [...cards(rec)]) if (isOpen(c) && (c.kind !== "permission" || !c.agent)) settle(rec, cardIdOf(c), { kind: "stopped" });
    for (const c of tasksCards) stopping.add(cardIdOf(c));
    for (const t of named) inFlight.set(t.id, t);
    beingStopped.set(rec.id, inFlight);
    // Registered before asking: Claude Code can end the turn before the interrupt returns.
    let stop = turnStops.get(rec.id);
    const prompt = drive.session.pending.find((p) => p.id === envelope)?.text ?? null;
    if (turn && stop?.envelope !== envelope) turnStops.set(rec.id, (stop = { envelope, prompt, early, at, said: [], covered: [], whole: false, asking: 0 }));
    if (!turn) stop = undefined;
    if (stop) stop.asking++;
    let r: StopReport;
    let endings: Awaited<ReturnType<typeof endOutlived>>[];
    try {
      const asked = s && (one === null || alone.length === 0) ? s.interrupt(target) : Promise.resolve({ ran: false, refused: [], late: [], woken: false });
      [r, endings] = await Promise.all([asked, Promise.all(alone.map(endOutlived))]);
    } catch (e) {
      if (stop && stop.asking === 1 && !stop.ended && turnStops.get(rec.id) === stop) turnStops.delete(rec.id);
      throw e;
    } finally {
      for (const t of named) inFlight.delete(t.id);
      if (stop) stop.asking--;
    }
    // A turn Claude Code began on its own that ended before the Stop reached it leaves no turn to say.
    if (stop && envelope === null && !r.woken) {
      if (stop.asking === 0 && !stop.ended && turnStops.get(rec.id) === stop) turnStops.delete(rec.id);
      stop = undefined;
    }
    const ending = (t: Task) => endings[alone.findIndex((o) => o.id === t.id)];
    const outlivedBy = (kind: (typeof endings)[number]) => alone.filter((_, i) => endings[i] === kind);
    letGo(rec, outlivedBy("stopped").map((o) => o.id), "stopped");
    letGo(rec, outlivedBy("gone").map((o) => o.id), "ended");
    letGo(rec, outlivedBy("unsure").map((o) => o.id), "unsure");
    const unproven = named.filter((t) => ending(t) === "unsure");
    const already = named.filter((t) => ending(t) === "gone");
    const missed = named.filter((t) => r.refused.includes(t.id) || ending(t) === "survived");
    const late = named.filter((t) => r.late.includes(t.id));
    const done = named.filter((t) => ![...missed, ...late, ...unproven, ...already].includes(t));
    const ran = r.ran || alone.length > 0;
    const fate = (c: OwnCard) => {
      const above = chain(a, (c.kind === "permission" ? c.agent?.id : undefined) as TaskId);
      return above.some((t) => missed.includes(t)) || !r.ran ? "missed" : above.some((t) => late.includes(t)) ? "late" : "done";
    };
    for (const c of tasksCards) {
      const f = fate(c);
      if (f === "missed") stopping.delete(cardIdOf(c));
      else if (f === "done" && isOpen(c)) settle(rec, cardIdOf(c), { kind: "stopped" });
    }
    if (!ran) {
      if (stop && stop.asking === 0) {
        if (stop.ended) sayTurnStop(rec, stop);
        else if (turnStops.get(rec.id) === stop) turnStops.delete(rec.id);
      }
      return refused(cantStop(rec, one) ?? (one === null ? NOTHING_RUNS : "That task is not running."));
    }
    // Claude Code confirms the stop of each task it was asked to stop; a foreground task stops only with its turn.
    const asked = (t: Task) => alone.some((o) => o.id === t.id) || (one !== null ? t.id === one : target === "all" && t.background);
    const confirmed = done.filter(asked);
    const covered = done.filter((t) => !asked(t));
    markStopped(rec, confirmed, one === null);
    // A task already waiting on Claude Code's word is not waited on, or said, twice; one it now confirms waits no more.
    const waited = awaiting.get(rec.id) ?? [];
    const fresh = late.filter((t) => !waited.some((w) => w.task.id === t.id));
    const still = [...waited.filter((w) => !done.some((t) => t.id === w.task.id)), ...fresh.map((task) => ({ task, ofRun: one === null }))];
    if (still.length > 0) awaiting.set(rec.id, still);
    else awaiting.delete(rec.id);
    const whole = target === "all" && missed.length === 0 && late.length === 0;
    // Only a turn of ours surely ends soon; what stopped beside a wake turn is said now, as it may never end.
    const held = stop !== undefined && stop.envelope !== null;
    if (held) addNew(stop!.said, confirmed);
    else if (confirmed.length > 0) {
      notice(rec.id, `${STOPPED_BY_YOU}: ${fewNames(confirmed.map(taskName), listed)}.`, "info", "stop");
      if (one === null) stoppedRun(rec, { early: false, tasks: confirmed, at, envelope: null, whole });
    }
    if (stop) {
      addNew(stop.covered, covered);
      stop.whole ||= whole && held;
      if (stop.ended && stop.asking === 0) sayTurnStop(rec, stop);
    }
    // Named as the composer's refusal names them, so a stop of many long commands stays a short line.
    if (already.length > 0) notice(rec.id, `Your stop came after ${fewOf(already)} had already ended.`, "info", "stop");
    if (unproven.length > 0) notice(rec.id, unsureText(fewOf(unproven), unproven.length), "error", "stop");
    if (missed.length > 0) notice(rec.id, `Couldn't stop ${fewOf(missed)}. ${pick(missed.length, "It", "They")} may still be running.`, "error", "stop");
    if (fresh.length > 0) notice(rec.id, `Claude Code has not confirmed the stop of ${fewOf(fresh)} yet.`, "info", "stop");
    changed(rec.id);
    if (missed.length > 0) return refused(`${missed.every((t) => ending(t) === "survived") ? "The bridge could not stop" : "Claude Code did not stop"} ${fewOf(missed)}.`);
    if (unproven.length > 0)
      return refused(
        `The bridge can no longer tell that ${fewOf(unproven)} ${pick(unproven.length, "is still the command", "are still the commands")} it followed, so it did not stop ${pick(unproven.length, "it", "them")}.`,
      );
    return late.length > 0 ? refused(`Claude Code has not confirmed the stop of ${fewOf(late)} yet.`) : { ok: true };
  }

  return {
    async send(rec, text, clientId, interrupt) {
      const drive = driveOf(rec);
      if (drive.session.pending.some((p) => p.clientId === clientId)) return { ok: true };
      const s = driver(rec);
      if (interrupt) await stopRun(rec, "turn");
      begin(rec);
      s.push({ kind: "envelope", text, initiator: { kind: "user" }, settles: null, clientId });
      changed(rec.id);
      return { ok: true };
    },

    stop: (rec, target = "all") => stopRun(rec, target),

    unqueue(rec, clientId) {
      if (withdrawn.get(rec.id)?.includes(clientId)) return refused("That message was already withdrawn.");
      if (!drivers.get(rec.id)?.unqueue(clientId)) return refused("That message is no longer queued: it already went to Claude.");
      withdrawn.set(rec.id, [...(withdrawn.get(rec.id) ?? []), clientId].slice(-PROMPTS_KEPT));
      changed(rec.id);
      return { ok: true };
    },

    decide(rec, cardId, choice) {
      return settle(rec, cardId, { kind: "choice", choice });
    },

    answer(rec, cardId, answers) {
      return settle(rec, cardId, answers === null ? { kind: "dismissed" } : { kind: "answers", answers });
    },

    async set(rec, patch) {
      const drive = driveOf(rec);
      const live = drivers.get(rec.id)?.controls() ?? null;
      // With no Claude Code to take the change and refuse what it cannot run, only the models the menu offers are kept.
      if (live === null && patch.model != null && !MODELS.some((m) => m.id === patch.model))
        return refused(`Claude Code is not running, so it cannot check the model "${displayName(maskSecrets(patch.model), LINE_MAX)}". Pick one from the menu.`);
      try {
        if (patch.model !== undefined) {
          await live?.setModel(patch.model ?? deps.last(rec.id).model ?? undefined);
          drive.model = patch.model;
        }
        if (patch.mode !== undefined) {
          await live?.setPermissionMode(patch.mode);
          drive.mode = patch.mode;
        }
      } catch (e) {
        return refused(`Claude Code did not take the change: ${plainSdkError(errorText(e))}`);
      } finally {
        deps.persist();
        changed(rec.id);
      }
      return { ok: true };
    },

    overlay(rec) {
      const drive = rec.own;
      if (!drive) return [];
      const items: SessionItem[] = [];
      for (const c of drive.cards) {
        switch (c.kind) {
          case "permission":
            items.push({
              kind: "permission",
              id: c.card.id as string as ItemId,
              at: c.card.at,
              card: { ...c.card },
              // Claude Code writes a subagent's calls to its sidechain, not the thread, so the card sits on the subagent's Agent step.
              stepId: c.agent ? (c.agent.stepId ?? c.toolUseId) : c.toolUseId,
              ...(c.agent?.label && { subagent: c.agent.label }),
            });
            break;
          case "ask":
            items.push({ kind: "ask", id: c.toolUseId as ItemId, at: c.at, questions: c.questions.map((q) => ({ ...q })), answers: c.answers, cardId: c.cardId });
            break;
          case "plan":
            items.push({ kind: "plan", id: c.toolUseId as ItemId, at: c.at, text: c.text, state: c.state, cardId: c.cardId });
            break;
        }
      }
      const life = drive.session.lifecycle;
      const turn = life.kind === "working" || life.kind === "stopping" ? life.turn : null;
      for (const k of drive.kept ?? []) items.push({ kind: "user", id: k.id, at: k.at, text: k.text, from: "user", queued: false });
      for (const r of drive.cutOff ?? []) items.push({ kind: "assistant", id: r.id, at: r.at, text: r.text });
      for (const p of drive.session.pending) {
        if (p.clientId === undefined) continue;
        const took = p.id === turn?.pending ? turn.startedAt : null;
        items.push({ kind: "user", id: p.clientId as ItemId, at: took ?? p.at, text: p.text, from: "user", queued: took === null });
      }
      return [...items, ...(drive.notices ?? [])];
    },

    controls(rec) {
      const s = drivers.get(rec.id);
      const pending = rec.own?.session.pending ?? [];
      const life = rec.own?.session.lifecycle;
      const inFlight = life && (life.kind === "working" || life.kind === "stopping") ? 1 : 0;
      const wait = deps.blocked(rec.id);
      const a = activityOf(rec);
      return {
        canSend: wait === null,
        reason: wait,
        working: (wait === null && (s?.working ?? false)) || runs(a),
        queued: Math.max(0, pending.length - inFlight),
        model: rec.own?.model ?? null,
        models: MODELS,
        mode: modeOf(rec),
        modes: [...PHONE_MODES],
        ...(life && stopPending(life as Lifecycle)),
        ...runControls(a, rec.own?.cards ?? []),
      };
    },

    status(rec) {
      const s = drivers.get(rec.id);
      const open = rec.own?.cards.filter(isOpen) ?? [];
      const a = activityOf(rec);
      const working = (s?.working ?? false) || runs(a);
      const cwd = rec.own?.cwd ?? "";
      const run = rowRun(a, rec.own?.cards ?? [], (c, target) => stepLabel(c.tool, c.input, cwd, target));
      const outcome = rec.own?.outcome;
      const ended = outcome ? { outcome } : {};
      if (s?.unavailable && deps.blocked(rec.id) === null) return { status: "unavailable", working, ...ended };
      // Until the bridge has looked up what outlived Claude Code, the row keeps reading as it did when it died: working.
      if (!working && s?.settling && deaths.has(rec.id)) return { status: "working", working: true, ...ended };
      if (open.some((c) => c.kind !== "ask")) return { status: "awaiting_approval", working, ...run, ...ended };
      if (open.length > 0) return { status: "awaiting_input", working, ...run, ...ended };
      if ((rec.own?.session.pending.length ?? 0) > 0 && deps.blocked(rec.id) !== null) return { status: "parked", working: false, ...ended };
      if (working) return { status: "working", working, ...run, ...ended };
      if (s?.parkedFor) return { status: "parked", working, ...ended };
      if (outcome?.kind === "failed" || outcome?.kind === "lost") return { status: "failed", working, ...ended };
      return { status: "idle", working, ...ended };
    },

    steps(rec) {
      const out = outlivedSteps(allOutlived(rec), { unseen: UNSEEN_END, cantTell: CANT_TELL });
      for (const key of rec.own?.unsure ?? []) out.set(key, { ...out.get(key), ended: { state: "unsure", cause: CANT_TELL }, outlived: true });
      for (const c of rec.own?.cards ?? []) {
        if (c.kind !== "permission") continue;
        if (c.agent) {
          // A subagent carries on after a denied call and returns ok, so its Agent step says what was refused.
          const step = c.agent.stepId;
          if (step !== null && (c.card.answer === "deny" || c.card.answer === "never") && out.get(step)?.ended === undefined)
            out.set(step, { ...out.get(step), ended: { state: "denied", cause: `You denied its ${c.card.tool}: ${displayName(maskSecrets(c.card.detail), LINE_MAX)}` } });
          continue;
        }
        if (isOpen(c)) out.set(c.toolUseId, { ...out.get(c.toolUseId), state: "waiting" });
        else if (c.allowedAt) out.set(c.toolUseId, { ...out.get(c.toolUseId), startedAt: c.allowedAt });
      }
      const a = activityOf(rec);
      // A task a Stop under way ended reads stopped by the user from its first frame, before the Stop's answer is in.
      const landed = landing(rec).flatMap((t) => (t.stepId === null ? [] : [t.stepId]));
      for (const id of [...(rec.own?.stoppedSteps ?? []), ...landed]) out.set(id, { ...out.get(id), ended: { state: "stopped", cause: STOPPED_BY_YOU } });
      for (const t of a.all.values()) if (t.ended && t.stepId !== null) out.set(t.stepId, { ...out.get(t.stepId), ...(t.told && { told: true as const }), ...(t.endedAt !== undefined && { endedAt: t.endedAt }) });
      for (const [id, p] of runningSteps(a)) out.set(id, { ...p, ...out.get(id), state: "running" });
      return out;
    },

    cuts(rec) {
      const drive = rec.own;
      if (!drive) return [];
      const turn = activityOf(rec).turn;
      const s = drivers.get(rec.id);
      // While what became of a gone query's work is still being looked up, it may turn out to run, so nothing is cut.
      const out = drive.cut && !(turn !== null && turn.startedAt <= drive.cut.at) && !s?.settling ? [drive.cut] : [];
      // At rest nothing runs, so a step the transcript still leaves running never got its result.
      // While Claude Code has announced a turn of its own, the work it reports on may not have its result written yet.
      if (!working(rec) && !deps.elsewhere(rec.id) && !s?.wakeDue && !s?.settling) out.push({ at: rested.get(rec.id) ?? bootAt, state: "stopped", cause: UNSEEN_END });
      return out;
    },

    yieldTo(id) {
      const s = drivers.get(id);
      if (s && !s.working) s.reopen();
    },

    unblock(id) {
      if (!held.delete(id)) return;
      drivers.get(id)?.retry();
    },

    resume() {
      for (const rec of deps.world.sessions.values()) {
        if (!rec.own) continue;
        let expired = false;
        for (const c of rec.own.cards) {
          if (!isOpen(c)) continue;
          expired = true;
          if (c.kind === "permission") c.card = { ...c.card, answer: "expired" };
          else if (c.kind === "ask") c.answers = "expired";
          else c.state = "expired";
        }
        if (expired) {
          deps.persist();
          notice(rec.id, "The bridge restarted while Claude Code waited on you, so that question expired.", "info", "restart");
        }
      }
    },

    restart() {
      // A session whose background work the restart killed gets its driver too, which says so in the thread.
      for (const rec of deps.world.sessions.values()) {
        if (!rec.own || (rec.own.session.pending.length === 0 && (rec.own.session.background?.length ?? 0) === 0)) continue;
        driver(rec);
        // After the driver tells how the cut-off turn ended and starts the next queued one, that turn begins a new run.
        queueMicrotask(() => changed(rec.id));
      }
    },

    tick(at) {
      for (const rec of deps.world.sessions.values()) {
        for (const c of rec.own?.cards ?? []) {
          const until = c.kind === "permission" ? c.card.expiresAt : c.expiresAt;
          if (isOpen(c) && until <= at.toISOString()) {
            settle(rec, cardIdOf(c), { kind: "expired" });
            notice(rec.id, expiredText(c, ttl), "info", "approval");
          }
        }
      }
      for (const [id, d] of deaths) {
        if (drivers.get(id)?.settling) continue;
        deaths.delete(id);
        if (deps.world.sessions.get(id)?.own?.outcome?.at !== d.at) continue;
        told.set(id, d.at);
        deps.ended?.(id, d.end, d.at);
      }
      for (const [id, since] of ending) {
        if (at.getTime() - since < END_SETTLE_MS || deaths.has(id)) continue;
        const rec = deps.world.sessions.get(id);
        const s = drivers.get(id);
        if (rec?.own && !working(rec) && (s?.wakeDue || s?.settling)) continue;
        ending.delete(id);
        const outcome = rec?.own?.outcome;
        if (!rec?.own || working(rec) || !outcome || told.get(id) === outcome.at) continue;
        // Work that may still run keeps the run going: it ends once that work has.
        if (unsure(rec)) {
          underway.add(id);
          continue;
        }
        if (outcome.kind === "finished" || outcome.kind === "failed") {
          told.set(id, outcome.at);
          deps.ended?.(id, outcome.kind, outcome.at);
        }
      }
      for (const s of drivers.values()) s.tick(at);
      if (at.getTime() >= nextOutlivedLook) {
        nextOutlivedLook = at.getTime() + OUTLIVED_LOOK_MS;
        for (const rec of deps.world.sessions.values()) if (allOutlived(rec).some((o) => o.over === undefined || o.over === "unsure")) void lookOutlived(rec);
      }
    },

    nextDeadline() {
      let next: string | null = null;
      const consider = (d: string | null) => {
        if (d !== null && (next === null || d < next)) next = d;
      };
      for (const rec of deps.world.sessions.values())
        for (const c of rec.own?.cards ?? []) if (isOpen(c)) consider(c.kind === "permission" ? c.card.expiresAt : c.expiresAt);
      for (const s of drivers.values()) consider(s.nextDeadline());
      // An ending held by an announced wake turn or a lookup waits for the session's own next deadline (the wake's), or
      // the clock's next look, rather than a deadline already past that would have it look every second.
      for (const [id, since] of ending) {
        const s = drivers.get(id);
        if (!(s?.wakeDue || s?.settling)) consider(new Date(since + END_SETTLE_MS).toISOString());
      }
      // A death is told as soon as the lookup of what outlived it is done; the clock looks again each second until then.
      if (deaths.size > 0) consider(deps.now().toISOString());
      if ([...deps.world.sessions.values()].some((rec) => allOutlived(rec).some((o) => o.over === undefined || o.over === "unsure")))
        consider(new Date(nextOutlivedLook).toISOString());
      return next;
    },

    close() {
      for (const s of drivers.values()) s.close();
      drivers.clear();
    },
  };
}

export const newDrive = (fields: { cwd: string; created: boolean; at: string; model: string | null; mode: PhoneMode | null; id: SessionId; prompt?: string }): OwnDrive => ({
  cwd: fields.cwd,
  created: fields.created,
  at: fields.at,
  ...(fields.prompt !== undefined && { prompt: fields.prompt }),
  model: fields.model,
  mode: fields.mode,
  session: emptySession(fields.id),
  cards: [],
});

/**
 * What Always allows, completing the card's "Always allows …": the rules Claude Code suggests, each tool named once
 * before its rules, every rule its own item ("Bash: perl -e 'sleep 45' · echo late *"). The card says the scope.
 */
export function alwaysText(suggestions: readonly PermissionUpdate[]): string {
  const byTool = new Map<string, string[]>();
  for (const s of suggestions) {
    if (s.type !== "addRules" || s.behavior !== "allow") continue;
    for (const r of s.rules) {
      const rules = byTool.get(r.toolName) ?? [];
      const content = r.ruleContent?.trim();
      if (content && !rules.includes(content)) rules.push(content);
      byTool.set(r.toolName, rules);
    }
  }
  if (byTool.size === 0) return "this";
  return [...byTool].map(([tool, rules]) => (rules.length > 0 ? `${tool}: ${rules.join(" · ")}` : tool)).join(" · ");
}
