import type { ClientMessage, ServerMessage } from "./protocol";

const at = "2026-10-16T12:00:00.000Z";
const projects = [
  { id: "p1", name: "drawdown", path: "/Users/me/drawdown", branch: "main", githubRepo: "me/drawdown" },
  { id: "p2", name: "scratch", path: "/Users/me/scratch", branch: null, githubRepo: null },
];
const task = {
  id: "t1", title: "Fix the login bug", target: { kind: "local", projectId: "p1" }, projectName: "drawdown",
  model: "opus", permissionMode: "default", status: "needs_input", createdAt: at, updatedAt: at,
  preview: "Looking at auth.ts", costUsd: 0.0123, cloudUrl: null,
};

export const server = [
  { type: "hello", machine: "MacBook", projects, tasks: [task] },
  { type: "task", task: { ...task, id: "t2", target: { kind: "cloud", projectId: "p1" }, status: "idle", cloudUrl: "https://claude.ai/code/session_01" } },
  {
    type: "transcript", taskId: "t1", items: [
      { kind: "user", id: "i1", text: "Fix the login bug", at },
      { kind: "assistant", id: "i2", text: "Looking at auth.ts", at },
      { kind: "tool", id: "i3", name: "Read", summary: "src/auth.ts", state: "ok", output: "export function login() {}", at },
      { kind: "tool", id: "i4", name: "Bash", summary: "bun test", state: "running", output: null, at },
      { kind: "approval", id: "i5", tool: "Edit", summary: "src/auth.ts", detail: "- old\n+ new", state: "pending", at },
      { kind: "question", id: "i6", questions: [{ question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "SQL" }, { label: "Redis", description: "KV" }] }], answers: null, at },
      { kind: "result", id: "i7", ok: true, text: "Fixed.", costUsd: 0.0123, durationMs: 4200, at },
      { kind: "notice", id: "i8", text: "Cloud session created", url: "https://claude.ai/code/session_01", at },
    ],
  },
  { type: "item", taskId: "t1", item: { kind: "question", id: "i6", questions: [], answers: { "Which DB?": "Postgres" }, at } },
  { type: "error", message: "Unknown task" },
] as unknown as ServerMessage[];

export const client = [
  { type: "create", prompt: "Add dark mode", target: { kind: "cloud", projectId: "p1" }, model: "sonnet", permissionMode: "acceptEdits" },
  { type: "subscribe", taskId: "t1" },
  { type: "send", taskId: "t1", text: "Also add tests" },
  { type: "decide", taskId: "t1", itemId: "i5", decision: "allow_always" },
  { type: "answer", taskId: "t1", itemId: "i6", answers: { "Which DB?": "Postgres" } },
  { type: "stop", taskId: "t1" },
] as unknown as ClientMessage[];

if (import.meta.main) {
  await Bun.write(new URL("../../fixtures/protocol.json", import.meta.url), JSON.stringify({ server, client }, null, 2) + "\n");
}
