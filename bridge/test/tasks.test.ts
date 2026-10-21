import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { emptyTasks, liveTasks, observe, runningSteps, type Lost, type Task } from "../src/tasks";
import { replay } from "./transcript";

// Claude Code's task stream as CLI 2.1.305 sent it in the UX audit's S1b, S2, S4 and S8 runs (test/transcripts/tasks-*),
// folded into the ledger frame by frame.

type Moment = { m: SDKMessage; live: Task[]; running: Set<string> };

function fold(name: string) {
  const t = emptyTasks();
  const lost: Lost[] = [];
  const moments: Moment[] = [];
  for (const m of replay(name).segments.flat()) {
    lost.push(...observe(t, m, "2026-10-21T10:00:00.000Z"));
    const live = liveTasks(t);
    moments.push({ m, live, running: new Set(runningSteps({ turn: null, tasks: live, all: t.all, calls: [], heardAt: null }).keys()) });
  }
  return { t, lost, moments, end: moments.at(-1)! };
}

const isResult = (m: SDKMessage) => m.type === "result";
const notified = (m: SDKMessage, id: string) => m.type === "system" && m.subtype === "task_notification" && m.task_id === id;

describe("Claude Code's task stream, recorded", () => {
  test("three background subagents live at once, each owning the foreground shell it runs, and all end with nothing lost", () => {
    const { t, lost, moments, end } = fold("tasks-background-subagents");
    const agents = [...t.all.values()].filter((x) => x.kind === "agent");
    expect(agents.map((a) => a.label).sort()).toEqual(["sleeper one", "sleeper three", "sleeper two"]);
    expect(Math.max(...moments.map((x) => x.live.filter((l) => l.kind === "agent").length))).toBe(3);
    const shells = [...t.all.values()].filter((x) => x.kind === "command");
    expect(shells.map((s) => [s.background, agents.some((a) => a.id === s.parent)])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    const firstResult = moments.findIndex((x) => isResult(x.m) && x.live.length > 0);
    expect(moments[firstResult]!.running).toEqual(new Set(agents.map((a) => a.stepId!)));
    expect([end.live, lost]).toEqual([[], []]);
  });

  test("a subagent's background command outlives the subagent and keeps its step running until the command ends", () => {
    const { t, lost, moments, end } = fold("tasks-subagent-background-command");
    const starter = [...t.all.values()].find((x) => x.kind === "agent")!;
    const shell = [...t.all.values()].find((x) => x.kind === "command")!;
    expect([starter.label, shell.background, shell.parent]).toEqual(["starter", true, starter.id]);
    const returned = moments.findIndex((x) => notified(x.m, starter.id));
    expect(moments[returned]!.live.map((x) => x.id)).toEqual([shell.id]);
    expect(moments[returned]!.running).toEqual(new Set([shell.stepId!, starter.stepId!]));
    const ended = moments.findIndex((x, i) => i > returned && !x.live.some((l) => l.id === shell.id));
    expect(ended - returned).toBeGreaterThan(2);
    expect(moments.slice(returned, ended).every((x) => x.running.has(starter.stepId!))).toBe(true);
    expect([end.live, lost]).toEqual([[], []]);
  });

  test("a background command lives past the turn that started it, and a stopped one ends with its notification", () => {
    const { t, lost, moments, end } = fold("tasks-background-command");
    const [first, second] = [...t.all.values()].filter((x) => x.kind === "command" && x.background);
    const afterTurn = moments.findIndex((x) => isResult(x.m) && x.live.length > 0);
    expect(moments[afterTurn]!.live.map((x) => x.id)).toEqual([first!.id]);
    expect(moments[afterTurn]!.running).toEqual(new Set([first!.stepId!]));
    expect(moments.find((x) => notified(x.m, second!.id))!.live.map((x) => x.id)).not.toContain(second!.id);
    expect([end.live, lost]).toEqual([[], []]);
  });

  test("a subagent the user stops, and the shell it ran, end with Claude Code's notifications and leave nothing lost", () => {
    const { t, lost, end } = fold("tasks-stopped-subagent");
    expect([...t.all.values()].map((x) => [x.kind, x.label === "long sleeper" || x.parent !== null])).toEqual([
      ["agent", true],
      ["command", true],
    ]);
    expect([end.live, lost]).toEqual([[], []]);
  });
});
