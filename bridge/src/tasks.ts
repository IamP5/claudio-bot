import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionControls, SessionRow, SessionTask, TaskId, ToolStep } from "./protocol";
import { displayName, fewNames, maskSecrets, middleCut, runTime } from "./text";
import { ownCardId, ownCardOpen, type Cut, type OwnCard } from "./world";

// The work Claude Code runs on one live query besides the turn: subagents and commands, foreground and background,
// read from its task stream. background_tasks_changed is the level for background work and wins over the edges
// (task_started, task_updated, task_notification), which are the only word on foreground tasks. Observed on CLI
// 2.1.305: a subagent is a local_agent task whose id is the agentID its permission asks carry; a subagent's shell names
// it in parent_task_id; a foreground shell becomes a task about 5 s after it starts; a finishing task is patched
// completed and notifies before it leaves the level; a task the bridge or Claude Code stops is patched killed and
// notifies stopped, which is how Claude Code ends a foreground subagent's background shell when the subagent returns.
// A foreground shell past its time limit is patched is_backgrounded and runs on. A subagent that returns while its own
// background work runs notifies completed, and registers again under the same id when that work wakes it.

export type Task = {
  id: TaskId;
  /** The tool_use id of the call that started it; null until task_started names it. */
  stepId: string | null;
  kind: SessionTask["kind"];
  label: string;
  background: boolean;
  /** When its call was made, else when Claude Code registered it; a later registration of the same task keeps it. */
  startedAt: string;
  parent: TaskId | null;
  progress: SessionTask["progress"];
  ended: boolean;
  /** When it ended: Claude Code's end_time when it gave one. */
  endedAt?: string;
  /** Claude Code said it completed or failed. A stop says nothing of the work. */
  told: boolean;
};

export type Tasks = {
  /** Every task of the query; an ended one stays until its turn ends, or while a live task names it as parent. */
  all: Map<TaskId, Task>;
  /** What the last background_tasks_changed listed. */
  listed: Set<TaskId>;
  /** Bash commands by their call's tool_use id, so a command task is named by what it runs; kept while it can. */
  commands: Map<string, string>;
  /** Each Bash call's command as Claude Code was given it, by tool_use id: only compared, never shown, logged or saved. */
  raw: Map<string, string>;
  /** When each Bash or Agent call was made, by tool_use id: a task's start, since Claude Code registers a foreground one late. */
  asked: Map<string, string>;
  /** Main-thread tool calls still waiting for their result. */
  calls: Map<string, Call>;
  /** Tasks the bridge stopped: their end is the user's doing. */
  stopped: Set<TaskId>;
  /**
   * Commands Claude Code stopped while the foreground subagent that started them still ran: it stops them as that
   * subagent returns, and says the subagent ended only after, so the note waits for that word or the turn's end.
   */
  held: Extract<TaskNote, { kind: "lost" }>[];
  /** Grows whenever a task or a main-thread call starts or ends, so a change is seen without comparing lists. */
  rev: number;
};

export type Call = { id: string; tool: string; input: Record<string, unknown> };

/**
 * What the thread is told about a task Claude Code changed on its own, at `at`:
 * - lost: a background task ended without Claude Code saying it completed or failed. killed: Claude Code stopped it.
 * - moved: a foreground command passed its time limit and runs on in the background.
 * - waiting: a subagent returned while a background command of its own runs.
 */
export type TaskNote =
  | { kind: "lost"; task: Task; command: string | null; owner: Task | null; killed: boolean; at: string }
  | { kind: "moved"; task: Task; command: string | null; at: string }
  | { kind: "waiting"; task: Task; on: Task; at: string };

export const emptyTasks = (): Tasks => ({ all: new Map(), listed: new Set(), commands: new Map(), raw: new Map(), asked: new Map(), calls: new Map(), stopped: new Set(), held: [], rev: 0 });

const LABEL_MAX = 200;
/** The whole command on one line, masked, cut from the middle so its end still shows. */
const label = (text: string) => middleCut(displayName(maskSecrets(text.trim()), Infinity), LABEL_MAX);
const kindOf = (type: string | undefined): Task["kind"] => (type === "local_agent" ? "agent" : type === "local_bash" ? "command" : "other");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const liveTasks = (t: Tasks): Task[] => [...t.all.values()].filter((x) => !x.ended);

const commandOf = (t: Tasks, task: Task) => (task.stepId === null ? null : (t.commands.get(task.stepId) ?? null));

/**
 * Ends a task and the foreground tasks under it, which cannot outlive it, noting a background one that was lost.
 * `at` is when Claude Code said so; null when the bridge only infers the end at a turn's end, which times nothing.
 */
function end(t: Tasks, id: TaskId, notes: TaskNote[], killed: boolean, at: string, said = true) {
  const task = t.all.get(id);
  if (!task || task.ended) return;
  task.ended = true;
  if (said) task.endedAt ??= at;
  t.rev++;
  if (task.background && !task.told && !t.stopped.has(id)) {
    const owner = task.parent === null ? null : (t.all.get(task.parent) ?? null);
    const note = { kind: "lost" as const, task, command: commandOf(t, task), owner, killed, at: task.endedAt ?? at };
    if (killed && owner?.kind === "agent" && !owner.background && !owner.ended) t.held.push(note);
    else notes.push(note);
  }
  for (const child of t.all.values()) if (child.parent === id && !child.background) end(t, child.id, notes, killed, at, said);
  release(t, notes, (n) => n.owner === task);
}

function release(t: Tasks, notes: TaskNote[], which: (n: TaskNote & { kind: "lost" }) => boolean) {
  notes.push(...t.held.filter(which));
  t.held = t.held.filter((n) => !which(n));
}

function start(t: Tasks, task: Task) {
  const command = task.kind === "command" && task.stepId !== null ? t.commands.get(task.stepId) : undefined;
  const asked = task.stepId === null ? undefined : t.asked.get(task.stepId);
  const startedAt = t.all.get(task.id)?.startedAt ?? (asked !== undefined && asked < task.startedAt ? asked : task.startedAt);
  t.all.set(task.id, { ...task, startedAt, ...(command && { label: command }) });
  t.rev++;
}

/** A call's time is kept this long for a task Claude Code has not registered yet, a subagent's included. */
const ASKED_KEEP_MS = 10 * 60_000;

/** At a turn's end, when every notification of its tasks is in: drops ended tasks no live task names as parent. */
function prune(t: Tasks, at: string) {
  const parents = new Set(liveTasks(t).flatMap((x) => (x.parent === null ? [] : [x.parent])));
  for (const task of [...t.all.values()]) {
    if (!task.ended || parents.has(task.id)) continue;
    t.all.delete(task.id);
    t.stopped.delete(task.id);
    if (task.stepId !== null) t.commands.delete(task.stepId);
    if (task.stepId !== null) t.raw.delete(task.stepId);
  }
  const steps = new Set([...t.all.values()].map((x) => x.stepId));
  for (const [id, asked] of t.asked) if (!steps.has(id) && !t.calls.has(id) && Date.parse(at) - Date.parse(asked) > ASKED_KEEP_MS) t.asked.delete(id);
}

const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * Folds one message into the ledger. Returns what the thread is told: background tasks that ended with no word that
 * they completed or failed and that the bridge did not stop, a command moved to the background, a subagent left
 * waiting on its own command.
 */
export function observe(t: Tasks, m: SDKMessage, at: string): TaskNote[] {
  const notes: TaskNote[] = [];
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type !== "tool_use" || !isRecord(b.input)) continue;
      if (b.name === "Bash" && typeof b.input.command === "string") {
        t.commands.set(b.id, label(b.input.command));
        t.raw.set(b.id, b.input.command);
      }
      if (b.name === "Bash" || AGENT_TOOLS.has(b.name)) t.asked.set(b.id, at);
      if (m.parent_tool_use_id === null) {
        t.calls.set(b.id, { id: b.id, tool: b.name, input: b.input });
        t.rev++;
      }
    }
  } else if (m.type === "user" && typeof m.message.content !== "string") {
    const running = new Set(liveTasks(t).map((x) => x.stepId));
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      if (!running.has(b.tool_use_id)) t.commands.delete(b.tool_use_id);
      if (!running.has(b.tool_use_id)) t.raw.delete(b.tool_use_id);
      if (m.parent_tool_use_id === null && t.calls.delete(b.tool_use_id)) t.rev++;
    }
  } else if (m.type === "result") {
    release(t, notes, () => true);
    if (t.calls.size > 0) t.rev++;
    t.calls.clear();
    // A foreground task lives inside a turn or a live subagent; one with neither has ended unannounced.
    for (const task of liveTasks(t)) {
      if (!task.background && (task.parent === null || t.all.get(task.parent)?.ended !== false)) end(t, task.id, notes, false, at, false);
    }
    prune(t, at);
  } else if (m.type === "system") {
    switch (m.subtype) {
      case "task_started": {
        if (m.ambient === true || m.skip_transcript === true) break;
        const id = m.task_id as TaskId;
        start(t, {
          id,
          stepId: m.tool_use_id ?? null,
          kind: kindOf(m.task_type),
          label: label(m.description),
          background: m.is_backgrounded === true,
          startedAt: at,
          parent: (m.parent_task_id as TaskId | undefined) ?? null,
          progress: null,
          ended: false,
          told: false,
        });
        t.stopped.delete(id);
        break;
      }
      case "task_progress": {
        const task = t.all.get(m.task_id as TaskId);
        if (task) task.progress = { tools: m.usage.tool_uses, last: m.last_tool_name ?? null, at };
        break;
      }
      case "task_updated": {
        const task = t.all.get(m.task_id as TaskId);
        if (!task) break;
        if (m.patch.is_backgrounded !== undefined && task.background !== m.patch.is_backgrounded) {
          task.background = m.patch.is_backgrounded;
          t.rev++;
          if (task.background && !task.ended && task.kind === "command") notes.push({ kind: "moved", task, command: commandOf(t, task), at });
        }
        if (typeof m.patch.end_time === "number" && !task.ended) task.endedAt = new Date(m.patch.end_time).toISOString();
        if (m.patch.status === "completed" || m.patch.status === "failed") task.told = true;
        if (m.patch.status === "completed" || m.patch.status === "failed" || m.patch.status === "killed") end(t, task.id, notes, m.patch.status === "killed", at);
        break;
      }
      case "task_notification": {
        const task = t.all.get(m.task_id as TaskId);
        if (!task) break;
        if (m.status !== "stopped") task.told = true;
        end(t, task.id, notes, m.status === "stopped", at);
        const on = task.kind === "agent" && m.status === "completed" ? liveTasks(t).find((x) => x.parent === task.id && x.kind === "command") : undefined;
        if (on) notes.push({ kind: "waiting", task, on, at });
        break;
      }
      case "background_tasks_changed": {
        const listed = m.tasks.filter((x) => x.ambient !== true);
        const now = new Set(listed.map((x) => x.task_id as TaskId));
        // A background task that leaves the level has ended; one never listed has once the level empties.
        for (const task of liveTasks(t)) if (task.background && !now.has(task.id) && (t.listed.has(task.id) || now.size === 0)) end(t, task.id, notes, false, at);
        for (const x of listed) {
          const id = x.task_id as TaskId;
          const known = t.all.get(id);
          if (known) {
            if (known.ended || !known.background) t.rev++;
            if (!known.background && !known.ended && known.kind === "command") notes.push({ kind: "moved", task: known, command: commandOf(t, known), at });
            known.ended = false;
            delete known.endedAt;
            known.background = true;
          } else
            start(t, {
              id,
              stepId: null,
              kind: kindOf(x.task_type),
              label: label(x.description),
              background: true,
              startedAt: at,
              parent: (x.parent_task_id as TaskId | undefined) ?? null,
              progress: null,
              ended: false,
              told: false,
            });
        }
        t.listed = now;
        break;
      }
    }
  } else if (m.type === "tool_progress" && m.task_id) {
    const task = t.all.get(m.task_id as TaskId);
    if (task) task.progress = { tools: task.progress?.tools ?? 0, last: task.progress?.last ?? m.tool_name, at };
  }
  return notes;
}

/**
 * Whether a task_notification announces a wake turn. Claude Code wakes for a background task that ended or that the
 * bridge stopped, not for a foreground one or one it stopped itself. A task the ledger never saw wakes, as it may.
 */
export function wakes(t: Tasks, id: TaskId, status: string): boolean {
  const task = t.all.get(id);
  return task?.background !== false && (status !== "stopped" || t.stopped.has(id));
}

const KIND_WORD: Record<Task["kind"], string> = { agent: "background agent", command: "background command", other: "background task" };
const RETURN_MS = 2_000;
const ran = (from: string, to: string) => runTime(Date.parse(to) - Date.parse(from));

/** The thread's words for a task note. Session code posts every note it gets under this name. */
export function lostNotice(n: TaskNote): string {
  const name = (t: Task, command: string | null = null) => `"${command ?? t.label}"`;
  if (n.kind === "moved") return `The command ${name(n.task, n.command)} passed its time limit and kept running in the background.`;
  if (n.kind === "waiting") return `Agent "${n.task.label}" is waiting on its own ${KIND_WORD[n.on.kind]} ${name(n.on)}, which started ${ran(n.on.startedAt, n.at)} before.`;
  const what = `The ${KIND_WORD[n.task.kind]} ${name(n.task, n.command)}${n.owner === null ? "" : `, started by ${n.owner.label},`}`;
  const after = ran(n.task.startedAt, n.at);
  // Claude Code stops a subagent's commands as it returns; a command that ends long after did not end with it.
  const returned = n.owner?.ended && (n.killed || Math.abs(Date.parse(n.at) - Date.parse(n.owner.endedAt ?? n.at)) <= RETURN_MS);
  if (returned && n.killed) return `${what} was stopped by Claude Code when ${n.owner!.label} returned, after ${after}. It did not finish.`;
  if (returned) return `${what} stopped when ${n.owner!.label} returned, after ${after}, and Claude Code did not say how it ended.`;
  if (n.killed) return `${what} was stopped by Claude Code after ${after}. It did not finish.`;
  return `${what} stopped after ${after}, and Claude Code did not say how it ended.`;
}

/** What runs on a session besides its queue. turn: the foreground turn; wake: Claude Code started it on its own. */
export type Activity = {
  turn: { startedAt: string; wake: boolean } | null;
  tasks: Task[];
  /** Every task of the query, so an owner that ended is still found. */
  all: ReadonlyMap<TaskId, Task>;
  calls: Call[];
  /** When Claude Code last said anything on the live query; null while none is open. */
  heardAt: string | null;
};

export const RESTING: Activity = { turn: null, tasks: [], all: new Map(), calls: [], heardAt: null };

export const runs = (a: Activity) => a.turn !== null || a.tasks.length > 0;

type Permission = Extract<OwnCard, { kind: "permission" }>;
const openPermissions = (cards: readonly OwnCard[]) => cards.filter((c): c is Permission => c.kind === "permission" && ownCardOpen(c));

/** When a task's work began: when the user allowed its call, else when the call was made. */
const startOf = (t: Task, cards: readonly OwnCard[]) => cards.find((c): c is Permission => c.kind === "permission" && c.toolUseId === t.stepId && c.allowedAt !== undefined)?.allowedAt ?? t.startedAt;

/** The controls' run fields, given the session's cards: a subagent task waits on the open card it asked. */
export function runControls(a: Activity, cards: readonly OwnCard[]): Pick<SessionControls, "turn" | "tasks" | "heardAt"> {
  return { ...(a.turn && { turn: a.turn }), tasks: wireTasks(a, cards), ...(a.heardAt !== null && { heardAt: a.heardAt }) };
}

function wireTasks(a: Activity, cards: readonly OwnCard[]): SessionTask[] {
  const open = openPermissions(cards);
  return a.tasks.map((t) => {
    const card = open.find((c) => c.agent?.id === t.id);
    return {
      id: t.id,
      stepId: t.stepId,
      kind: t.kind,
      label: t.label,
      background: t.background,
      startedAt: startOf(t, cards),
      owner: t.parent === null ? null : (a.all.get(t.parent)?.stepId ?? null),
      progress: t.progress,
      waiting: card ? ownCardId(card) : null,
    };
  });
}

/** A call's label, given how to name the task a control tool such as TaskStop points at. */
export type CallLabel = (c: Call, target: (taskId: string | null) => string) => string;

/** A task and the tasks it runs under, nearest first. */
function chain(a: Activity, t: Task): Task[] {
  const out: Task[] = [];
  for (let x: Task | undefined = t; x && !out.includes(x); x = x.parent === null ? undefined : a.all.get(x.parent)) out.push(x);
  return out;
}

const WAITS: Record<string, string> = { AskUserQuestion: "Waiting for your answer", ExitPlanMode: "Waiting for plan approval" };

/**
 * The row's run: since when, what runs, and one line on what it is doing. Counts are top-level work: a subagent counts
 * while its step runs, waiting on its own command included, and a command it started is not counted again. A
 * main-thread command counts from its call, since Claude Code registers a foreground one seconds late.
 */
export function rowRun(a: Activity, cards: readonly OwnCard[], call: CallLabel): Pick<SessionRow, "since" | "running" | "activity"> {
  if (!runs(a)) return {};
  const target = (id: string | null) => {
    const t = id === null ? undefined : a.all.get(id as TaskId);
    return t ? `${t.kind === "agent" ? "agent" : "background command"}: ${t.label}` : "a background task";
  };
  const agents = [...new Set(a.tasks.flatMap((t) => chain(a, t).filter((x) => x.kind === "agent")))];
  const commands = a.tasks.filter((t) => t.kind === "command" && !chain(a, t).some((x) => x.kind === "agent"));
  const open = openPermissions(cards);
  const registered = new Set([...a.all.values()].map((t) => t.stepId));
  const unregistered = a.calls.filter((c) => c.tool === "Bash" && !registered.has(c.id) && !open.some((o) => o.toolUseId === c.id));
  const starts = [...(a.turn ? [a.turn.startedAt] : []), ...a.tasks.map((t) => startOf(t, cards)), ...agents.map((t) => startOf(t, cards))].sort();
  const background = a.tasks.filter((t) => t.background);
  const last = a.calls.at(-1);
  const asking = cards.find((c) => c.kind !== "permission" && ownCardOpen(c));
  const first = open[0];
  const activity = first
    ? `Waiting for approval: ${first.card.tool}${first.agent?.label ? ` in ${first.agent.label}` : ""}${open.length > 1 ? ` (${open.length} waiting)` : ""}`
    : asking
      ? WAITS[asking.kind === "ask" ? "AskUserQuestion" : "ExitPlanMode"]!
      : agents.length > 1
        ? `${fewNames(agents.map((t) => t.label), (names) => (names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`))} running`
        : last
          ? (WAITS[last.tool] ?? call(last, target))
          : background.length > 0
            ? `Background: ${background[0]!.label}${background.length > 1 ? ` and ${background.length - 1} more` : ""}`
            : null;
  return {
    since: starts[0]!,
    running: { agents: agents.length, commands: commands.length + unregistered.length },
    ...(activity !== null && { activity }),
  };
}

/**
 * How the bridge's live view changes a transcript step: waiting on a card, still running, started when approved.
 * ended: how a call that reads running, or ok, really ended: the user stopped its task, or denied a call its subagent
 * asked for.
 */
export type StepPatch = {
  state?: "waiting" | "running";
  startedAt?: string;
  ended?: { state: "stopped" | "denied" | "unsure" | "ended"; cause: string };
  /** When its task ended, as Claude Code timed it: a settled step ends then. */
  endedAt?: string;
  /**
   * The step of a command that outlived its Claude Code: a later Claude Code's "stopped", or the "interrupted" error it
   * writes for a foreground call it never saw end, does not hold.
   */
  outlived?: true;
  /** Claude Code said its task completed or failed, so its result is on its way to the transcript: no cut ends it. */
  told?: true;
};

/**
 * Steps whose work still runs, each live task's own call and the calls of the subagents above it, with the patch that
 * says so. A step keeps the start its call has.
 */
export function runningSteps(a: Activity): Map<string, StepPatch> {
  const out = new Map<string, StepPatch>();
  for (const t of a.tasks) for (const x of chain(a, t)) if (x.stepId !== null && !out.has(x.stepId)) out.set(x.stepId, { state: "running" });
  return out;
}

/** A transcript step as shown: a waiting card only over a call that reads running, a live task never over a failure. */
export function patchStep(shown: ToolStep, p: StepPatch): ToolStep {
  const step = p.outlived && (shown.state === "stopped" || shown.state === "error") ? unclaimed(shown) : shown;
  const started = p.startedAt !== undefined ? { startedAt: p.startedAt } : {};
  if (p.state === undefined && p.ended && step.state === (p.ended.state === "denied" ? "ok" : "running")) {
    const endedAt = step.endedAt ?? p.endedAt;
    return { ...step, state: p.ended.state, cause: p.ended.cause, ...(endedAt !== undefined && { endedAt }) };
  }
  if (p.state === "running" && step.state === "ok") return { ...unclaimed(step), ...started };
  if (p.state === "waiting" && step.state === "running") return { ...step, state: "waiting", ...started };
  if (step.state === "running" || step.state === "waiting") return { ...step, ...started };
  return { ...step, ...started, ...(p.endedAt !== undefined && { endedAt: p.endedAt }) };
}

/** A step whose work runs on: no end, cause or result from a Claude Code that never saw it end. */
function unclaimed(step: ToolStep): ToolStep {
  const { cause: _cause, endedAt: _endedAt, ...rest } = step;
  return { ...rest, state: "running", output: null };
}

/** A transcript step as shown once its work was cut off: one that still reads running takes the first cut after its start. */
export function cutStep(step: ToolStep, cuts: readonly Cut[]): ToolStep {
  const started = step.startedAt;
  if (step.state !== "running" || started === undefined) return step;
  const cut = cuts.filter((c) => started <= c.at).sort((a, b) => a.at.localeCompare(b.at))[0];
  return cut ? { ...step, state: cut.state, cause: cut.cause, endedAt: step.endedAt ?? cut.at } : step;
}
