import type { CanUseTool, HookCallbackMatcher, Options, PermissionResult, PermissionUpdate, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Driven } from "./catalog";
import type { Tickable } from "./clock";
import { failClosed, resolveReal, toCall, toHookOutput } from "./gate";
import type { Ledger } from "./ledger";
import { detailOf, floors, type Scope } from "./policy";
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
import { createSession, RESTARTED_ERROR, type Session, type SessionSpec, type TurnEnd } from "./session";
import type { Persist } from "./store";
import { RESTING, rowRun, runControls, runningSteps, runs, type Activity, type StepPatch, type Task } from "./tasks";
import { displayName, errorText, maskSecrets } from "./text";
import { maskSummary, stepLabel } from "./transcript";
import { emptySession, newMessageId, ownCardId, ownCardOpen, type Cut, type OwnCard, type OwnDrive, type SessionRecord, type World } from "./world";

// The drivers of sessions the user drives from the phone: one session.ts Session per id, opened in the transcript's
// cwd with the user's own Claude Code settings. What Claude Code asks (a permission, AskUserQuestion, ExitPlanMode)
// waits as a card in the thread until the phone answers it; a PreToolUse hook adds only the policy's floors.

export type OwnDeps = {
  world: World;
  userName: string;
  ledger: Ledger;
  persist: Persist;
  claude: Pick<SessionSpec, "query" | "executable">;
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
  /** Every message of the live query, for the streaming text. */
  observe?(id: SessionId, m: Parameters<SessionSpec["onMessage"]>[0]): void;
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
/** An own session's query with nothing to do closes after this; an agent's stays 15 minutes. */
export const OWN_IDLE_MS = 10 * 60_000;
const SETTLED_KEPT = 20;
const NOTICES_KEPT = 10;
const PROMPTS_KEPT = 5;
const STOPPED_STEPS_KEPT = 20;
const LINE_MAX = 160;

const NOTHING_RUNS = "Nothing is running.";
const STOPPED_BY_YOU = "Stopped by you";
const RESTARTED = "The bridge restarted";
const UNSEEN_END = "It ended without a result";
/** What the SDK says when Claude Code's process ends under a query. */
const DIED = /^Claude Code process (exited|terminated)/;

const line = (text: string) => displayName(maskSecrets(text.split("\n")[0] ?? ""), LINE_MAX);
const listed = (parts: readonly string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** A refusal the phone shows under its composer: at most two commands, each on one short line, then how many more. */
const fewOf = (tasks: readonly Task[]) => {
  const names = tasks.map((t) => displayName(t.label, 40));
  return names.length <= 2 ? listed(names) : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
};
const KIND_WORD: Record<Task["kind"], string> = { agent: "agent", command: "command", other: "task" };
const taskName = (t: Task) => `${KIND_WORD[t.kind]} "${t.label}"`;

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
  /** Claude Code's summary of the last background task that ended in the run: the row's line when the run finishes. */
  const lastTask = new Map<SessionId, string>();
  /** Subagent cards a task stop covers: when their query gives up on them, the user's stop closed them. */
  const stopping = new Set<MessageId>();
  /** Task stops Claude Code had not confirmed within the wait; each counts as the user's once the task is gone. */
  const awaiting = new Map<SessionId, Task[]>();
  /** When each session last came to rest; one that has not run since the bridge started rests since then. */
  const rested = new Map<SessionId, string>();
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
  const activityOf = (rec: SessionRecord): Activity => drivers.get(rec.id)?.activity() ?? RESTING;

  const working = (rec: SessionRecord) => (drivers.get(rec.id)?.working ?? false) || runs(activityOf(rec));

  /** A new run starts: how the last one ended no longer shows. */
  function begin(rec: SessionRecord) {
    const drive = driveOf(rec);
    delete drive.outcome;
    delete drive.endedTurn;
    stoppedBy.delete(rec.id);
    lastTask.delete(rec.id);
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
      const life = drive.session.lifecycle;
      const turn = life.kind === "working" || life.kind === "stopping" ? life.turn.pending : null;
      if (life.kind === "working" || life.kind === "stopping") taken.set(id, { turn: life.turn.pending, at: life.turn.startedAt });
      if (drive.outcome && drive.outcome.kind !== "finished" && turn !== null && turn !== drive.endedTurn) begin(rec);
      if (working(rec)) {
        underway.add(id);
        rested.delete(id);
      } else {
        if (!rested.has(id)) rested.set(id, now());
        if (underway.delete(id) && (!drive.outcome || drive.outcome.kind === "finished")) {
          drive.outcome = stoppedBy.has(id) ? { kind: "stopped", text: STOPPED_BY_YOU, at: now() } : { kind: "finished", text: lastTask.get(id) ?? "Finished", at: now() };
          deps.persist("now");
        }
      }
    }
    deps.changed(id);
  }

  /** The tasks the user stopped are the user's doing: the run reads stopped, and their steps read stopped. */
  function markStopped(rec: SessionRecord, tasks: readonly Task[]) {
    if (tasks.length === 0) return;
    stoppedBy.add(rec.id);
    const drive = driveOf(rec);
    const steps = tasks.flatMap((t) => (t.stepId === null ? [] : [t.stepId]));
    if (steps.length > 0) drive.stoppedSteps = [...(drive.stoppedSteps ?? []), ...steps].slice(-STOPPED_STEPS_KEPT);
    deps.persist("now");
  }

  /** A task stop Claude Code confirmed late lands once the task is gone. */
  function confirmLate(rec: SessionRecord) {
    const late = awaiting.get(rec.id);
    if (!late) return;
    const live = new Set(activityOf(rec).tasks.map((t) => t.id));
    const gone = late.filter((t) => !live.has(t.id));
    if (gone.length === 0) return;
    const left = late.filter((t) => live.has(t.id));
    if (left.length > 0) awaiting.set(rec.id, left);
    else awaiting.delete(rec.id);
    markStopped(rec, gone);
    for (const c of [...cards(rec)]) if (c.kind === "permission" && c.agent && isOpen(c) && stopping.has(cardIdOf(c)) && !live.has(c.agent.id as TaskId)) settle(rec, cardIdOf(c), { kind: "stopped" });
    notice(rec.id, `${STOPPED_BY_YOU}: ${listed(gone.map(taskName))}.`, "info", "stop");
  }

  function notice(id: SessionId, text: string, tone: "info" | "error" = "info", reason?: NoticeReason) {
    const drive = deps.world.sessions.get(id)?.own;
    if (!drive) return;
    const item = { kind: "notice", id: `n_${crypto.randomUUID()}` as ItemId, at: now(), text, tone, ...(reason && { reason }) } as const;
    drive.notices = [...(drive.notices ?? []), item].slice(-NOTICES_KEPT);
    deps.persist("now");
    changed(id);
  }

  /** turn: the envelope whose turn this ended, if any. */
  function end(rec: SessionRecord, outcome: SessionOutcome, turn: string | null, cut?: Omit<Cut, "at">) {
    const drive = driveOf(rec);
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
      return notice(rec.id, `Claude Code stopped unexpectedly. Send a message to start it again.\n${maskSecrets(error)}`, "error", "failure");
    }
    end(rec, { kind: "failed", text: line(error), at }, turn, { state: "error", cause: line(error) });
    notice(rec.id, maskSecrets(error), "error", "failure");
  }

  /** A bridge restart cut the run off. */
  function lose(rec: SessionRecord, text: string, turn: string | null) {
    end(rec, { kind: "lost", text: line(text), at: now() }, turn, { state: "stopped", cause: RESTARTED });
    notice(rec.id, text, "info", "restart");
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
        card.answers = reply.kind === "answers" ? reply.answers : reply.kind === "dismissed" ? "dismissed" : "expired";
        break;
      case "plan":
        if (reply.kind === "answers" || reply.kind === "dismissed") return refused("A plan takes a choice");
        card.state = reply.kind !== "choice" ? "expired" : reply.choice === "once" || reply.choice === "always" ? "approved" : "rejected";
        break;
    }
    prune(rec);
    deps.persist();
    stopping.delete(cardId);
    waiting.get(cardId)?.(reply);
    changed(rec.id);
    return { ok: true };
  }

  const expiresAt = () => new Date(deps.now().getTime() + OWN_CARD_TTL_MS).toISOString();

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
        if (m.type === "system" && m.subtype === "task_notification" && m.status !== "stopped" && m.summary) {
          const task = drivers.get(id)?.activity().all.get(m.task_id as TaskId);
          lastTask.set(id, displayName(maskSummary(m.summary.split("\n")[0] ?? "", task?.label ?? null), LINE_MAX));
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
        else if (end.kind === "done") deps.done(id);
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
    target === "all" ? true : typeof target === "object" ? chain(a, id).some((t) => t.id === target.task) : !chain(a, id).some((t) => t.background);

  /**
   * Stop closes the turn's cards, then interrupts. A subagent's card closes with its task, once Claude Code takes the
   * stop. The thread says what stopped, what Claude Code refused to stop and what it has not confirmed yet. A stop that
   * ended the turn or something else is the run's outcome, and a stop of everything that all landed cuts off every step.
   */
  async function stopRun(rec: SessionRecord, target: StopTarget): Promise<Result> {
    const s = drivers.get(rec.id);
    const a = activityOf(rec);
    const one = typeof target === "object" ? target.task : null;
    if (one !== null && !a.tasks.some((t) => t.id === one)) return refused("That task is not running.");
    if (!s) return refused(NOTHING_RUNS);
    const at = now();
    const drive = driveOf(rec);
    const life = drive.session.lifecycle;
    const early = life.kind === "working" && !life.turn.output;
    const ending = life.kind === "working" || life.kind === "stopping" ? life.turn.pending : life.kind === "backoff" ? (drive.session.pending[0]?.id ?? null) : null;
    const turn = one === null && (a.turn !== null || ending !== null);
    const named = a.tasks.filter((t) => ends(a, target, t.id));
    const tasksCards = cards(rec).filter((c) => isOpen(c) && c.kind === "permission" && c.agent !== undefined && ends(a, target, c.agent.id as TaskId));
    if (one === null) for (const c of [...cards(rec)]) if (isOpen(c) && (c.kind !== "permission" || !c.agent)) settle(rec, cardIdOf(c), { kind: "stopped" });
    for (const c of tasksCards) stopping.add(cardIdOf(c));
    const r = await s.interrupt(target);
    const missed = named.filter((t) => r.refused.includes(t.id));
    const late = named.filter((t) => r.late.includes(t.id));
    const done = named.filter((t) => !missed.includes(t) && !late.includes(t));
    const fate = (c: OwnCard) => {
      const above = chain(a, (c.kind === "permission" ? c.agent?.id : undefined) as TaskId);
      return above.some((t) => missed.includes(t)) || !r.ran ? "missed" : above.some((t) => late.includes(t)) ? "late" : "done";
    };
    for (const c of tasksCards) {
      const f = fate(c);
      if (f === "missed") stopping.delete(cardIdOf(c));
      else if (f === "done" && isOpen(c)) settle(rec, cardIdOf(c), { kind: "stopped" });
    }
    if (!r.ran) return refused(one === null ? NOTHING_RUNS : "That task is not running.");
    if (turn) stoppedBy.add(rec.id);
    markStopped(rec, done);
    if (late.length > 0) awaiting.set(rec.id, [...(awaiting.get(rec.id) ?? []), ...late]);
    const parts = [...(turn ? ["the turn"] : []), ...done.map(taskName)];
    if (parts.length > 0) notice(rec.id, early && done.length === 0 ? `${STOPPED_BY_YOU} before Claude replied.` : `${STOPPED_BY_YOU}: ${listed(parts)}.`, "info", "stop");
    if (missed.length > 0) notice(rec.id, `Couldn't stop ${listed(missed.map(taskName))}. It may still be running.`, "error", "stop");
    if (late.length > 0) notice(rec.id, `Claude Code has not confirmed the stop of ${listed(late.map(taskName))} yet.`, "info", "stop");
    if (one === null && parts.length > 0) {
      const of = (kind: Task["kind"]) => done.filter((t) => t.kind === kind).length;
      const what = [...(turn ? ["the turn"] : []), ...(["agent", "command", "other"] as const).flatMap((k) => (of(k) > 0 ? [counted(of(k), KIND_WORD[k])] : []))];
      const all = target === "all" && missed.length === 0 && late.length === 0;
      end(rec, { kind: "stopped", text: `${STOPPED_BY_YOU}: ${what.join(", ")}`, at }, ending, all ? { state: "stopped", cause: STOPPED_BY_YOU } : undefined);
    }
    changed(rec.id);
    if (missed.length > 0) return refused(`Claude Code did not stop ${fewOf(missed)}.`);
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
        return refused(`Claude Code did not take the change: ${errorText(e)}`);
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
            items.push({ kind: "ask", id: c.toolUseId as ItemId, at: c.at, questions: c.questions.map((q) => ({ ...q })), answers: c.answers, cardId: c.answers === null ? c.cardId : null });
            break;
          case "plan":
            items.push({ kind: "plan", id: c.toolUseId as ItemId, at: c.at, text: c.text, state: c.state, cardId: c.state === "proposed" ? c.cardId : null });
            break;
        }
      }
      const life = drive.session.lifecycle;
      const turn = life.kind === "working" || life.kind === "stopping" ? life.turn : null;
      for (const k of drive.kept ?? []) items.push({ kind: "user", id: k.id, at: k.at, text: k.text, from: "user", queued: false });
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
      const open = rec.own?.cards.filter((c) => c.kind === "permission" && isOpen(c) && c.agent) ?? [];
      return {
        canSend: wait === null,
        reason: wait,
        working: (wait === null && (s?.working ?? false)) || runs(a),
        queued: Math.max(0, pending.length - inFlight),
        model: rec.own?.model ?? null,
        models: MODELS,
        mode: modeOf(rec),
        modes: [...PHONE_MODES],
        ...runControls(a, (t) => {
          const card = open.find((c) => c.kind === "permission" && c.agent?.id === t.id);
          return card ? cardIdOf(card) : null;
        }),
      };
    },

    status(rec) {
      const s = drivers.get(rec.id);
      const open = rec.own?.cards.filter(isOpen) ?? [];
      const a = activityOf(rec);
      const working = (s?.working ?? false) || runs(a);
      const asking = open.find((c) => c.kind === "permission");
      const cwd = rec.own?.cwd ?? "";
      const run = rowRun(a, asking?.kind === "permission" ? asking.card.tool : null, (c, target) => stepLabel(c.tool, c.input, cwd, target));
      const outcome = rec.own?.outcome;
      const ended = outcome ? { outcome } : {};
      if (s?.unavailable && deps.blocked(rec.id) === null) return { status: "unavailable", working, ...ended };
      if (open.some((c) => c.kind !== "ask")) return { status: "awaiting_approval", working, ...run, ...ended };
      if (open.length > 0) return { status: "awaiting_input", working, ...run, ...ended };
      if ((rec.own?.session.pending.length ?? 0) > 0 && deps.blocked(rec.id) !== null) return { status: "parked", working: false, ...ended };
      if (working) return { status: "working", working, ...run, ...ended };
      if (s?.parkedFor) return { status: "parked", working, ...ended };
      if (outcome?.kind === "failed" || outcome?.kind === "lost") return { status: "failed", working, ...ended };
      return { status: "idle", working, ...ended };
    },

    steps(rec) {
      const out = new Map<string, StepPatch>();
      for (const c of rec.own?.cards ?? []) {
        if (c.kind !== "permission") continue;
        if (c.agent) {
          // A subagent carries on after a denied call and returns ok, so its Agent step says what was refused.
          const step = c.agent.stepId;
          if (step !== null && (c.card.answer === "deny" || c.card.answer === "never") && !out.has(step))
            out.set(step, { ended: { state: "denied", cause: `You denied its ${c.card.tool}: ${displayName(maskSecrets(c.card.detail), LINE_MAX)}` } });
          continue;
        }
        if (isOpen(c)) out.set(c.toolUseId, { state: "waiting" });
        else if (c.allowedAt) out.set(c.toolUseId, { startedAt: c.allowedAt });
      }
      for (const id of rec.own?.stoppedSteps ?? []) out.set(id, { ...out.get(id), ended: { state: "stopped", cause: STOPPED_BY_YOU } });
      for (const [id, p] of runningSteps(activityOf(rec))) out.set(id, { ...p, ...out.get(id), state: "running" });
      return out;
    },

    cuts(rec) {
      const drive = rec.own;
      if (!drive) return [];
      const turn = activityOf(rec).turn;
      const out = drive.cut && !(turn !== null && turn.startedAt <= drive.cut.at) ? [drive.cut] : [];
      // At rest nothing runs, so a step the transcript still leaves running never got its result.
      if (!working(rec) && !deps.elsewhere(rec.id)) out.push({ at: rested.get(rec.id) ?? bootAt, state: "stopped", cause: UNSEEN_END });
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
            notice(rec.id, "A request waited two hours unanswered, so it was denied. You did not say no.", "info", "approval");
          }
        }
      }
      for (const s of drivers.values()) s.tick(at);
    },

    nextDeadline() {
      let next: string | null = null;
      const consider = (d: string | null) => {
        if (d !== null && (next === null || d < next)) next = d;
      };
      for (const rec of deps.world.sessions.values())
        for (const c of rec.own?.cards ?? []) if (isOpen(c)) consider(c.kind === "permission" ? c.card.expiresAt : c.expiresAt);
      for (const s of drivers.values()) consider(s.nextDeadline());
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
