import { describe, expect, test } from "bun:test";
import { SCENARIOS, type Controls, type Ev, type Item, type Snap } from "./scenarios";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function evidence(over: Partial<Ev>): Ev {
  return {
    now: () => 120_000,
    marks: {},
    history: [],
    frameTimes: [],
    ids: {},
    resumes: [],
    sim: false,
    paired: false,
    transcript: () => ({ main: [], subagents: [] }),
    exists: () => false,
    read: () => null,
    pushes: () => [],
    away: false,
    alerts: [],
    pushStates: [],
    atOf: (s) => Date.parse(s) - T0,
    procs: () => [],
    samples: {},
    app: [],
    list: [],
    sends: [],
    replies: [],
    labels: [],
    watches: [],
    streamed: {},
    opens: [],
    ...over,
  };
}

type RowBits = { status: string; running?: { agents: number; commands: number }; since?: string; activity?: string; outcome?: { kind: string; text: string; at: string } };
const snap = (at: number, name: string, row: RowBits, items: Item[] = [], controls: Partial<Controls> | null = null): Snap => ({
  at,
  frame: 0,
  name,
  row: { id: name, projectId: "p", title: name, origin: "phone", holder: "bridge", unread: false, agent: null, mirror: "off", hidden: false, branch: null, worktree: false, lastAt: iso(at), ...row },
  controls: controls && { canSend: true, reason: null, working: true, queued: 0, ...controls },
  items,
});
const card = (id: string, at: number, answer: string | null): Item => ({ kind: "permission", id: `i-${id}`, at: iso(at), card: { id, answer, label: "Bash", detail: "perl -e 'sleep 30'" } });
const judge = (id: string, ev: Ev) => {
  const sc = SCENARIOS.find((s) => s.rubric.some((r) => r.id === id));
  if (!sc) throw new Error(`no rubric item ${id}`);
  return sc.rubric.find((r) => r.id === id)!.check!(ev);
};

describe("S1.3 the row while subagents run", () => {
  const marks = { "agents-from": 4_000, "agents-to": 42_000 };
  test("awaiting_approval while the subagents' cards are open passes, also while the list trails an answer by 0.5 s", () => {
    const history = [
      snap(4_000, "s1", { status: "working" }),
      snap(5_600, "s1", { status: "working" }, [card("c1", 5_595, null)]),
      snap(6_100, "s1", { status: "awaiting_approval" }, [card("c1", 5_595, null)]),
      snap(10_600, "s1", { status: "awaiting_approval" }, [card("c1", 5_595, "once")]),
      snap(11_100, "s1", { status: "working" }, [card("c1", 5_595, "once")]),
    ];
    expect(judge("S1.3", evidence({ marks, history }))).toEqual({ ok: true, why: "row working in all 5 states, or awaiting_approval while one of 1 cards was open (2 states)" });
  });
  test("an idle row fails", () => {
    const history = [snap(4_000, "s1", { status: "working" }), snap(20_000, "s1", { status: "idle" }), snap(23_000, "s1", { status: "working" })];
    expect(judge("S1.3", evidence({ marks, history }))).toEqual({ ok: false, why: "row idle for about 3 of the 38 s the subagents ran" });
  });
  test("awaiting_approval with no card fails", () => {
    const history = [snap(4_000, "s1", { status: "working" }), snap(20_000, "s1", { status: "awaiting_approval" }), snap(26_000, "s1", { status: "working" })];
    expect(judge("S1.3", evidence({ marks, history }))).toEqual({ ok: false, why: "row awaiting_approval with no open card for about 6 of the 38 s the subagents ran" });
  });
  test("awaiting_approval that outlasts its answered card by 5 s fails for the time past the list's coalescing", () => {
    const history = [
      snap(4_000, "s1", { status: "working" }),
      snap(6_100, "s1", { status: "awaiting_approval" }, [card("c1", 6_000, null)]),
      snap(10_000, "s1", { status: "awaiting_approval" }, [card("c1", 6_000, "once")]),
      snap(15_000, "s1", { status: "working" }, [card("c1", 6_000, "once")]),
    ];
    expect(judge("S1.3", evidence({ marks, history }))).toEqual({ ok: false, why: "row awaiting_approval with no open card for about 4 of the 38 s the subagents ran" });
  });
});

describe("S1.10 and S1.12 the subagents' steps and counts", () => {
  const work = (output: string): Item => ({ kind: "work", id: "w", at: iso(5_000), steps: [{ id: "a1", tool: "Agent", label: "Agent: sleeper one", state: "ok", output }] });
  test("the hand-back wrapper in a step's output fails", () => {
    const history = [snap(40_000, "s1", { status: "working" }, [work("<tools-used-before-summary>Bash</tools-used-before-summary>\n\ndone")])];
    expect(judge("S1.10", evidence({ history }))).toEqual({ ok: false, why: 'Agent: sleeper one: "<tools-used-before-summary>"' });
  });
  test("plain output passes", () => {
    expect(judge("S1.10", evidence({ history: [snap(40_000, "s1", { status: "working" }, [work("done")])] }))).toEqual({ ok: true, why: "no step output matches" });
  });
  const main = [{ type: "assistant", timestamp: iso(4_000), message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] } }];
  const marks = { "agents-from": 4_000, "agents-to": 42_000 };
  test("a row that counts the subagents' own commands fails", () => {
    const history = [snap(10_000, "s1", { status: "working", running: { agents: 3, commands: 3 } })];
    expect(judge("S1.12", evidence({ marks, history, transcript: () => ({ main, subagents: [] }) }))).toEqual({ ok: false, why: "1/1 row states count the subagents' commands again: 3 agents, 3 commands" });
  });
  test("a row that counts only the subagents passes", () => {
    const history = [snap(10_000, "s1", { status: "working", running: { agents: 3, commands: 0 } })];
    expect(judge("S1.12", evidence({ marks, history, transcript: () => ({ main, subagents: [] }) }))).toEqual({ ok: true, why: "1 row states, each counting no command" });
  });
});

describe("S3b.4 the alert reaches a phone on the list", () => {
  const alerts = [{ at: 30_000, name: "s3b", frame: { type: "session_alert", reason: "finished" } }];
  test("an alert after the phone unwatched the thread passes", () => {
    const watches = [{ at: 1_000, name: "s3b", on: true }, { at: 16_000, name: "s3b", on: false }];
    expect(judge("S3b.4", evidence({ alerts, watches }))).toEqual({ ok: true, why: "unwatched at +16.0 s, 14.0 s before the alert" });
  });
  test("an alert while the thread is watched fails, as when open-thread re-watched it", () => {
    const watches = [{ at: 1_000, name: "s3b", on: true }, { at: 13_400, name: "s3b", on: false }, { at: 13_400, name: "s3b", on: true }];
    expect(judge("S3b.4", evidence({ alerts, watches }))).toEqual({ ok: false, why: "watching s3b since +13.4 s, 16.6 s before the alert" });
  });
});

describe("S5.10 frames while a card waits", () => {
  const history = [snap(10_000, "s5", { status: "awaiting_approval" }, [card("c", 10_000, null)]), snap(70_000, "s5", { status: "working" }, [card("c", 10_000, "once")])];
  const frames = (...ats: number[]) => ats.map((at) => ({ at, name: "s5", type: "session_items" }));
  test("a thread frame at least every 30 s passes", () => {
    expect(judge("S5.10", evidence({ history, frameTimes: frames(35_000, 60_000) }))).toEqual({ ok: true, why: "longest gap 25 s over the 60 s the card waited" });
  });
  test("a 40 s silence fails, and list frames do not count", () => {
    const frameTimes = [...frames(20_000, 60_000), { at: 40_000, name: "s5", type: "session_rows" }];
    expect(judge("S5.10", evidence({ history, frameTimes }))).toEqual({ ok: false, why: "a 40 s gap while the card waited 60 s" });
  });
});

describe("S4c.4 stopping is on the wire", () => {
  const marks = { "k-stopped": 20_000 };
  test("controls with stopping within 1 s of Stop pass", () => {
    const history = [snap(20_400, "s4k", { status: "working" }, [], { stopping: { at: iso(20_000), deadline: iso(35_000) } })];
    expect(judge("S4c.4", evidence({ marks, history })).ok).toBe(true);
  });
  test("controls without stopping fail", () => {
    const history = [snap(20_400, "s4k", { status: "working" }, [], { turn: { startedAt: iso(18_000), wake: false } })];
    expect(judge("S4c.4", evidence({ marks, history }))).toEqual({ ok: false, why: "no stopping within 1 s; controls keys then: canSend,reason,working,queued,turn" });
  });
});

describe("S6k.1 a reply cut off by a crash", () => {
  const streamed = { k1: "The first lighthouses were fires kept burning on hilltops by people who knew the coast." };
  const user: Item = { kind: "user", id: "u", at: iso(1_000), text: "Write an essay" };
  test("a fresh open with the partial reply kept and a notice after it passes", () => {
    const opens = [{ at: 9_000, mark: "fresh", name: "k1", live: null, controls: null, items: [user, { kind: "assistant", id: "a", at: iso(3_000), text: streamed.k1 }, { kind: "notice", id: "n", at: iso(8_000), text: "Claude Code stopped while writing this reply." }] }];
    expect(judge("S6k.1", evidence({ streamed, opens }))).toEqual({ ok: true, why: `live null; partial reply of ${streamed.k1.length} characters, then a notice` });
  });
  test("a fresh open that still seeds the dead text as live fails", () => {
    const opens = [{ at: 9_000, mark: "fresh", name: "k1", live: { itemId: "a", text: streamed.k1 }, controls: null, items: [user, { kind: "notice", id: "n", at: iso(8_000), text: "Claude Code stopped unexpectedly." }] }];
    expect(judge("S6k.1", evidence({ streamed, opens }))).toEqual({ ok: false, why: `live still holds ${streamed.k1.length} characters; no assistant item holds the partial text (items: user, notice)` });
  });
});

describe("S6e.7 the row never flickers", () => {
  const marks = { restarted: 10_000, "e1-stop": 40_000, killed: 20_000, "e2-stop": 40_000 };
  test("working, failed, working fails", () => {
    const history = [snap(5_000, "e1", { status: "working" }), snap(15_000, "e1", { status: "failed" }), snap(15_500, "e1", { status: "working" }), snap(19_000, "e2", { status: "working" })];
    expect(judge("S6e.7", evidence({ marks, history }))).toEqual({ ok: false, why: "e1: working → failed → working" });
  });
  test("one change per real change passes", () => {
    const history = [snap(5_000, "e1", { status: "working" }), snap(15_000, "e1", { status: "working" }), snap(19_000, "e2", { status: "working" }), snap(21_000, "e2", { status: "failed" })];
    expect(judge("S6e.7", evidence({ marks, history }))).toEqual({ ok: true, why: "each row status held until a real change" });
  });
});

describe("S6d.4 no finished alert while unsure", () => {
  const unsure: Item = { kind: "work", id: "w", at: iso(1_000), steps: [{ id: "b", tool: "Bash", label: "Run sleep 52", state: "unsure", output: null }] };
  const ended: Item = { kind: "work", id: "w", at: iso(1_000), steps: [{ id: "b", tool: "Bash", label: "Run sleep 52", state: "ended", output: null }] };
  const alerts = [{ at: 40_000, name: "vu2", frame: { type: "session_alert", reason: "finished" } }];
  test("a finished alert while a step reads unsure fails", () => {
    expect(judge("S6d.4", evidence({ alerts, history: [snap(35_000, "vu2", { status: "idle" }, [unsure])] }))).toEqual({ ok: false, why: "vu2 finished at +40 s with 1 step(s) unsure" });
  });
  test("a finished alert once the step ended passes", () => {
    expect(judge("S6d.4", evidence({ alerts, history: [snap(35_000, "vu2", { status: "idle" }, [ended])] })).ok).toBe(true);
  });
});

describe("S9.7 and S9.8 after the push server recovers", () => {
  const marks = { "sink-back": 12_000 };
  const push = (at: number, body: string) => ({ at: iso(at), title: null, click: "claudiobot://session/s", status: 200, body });
  const reminder = push(60_000, "A Claude Code session is still waiting for you");
  test("the owed card push before the reminder, and on without a new event, pass", () => {
    const ev = evidence({ marks, pushes: () => [push(40_000, "A Claude Code session needs your approval"), reminder], pushStates: [{ at: 40_500, via: "push_state", push: { state: "on" } }] });
    expect([judge("S9.7", ev).ok, judge("S9.8", ev)]).toEqual([true, { ok: true, why: "on 28.5 s after the server came back" }]);
  });
  test("only the reminder gets through, and on follows it, fail", () => {
    const ev = evidence({ marks, pushes: () => [reminder], pushStates: [{ at: 30_500, via: "push_state", push: { state: "on" } }] });
    const early = evidence({ marks, pushes: () => [push(30_000, "A Claude Code session is still waiting for you")], pushStates: [{ at: 30_500, via: "push_state", push: { state: "on" } }] });
    expect([judge("S9.7", ev), judge("S9.8", early)]).toEqual([
      { ok: false, why: "no card push got through after the server came back; the reminder did, 48 s after" },
      { ok: false, why: "on only 18.5 s after the server came back, after the reminder got through" },
    ]);
  });
});
