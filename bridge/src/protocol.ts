// Wire protocol between the iOS app and the Mac bridge. JSON over one WebSocket.
// ios/ClaudeBot/Model/Protocol.swift mirrors this file; fixtures/protocol.json pins both.

export type TaskId = string & { readonly __brand: "TaskId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type ItemId = string & { readonly __brand: "ItemId" };

export type Project = {
  id: ProjectId;
  name: string;
  path: string;
  branch: string | null;
  // owner/name on GitHub. Null means the project can only run locally.
  githubRepo: string | null;
};

export type Target =
  | { kind: "local"; projectId: ProjectId }
  | { kind: "cloud"; projectId: ProjectId };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

// running: Claude is working. needs_input: an approval or question is pending.
// idle: the turn ended and the task accepts a follow-up. failed / stopped are terminal.
export type TaskStatus = "running" | "needs_input" | "idle" | "failed" | "stopped";

export type TaskSummary = {
  id: TaskId;
  title: string;
  target: Target;
  projectName: string;
  model: string;
  permissionMode: PermissionMode;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  // Last line of assistant text, for the home list.
  preview: string;
  costUsd: number;
  // claude.ai/code URL for cloud tasks.
  cloudUrl: string | null;
};

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type Item =
  | { kind: "user"; id: ItemId; text: string; at: string }
  | { kind: "assistant"; id: ItemId; text: string; at: string }
  | {
      kind: "tool";
      id: ItemId;
      name: string;
      summary: string;
      state: "running" | "ok" | "error";
      output: string | null;
      at: string;
    }
  | {
      kind: "approval";
      id: ItemId;
      tool: string;
      summary: string;
      detail: string;
      state: "pending" | "allowed" | "denied";
      at: string;
    }
  | {
      kind: "question";
      id: ItemId;
      questions: Question[];
      answers: Record<string, string> | null;
      at: string;
    }
  | {
      kind: "result";
      id: ItemId;
      ok: boolean;
      text: string;
      costUsd: number;
      durationMs: number;
      at: string;
    }
  | { kind: "notice"; id: ItemId; text: string; url: string | null; at: string };

export type ServerMessage =
  | { type: "hello"; machine: string; projects: Project[]; tasks: TaskSummary[] }
  | { type: "task"; task: TaskSummary }
  // Full transcript, sent on subscribe.
  | { type: "transcript"; taskId: TaskId; items: Item[] }
  // Insert or replace by item.id. Replaying the same message is a no-op.
  | { type: "item"; taskId: TaskId; item: Item }
  | { type: "error"; message: string };

export type Decision = "allow" | "allow_always" | "deny";

export type ClientMessage =
  | {
      type: "create";
      prompt: string;
      target: Target;
      model: string;
      permissionMode: PermissionMode;
    }
  | { type: "subscribe"; taskId: TaskId }
  | { type: "send"; taskId: TaskId; text: string }
  | { type: "decide"; taskId: TaskId; itemId: ItemId; decision: Decision }
  | { type: "answer"; taskId: TaskId; itemId: ItemId; answers: Record<string, string> }
  | { type: "stop"; taskId: TaskId };
