import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId, SessionControls, SessionRow, SessionTask, TaskId, ToolStep } from "./protocol";
import { displayName, maskSecrets } from "./text";

// The work Claude Code runs on one live query besides the turn: subagents and commands, foreground and background,
// read from its task stream. background_tasks_changed is the level for background work and wins over the edges
// (task_started, task_updated, task_notification), which are the only word on foreground tasks. Observed on CLI
// 2.1.305: a subagent is a local_agent task whose id is the agentID its permission asks carry; a subagent's shell names
// it in parent_task_id; a foreground shell becomes a task about 5 s after it starts; a finishing task is patched
// completed and notifies before it leaves the level; a task the bridge or Claude Code stops is patched killed and
// notifies stopped, which is how Claude Code ends a foreground subagent's background shell when the subagent returns.

export type Task = {
  id: TaskId;
  /** The tool_use id of the call that started it; null until task_started names it. */
  stepId: string | null;
  kind: SessionTask["kind"];
  label: string;
  background: boolean;
  startedAt: string;
  parent: TaskId | null;
  progress: SessionTask["progress"];
  ended: boolean;
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
  /** Main-thread tool calls still waiting for their result. */
  calls: Map<string, { tool: string; input: Record<string, unknown> }>;
  /** Tasks the bridge stopped: their end is the user's doing. */
  stopped: Set<TaskId>;
  /** Grows whenever a task or a main-thread call starts or ends, so a change is seen without comparing lists. */
  rev: number;
};

/** A background task that ended without Claude Code saying it completed or failed. killed: Claude Code stopped it. */
export type Lost = { task: Task; command: string | null; owner: Task | null; killed: boolean };

export const emptyTasks = (): Tasks => ({ all: new Map(), listed: new Set(), commands: new Map(), calls: new Map(), stopped: new Set(), rev: 0 });

const LABEL_MAX = 80;
const label = (text: string) => displayName(maskSecrets(text), LABEL_MAX);
const firstLine = (s: string) => displayName(maskSecrets(s.trim()).split("\n")[0] ?? "", LABEL_MAX);
const kindOf = (type: string | undefined): Task["kind"] => (type === "local_agent" ? "agent" : type === "local_bash" ? "command" : "other");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const liveTasks = (t: Tasks): Task[] => [...t.all.values()].filter((x) => !x.ended);

/** Ends a task and the foreground tasks under it, which cannot outlive it, noting a background one that was lost. */
function end(t: Tasks, id: TaskId, lost: Lost[], killed: boolean) {
  const task = t.all.get(id);
  if (!task || task.ended) return;
  task.ended = true;
  t.rev++;
  if (task.background && !task.told && !t.stopped.has(id)) {
    const owner = task.parent === null ? null : (t.all.get(task.parent) ?? null);
    lost.push({ task, command: task.stepId === null ? null : (t.commands.get(task.stepId) ?? null), owner, killed });
  }
  for (const child of t.all.values()) if (child.parent === id && !child.background) end(t, child.id, lost, killed);
}

function start(t: Tasks, task: Task) {
  const command = task.kind === "command" && task.stepId !== null ? t.commands.get(task.stepId) : undefined;
  t.all.set(task.id, command ? { ...task, label: command } : task);
  t.rev++;
}

/** At a turn's end, when every notification of its tasks is in: drops ended tasks no live task names as parent. */
function prune(t: Tasks) {
  const parents = new Set(liveTasks(t).flatMap((x) => (x.parent === null ? [] : [x.parent])));
  for (const task of [...t.all.values()]) {
    if (!task.ended || parents.has(task.id)) continue;
    t.all.delete(task.id);
    t.stopped.delete(task.id);
    if (task.stepId !== null) t.commands.delete(task.stepId);
  }
}

/**
 * Folds one message into the ledger. Returns the background tasks that ended with no word that they completed or
 * failed and that the bridge did not stop, which the thread then names.
 */
export function observe(t: Tasks, m: SDKMessage, at: string): Lost[] {
  const lost: Lost[] = [];
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type !== "tool_use" || !isRecord(b.input)) continue;
      if (b.name === "Bash" && typeof b.input.command === "string") t.commands.set(b.id, firstLine(b.input.command));
      if (m.parent_tool_use_id === null) {
        t.calls.set(b.id, { tool: b.name, input: b.input });
        t.rev++;
      }
    }
  } else if (m.type === "user" && typeof m.message.content !== "string") {
    const running = new Set(liveTasks(t).map((x) => x.stepId));
    for (const b of m.message.content) {
      if (b.type !== "tool_result") continue;
      if (!running.has(b.tool_use_id)) t.commands.delete(b.tool_use_id);
      if (m.parent_tool_use_id === null && t.calls.delete(b.tool_use_id)) t.rev++;
    }
  } else if (m.type === "result") {
    if (t.calls.size > 0) t.rev++;
    t.calls.clear();
    // A foreground task lives inside a turn or a live subagent; one with neither has ended unannounced.
    for (const task of liveTasks(t)) {
      if (!task.background && (task.parent === null || t.all.get(task.parent)?.ended !== false)) end(t, task.id, lost, false);
    }
    prune(t);
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
        }
        if (m.patch.status === "completed" || m.patch.status === "failed") task.told = true;
        if (m.patch.status === "completed" || m.patch.status === "failed" || m.patch.status === "killed") end(t, task.id, lost, m.patch.status === "killed");
        break;
      }
      case "task_notification": {
        const task = t.all.get(m.task_id as TaskId);
        if (!task) break;
        if (m.status !== "stopped") task.told = true;
        end(t, task.id, lost, m.status === "stopped");
        break;
      }
      case "background_tasks_changed": {
        const listed = m.tasks.filter((x) => x.ambient !== true);
        const now = new Set(listed.map((x) => x.task_id as TaskId));
        // A background task that leaves the level has ended; one never listed has once the level empties.
        for (const task of liveTasks(t)) if (task.background && !now.has(task.id) && (t.listed.has(task.id) || now.size === 0)) end(t, task.id, lost, false);
        for (const x of listed) {
          const id = x.task_id as TaskId;
          const known = t.all.get(id);
          if (known) {
            if (known.ended || !known.background) t.rev++;
            known.ended = false;
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
  return lost;
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

export function lostNotice(l: Lost): string {
  const what = `The ${KIND_WORD[l.task.kind]} "${l.command ?? l.task.label}"${l.owner === null ? "" : `, started by ${l.owner.label},`}`;
  if (l.killed) return `${what} was stopped by Claude Code.`;
  if (l.owner?.ended) return `${what} was stopped when ${l.owner.label} returned.`;
  return `${what} stopped, and Claude Code did not say how it ended.`;
}

/** What runs on a session besides its queue. turn: the foreground turn; wake: Claude Code started it on its own. */
export type Activity = {
  turn: { startedAt: string; wake: boolean } | null;
  tasks: Task[];
  /** Every task of the query, so an owner that ended is still found. */
  all: ReadonlyMap<TaskId, Task>;
  calls: { tool: string; input: Record<string, unknown> }[];
  /** When Claude Code last said anything on the live query; null while none is open. */
  heardAt: string | null;
};

export const RESTING: Activity = { turn: null, tasks: [], all: new Map(), calls: [], heardAt: null };

export const runs = (a: Activity) => a.turn !== null || a.tasks.length > 0;

/** The controls' run fields. waiting: the open card a subagent task is blocked on. */
export function runControls(a: Activity, waiting: (t: Task) => MessageId | null): Pick<SessionControls, "turn" | "tasks" | "heardAt"> {
  return { ...(a.turn && { turn: a.turn }), tasks: wireTasks(a, waiting), ...(a.heardAt !== null && { heardAt: a.heardAt }) };
}

function wireTasks(a: Activity, waiting: (t: Task) => MessageId | null): SessionTask[] {
  return a.tasks.map((t) => ({
    id: t.id,
    stepId: t.stepId,
    kind: t.kind,
    label: t.label,
    background: t.background,
    startedAt: t.startedAt,
    owner: t.parent === null ? null : (a.all.get(t.parent)?.stepId ?? null),
    progress: t.progress,
    waiting: waiting(t),
  }));
}

/** A call's label, given how to name the task a control tool such as TaskStop points at. */
export type CallLabel = (c: Activity["calls"][number], target: (taskId: string | null) => string) => string;

export function rowRun(a: Activity, card: string | null, call: CallLabel): Pick<SessionRow, "since" | "running" | "activity"> {
  if (!runs(a)) return {};
  const target = (id: string | null) => {
    const t = id === null ? undefined : a.all.get(id as TaskId);
    return t ? `${t.kind === "agent" ? "agent" : "background command"}: ${t.label}` : "a background task";
  };
  const starts = [...(a.turn ? [a.turn.startedAt] : []), ...a.tasks.map((t) => t.startedAt)].sort();
  const background = a.tasks.filter((t) => t.background);
  const last = a.calls.at(-1);
  const activity =
    card !== null
      ? `Waiting for approval: ${card}`
      : last
        ? call(last, target)
        : background.length > 0
          ? `Background: ${background[0]!.label}${background.length > 1 ? ` and ${background.length - 1} more` : ""}`
          : null;
  return {
    since: starts[0]!,
    running: { agents: a.tasks.filter((t) => t.kind === "agent").length, commands: a.tasks.filter((t) => t.kind === "command").length },
    ...(activity !== null && { activity }),
  };
}

/** How the bridge's live view changes a transcript step: waiting on a card, still running, started when approved. */
export type StepPatch = { state?: "waiting" | "running"; startedAt?: string };

/**
 * Steps whose work still runs, each live task's own call and the calls of the subagents above it, with the patch that
 * says so. A background task starts when Claude Code registers it; a foreground one is registered seconds late, so
 * its step keeps the time it already has.
 */
export function runningSteps(a: Activity): Map<string, StepPatch> {
  const out = new Map<string, StepPatch>();
  for (const t of a.tasks) {
    const seen = new Set<TaskId>();
    for (let x: Task | undefined = t; x && !seen.has(x.id); x = x.parent === null ? undefined : a.all.get(x.parent)) {
      seen.add(x.id);
      if (x.stepId !== null && !out.has(x.stepId)) out.set(x.stepId, { state: "running", ...(x.background && { startedAt: x.startedAt }) });
    }
  }
  return out;
}

/** A transcript step as shown: a waiting card only over a call that reads running, a live task never over a failure. */
export function patchStep(step: ToolStep, p: StepPatch): ToolStep {
  const state = p.state === "waiting" ? (step.state === "running" ? "waiting" : step.state) : p.state === "running" && step.state === "ok" ? "running" : step.state;
  return { ...step, state, ...(p.startedAt !== undefined && { startedAt: p.startedAt }), ...(state === "running" && step.state === "ok" && { output: null }) };
}
