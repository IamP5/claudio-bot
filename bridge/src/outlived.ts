import { endGroup, stillRuns } from "./procs";
import type { TaskId } from "./protocol";
import type { Activity, Task } from "./tasks";
import type { BackgroundTask } from "./world";

// Background commands that outlived the Claude Code that ran them, after a bridge restart or a Claude Code exit. No
// Claude Code reports on them any more, so the bridge follows them in the process table: they show as tasks of the
// session while their shell still writes to their output, and Stop ends them.

export type Outlived = BackgroundTask & { group: number };

/** How often the bridge looks whether an outlived command still runs. */
export const OUTLIVED_LOOK_MS = 5_000;

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

/** The live query's activity with the outlived commands after its own tasks. */
export function withOutlived(a: Activity, list: readonly Outlived[], startedAt: string): Activity {
  const left = list.map((o) => outlivedTask(o, startedAt)).filter((t) => !a.all.has(t.id));
  if (left.length === 0) return a;
  return { ...a, tasks: [...a.tasks, ...left], all: new Map([...a.all, ...left.map((t) => [t.id, t] as const)]) };
}

/** Those of `list` that no longer run. */
export async function endedOf(list: readonly Outlived[]): Promise<Outlived[]> {
  const runs = await Promise.all(list.map((o) => stillRuns(o.group, o.id)));
  return list.filter((_, i) => !runs[i]);
}

/** Ends an outlived command. True once it no longer runs. */
export const endOutlived = (o: Outlived): Promise<boolean> => endGroup(o.group, o.id);
