import { endGroup, taskRun, type TaskRun } from "./procs";
import type { TaskId } from "./protocol";
import type { Activity, StepPatch, Task } from "./tasks";
import type { OwnDrive } from "./world";

// Background commands that outlived the Claude Code that ran them, after a bridge restart or a Claude Code exit. No
// Claude Code reports on them any more, so the bridge follows them in the process table: they show as tasks of the
// session while their shell still writes to their output, and Stop ends them. What a later Claude Code says of them
// is not what happened to them, so their steps keep what the bridge saw.

export type Outlived = NonNullable<OwnDrive["outlived"]>[number];

/** How often the bridge looks whether an outlived command still runs. */
export const OUTLIVED_LOOK_MS = 5_000;
const KEPT = 20;

export const followed = (list: readonly Outlived[]) => list.filter((o) => o.over === undefined);

export const outlivedTask = (o: Outlived, startedAt: string): Task => ({
  id: o.id as TaskId,
  stepId: o.stepId ?? null,
  kind: o.kind === "other" ? "other" : "command",
  label: o.label ?? o.description ?? o.id,
  background: true,
  startedAt: o.startedAt ?? startedAt,
  parent: null,
  progress: null,
  ended: false,
  told: false,
});

/** The live query's activity with the followed commands after its own tasks. */
export function withOutlived(a: Activity, list: readonly Outlived[], startedAt: string): Activity {
  const left = followed(list)
    .map((o) => outlivedTask(o, startedAt))
    .filter((t) => !a.all.has(t.id));
  if (left.length === 0) return a;
  return { ...a, tasks: [...a.tasks, ...left], all: new Map([...a.all, ...left.map((t) => [t.id, t] as const)]) };
}

/** The list with these no longer followed, as `over`, keeping the newest few the bridge stopped following. */
export function settled(list: readonly Outlived[], ids: readonly string[], over: NonNullable<Outlived["over"]>): Outlived[] {
  const out = list.map((o) => (ids.includes(o.id) && o.over === undefined ? { ...o, over } : o));
  const done = out.filter((o) => o.over !== undefined);
  const drop = new Set(done.slice(0, Math.max(0, done.length - KEPT)));
  return out.filter((o) => !drop.has(o));
}

/** How each step of an outlived command reads: running while followed, and never what a later Claude Code claimed. */
export function outlivedSteps(list: readonly Outlived[], unseen: string): Map<string, StepPatch> {
  const out = new Map<string, StepPatch>();
  for (const o of list) {
    if (o.stepId === undefined) continue;
    if (o.over === undefined) out.set(o.stepId, { state: "running", outlived: true, ...(o.startedAt !== undefined && { startedAt: o.startedAt }) });
    else if (o.over === "ended") out.set(o.stepId, { ended: { state: "stopped", cause: unseen }, outlived: true });
    else out.set(o.stepId, { outlived: true, ...(o.over === "unsure" && { uncut: true }) });
  }
  return out;
}

export async function runOf(o: Outlived): Promise<TaskRun> {
  return taskRun(o.group, o.id);
}

export const endOutlived = (o: Outlived) => endGroup(o.group, o.id);
