import type { Decision, ItemId, PermissionMode, TaskId } from "../protocol";
import type { TaskEvent } from "../task";

// What a runner needs to know about a task, plus the one way it reports back.
export type RunContext = {
  taskId: TaskId;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  sessionId: () => string | null;
  dispatch: (event: TaskEvent) => void;
};

export type Runner = {
  start(ctx: RunContext, prompt: string): void;
  send(ctx: RunContext, text: string): void;
  decide(ctx: RunContext, itemId: ItemId, decision: Decision): void;
  answer(ctx: RunContext, itemId: ItemId, answers: Record<string, string>): void;
  stop(ctx: RunContext): void;
};

export const now = () => new Date().toISOString();
export const newItemId = (prefix: string) => `${prefix}:${crypto.randomUUID()}` as ItemId;
