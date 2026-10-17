import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item, ItemId, ServerMessage, TaskId } from "../src/protocol";
import { loadTasks } from "../src/store";
import { acceptsFollowUp, apply, createTask, toStored, type TaskEvent, type TaskState } from "../src/task";
import askQuestion from "./recordings/ask-question.json";
import bashError from "./recordings/bash-error.json";
import writeFile from "./recordings/write-file.json";

type Recording = { cwd: string; events: TaskEvent[] };

const at = "2026-10-16T12:00:00.000Z";
const fresh = (cwd = "/repo", prompt = "Do the thing") =>
  createTask({ id: "t1" as TaskId, prompt, target: { kind: "local", projectId: "p1" as never }, projectName: "repo", cwd, model: "haiku", permissionMode: "default", at });

function replay(events: TaskEvent[], start: TaskState = fresh()) {
  let state = start;
  const emitted: ServerMessage[] = [];
  const statuses = [state.summary.status];
  for (const event of events) {
    const out = apply(state, event);
    state = out.state;
    emitted.push(...out.emitted);
    if (statuses.at(-1) !== state.summary.status) statuses.push(state.summary.status);
  }
  return { state, emitted, statuses };
}

// The recorder stops the task after its result; most tests want the run before that.
const run = (r: unknown) => (r as Recording).events.filter((e) => e.type !== "stopped");
const indexOf = (events: TaskEvent[], pred: (e: TaskEvent) => boolean) => events.findIndex(pred);
const items = (s: TaskState) => [...s.items.values()];
const ofKind = <K extends Item["kind"]>(s: TaskState, kind: K) => items(s).filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);

test("a tool is running until its tool_result arrives, then ok with its output", () => {
  const events = run(writeFile);
  const resultAt = indexOf(events, (e) => e.type === "sdk" && e.message.type === "user");
  const before = replay(events.slice(0, resultAt)).state;
  expect(ofKind(before, "tool")).toMatchObject([{ name: "Write", summary: "notes.txt", state: "running", output: null }]);

  const after = replay(events.slice(0, resultAt + 1)).state;
  const [tool] = ofKind(after, "tool");
  expect(tool?.state).toBe("ok");
  expect(tool?.output).toContain("File created successfully at: /repo/notes.txt");
});

test("a pending approval puts the task in needs_input until it is decided", () => {
  const events = run(writeFile);
  const requested = indexOf(events, (e) => e.type === "approval_requested");
  const pending = replay(events.slice(0, requested + 1)).state;
  expect(pending.summary.status).toBe("needs_input");
  expect(ofKind(pending, "approval")).toMatchObject([{ tool: "Write", summary: "notes.txt", detail: "hi", state: "pending" }]);

  const decided = replay(events.slice(0, requested + 2)).state;
  expect(decided.summary.status).toBe("running");
  expect(ofKind(decided, "approval")[0]?.state).toBe("allowed");
});

test("a successful result makes the task idle and records its cost", () => {
  const { state, statuses } = replay(run(writeFile));
  expect(statuses).toEqual(["running", "needs_input", "running", "idle"]);
  expect(state.summary.costUsd).toBe(0.00627976);
  expect(state.summary.preview).toBe("DONE");
  expect(ofKind(state, "result")).toMatchObject([{ ok: true, text: "DONE", costUsd: 0.00627976, durationMs: 6493 }]);
  expect(acceptsFollowUp(state.summary.status)).toBe(true);
});

test("deciding an approval twice is a no-op", () => {
  const events = run(writeFile);
  const decided = events.find((e) => e.type === "approval_decided")!;
  const { state } = replay(events);
  for (const again of [decided, { ...decided, decision: "deny" } as TaskEvent]) {
    const out = apply(state, again);
    expect(out.emitted).toEqual([]);
    expect(out.state).toBe(state);
  }
});

test("replaying an SDK message that was already applied emits nothing", () => {
  const { state } = replay(run(writeFile));
  const last = run(writeFile).findLast((e) => e.type === "sdk" && e.message.type === "assistant")!;
  expect(apply(state, last).emitted).toEqual([]);
});

test("a failing tool ends in error with its output", () => {
  const { state } = replay(run(bashError), fresh());
  expect(ofKind(state, "tool")).toMatchObject([{ name: "Bash", summary: "cat does-not-exist.txt", state: "error" }]);
  expect(ofKind(state, "tool")[0]?.output).toContain("No such file or directory");
});

test("a question is pending until answered, and a second answer is ignored", () => {
  const events = run(askQuestion);
  const asked = indexOf(events, (e) => e.type === "question_asked");
  const pending = replay(events.slice(0, asked + 1)).state;
  expect(pending.summary.status).toBe("needs_input");
  expect(ofKind(pending, "question")[0]).toMatchObject({ answers: null, questions: [{ question: "Do you prefer Tea or Coffee?", options: [{ label: "Tea" }, { label: "Coffee" }] }] });

  const { state, statuses } = replay(events);
  expect(statuses).toEqual(["running", "needs_input", "running", "idle"]);
  expect(ofKind(state, "question")[0]?.answers).toEqual({ "Do you prefer Tea or Coffee?": "Coffee" });
  const again: TaskEvent = { type: "question_answered", itemId: ofKind(state, "question")[0]!.id, answers: { "Do you prefer Tea or Coffee?": "Tea" }, at };
  expect(apply(state, again).emitted).toEqual([]);
});

test("stop denies pending approvals and nothing after it revives the task", () => {
  const events = run(writeFile);
  const requested = indexOf(events, (e) => e.type === "approval_requested");
  const pending = replay(events.slice(0, requested + 1)).state;
  const stopped = apply(pending, { type: "stopped", at }).state;
  expect(stopped.summary.status).toBe("stopped");
  expect(ofKind(stopped, "approval")[0]?.state).toBe("denied");

  const after = replay(events.slice(requested + 1), stopped).state;
  expect(after.summary.status).toBe("stopped");
  expect(acceptsFollowUp(after.summary.status)).toBe(false);
});

test("a follow-up moves an idle task back to running", () => {
  const { state } = replay(run(writeFile));
  const next = apply(state, { type: "user_sent", itemId: "user:2" as ItemId, text: "Now delete it", at });
  expect(next.state.summary.status).toBe("running");
  expect(next.emitted).toContainEqual({ type: "item", taskId: "t1", item: { kind: "user", id: "user:2", text: "Now delete it", at } } as ServerMessage);
});

test("a crash while running fails the task with a notice", () => {
  const { state } = replay([{ type: "crashed", itemId: "n1" as ItemId, error: "Claude Code exited", at }]);
  expect(state.summary.status).toBe("failed");
  expect(ofKind(state, "notice")).toMatchObject([{ text: "Claude Code exited" }]);
});

test("cloud creation records the session url and leaves the task idle", () => {
  const { state } = replay([
    { type: "cloud_created", itemId: "n1" as ItemId, sessionId: "session_01", url: "https://claude.ai/code/session_01", title: "README summary", at },
  ]);
  expect(state.summary).toMatchObject({ status: "idle", cloudUrl: "https://claude.ai/code/session_01" });
  expect(state.sessionId).toBe("session_01");
  expect(ofKind(state, "notice")).toMatchObject([{ url: "https://claude.ai/code/session_01" }]);
});

test("title is the first line of the prompt, at most 60 characters", () => {
  expect(fresh("/repo", "Fix the login bug\nIt fails on Safari").summary.title).toBe("Fix the login bug");
  expect(fresh("/repo", "x".repeat(100)).summary.title).toHaveLength(60);
});

test("after a restart, live tasks come back stopped and idle tasks keep their session", async () => {
  const home = mkdtempSync(join(tmpdir(), "claudebot-store-"));
  const idle = replay(run(writeFile)).state;
  const live = replay(run(writeFile).slice(0, indexOf(run(writeFile), (e) => e.type === "approval_requested") + 1), {
    ...fresh(),
    summary: { ...fresh().summary, id: "t2" as TaskId },
  }).state;
  writeFileSync(join(home, "state.json"), JSON.stringify({ version: 1, tasks: [toStored(idle), toStored(live)] }));

  const loaded = await loadTasks(home);
  expect(loaded.get("t1" as TaskId)?.summary.status).toBe("idle");
  expect(loaded.get("t1" as TaskId)?.sessionId).toBe(idle.sessionId!);
  const restored = loaded.get("t2" as TaskId)!;
  expect(restored.summary.status).toBe("stopped");
  expect(ofKind(restored, "approval")[0]?.state).toBe("denied");
  expect(ofKind(restored, "notice").at(-1)?.text).toContain("restarted");
});
