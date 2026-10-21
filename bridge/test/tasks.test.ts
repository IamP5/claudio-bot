import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TaskId } from "../src/protocol";
import { emptyTasks, liveTasks, lostNotice, observe, runningSteps, wakes, type Lost, type Task } from "../src/tasks";
import { replay } from "./transcript";

// Claude Code's task stream as CLI 2.1.305 sent it in the UX audit's S1b, S2, S4 and S8 runs (test/transcripts/tasks-*),
// folded into the ledger frame by frame. `stopped`: the tasks the recording's bridge stopped on the user's word.

type Moment = { m: SDKMessage; live: Task[]; running: Set<string>; wakes: boolean | null };

function fold(name: string, stopped: string[] = []) {
  const t = emptyTasks();
  const lost: Lost[] = [];
  const moments: Moment[] = [];
  const seen = new Map<TaskId, Task>();
  for (const m of replay(name).segments.flat()) {
    const wake = m.type === "system" && m.subtype === "task_notification" ? wakes(t, m.task_id as TaskId, m.status) : null;
    if (m.type === "system" && m.subtype === "task_updated" && stopped.includes(m.task_id)) t.stopped.add(m.task_id as TaskId);
    lost.push(...observe(t, m, "2026-10-21T10:00:00.000Z"));
    for (const x of t.all.values()) seen.set(x.id, { ...x });
    const live = liveTasks(t);
    moments.push({ m, live, running: new Set(runningSteps({ turn: null, tasks: live, all: t.all, calls: [], heardAt: null }).keys()), wakes: wake });
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
    expect([end.live, lost]).toEqual([[], []]);
  });

  test("when a foreground subagent returns, Claude Code stops its background command, the thread names both, and no wake turn is due", () => {
    const { lost, moments, seen, end } = fold("tasks-foreground-subagent-background-command");
    const shell = seen.find((x) => x.kind === "command")!;
    expect(lost.map(lostNotice)).toEqual(['The background command "sleep 60 && echo nested-done > nested.txt", started by starter, was stopped by Claude Code.']);
    expect(moments.find((x) => notified(x.m, shell.id))!.wakes).toBe(false);
    expect(end.live).toEqual([]);
  });

  test("a background command lives past the turn that started it; one the user stops ends silently, one Claude Code stops is named", () => {
    const recorded = fold("tasks-background-command");
    const [first, second] = recorded.seen.filter((x) => x.kind === "command" && x.background);
    const afterTurn = recorded.moments.findIndex((x) => isResult(x.m) && x.live.length > 0);
    expect(recorded.moments[afterTurn]!.live.map((x) => x.id)).toEqual([first!.id]);
    expect(recorded.moments[afterTurn]!.running).toEqual(new Set([first!.stepId!]));
    expect(recorded.lost.map((l) => [l.task.id, l.killed])).toEqual([[second!.id, true]]);
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
