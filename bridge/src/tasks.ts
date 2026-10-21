import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId, SessionControls, SessionRow, SessionTask, TaskId, ToolStep } from "./protocol";
import { displayName, maskSecrets } from "./text";

// The work Claude Code runs on one live query besides the turn: subagents and commands, foreground and background,
// read from its task stream. background_tasks_changed is the level for background work and wins over the edges
// (task_started, task_updated, task_notification), which are the only word on foreground tasks. Observed on CLI
// 2.1.305: a subagent is a local_agent task whose id is the agentID its permission asks carry; a subagent's shell names
// it in parent_task_id; a foreground shell becomes a task about 5 s after it starts; a finishing task notifies before
// it leaves the level, and a stopped one is patched killed and notifies stopped.

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
  /** Claude Code said how it ended: a notification, or a completed or failed status. Killed alone says nothing. */
  told: boolean;
};

export type Tasks = {
  /** Every task of the query, ended ones too, so an ended owner can still be named. */
  all: Map<TaskId, Task>;
  /** What the last background_tasks_changed listed. */
  listed: Set<TaskId>;
  /** Background Bash commands by their call's tool_use id, so a lost command is named by what it ran. */
  commands: Map<string, string>;
  /** Main-thread tool calls still waiting for their result. */
  calls: Map<string, { tool: string; input: Record<string, unknown> }>;
  /** Tasks the bridge stopped: their end is the user's doing. */
  stopped: Set<TaskId>;
};

/** A background task that left without Claude Code saying how it ended. */
export type Lost = { task: Task; command: string | null; owner: Task | null };

export const emptyTasks = (): Tasks => ({ all: new Map(), listed: new Set(), commands: new Map(), calls: new Map(), stopped: new Set() });

const LABEL_MAX = 80;
const label = (text: string) => displayName(maskSecrets(text), LABEL_MAX);
const kindOf = (type: string | undefined): Task["kind"] => (type === "local_agent" ? "agent" : type === "local_bash" ? "command" : "other");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const liveTasks = (t: Tasks): Task[] => [...t.all.values()].filter((x) => !x.ended);

/** Ends a task and the foreground tasks under it, which cannot outlive it. */
function end(t: Tasks, id: TaskId) {
  const task = t.all.get(id);
  if (!task || task.ended) return;
  task.ended = true;
  for (const child of t.all.values()) if (child.parent === id && !child.background) end(t, child.id);
}

/**
 * Folds one message into the ledger. Returns the background tasks that left the level with no word on how they ended
 * and that the bridge did not stop, which is how Claude Code kills a subagent's shell when the subagent returns.
 */
export function observe(t: Tasks, m: SDKMessage, at: string): Lost[] {
  const lost: Lost[] = [];
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type !== "tool_use" || !isRecord(b.input)) continue;
      if (b.name === "Bash" && b.input.run_in_background === true && typeof b.input.command === "string") t.commands.set(b.id, firstLine(b.input.command));
      if (m.parent_tool_use_id === null) t.calls.set(b.id, { tool: b.name, input: b.input });
    }
  } else if (m.type === "user" && m.parent_tool_use_id === null && typeof m.message.content !== "string") {
    for (const b of m.message.content) if (b.type === "tool_result") t.calls.delete(b.tool_use_id);
  } else if (m.type === "result") {
    t.calls.clear();
    // A foreground task lives inside a turn or a live subagent; one with neither has ended unannounced.
    for (const task of liveTasks(t)) {
      if (!task.background && (task.parent === null || t.all.get(task.parent)?.ended !== false)) end(t, task.id);
    }
  } else if (m.type === "system") {
    switch (m.subtype) {
      case "task_started": {
        if (m.ambient === true || m.skip_transcript === true) break;
        const id = m.task_id as TaskId;
        t.all.set(id, {
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
        if (m.patch.is_backgrounded !== undefined) task.background = m.patch.is_backgrounded;
        if (m.patch.status === "completed" || m.patch.status === "failed") task.told = true;
        if (m.patch.status === "completed" || m.patch.status === "failed" || m.patch.status === "killed") end(t, task.id);
        break;
      }
      case "task_notification": {
        const task = t.all.get(m.task_id as TaskId);
        if (!task) break;
        task.told = true;
        end(t, task.id);
        break;
      }
      case "background_tasks_changed": {
        const listed = m.tasks.filter((x) => x.ambient !== true);
        const now = new Set(listed.map((x) => x.task_id as TaskId));
        for (const id of t.listed) {
          if (now.has(id)) continue;
          const task = t.all.get(id);
          if (task && !task.told && !t.stopped.has(id)) {
            const owner = task.parent === null ? null : (t.all.get(task.parent) ?? null);
            lost.push({ task, command: task.stepId === null ? null : (t.commands.get(task.stepId) ?? null), owner });
          }
          end(t, id);
        }
        for (const x of listed) {
          const id = x.task_id as TaskId;
          const known = t.all.get(id);
          if (known && !known.ended) known.background = true;
          else if (!known)
            t.all.set(id, {
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

const firstLine = (s: string) => displayName(maskSecrets(s.trim().split("\n")[0] ?? ""), LABEL_MAX);

const KIND_WORD: Record<Task["kind"], string> = { agent: "background agent", command: "background command", other: "background task" };

export function lostNotice(l: Lost): string {
  const what = `The ${KIND_WORD[l.task.kind]} "${l.command ?? l.task.label}"`;
  if (l.owner === null) return `${what} stopped, and Claude Code did not say how it ended.`;
  if (l.owner.ended) return `${what}, started by ${l.owner.label}, was stopped when ${l.owner.label} returned.`;
  return `${what}, started by ${l.owner.label}, stopped, and Claude Code did not say how it ended.`;
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

export function rowRun(a: Activity, card: string | null, call: (c: Activity["calls"][number]) => string): Pick<SessionRow, "since" | "running" | "activity"> {
  if (!runs(a)) return {};
  const starts = [...(a.turn ? [a.turn.startedAt] : []), ...a.tasks.map((t) => t.startedAt)].sort();
  const background = a.tasks.filter((t) => t.background);
  const last = a.calls.at(-1);
  const activity =
    card !== null
      ? `Waiting for approval: ${card}`
      : last
        ? call(last)
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
