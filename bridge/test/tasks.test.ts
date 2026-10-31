import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId, PermissionMessage, TaskId, ToolStep } from "../src/protocol";
import { emptyTasks, liveTasks, lostNotice, observe, patchStep, rowRun, runControls, runningSteps, wakes, type Activity, type Call, type Task, type TaskNote } from "../src/tasks";
import type { OwnCard } from "../src/world";
import { replay } from "./transcript";

// Claude Code's task stream as CLI 2.1.305 sent it in the UX audit's S1b, S2, S4 and S8 runs (test/transcripts/tasks-*),
// folded into the ledger frame by frame. `stopped`: the tasks the recording's bridge stopped on the user's word.

type Moment = { m: SDKMessage; live: Task[]; running: Set<string>; wakes: boolean | null; row: ReturnType<typeof rowRun> };

const callLabel = (c: Call) => `${c.tool} call`;

function fold(name: string, stopped: string[] = []) {
  const t = emptyTasks();
  const lost: TaskNote[] = [];
  const moments: Moment[] = [];
  const seen = new Map<TaskId, Task>();
  const recorded = replay(name);
  const start = Date.parse(String(recorded.meta.recordedAt));
  for (const m of recorded.segments.flat()) {
    const wake = m.type === "system" && m.subtype === "task_notification" ? wakes(t, m.task_id as TaskId, m.status) : null;
    if (m.type === "system" && m.subtype === "task_updated" && stopped.includes(m.task_id)) t.stopped.add(m.task_id as TaskId);
    lost.push(...observe(t, m, new Date(start + (recorded.at.get(m) ?? 0)).toISOString()));
    for (const x of t.all.values()) seen.set(x.id, { ...x });
    const live = liveTasks(t);
    const a: Activity = { turn: null, tasks: live, all: t.all, calls: [...t.calls.values()], heardAt: null };
    moments.push({ m, live, running: new Set(runningSteps(a).keys()), wakes: wake, row: rowRun(a, [], callLabel) });
  }
  return { t, lost, moments, seen: [...seen.values()], end: moments.at(-1)! };
}

const isResult = (m: SDKMessage) => m.type === "result";
const notified = (m: SDKMessage, id: string) => m.type === "system" && m.subtype === "task_notification" && m.task_id === id;

describe("Claude Code's task stream, recorded", () => {
  test("three background subagents live at once, each owning the foreground shell it runs, and all end with nothing lost", () => {
    const { t, lost, moments, seen, end } = fold("tasks-background-subagents");
    const agents = seen.filter((x) => x.kind === "agent");
    expect(agents.map((a) => a.label).sort()).toEqual(["sleeper one", "sleeper three", "sleeper two"]);
    expect(Math.max(...moments.map((x) => x.live.filter((l) => l.kind === "agent").length))).toBe(3);
    expect(seen.filter((x) => x.kind === "command").map((s) => [s.background, agents.some((a) => a.id === s.parent), s.label])).toEqual([
      [false, true, "perl -e 'sleep 30'"],
      [false, true, "perl -e 'sleep 30'"],
      [false, true, "perl -e 'sleep 30'"],
    ]);
    const firstResult = moments.findIndex((x) => isResult(x.m) && x.live.length > 0);
    expect(moments[firstResult]!.running).toEqual(new Set(agents.map((a) => a.stepId!)));
    const kindOf = (m: SDKMessage) => (m.type === "system" && m.subtype === "task_notification" ? seen.find((x) => x.id === m.task_id)!.kind : null);
    expect(moments.filter((x) => x.wakes !== null).map((x) => [kindOf(x.m), x.wakes])).toEqual([
      ["command", false],
      ["command", false],
      ["command", false],
      ["agent", true],
      ["agent", true],
      ["agent", true],
    ]);
    expect([end.live, lost, t.all.size, t.commands.size]).toEqual([[], [], 0, 0]);
  });

  test("a subagent's background command outlives the subagent and keeps its step running until the command ends", () => {
    const { lost, moments, seen, end } = fold("tasks-subagent-background-command");
    const starter = seen.find((x) => x.kind === "agent")!;
    const shell = seen.find((x) => x.kind === "command")!;
    expect([starter.label, shell.background, shell.parent, shell.label]).toEqual(["starter", true, starter.id, "sleep 60 && echo nested-done > nested.txt"]);
    const returned = moments.findIndex((x) => notified(x.m, starter.id));
    expect(moments[returned]!.live.map((x) => x.id)).toEqual([shell.id]);
    expect(moments[returned]!.running).toEqual(new Set([shell.stepId!, starter.stepId!]));
    const ended = moments.findIndex((x, i) => i > returned && !x.live.some((l) => l.id === shell.id));
    expect(ended - returned).toBeGreaterThan(2);
    expect(moments.slice(returned, ended).every((x) => x.running.has(starter.stepId!))).toBe(true);
    expect(end.live).toEqual([]);
    expect(lost.map(lostNotice)).toEqual(['Agent "starter" is waiting on its own background command "sleep 60 && echo nested-done > nested.txt", which started 1s before.']);
  });

  test("when a foreground subagent returns, Claude Code stops its background command, the thread names both, and no wake turn is due", () => {
    const { lost, moments, seen, end } = fold("tasks-foreground-subagent-background-command");
    const shell = seen.find((x) => x.kind === "command")!;
    expect(lost.map(lostNotice)).toEqual(['The background command "sleep 60 && echo nested-done > nested.txt", started by starter, was stopped by Claude Code when starter returned, after 1s. It did not finish.']);
    expect(moments.find((x) => notified(x.m, shell.id))!.wakes).toBe(false);
    expect(end.live).toEqual([]);
  });

  test("a background command lives past the turn that started it; one the user stops ends silently, one Claude Code stops is named", () => {
    const recorded = fold("tasks-background-command");
    const [first, second] = recorded.seen.filter((x) => x.kind === "command" && x.background);
    const afterTurn = recorded.moments.findIndex((x) => isResult(x.m) && x.live.length > 0);
    expect(recorded.moments[afterTurn]!.live.map((x) => x.id)).toEqual([first!.id]);
    expect(recorded.moments[afterTurn]!.running).toEqual(new Set([first!.stepId!]));
    expect(recorded.lost.map((l) => [l.task.id, l.kind === "lost" && l.killed])).toEqual([[second!.id, true]]);
    const stopped = fold("tasks-background-command", [second!.id]);
    expect([stopped.end.live, stopped.lost]).toEqual([[], []]);
    expect(stopped.moments.find((x) => notified(x.m, second!.id))!.wakes).toBe(true);
  });

  test("a subagent the user stops, and the shell it ran, end with Claude Code's notifications and leave nothing lost", () => {
    const agent = fold("tasks-stopped-subagent").seen.find((x) => x.kind === "agent")!;
    const { lost, seen, end } = fold("tasks-stopped-subagent", [agent.id]);
    expect(seen.map((x) => [x.kind, x.kind === "agent" ? x.label : x.parent])).toEqual([
      ["agent", "long sleeper"],
      ["command", agent.id],
    ]);
    expect([end.live, lost]).toEqual([[], []]);
  });
});

const sys = (subtype: string, o: object) => ({ type: "system", subtype, uuid: "u", session_id: "s", ...o }) as unknown as SDKMessage;
const bashCall = (id: string, command: string) =>
  ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } }) as unknown as SDKMessage;
const task = (over: Partial<Task>): Task => ({ id: "x" as TaskId, stepId: null, kind: "agent", label: "x", background: true, startedAt: "2026-10-31T12:00:00.000Z", parent: null, progress: null, ended: false, told: false, ...over });
const permission = (toolUseId: string, tool: string, over: Partial<Extract<OwnCard, { kind: "permission" }>> = {}): OwnCard => ({
  kind: "permission",
  card: { id: `c-${toolUseId}` as MessageId, tool, answer: null } as unknown as PermissionMessage,
  toolUseId,
  suggestions: [],
  ...over,
});

describe("what the thread and the row are told about tasks", () => {
  test("a foreground command past its time limit is said to keep running in the background, and keeps the start of its call", () => {
    const t = emptyTasks();
    observe(t, bashCall("toolu_p", "perl -e 'sleep 60'"), "2026-10-31T12:00:00.000Z");
    observe(t, sys("task_started", { task_id: "bp", tool_use_id: "toolu_p", description: "Run perl", is_backgrounded: false, task_type: "local_bash" }), "2026-10-31T12:00:04.400Z");
    const notes = observe(t, sys("task_updated", { task_id: "bp", patch: { is_backgrounded: true } }), "2026-10-31T12:00:08.000Z");
    expect(notes.map(lostNotice)).toEqual(["The command \"perl -e 'sleep 60'\" passed its time limit and kept running in the background."]);
    expect(t.all.get("bp" as TaskId)).toMatchObject({ background: true, startedAt: "2026-10-31T12:00:00.000Z" });
  });

  test("a foreground command the level lists as background is said to have moved, once", () => {
    const t = emptyTasks();
    observe(t, bashCall("toolu_p", "perl -e 'sleep 30'"), "2026-10-31T12:00:00.000Z");
    observe(t, sys("task_started", { task_id: "bp", tool_use_id: "toolu_p", description: "Run perl", is_backgrounded: false, task_type: "local_bash" }), "2026-10-31T12:00:04.400Z");
    const level = sys("background_tasks_changed", { tasks: [{ task_id: "bp", task_type: "local_bash", description: "Run perl" }] });
    expect(observe(t, level, "2026-10-31T12:00:08.000Z").map(lostNotice)).toEqual(["The command \"perl -e 'sleep 30'\" passed its time limit and kept running in the background."]);
    expect(observe(t, sys("task_updated", { task_id: "bp", patch: { is_backgrounded: true } }), "2026-10-31T12:00:08.001Z")).toEqual([]);
  });

  test("a subagent's command that vanishes long after the subagent returned is not said to have ended with it", () => {
    const t = emptyTasks();
    observe(t, sys("task_started", { task_id: "a1", tool_use_id: "toolu_a", description: "starter", is_backgrounded: true, task_type: "local_agent" }), "2026-10-31T12:00:00.000Z");
    observe(t, sys("task_started", { task_id: "b1", tool_use_id: "toolu_b", description: "sleep 60", is_backgrounded: true, task_type: "local_bash", parent_task_id: "a1" }), "2026-10-31T12:00:02.000Z");
    observe(t, sys("background_tasks_changed", { tasks: [{ task_id: "a1", task_type: "local_agent", description: "starter" }, { task_id: "b1", task_type: "local_bash", description: "sleep 60", parent_task_id: "a1" }] }), "2026-10-31T12:00:02.000Z");
    observe(t, sys("task_notification", { task_id: "a1", tool_use_id: "toolu_a", status: "completed", summary: "started" }), "2026-10-31T12:00:03.000Z");
    const notes = observe(t, sys("background_tasks_changed", { tasks: [] }), "2026-10-31T12:01:02.000Z");
    expect(notes.map(lostNotice)).toEqual(['The background command "sleep 60", started by starter, stopped after 1m, and Claude Code did not say how it ended.']);
  });

  test("a command task is named by its whole command on one line, cut from the middle so its end shows", () => {
    const t = emptyTasks();
    observe(t, bashCall("toolu_l", `echo ${"x".repeat(300)} \\\n  > out.txt`), "2026-10-31T12:00:00.000Z");
    observe(t, sys("task_started", { task_id: "bl", tool_use_id: "toolu_l", description: "d", is_backgrounded: true, task_type: "local_bash" }), "2026-10-31T12:00:00.100Z");
    expect(t.all.get("bl" as TaskId)!.label).toBe(`echo ${"x".repeat(95)}…${"x".repeat(87)} \\ > out.txt`);
  });

  test("three subagents each running a command read as three agents, named, not six things", () => {
    const { moments } = fold("tasks-background-subagents");
    const busiest = moments.find((x) => x.live.length === 6)!;
    expect(busiest.row).toMatchObject({ running: { agents: 3, commands: 0 }, activity: "sleeper one, sleeper two and sleeper three running" });
  });

  test("a subagent waiting on its own command stays counted from its first start, through its return and its next run", () => {
    const { moments, seen } = fold("tasks-subagent-background-command");
    const starter = seen.find((x) => x.kind === "agent")!;
    const shell = seen.find((x) => x.kind === "command")!;
    const from = moments.findIndex((x) => notified(x.m, starter.id));
    const shellEnds = moments.findIndex((x, i) => i > from && !x.live.some((l) => l.id === shell.id));
    const rerun = moments.findIndex((x, i) => i > from && x.m.type === "system" && x.m.subtype === "task_started" && x.m.task_id === starter.id);
    const rows = [...moments.slice(from - 1, shellEnds), moments[rerun]!].map((x) => JSON.stringify([x.row.running, x.row.since]));
    expect(new Set(rows)).toEqual(new Set([JSON.stringify([{ agents: 1, commands: 0 }, "2026-10-21T09:56:41.781Z"])]));
    expect(shell.parent).toBe(starter.id);
  });

  test("the row names who waits on approval and how many cards wait, and what a question or a plan waits for", () => {
    const one = task({ id: "a1" as TaskId, stepId: "toolu_a1", label: "sleeper one" });
    const two = task({ id: "a2" as TaskId, stepId: "toolu_a2", label: "sleeper two" });
    const a: Activity = { turn: null, tasks: [one, two], all: new Map([one, two].map((x) => [x.id, x])), calls: [], heardAt: null };
    const asked = [permission("toolu_b2", "Bash", { agent: { id: "a2", label: "sleeper two", stepId: "toolu_a2" } }), permission("toolu_b1", "Bash", { agent: { id: "a1", label: "sleeper one", stepId: "toolu_a1" } })];
    expect(rowRun(a, asked, callLabel).activity).toBe("Waiting for approval: Bash in sleeper two (2 waiting)");
    expect(runControls(a, asked).tasks!.map((x) => x.waiting as string | null)).toEqual(["c-toolu_b1", "c-toolu_b2"]);
    const turn: Activity = { ...RESTING_TURN, calls: [{ id: "q", tool: "AskUserQuestion", input: {} }] };
    expect(rowRun(turn, [], callLabel).activity).toBe("Waiting for your answer");
    expect(rowRun({ ...RESTING_TURN, calls: [{ id: "p", tool: "ExitPlanMode", input: {} }] }, [], callLabel).activity).toBe("Waiting for plan approval");
  });

  test("a main-thread command counts from its call, not once Claude Code registers it; one waiting for approval does not", () => {
    const a: Activity = { ...RESTING_TURN, calls: [{ id: "toolu_s", tool: "Bash", input: { command: "sleep 60" } }] };
    expect(rowRun(a, [], callLabel).running).toEqual({ agents: 0, commands: 1 });
    expect(rowRun(a, [permission("toolu_s", "Bash")], callLabel).running).toEqual({ agents: 0, commands: 0 });
  });

  test("an allowed command's task runs from the moment the user allowed it, like its step", () => {
    const shell = task({ id: "bs" as TaskId, stepId: "toolu_s", kind: "command", label: "sleep 120", background: false, startedAt: "2026-10-31T12:00:00.000Z" });
    const a: Activity = { ...RESTING_TURN, tasks: [shell], all: new Map([[shell.id, shell]]) };
    const allowed = permission("toolu_s", "Bash", { card: { id: "c" as MessageId, tool: "Bash", answer: "once" } as unknown as PermissionMessage, allowedAt: "2026-10-31T12:00:19.100Z" });
    expect(runControls(a, [allowed]).tasks!.map((x) => x.startedAt)).toEqual(["2026-10-31T12:00:19.100Z"]);
    expect(runControls(a, []).tasks!.map((x) => x.startedAt)).toEqual(["2026-10-31T12:00:00.000Z"]);
  });

  test("a step shows no result while its work runs on, and a stopped or finished one keeps when it ended", () => {
    const step: ToolStep = { id: "t", tool: "Bash", label: "Run perl", state: "error", diff: null, output: "[Tool call interrupted: the session ended before this call's result was recorded]", startedAt: "2026-10-31T12:00:00.000Z", endedAt: "2026-10-31T12:00:09.000Z", cause: "x" };
    expect(patchStep(step, { state: "running", outlived: true })).toEqual({ id: "t", tool: "Bash", label: "Run perl", state: "running", diff: null, output: null, startedAt: "2026-10-31T12:00:00.000Z" });
    const running: ToolStep = { ...step, state: "running", output: null, endedAt: undefined, cause: undefined };
    expect(patchStep(running, { ended: { state: "stopped", cause: "Stopped by you" }, endedAt: "2026-10-31T12:00:28.000Z" })).toMatchObject({ state: "stopped", cause: "Stopped by you", endedAt: "2026-10-31T12:00:28.000Z" });
    const done: ToolStep = { ...step, state: "ok", output: "done", cause: undefined, endedAt: "2026-10-31T12:00:58.454Z" };
    expect(patchStep(done, { told: true, endedAt: "2026-10-31T12:00:57.585Z" }).endedAt).toBe("2026-10-31T12:00:57.585Z");
  });

  test("a task ends when Claude Code timed its end", () => {
    const t = emptyTasks();
    observe(t, sys("task_started", { task_id: "a1", tool_use_id: "toolu_a", description: "sleeper", is_backgrounded: true, task_type: "local_agent" }), "2026-10-31T12:00:00.000Z");
    observe(t, sys("task_updated", { task_id: "a1", patch: { status: "completed", end_time: Date.parse("2026-10-31T12:00:35.050Z") } }), "2026-10-31T12:00:35.900Z");
    expect(t.all.get("a1" as TaskId)).toMatchObject({ ended: true, endedAt: "2026-10-31T12:00:35.050Z" });
  });
});

const RESTING_TURN: Activity = { turn: { startedAt: "2026-10-31T12:00:00.000Z", wake: false }, tasks: [], all: new Map(), calls: [], heardAt: null };
