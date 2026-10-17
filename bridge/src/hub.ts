import type { ClientMessage, Project, ServerMessage, TaskId } from "./protocol";
import type { Runners } from "./runners";
import { newItemId, now, type RunContext } from "./runners/types";
import { acceptsFollowUp, apply, createTask, type TaskState } from "./task";

export type Hub = ReturnType<typeof createHub>;

export function createHub(opts: {
  machine: string;
  tasks: Map<TaskId, TaskState>;
  runners: Runners;
  scan: () => Promise<Project[]>;
  broadcast: (message: ServerMessage) => void;
  persist: (snapshot: () => TaskState[]) => void;
}) {
  const { tasks, runners } = opts;
  let projects: Project[] = [];

  function dispatch(taskId: TaskId, event: Parameters<typeof apply>[1]) {
    const task = tasks.get(taskId);
    if (!task) return;
    const { state, emitted } = apply(task, event);
    if (state === task) return;
    tasks.set(taskId, state);
    for (const message of emitted) opts.broadcast(message);
    opts.persist(() => [...tasks.values()]);
  }

  function context(task: TaskState): RunContext {
    const taskId = task.summary.id;
    return {
      taskId,
      cwd: task.cwd,
      model: task.summary.model,
      permissionMode: task.summary.permissionMode,
      sessionId: () => tasks.get(taskId)?.sessionId ?? null,
      dispatch: (event) => dispatch(taskId, event),
    };
  }

  async function findProject(id: string): Promise<Project | undefined> {
    const found = projects.find((p) => p.id === id);
    if (found) return found;
    projects = await opts.scan();
    return projects.find((p) => p.id === id);
  }

  const error = (message: string): ServerMessage[] => [{ type: "error", message }];

  async function handle(message: ClientMessage): Promise<ServerMessage[]> {
    if (message.type === "create") {
      const project = await findProject(message.target.projectId);
      if (!project) return error("Unknown project");
      if (message.target.kind === "cloud" && !project.githubRepo) return error(`${project.name} has no GitHub remote, so it can only run locally`);
      const at = now();
      const task = createTask({
        id: crypto.randomUUID() as TaskId,
        prompt: message.prompt,
        target: message.target,
        model: message.model,
        permissionMode: message.permissionMode,
        projectName: project.name,
        cwd: project.path,
        at,
      });
      tasks.set(task.summary.id, task);
      dispatch(task.summary.id, { type: "user_sent", itemId: newItemId("user"), text: message.prompt, at });
      runners[message.target.kind].start(context(task), message.prompt);
      return [];
    }

    const task = tasks.get(message.taskId);
    if (!task) return error("Unknown task");
    const runner = runners[task.summary.target.kind];
    const ctx = context(task);

    switch (message.type) {
      case "subscribe":
        return [{ type: "transcript", taskId: message.taskId, items: [...task.items.values()] }];
      case "send":
        if (!acceptsFollowUp(task.summary.status)) return error(`Task is ${task.summary.status}`);
        dispatch(message.taskId, { type: "user_sent", itemId: newItemId("user"), text: message.text, at: now() });
        runner.send(ctx, message.text);
        return [];
      case "decide":
        runner.decide(ctx, message.itemId, message.decision);
        return [];
      case "answer":
        runner.answer(ctx, message.itemId, message.answers);
        return [];
      case "stop":
        runner.stop(ctx);
        return [];
    }
  }

  return {
    async hello(): Promise<ServerMessage> {
      projects = await opts.scan();
      const summaries = [...tasks.values()].map((t) => t.summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { type: "hello", machine: opts.machine, projects, tasks: summaries };
    },
    handle,
  };
}
