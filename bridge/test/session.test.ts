import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Headroom, Ledger } from "../src/ledger";
import type { AgentId, BotId, RoutineId, RunId } from "../src/protocol";
import {
  BREAKER_NOTE,
  CAP_NOTE,
  HEADROOM_RETRY_MS,
  RESTARTED_ERROR,
  START_RETRY_MS,
  STOP_DEADLINE_MS,
  USAGE_PARK_FALLBACK_MS,
  USAGE_PARK_MAX_MS,
  USAGE_PARK_SLACK_MS,
  classify,
  claudeExecutable,
  createSession,
  freshMemo,
  noSignals,
  step,
  type Core,
  type Effect,
  type Event,
  type Outcome,
  type TurnEnd,
  usedBudget,
} from "../src/session";
import type { SessionInput } from "../src/prompts";
import {
  attended,
  emptySession,
  type AccountState,
  type ActiveTurn,
  type EnvelopeId,
  type Initiator,
  type Lifecycle,
  type Pending,
  type RunRef,
  type SessionState,
} from "../src/world";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const user: Initiator = { kind: "user" };
const routine: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_1" as RunId }, manual: false };
const manualRun: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_2" as RunId }, manual: true };
const botMail: Initiator = { kind: "bot", botId: "b_2" as BotId, hops: 1, origin: { kind: "user" } };
const agentMail: Initiator = { kind: "agent", agentId: "a_1" as AgentId, hops: 0, origin: { kind: "user" } };
const attendedNow = attended;

const roomy = (): Headroom => ({ ok: true, capReached: false });
const fired: RunRef = { routineId: "r_1" as RoutineId, runId: "run_1" as RunId };

// ─── step(): the lifecycle as a table ───────────────────────────────────────────────────────────────────────────────

const env = (id: string, initiator: Initiator = user, attempts = 0): Pending => ({
  id: id as EnvelopeId,
  kind: "envelope",
  at: NOW.toISOString(),
  text: `[${id}]`,
  initiator,
  settles: null,
  attempts,
});
/** A routine's scheduled fire: the only envelope that settles a run. */
const fire = (id: string): Pending => ({ ...env(id, routine), settles: routine.kind === "routine" ? routine.run : null });
const turn = (id: string, over: Partial<ActiveTurn> = {}): ActiveTurn => ({ pending: id as EnvelopeId, startedAt: NOW.toISOString(), output: false, denials: 0, ...over });
const core = (lifecycle: Lifecycle, pending: Pending[], over: Partial<Core> = {}): Core => ({
  session: { id: "s_1", pending, lifecycle, notices: [] },
  parkedUntil: null,
  memo: freshMemo(),
  ...over,
});
const run = (c: Core, ev: Event, headroom: (i: Initiator) => Headroom = roomy, now = NOW) => step(c, ev, { now, headroom, userName: "Alex" });
const endsOf = (fx: Effect[]) => fx.flatMap((e) => (e.kind === "end" ? [[e.pending.id as string, e.end.kind]] : []));
const kinds = (fx: Effect[]) => fx.map((e) => e.kind);
const ok = (cost = 1): Outcome => ({ kind: "result", result: { type: "result", subtype: "success", is_error: false, total_cost_usd: cost } as SDKResultMessage });

describe("step", () => {
  test("an idle session starts a pushed envelope: one attempt counted, its text sent", () => {
    const t = run(core({ kind: "idle" }, []), { kind: "push", pending: env("a") });
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("a") });
    expect(t.core.session.pending).toEqual([env("a", user, 1)]);
    expect(t.effects).toEqual([{ kind: "send", pending: env("a", user, 1), text: "[a]" }]);
  });

  test("an approval continuation goes right behind the turn in flight, before everything queued", () => {
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", user, 1), env("b")]), { kind: "push", pending: { ...env("c", routine), kind: "continuation" } });
    expect(t.core.session.pending.map((p) => p.id as string)).toEqual(["a", "c", "b"]);
    expect(t.effects).toEqual([]);
  });

  test.each([
    [1, { kind: "working", turn: turn("a", { denials: 1 }) }, []],
    [2, { kind: "working", turn: turn("a", { denials: 2 }) }, []],
    [3, { kind: "stopping", turn: turn("a", { denials: 3 }), deadline: later(STOP_DEADLINE_MS) }, ["interrupt", "note"]],
  ] as const)("denial %i in one turn", (n, lifecycle, effects) => {
    const t = run(core({ kind: "working", turn: turn("a", { denials: n - 1 }) }, [env("a", user, 1)]), { kind: "denied" });
    expect(t.core.session.lifecycle).toEqual(lifecycle);
    expect(kinds(t.effects)).toEqual([...effects]);
    if (n === 3) expect(t.effects[1]).toEqual({ kind: "note", text: BREAKER_NOTE });
  });

  test("denials while stopping are the gate's doing and do not count", () => {
    const stopping: Lifecycle = { kind: "stopping", turn: turn("a", { denials: 1 }), deadline: later(STOP_DEADLINE_MS) };
    const t = run(core(stopping, [env("a", user, 1)]), { kind: "denied" });
    expect(t.core.session.lifecycle).toEqual(stopping);
  });

  test("a result ends the turn as done and the next envelope starts", () => {
    const outcome = ok();
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", user, 1), env("b")]), { kind: "end", outcome });
    expect(t.effects[0]).toEqual({ kind: "end", pending: env("a", user, 1), end: { kind: "done", result: outcome.kind === "result" ? outcome.result : (null as never) } });
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("b") });
  });

  test.each([
    [1, { kind: "backoff", until: later(1_000), attempt: 1 }, "deferred"],
    [2, { kind: "backoff", until: later(3_000), attempt: 2 }, "deferred"],
    [3, { kind: "backoff", until: later(8_000), attempt: 3 }, "deferred"],
    [4, { kind: "idle" }, "failed"],
  ] as const)("a transient error with no output on start %i", (attempts, lifecycle, end) => {
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", user, attempts)]), { kind: "end", outcome: { kind: "transient", error: "overloaded" } });
    expect(t.core.session.lifecycle).toEqual(lifecycle);
    expect(endsOf(t.effects)).toEqual([["a", end]]);
    expect(t.core.session.pending.length).toBe(end === "deferred" ? 1 : 0);
  });

  test("a transient error after output fails the turn: it may have had effects", () => {
    const t = run(core({ kind: "working", turn: turn("a", { output: true }) }, [env("a", user, 1)]), { kind: "end", outcome: { kind: "transient", error: "overloaded" } });
    expect(t.effects).toEqual([{ kind: "end", pending: env("a", user, 1), end: { kind: "failed", error: "overloaded" } }]);
    expect(t.core.session.pending).toEqual([]);
  });

  test("a usage limit with no output parks the account and the session, keeps the envelope and gives its attempt back", () => {
    const until = later(3_600_000);
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", routine, 1)]), { kind: "end", outcome: { kind: "usage_limit", error: "limit", until, scope: "account" } });
    expect(t.core.parkedUntil).toBe(until);
    expect(t.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
    expect(t.core.session.pending).toEqual([env("a", routine, 0)]);
    expect(t.effects).toEqual([{ kind: "end", pending: env("a", routine, 0), end: { kind: "deferred", until, why: "usage_limit" } }]);
  });

  test("a usage limit after output fails the turn but still parks the account for what is queued", () => {
    const until = later(3_600_000);
    const t = run(core({ kind: "working", turn: turn("a", { output: true }) }, [env("a", user, 1), env("b")]), { kind: "end", outcome: { kind: "usage_limit", error: "limit", until, scope: "account" } });
    expect(endsOf(t.effects)).toEqual([
      ["a", "failed"],
      ["b", "deferred"],
    ]);
    expect(t.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
  });

  test("a usage limit on one model parks only this session: the account stays open and the envelope keeps its attempt", () => {
    const until = later(3_600_000);
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", routine, 1), env("b")]), { kind: "end", outcome: { kind: "usage_limit", error: "limit", until, scope: "session" } });
    expect(t.core.parkedUntil).toBeNull();
    expect(t.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
    expect(t.core.session.pending).toEqual([env("a", routine, 0), env("b")]);
    expect(endsOf(t.effects)).toEqual([["a", "deferred"]]);
    const after = run(t.core, { kind: "tick" }, roomy, new Date(until));
    expect(after.core.session.lifecycle).toEqual({ kind: "working", turn: turn("a", { startedAt: until }) });
  });

  test("a usage limit on one model after output fails the turn and still parks this session for what is queued", () => {
    const until = later(3_600_000);
    const t = run(core({ kind: "working", turn: turn("a", { output: true }) }, [env("a", user, 1), env("b")]), { kind: "end", outcome: { kind: "usage_limit", error: "limit", until, scope: "session" } });
    expect(endsOf(t.effects)).toEqual([
      ["a", "failed"],
      ["b", "deferred"],
    ]);
    expect([t.core.parkedUntil, t.core.session.lifecycle]).toEqual([null, { kind: "parked", reason: "usage_limit", until }]);
  });

  const interrupted: Outcome = { kind: "result", result: { type: "result", subtype: "error_during_execution", is_error: true, errors: [] } as unknown as SDKResultMessage };
  test.each([
    ["the interrupt's error_during_execution", interrupted],
    ["a transient error", { kind: "transient", error: "x" }],
    ["a terminal error", { kind: "terminal", error: "x" }],
  ] as [string, Outcome][])("%s while stopping ends the turn as stopped, never retried", (_, outcome) => {
    const stopping: Lifecycle = { kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) };
    const t = run(core(stopping, [env("a", user, 1)]), { kind: "end", outcome });
    expect(t.effects).toEqual([{ kind: "end", pending: env("a", user, 1), end: { kind: "stopped", by: "user" } }]);
    expect(t.core.session).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
  });

  test("a real success that lands while stopping is done, so the turn's final report is kept", () => {
    const outcome = ok();
    const stopping: Lifecycle = { kind: "stopping", turn: turn("a", { denials: 3 }), deadline: later(STOP_DEADLINE_MS) };
    const t = run(core(stopping, [env("a", user, 1)]), { kind: "end", outcome });
    expect(endsOf(t.effects)).toEqual([["a", "done"]]);
    expect(t.core.session).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
  });

  test("Stop on a working turn interrupts it and drops queued routine fires and bot messages, with one notice", () => {
    const pending = [env("a", routine, 1), env("u1"), fire("r"), env("b", botMail), env("m", manualRun), env("g", agentMail)];
    const t = run(core({ kind: "working", turn: turn("a") }, pending), { kind: "stop" });
    expect(t.core.session.lifecycle).toEqual({ kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) });
    expect(t.core.session.pending.map((p) => p.id as string)).toEqual(["a", "u1", "m", "g"]);
    expect(kinds(t.effects)).toEqual(["interrupt", "end", "end"]);
    expect(endsOf(t.effects)).toEqual([
      ["r", "dropped"],
      ["b", "dropped"],
    ]);
    expect(t.core.session.notices.map((n) => n.text)).toEqual(["[Alex pressed Stop, so 2 queued messages never ran: [r]; [b]]"]);
  });

  test("Stop keeps agent reports and the continuations of calls a routine or the bridge asked for", () => {
    const system: Initiator = { kind: "system" };
    const pending = [env("a", user, 1), env("g", agentMail), env("rc", routine), env("sc", system)];
    const t = run(core({ kind: "working", turn: turn("a") }, pending), { kind: "stop" });
    expect(t.core.session.pending.map((p) => p.id as string)).toEqual(["a", "g", "rc", "sc"]);
    expect([kinds(t.effects), t.core.session.notices]).toEqual([["interrupt"], []]);
  });

  test.each([
    [1, ["[Alex pressed Stop, so this never ran: [r1]]"]],
    [5, ["[Alex pressed Stop, so 5 queued messages never ran: [r1]; [r2]; [r3]; and 2 more]"]],
  ] as const)("Stop dropping %i envelopes leaves one notice", (n, notices) => {
    const queued = Array.from({ length: n }, (_, i) => fire(`r${i + 1}`));
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", user, 1), ...queued]), { kind: "stop" });
    expect(t.core.session.notices.map((x) => x.text)).toEqual([...notices]);
  });

  test("Stop on a head waiting in backoff ends it as stopped and runs the user's queued message", () => {
    const t = run(core({ kind: "backoff", until: later(3_000), attempt: 2 }, [env("a", routine, 2), env("u")]), { kind: "stop" });
    expect(endsOf(t.effects)).toEqual([["a", "stopped"]]);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("u") });
  });

  test.each([
    ["an idle session with nothing queued", core({ kind: "idle" }, [])],
    ["a turn already stopping", core({ kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) }, [env("a", routine, 1), env("u")])],
  ] as const)("Stop changes nothing for %s", (_, c) => {
    const t = run(c, { kind: "stop" });
    expect(t.core).toEqual(c);
    expect(t.effects).toEqual([]);
  });

  test("Stop while parked for the usage limit drops queued unattended work and keeps the user's message parked", () => {
    const until = later(60_000);
    const parked: Lifecycle = { kind: "parked", reason: "usage_limit", until };
    const t = run(core(parked, [env("u"), fire("r"), env("b", botMail)], { parkedUntil: until }), { kind: "stop" });
    expect(t.core.session.pending.map((p) => p.id as string)).toEqual(["u"]);
    expect(t.core.session.lifecycle).toEqual(parked);
    expect(endsOf(t.effects)).toEqual([
      ["r", "dropped"],
      ["b", "dropped"],
    ]);
    expect(t.core.session.notices.map((n) => n.text)).toEqual(["[Alex pressed Stop, so 2 queued messages never ran: [r]; [b]]"]);
  });

  test("Stop while parked at the daily cap with only unattended work empties the queue", () => {
    const t = run(core({ kind: "parked", reason: "daily_cap", until: later(60_000) }, [fire("r1"), fire("r2")]), { kind: "stop" });
    expect(t.core.session).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
    expect(endsOf(t.effects)).toEqual([
      ["r1", "dropped"],
      ["r2", "dropped"],
    ]);
  });

  test("Stop on an idle session with a queue drops unattended mail and starts the user's message", () => {
    const t = run(core({ kind: "idle" }, [env("b", botMail), env("u")]), { kind: "stop" });
    expect(endsOf(t.effects)).toEqual([["b", "dropped"]]);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("u") });
  });

  test("the stop deadline kills the query and ends the turn as stopped", () => {
    const stopping: Lifecycle = { kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) };
    const c = core(stopping, [env("a", user, 1), env("u")]);
    expect(run(c, { kind: "tick" }, roomy, new Date(later(STOP_DEADLINE_MS - 1))).effects).toEqual([]);
    const t = run(c, { kind: "tick" }, roomy, new Date(later(STOP_DEADLINE_MS)));
    expect(kinds(t.effects)).toEqual(["kill", "end", "send"]);
    expect(endsOf(t.effects)).toEqual([["a", "stopped"]]);
  });

  test.each([
    { kind: "backoff", until: later(1_000), attempt: 1 },
    { kind: "parked", reason: "usage_limit", until: later(1_000) },
  ] as Lifecycle[])("$kind holds the head until its deadline, then starts it", (lifecycle) => {
    const c = core(lifecycle, [env("a", routine, 1)]);
    expect(run(c, { kind: "tick" }, roomy, new Date(later(999))).core.session.lifecycle).toEqual(lifecycle);
    const t = run(c, { kind: "tick" }, roomy, new Date(later(1_000)));
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("a", { startedAt: later(1_000) }) });
    expect(t.core.session.pending[0]!.attempts).toBe(2);
  });

  test("a daily-cap park re-checks headroom on every tick, tells the park once, and starts the head once it may run", () => {
    const until = later(12 * 3_600_000);
    let capped = true;
    const headroom = (i: Initiator): Headroom => (!capped || attendedNow(i) ? roomy() : { ok: false, reason: "daily_cap", until });
    const parked = run(core({ kind: "idle" }, []), { kind: "push", pending: env("r", routine) }, headroom);
    expect(endsOf(parked.effects)).toEqual([["r", "deferred"]]);
    const still = run(parked.core, { kind: "tick" }, headroom, new Date(later(60_000)));
    expect([still.core.session, still.effects]).toEqual([parked.core.session, []]);
    capped = false;
    const t = run(still.core, { kind: "tick" }, headroom, new Date(later(120_000)));
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("r", { startedAt: later(120_000) }) });
  });

  test("a park whose deadline keeps moving is told once", () => {
    let at = NOW.getTime();
    const headroom = (): Headroom => ({ ok: false, reason: "daily_cap", until: new Date(at + 60_000).toISOString() });
    let c = run(core({ kind: "idle" }, []), { kind: "push", pending: env("r", routine) }, headroom).core;
    const told: string[][] = [];
    for (let i = 0; i < 3; i++) {
      at += 60_000;
      const t = run(c, { kind: "tick" }, headroom, new Date(at));
      told.push(...endsOf(t.effects));
      c = t.core;
    }
    expect(told).toEqual([]);
    expect(c.session.lifecycle).toMatchObject({ kind: "parked", reason: "daily_cap" });
  });

  test("a query that could not open gives the attempt back, waits 30 s, touches nothing else queued, and says so at once", () => {
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", user, 1), env("b", routine)]), { kind: "unstarted", error: "claude was not found" });
    const until = later(START_RETRY_MS[0]);
    expect(t.core.session.pending).toEqual([env("a", user, 0), env("b", routine)]);
    expect(t.core.session.lifecycle).toEqual({ kind: "backoff", until, attempt: 0 });
    expect(t.effects).toEqual([
      { kind: "end", pending: env("a", user, 0), end: { kind: "deferred", until, why: "retry" } },
      { kind: "note", text: "Claude Code could not start: claude was not found. Queued messages are kept, and it keeps trying." },
    ]);
  });

  test("repeated start failures wait longer each time up to a cap, never use up the envelope, and leave one note", () => {
    let at = NOW.getTime();
    let c = run(core({ kind: "idle" }, []), { kind: "push", pending: env("a") }).core;
    const waits: number[] = [];
    const notes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = run(c, { kind: "unstarted", error: "gate not ready" }, roomy, new Date(at));
      const life = t.core.session.lifecycle;
      if (life.kind !== "backoff") throw new Error(`expected backoff, got ${life.kind}`);
      waits.push(Date.parse(life.until) - at);
      notes.push(...t.effects.flatMap((e) => (e.kind === "note" ? [e.text] : [])));
      at = Date.parse(life.until);
      c = run(t.core, { kind: "tick" }, roomy, new Date(at)).core;
      expect(c.session.pending).toEqual([{ ...env("a", user, 1) }]);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("gate not ready");
    const opened = run(c, { kind: "end", outcome: ok() }, roomy, new Date(at)).core;
    const again = run(run(opened, { kind: "push", pending: env("b") }, roomy, new Date(at)).core, { kind: "unstarted", error: "x" }, roomy, new Date(at));
    expect(again.core.session.lifecycle).toMatchObject({ until: new Date(at + START_RETRY_MS[0]).toISOString() });
  });

  test.each([
    ["a terminal error before output", { kind: "working", turn: turn("a") }, { kind: "terminal", error: "x" }, 1, ["[n]"]],
    ["the last transient retry before output", { kind: "working", turn: turn("a") }, { kind: "transient", error: "x" }, 4, ["[n]"]],
    ["Stop's interrupt before output", { kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) }, interrupted, 1, ["[n]"]],
    ["a result", { kind: "working", turn: turn("a") }, ok(), 1, []],
  ] as [string, Lifecycle, Outcome, number, string[]][])("the notices a turn carried are kept after %s only if the model never saw them", (_, lifecycle, outcome, attempts, left) => {
    const c = core(lifecycle, [env("a", user, attempts)]);
    c.session.notices = [{ at: NOW.toISOString(), text: "[n]" }];
    c.memo.carried = 1;
    const t = run(c, { kind: "end", outcome });
    expect(t.core.session.pending).toEqual([]);
    expect(t.core.session.notices.map((n) => n.text)).toEqual(left);
  });

  test("a tick at the same moment twice changes nothing the second time", () => {
    const first = run(core({ kind: "backoff", until: later(1_000), attempt: 1 }, [env("a", user, 1)]), { kind: "tick" }, roomy, new Date(later(1_000)));
    const second = run(first.core, { kind: "tick" }, roomy, new Date(later(1_000)));
    expect(second.core).toEqual(first.core);
    expect(second.effects).toEqual([]);
  });

  test("while the account is parked nothing starts, and the park is told once", () => {
    const until = later(60_000);
    const first = run(core({ kind: "idle" }, [], { parkedUntil: until }), { kind: "push", pending: env("a") });
    expect(first.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
    expect(endsOf(first.effects)).toEqual([["a", "deferred"]]);
    expect(run(first.core, { kind: "push", pending: env("b") }).effects).toEqual([]);
  });

  test("the daily cap parks an unattended head while an attended envelope behind it runs, noting the cap once", () => {
    const until = later(12 * 3_600_000);
    const headroom = (i: Initiator): Headroom => (attendedNow(i) ? { ok: true, capReached: true } : { ok: false, reason: "daily_cap", until });
    const t = run(core({ kind: "idle" }, [env("r", routine), env("u")]), { kind: "pump" }, headroom);
    expect(t.core.session.pending.map((p) => p.id as string)).toEqual(["u", "r"]);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("u") });
    expect(t.effects).toEqual([
      { kind: "end", pending: env("r", routine), end: { kind: "deferred", until, why: "daily_cap" } },
      { kind: "send", pending: env("u", user, 1), text: "[u]" },
      { kind: "note", text: CAP_NOTE },
    ]);
    const after = run(t.core, { kind: "end", outcome: ok() }, headroom);
    expect(after.core.session.lifecycle).toEqual({ kind: "parked", reason: "daily_cap", until });
    expect(endsOf(after.effects)).toEqual([["u", "done"]]);
    const again = run(after.core, { kind: "push", pending: env("u2") }, headroom);
    expect(kinds(again.effects)).toEqual(["send"]);
  });

  test("an exhausted agent budget fails the envelope without starting it", () => {
    const t = run(core({ kind: "idle" }, []), { kind: "push", pending: env("a", botMail) }, () => ({ ok: false, reason: "agent_budget" }));
    expect(endsOf(t.effects)).toEqual([["a", "failed"]]);
    expect(t.core.session).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
  });

  test("a budget that ran out, before the turn or during it, reads as used up; other ends do not", () => {
    const outOfBudget = run(core({ kind: "idle" }, []), { kind: "push", pending: env("a", botMail) }, () => ({ ok: false, reason: "agent_budget" }));
    const outOfAttempts = run(core({ kind: "idle" }, [env("a", user, 4)]), { kind: "pump" });
    const endOf = (fx: Effect[]) => fx.flatMap((e) => (e.kind === "end" ? [e.end] : []))[0]!;
    const result = (subtype: string) => ({ type: "result", subtype, is_error: subtype !== "success", errors: [], total_cost_usd: 1 }) as unknown as SDKResultMessage;
    const ends: TurnEnd[] = [
      endOf(outOfBudget.effects),
      { kind: "done", result: result("error_max_budget_usd") },
      endOf(outOfAttempts.effects),
      { kind: "done", result: result("success") },
      { kind: "done", result: result("error_max_turns") },
      { kind: "stopped", by: "user" },
    ];
    expect(ends.map(usedBudget)).toEqual([true, true, false, false, false, false]);
  });

  test("an envelope out of attempts fails instead of starting a fifth time", () => {
    const t = run(core({ kind: "idle" }, [env("a", user, 4), env("b")]), { kind: "pump" });
    expect(endsOf(t.effects)).toEqual([["a", "failed"]]);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("b") });
  });

  test("notices ride on the next envelope, are kept for a retry, and are dropped once the turn has output", () => {
    const c = core({ kind: "idle" }, []);
    c.session.notices = [{ at: NOW.toISOString(), text: "[Your question expired.]" }];
    const started = run(c, { kind: "push", pending: env("a") });
    expect(started.effects).toEqual([{ kind: "send", pending: env("a", user, 1), text: "[Your question expired.]\n[a]" }]);
    const retried = run(started.core, { kind: "end", outcome: { kind: "transient", error: "overloaded" } });
    expect(retried.core.session.notices).toHaveLength(1);
    const again = run(retried.core, { kind: "tick" }, roomy, new Date(later(1_000)));
    expect(again.effects[0]).toMatchObject({ kind: "send", text: "[Your question expired.]\n[a]" });
    const noticeDuring = run(again.core, { kind: "notice", notice: { at: NOW.toISOString(), text: "[later]" } });
    expect(run(noticeDuring.core, { kind: "output" }).core.session.notices.map((n) => n.text)).toEqual(["[later]"]);
  });

  test.each([
    ["working without output: replayed", { kind: "working", turn: turn("a") }, { kind: "idle" }, [], 1, 0],
    ["working with output: failed, with a notice", { kind: "working", turn: turn("a", { output: true }) }, { kind: "idle" }, [["a", "failed"]], 0, 1],
    ["stopping: stopped", { kind: "stopping", turn: turn("a"), deadline: later(1) }, { kind: "idle" }, [["a", "stopped"]], 0, 0],
    ["backoff: unchanged", { kind: "backoff", until: later(1), attempt: 1 }, { kind: "backoff", until: later(1), attempt: 1 }, [], 1, 0],
    ["parked: unchanged", { kind: "parked", reason: "usage_limit", until: later(1) }, { kind: "parked", reason: "usage_limit", until: later(1) }, [], 1, 0],
  ] as const)("recover %s", (_, from, to, ends, queued, noticeCount) => {
    const t = run(core(from as Lifecycle, [env("a", routine, 1)]), { kind: "recover" });
    expect(t.core.session.lifecycle).toEqual(to as Lifecycle);
    expect(endsOf(t.effects)).toEqual(ends as unknown as string[][]);
    expect(t.core.session.pending).toHaveLength(queued);
    expect(t.core.session.notices).toHaveLength(noticeCount);
    if (ends[0]?.[1] === "failed") expect(t.effects[0]).toMatchObject({ end: { kind: "failed", error: RESTARTED_ERROR } });
  });
});

describe("classify", () => {
  const success = (over: object = {}) => ({ type: "result", subtype: "success", is_error: false, result: "done", errors: [], ...over }) as unknown as SDKResultMessage;
  const apiFailure = (over: object = {}) => success({ is_error: true, result: "API Error: boom", ...over });
  const interruptResult = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic]"] } as unknown as SDKResultMessage;
  const signals = (over: object = {}) => ({ ...noSignals(), ...over });
  const resetsAt = Math.floor(NOW.getTime() / 1000) + 3_600;

  test.each([
    ["success", success(), signals(), "result"],
    ["an error subtype", interruptResult, signals(), "result"],
    ["overloaded", apiFailure(), signals({ apiError: "overloaded" }), "transient"],
    ["server_error", apiFailure(), signals({ apiError: "server_error" }), "transient"],
    ["a 5xx status", apiFailure({ api_error_status: 529 }), signals(), "transient"],
    ["authentication_failed", apiFailure(), signals({ apiError: "authentication_failed" }), "terminal"],
    ["a rejected rate limit", apiFailure(), signals({ rejected: true, resetsAt }), "usage_limit"],
    ["an error subtype after a rejected rate limit", interruptResult, signals({ rejected: true, resetsAt }), "usage_limit"],
    ["a 429 after a rejected rate limit", apiFailure({ api_error_status: 429 }), signals({ apiError: "rate_limit", rejected: true, resetsAt }), "usage_limit"],
    ["a 429 with no reset info", apiFailure({ api_error_status: 429 }), signals(), "transient"],
    ["a rate_limit error with no reset info", apiFailure(), signals({ apiError: "rate_limit" }), "transient"],
  ] as const)("%s → %s", (_, result, s, kind) => {
    expect(classify(result, s, NOW).kind).toBe(kind);
  });

  const untilOf = (s: object) => {
    const o = classify(apiFailure(), signals({ rejected: true, ...s }), NOW);
    if (o.kind !== "usage_limit") throw new Error(`expected usage_limit, got ${o.kind}`);
    return o.until;
  };

  test("the usage park ends 30 s after resetsAt, read as epoch seconds or, above 1e12, as milliseconds", () => {
    const expected = new Date(resetsAt * 1000 + USAGE_PARK_SLACK_MS).toISOString();
    expect(untilOf({ resetsAt })).toBe(expected);
    expect(untilOf({ resetsAt: resetsAt * 1000 })).toBe(expected);
  });

  test.each([null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("a rejection whose resetsAt is %p parks for the fallback", (value) => {
    expect(untilOf({ resetsAt: value })).toBe(later(USAGE_PARK_FALLBACK_MS + USAGE_PARK_SLACK_MS));
  });

  test.each([resetsAt + 30 * 86_400, 1e15, 1e300])("a reset as far off as %p parks at most 8 days", (value) => {
    expect(USAGE_PARK_MAX_MS).toBe(8 * 86_400_000);
    expect(untilOf({ resetsAt: value })).toBe(later(USAGE_PARK_MAX_MS));
  });

  test("a reset already past parks for the slack only", () => {
    expect(untilOf({ resetsAt: resetsAt - 7_200 })).toBe(later(USAGE_PARK_SLACK_MS));
  });

  test.each([
    [null, "account"],
    ["five_hour", "account"],
    ["seven_day", "account"],
    ["overage", "account"],
    ["seven_day_opus", "session"],
    ["seven_day_sonnet", "session"],
    ["seven_day_overage_included", "session"],
  ] as const)("a rejection of limit type %p parks the %s", (limitType, scope) => {
    expect(classify(apiFailure(), signals({ rejected: true, resetsAt, limitType }), NOW)).toMatchObject({ kind: "usage_limit", scope });
  });
});

// ─── createSession(): the shell, against a fake query ───────────────────────────────────────────────────────────────

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeQuery {
  readonly received: { text: string; disk: SessionState }[] = [];
  interrupts = 0;
  closed = false;
  private queue: SDKMessage[] = [];
  private failure: Error | null = null;
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    disk: () => SessionState,
  ) {
    void (async () => {
      for await (const m of prompt) this.received.push({ text: m.message.content as string, disk: disk() });
    })();
  }

  emit(...ms: SDKMessage[]) {
    this.queue.push(...ms);
    this.wake?.();
  }
  exit() {
    this.ended = true;
    this.wake?.();
  }
  crash(error: Error) {
    this.failure = error;
    this.wake?.();
  }
  async interrupt() {
    this.interrupts++;
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended || this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

const configuredClaude = process.env.CLAUDIOBOT_CLAUDE;
afterEach(() => {
  if (configuredClaude === undefined) delete process.env.CLAUDIOBOT_CLAUDE;
  else process.env.CLAUDIOBOT_CLAUDE = configuredClaude;
});

let uuid = 0;
const said = (t: string) =>
  ({ type: "assistant", uuid: `u${++uuid}`, session_id: "s_1", parent_tool_use_id: null, message: { content: [{ type: "text", text: t }] } }) as unknown as SDKMessage;
const apiErrorMessage = (error: string) =>
  ({ type: "assistant", uuid: `u${++uuid}`, session_id: "s_1", parent_tool_use_id: null, error, message: { content: [{ type: "text", text: `API Error: ${error}` }] } }) as unknown as SDKMessage;
const resultMsg = (cost: number, over: object = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: "ok", errors: [], session_id: "s_1", total_cost_usd: cost, ...over }) as unknown as SDKMessage;
const apiErrorResult = (cost: number) => resultMsg(cost, { is_error: true, result: "API Error: overloaded" });
const interruptedResult = (cost: number) =>
  resultMsg(cost, { subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"] });
const rejected = (resetsAt: unknown, info: object = {}) =>
  ({ type: "rate_limit_event", uuid: "rl", session_id: "s_1", rate_limit_info: { status: "rejected", resetsAt, ...info } }) as unknown as SDKMessage;

type Harness = ReturnType<typeof harness>;

function harness(
  opts: {
    state?: SessionState;
    account?: AccountState;
    headroom?: (i: Initiator) => Headroom;
    options?: () => Options;
    add?: Ledger["add"];
    persist?: (urgency?: "now") => void;
    executable?: string | null;
    defaultExecutable?: boolean;
    clock?: { t: number };
    dailyLeft?: () => number;
  } = {},
) {
  const clock = opts.clock ?? { t: NOW.getTime() };
  const state = opts.state ?? emptySession();
  const account = opts.account ?? { parkedUntil: null };
  const ends: { id: string; text: string; pending: Pending; end: TurnEnd }[] = [];
  const notes: string[] = [];
  const messages: { m: SDKMessage; turn: Pending | null }[] = [];
  const usage: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const queries: FakeQuery[] = [];
  let disk = structuredClone(state);
  let changes = 0;
  const session = createSession({
    actor: { kind: "bot", botId: "b_1" as BotId },
    state,
    account,
    options: opts.options ?? (() => ({ cwd: "/bots/b_1", resume: state.id ?? undefined })),
    ledger: {
      add: opts.add ?? ((row) => void usage.push(row as Record<string, unknown>)),
      headroom: (_, i) => (opts.headroom ?? roomy)(i),
      budgetLeft: () => 5,
      dailyLeft: opts.dailyLeft ?? (() => 10),
    },
    onMessage: (m, t) => messages.push({ m, turn: t }),
    onTurnEnd: (p, end) => ends.push({ id: p.id, text: p.text, pending: p, end }),
    onChange: () => changes++,
    note: (text) => notes.push(text),
    persist:
      opts.persist ??
      ((urgency) => {
        if (urgency === "now") disk = structuredClone(state);
      }),
    userName: "Alex",
    name: () => "Ana",
    log: (line) => logs.push(line),
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const q = new FakeQuery(options, prompt, () => structuredClone(disk));
      queries.push(q);
      return q;
    }) as unknown as typeof query,
    ...(!opts.defaultExecutable && { executable: () => (opts.executable === undefined ? "/fake/claude" : opts.executable) }),
    now: () => new Date(clock.t),
  });
  return {
    session,
    state,
    account,
    ends,
    notes,
    messages,
    usage,
    logs,
    queries,
    clock,
    get disk() {
      return disk;
    },
    get changes() {
      return changes;
    },
    q: () => queries.at(-1)!,
    sent: () => queries.flatMap((q) => q.received.map((r) => r.text)),
    finals: (id: string) => ends.filter((e) => e.id === id && e.end.kind !== "deferred"),
    push(text: string, initiator: Initiator = user, ahead = false, settles: RunRef | null = null) {
      const input: SessionInput = { kind: ahead ? "continuation" : "envelope", text, initiator, settles };
      session.push(input);
      return state.pending.find((p) => p.text === text)?.id ?? ends.findLast((e) => e.text === text)!.id;
    },
    async advance(ms: number) {
      clock.t += ms;
      session.tick(new Date(clock.t));
      await flush();
    },
  };
}

async function started(text: string, initiator: Initiator = user): Promise<{ h: Harness; id: string }> {
  const h = harness();
  const id = h.push(text, initiator);
  await flush();
  return { h, id };
}

describe("session", () => {
  test("an envelope is on disk, counted as started, before the SDK sees it", async () => {
    const { h, id } = await started("[Alex]\nhello");
    expect(h.q().received).toHaveLength(1);
    const { disk } = h.q().received[0]!;
    expect(disk.pending).toMatchObject([{ id, text: "[Alex]\nhello", settles: null, attempts: 1 }]);
    expect(disk.lifecycle).toMatchObject({ kind: "working", turn: { pending: id, output: false } });
  });

  test("one envelope per turn: the next is sent only after the result, and each ends done", async () => {
    const { h, id: a } = await started("[a]");
    const b = h.push("[b]", routine);
    await flush();
    expect(h.sent()).toEqual(["[a]"]);
    expect(h.session.current?.id).toBe(a as EnvelopeId);
    h.q().emit(said("hi"), resultMsg(0.5));
    await flush();
    expect(h.sent()).toEqual(["[a]", "[b]"]);
    expect(h.session.current?.initiator).toEqual(routine);
    h.q().emit(resultMsg(1.25));
    await flush();
    expect(h.ends.map((e) => [e.id, e.end.kind])).toEqual([
      [a, "done"],
      [b, "done"],
    ]);
    expect(h.state).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
    expect(h.session.working).toBe(false);
  });

  test("every result forwards the cumulative cost and initiator to the ledger; only a fresh query's first result is fresh", async () => {
    const { h } = await started("[a]");
    h.push("[b]", routine);
    h.q().emit(resultMsg(0.5));
    await flush();
    h.q().emit(resultMsg(1.25));
    await flush();
    expect(h.usage).toEqual([
      { actor: { kind: "bot", botId: "b_1" }, sessionId: "s_1", initiator: user, cumulativeUsd: 0.5, fresh: true },
      { actor: { kind: "bot", botId: "b_1" }, sessionId: "s_1", initiator: routine, cumulativeUsd: 1.25, fresh: false },
    ]);
  });

  test("a query started with a resume id is not fresh, whatever the saved id says", async () => {
    const h = harness({ options: () => ({ cwd: "/bots/b_1", resume: "s_0" }) });
    h.push("[a]");
    await flush();
    h.q().emit(resultMsg(9));
    await flush();
    expect(h.usage[0]).toMatchObject({ cumulativeUsd: 9, fresh: false });
  });

  test("a query that resumes a saved session id is not fresh", async () => {
    const h = harness({ state: emptySession("s_1") });
    h.push("[a]");
    await flush();
    h.q().emit(resultMsg(9));
    await flush();
    expect(h.usage[0]).toMatchObject({ cumulativeUsd: 9, fresh: false });
  });

  test("the session id the SDK reports is saved for resume", async () => {
    const { h } = await started("[a]");
    h.q().emit(said("hi"));
    await flush();
    expect(h.state.id).toBe("s_1");
  });

  test("replay rule: a turn the bridge died in before any output is sent again", async () => {
    const before = harness();
    const a = before.push("[a]");
    before.push("[b]");
    await flush();
    before.session.close();
    const h = harness({ state: structuredClone(before.disk) });
    await flush();
    expect(h.sent()).toEqual(["[a]"]);
    expect(h.disk.pending[0]).toMatchObject({ id: a, attempts: 2 });
    expect(h.ends).toEqual([]);
    h.q().emit(resultMsg(1));
    await flush();
    expect(h.sent()).toEqual(["[a]", "[b]"]);
  });

  test("replay rule: a turn with output that the bridge died in fails once and its notice tops the next envelope", async () => {
    const before = harness();
    const a = before.push("[Routine Digest fired]\nsummarize", routine);
    before.push("[Alex]\nstill there?");
    await flush();
    before.q().emit(said("Working on it."));
    await flush();
    before.session.close();
    const h = harness({ state: structuredClone(before.disk) });
    await flush();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "failed", error: RESTARTED_ERROR } }]);
    expect(h.sent()).toEqual([
      "[The bridge restarted during your turn on: [Routine Digest fired] It may be partly done; check before redoing it.]\n[Alex]\nstill there?",
    ]);
  });

  test("a turn the bridge died in while stopping ends as stopped", async () => {
    const before = harness();
    const a = before.push("[a]");
    await flush();
    await before.session.interrupt();
    before.session.close();
    const h = harness({ state: structuredClone(before.disk) });
    await flush();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "stopped", by: "user" } }]);
    expect(h.sent()).toEqual([]);
  });

  test("transient errors with no output back off 1 s, 3 s and 8 s, then fail", async () => {
    const { h, id } = await started("[a]");
    const fail = async () => {
      h.q().emit(apiErrorMessage("overloaded"), apiErrorResult(0));
      await flush();
    };
    for (const wait of [1_000, 3_000, 8_000]) {
      await fail();
      expect(h.ends.at(-1)).toMatchObject({ id, end: { kind: "deferred", why: "retry", until: new Date(h.clock.t + wait).toISOString() } });
      expect(h.session.nextDeadline()).toBe(new Date(h.clock.t + wait).toISOString());
      expect(h.session.working).toBe(true);
      await h.advance(wait - 1);
      const sends = h.sent().length;
      await h.advance(1);
      expect(h.sent()).toHaveLength(sends + 1);
    }
    await fail();
    expect(h.finals(id)).toMatchObject([{ end: { kind: "failed" } }]);
    expect(h.sent()).toEqual(["[a]", "[a]", "[a]", "[a]"]);
    expect(h.messages.some(({ m }) => m.type === "assistant")).toBe(true);
  });

  test("a CLI crash with no output retries on a fresh query, and nothing else queued is lost", async () => {
    const { h, id: a } = await started("[a]");
    const r = h.push("[r]", routine);
    h.q().crash(new Error("spawn failed"));
    await flush();
    expect(h.ends).toMatchObject([{ id: a, end: { kind: "deferred", why: "retry" } }]);
    expect(h.state.pending.map((p) => p.id as string)).toEqual([a, r]);
    await h.advance(1_000);
    expect(h.queries).toHaveLength(2);
    expect(h.q().received.map((x) => x.text)).toEqual(["[a]"]);
    h.q().emit(resultMsg(1));
    await flush();
    h.q().emit(resultMsg(2));
    await flush();
    expect([h.finals(a).length, h.finals(r).length]).toEqual([1, 1]);
  });

  test("a CLI exit after output fails only the turn in flight; the next envelope starts a fresh query", async () => {
    const { h, id: a } = await started("[a]");
    const b = h.push("[b]");
    h.q().emit(said("Deleting the branch now."));
    await flush();
    h.q().exit();
    await flush();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "failed", error: "Claude Code exited" } }]);
    expect(h.queries).toHaveLength(2);
    expect(h.q().received.map((x) => x.text)).toEqual(["[b]"]);
    expect(h.finals(b)).toEqual([]);
  });

  test("a usage limit parks every session until resetsAt + 30 s; the envelope stays at the head and runs after", async () => {
    const clock = { t: NOW.getTime() };
    const account: AccountState = { parkedUntil: null };
    const one = harness({ clock, account });
    const two = harness({ clock, account });
    const a = one.push("[a]", routine);
    await flush();
    const resetsAt = Math.floor(NOW.getTime() / 1000) + 3_600;
    const until = new Date(resetsAt * 1000 + USAGE_PARK_SLACK_MS).toISOString();
    one.q().emit(rejected(resetsAt), apiErrorMessage("rate_limit"), apiErrorResult(0.1));
    await flush();
    expect(account.parkedUntil).toBe(until);
    expect(one.ends).toMatchObject([{ id: a, end: { kind: "deferred", why: "usage_limit", until } }]);
    expect(one.state.pending).toMatchObject([{ id: a, attempts: 0 }]);
    expect([one.session.working, one.session.parkedFor]).toEqual([false, "usage_limit"]);
    expect(one.disk.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });

    const b = two.push("[b]");
    await flush();
    expect(two.queries).toHaveLength(0);
    expect(two.ends).toMatchObject([{ id: b, end: { kind: "deferred", why: "usage_limit", until } }]);
    expect([two.session.parkedFor, two.session.nextDeadline()]).toEqual(["usage_limit", until]);

    clock.t = Date.parse(until) - 1;
    one.session.tick(new Date(clock.t));
    two.session.tick(new Date(clock.t));
    await flush();
    expect([one.sent(), two.sent()]).toEqual([["[a]"], []]);
    clock.t = Date.parse(until);
    one.session.tick(new Date(clock.t));
    two.session.tick(new Date(clock.t));
    await flush();
    expect([one.sent(), two.sent()]).toEqual([["[a]", "[a]"], ["[b]"]]);
    expect(one.state.pending[0]!.attempts).toBe(1);
    expect(account.parkedUntil).toBeNull();
  });

  test("Stop interrupts, and the interrupt's error_during_execution result ends the turn as stopped, never failed or retried", async () => {
    const { h, id } = await started("[a]");
    h.q().emit(said("Running the migration."));
    await flush();
    expect(await h.session.interrupt()).toBe(true);
    expect(h.q().interrupts).toBe(1);
    expect(h.session.lifecycle.kind).toBe("stopping");
    expect(h.session.current?.id).toBe(id as EnvelopeId);
    h.q().emit(interruptedResult(0.3));
    await flush();
    expect(h.ends).toMatchObject([{ id, end: { kind: "stopped", by: "user" } }]);
    expect(h.usage).toMatchObject([{ cumulativeUsd: 0.3 }]);
    expect([h.session.nextDeadline(), h.session.working, h.sent().length]).toEqual([later(15 * 60_000), false, 1]);
    expect(await h.session.interrupt()).toBe(false);
  });

  test("while stopping nothing new is sent; queued unattended mail is dropped and the user's queued message runs after", async () => {
    const { h, id: a } = await started("[a]");
    const r = h.push("[Routine Digest fired]\nsummarize", routine, false, fired);
    const u = h.push("[Alex]\nactually, wait");
    const b = h.push("[Message from bot Scout]\nping", botMail);
    await h.session.interrupt();
    expect([h.finals(r), h.finals(b)]).toMatchObject([[{ end: { kind: "dropped" } }], [{ end: { kind: "dropped" } }]]);
    expect(h.state.pending.map((p) => p.id as string)).toEqual([a, u]);
    h.q().emit(said("Stopping."));
    await flush();
    expect(h.sent()).toEqual(["[a]"]);
    h.q().emit(interruptedResult(0.2));
    await flush();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "stopped" } }]);
    expect(h.finals(u)).toEqual([]);
    expect(h.sent()).toEqual([
      "[a]",
      "[Alex pressed Stop, so 2 queued messages never ran: [Routine Digest fired]; [Message from bot Scout]]\n[Alex]\nactually, wait",
    ]);
    expect(h.queries).toHaveLength(1);
  });

  test("Stop keeps the continuation of a call a bot's message asked for, and drops the bot's message itself", async () => {
    const { h } = await started("[a]");
    const b = h.push("[Message from bot Scout]\nping", botMail);
    const c = h.push("[Alex allowed Bash `make` once]", botMail, true);
    const g = h.push("[Agent Fix tests reports]\ndone", agentMail);
    await h.session.interrupt();
    expect(h.finals(b)).toMatchObject([{ end: { kind: "dropped" } }]);
    expect(h.state.pending.map((p) => p.text)).toEqual(["[a]", "[Alex allowed Bash `make` once]", "[Agent Fix tests reports]\ndone"]);
    expect([h.finals(c), h.finals(g)]).toEqual([[], []]);
  });

  test("a query that serves no turn for 15 minutes is closed, and the next push resumes the session on a new one", async () => {
    const { h } = await started("[a]");
    h.q().emit(said("hi"), resultMsg(0.5));
    await flush();
    expect(h.session.nextDeadline()).toBe(new Date(h.clock.t + 15 * 60_000).toISOString());
    await h.advance(15 * 60_000 - 1);
    expect(h.q().closed).toBe(false);
    await h.advance(1);
    expect([h.q().closed, h.session.nextDeadline()]).toEqual([true, null]);
    h.push("[b]");
    await flush();
    expect(h.queries.map((q) => [q.options.resume, q.received.map((r) => r.text)])).toEqual([
      [undefined, ["[a]"]],
      ["s_1", ["[b]"]],
    ]);
    h.q().emit(resultMsg(0.75));
    await flush();
    expect(h.usage.map((u) => [u.cumulativeUsd, u.fresh])).toEqual([
      [0.5, true],
      [0.75, false],
    ]);
  });

  test("output after the turn ended keeps the query open: the 15 minutes count from its last message", async () => {
    const { h } = await started("[a]");
    h.q().emit(resultMsg(0.5));
    await flush();
    await h.advance(10 * 60_000);
    h.q().emit(said("The background build finished."));
    await flush();
    await h.advance(10 * 60_000);
    expect(h.q().closed).toBe(false);
    await h.advance(5 * 60_000);
    expect(h.q().closed).toBe(true);
  });

  test("a query whose queue waits on the daily cap is closed after 15 minutes too, and the work runs once the cap lifts", async () => {
    let capped = true;
    const h = harness({ headroom: (i) => (!capped || attendedNow(i) ? roomy() : { ok: false, reason: "daily_cap", until: later(12 * 3_600_000) }) });
    h.push("[a]");
    await flush();
    h.q().emit(resultMsg(0.5));
    await flush();
    h.push("[r]", routine, false, fired);
    await flush();
    expect(h.session.parkedFor).toBe("daily_cap");
    await h.advance(15 * 60_000);
    expect(h.q().closed).toBe(true);
    capped = false;
    h.session.recheck();
    await flush();
    expect(h.queries.map((q) => [q.options.resume, q.received.map((r) => r.text)])).toEqual([
      [undefined, ["[a]"]],
      ["s_1", ["[r]"]],
    ]);
  });

  test("an unattended turn runs on a query opened for it and capped at what is left of the daily cap; an attended one never does", async () => {
    const left = [3.25, 2.5];
    const h = harness({ dailyLeft: () => left.shift()! });
    const turn = async (text: string, initiator: Initiator = user, settles: RunRef | null = null) => {
      h.push(text, initiator, false, settles);
      await flush();
      h.q().emit(resultMsg(1));
      await flush();
    };
    await turn("[a]");
    await turn("[r]", routine, fired);
    await turn("[b]", botMail);
    await turn("[u1]");
    await turn("[u2]");
    expect(h.queries.map((q) => [q.options.resume, q.options.maxBudgetUsd, q.closed, q.received.map((r) => r.text)])).toEqual([
      [undefined, undefined, true, ["[a]"]],
      ["s_1", 3.25, true, ["[r]"]],
      ["s_1", 2.5, true, ["[b]"]],
      ["s_1", undefined, false, ["[u1]", "[u2]"]],
    ]);
  });

  test("an unattended agent turn is capped by the smaller of the agent's budget and the daily cap", async () => {
    const left = [3, 9];
    const h = harness({ dailyLeft: () => left.shift()!, options: () => ({ cwd: "/code/shop", maxBudgetUsd: 4.5 }) });
    for (const [text, initiator] of [["[r1]", routine], ["[r2]", routine], ["[u]", user]] as const) {
      h.push(text, initiator);
      await flush();
      h.q().emit(resultMsg(1));
      await flush();
    }
    expect(h.queries.map((q) => q.options.maxBudgetUsd)).toEqual([3, 4.5, 4.5]);
  });

  test("a turn silent for 30 minutes leaves one note naming the bot, and keeps running", async () => {
    const { h } = await started("[a]");
    await h.advance(30 * 60_000 - 1);
    expect([h.notes, h.session.nextDeadline()]).toEqual([[], new Date(h.clock.t + 1).toISOString()]);
    await h.advance(1);
    expect(h.notes).toEqual(["Ana has been silent for 30 minutes; you can press Stop."]);
    await h.advance(60 * 60_000);
    expect([h.notes.length, h.q().interrupts, h.q().closed, h.state.lifecycle.kind]).toEqual([1, 0, false, "working"]);
    h.q().emit(resultMsg(1));
    await flush();
    expect(h.ends.map((e) => e.end.kind)).toEqual(["done"]);
  });

  test("each SDK message restarts the 30 minutes, and every turn can be told once", async () => {
    const { h } = await started("[a]");
    await h.advance(20 * 60_000);
    h.q().emit(said("Still building."));
    await flush();
    await h.advance(20 * 60_000);
    expect(h.notes).toEqual([]);
    await h.advance(10 * 60_000);
    h.q().emit(resultMsg(1));
    await flush();
    h.push("[b]");
    await flush();
    await h.advance(30 * 60_000);
    expect(h.notes).toEqual(["Ana has been silent for 30 minutes; you can press Stop.", "Ana has been silent for 30 minutes; you can press Stop."]);
  });

  test("Stop with no answer kills the query at 15 s, and the next envelope starts a fresh one", async () => {
    const { h, id: a } = await started("[a]");
    const u = h.push("[u]");
    await h.session.interrupt();
    await h.advance(STOP_DEADLINE_MS - 1);
    expect([h.q().closed, h.finals(a).length]).toEqual([false, 0]);
    await h.advance(1);
    expect(h.queries[0]!.closed).toBe(true);
    expect(h.finals(a)).toMatchObject([{ end: { kind: "stopped" } }]);
    expect(h.queries).toHaveLength(2);
    expect(h.q().received.map((x) => x.text)).toEqual(["[u]"]);
    h.queries[0]!.emit(resultMsg(5));
    await flush();
    expect([h.usage.length, h.finals(u).length]).toEqual([0, 0]);
  });

  test("Stop when nothing runs resolves false and changes nothing", async () => {
    const h = harness();
    expect(await h.session.interrupt()).toBe(false);
    expect(h.state).toEqual(emptySession());
  });

  test("three held or denied calls in one turn stop it with a note; the next turn starts with a clean count", async () => {
    const { h, id } = await started("[a]");
    h.session.denied();
    h.session.denied();
    expect(h.session.lifecycle.kind).toBe("working");
    h.session.denied();
    expect(h.session.lifecycle.kind).toBe("stopping");
    expect([h.q().interrupts, h.notes]).toEqual([1, [BREAKER_NOTE]]);
    h.push("[b]");
    h.q().emit(interruptedResult(0.4));
    await flush();
    expect(h.finals(id)).toMatchObject([{ end: { kind: "stopped", by: "breaker" } }]);
    h.session.denied();
    h.session.denied();
    expect(h.session.lifecycle.kind).toBe("working");
  });

  test("the daily cap holds unattended envelopes; the user's turns still run, show working, and note the cap once", async () => {
    const until = new Date(NOW.getTime() + 12 * 3_600_000).toISOString();
    let capped = true;
    const h = harness({
      headroom: (i) => (!capped ? roomy() : attendedNow(i) ? { ok: true, capReached: true } : { ok: false, reason: "daily_cap", until }),
    });
    const r = h.push("[r]", routine);
    await flush();
    expect(h.sent()).toEqual([]);
    expect([h.session.working, h.session.parkedFor]).toEqual([false, "daily_cap"]);
    expect(h.ends).toMatchObject([{ id: r, end: { kind: "deferred", why: "daily_cap", until } }]);
    const changesWhenParked = h.changes;

    h.push("[u1]");
    await flush();
    expect(h.sent()).toEqual(["[u1]"]);
    expect([h.session.working, h.session.parkedFor]).toEqual([true, null]);
    expect(h.changes).toBeGreaterThan(changesWhenParked);
    expect(h.notes).toEqual([CAP_NOTE]);
    h.q().emit(resultMsg(1));
    await flush();
    expect(h.session.parkedFor).toBe("daily_cap");
    h.push("[u2]");
    await flush();
    h.q().emit(resultMsg(2));
    await flush();
    expect(h.notes).toEqual([CAP_NOTE]);
    expect(h.ends.filter((e) => e.id === r)).toHaveLength(1);

    capped = false;
    clockTo(h, until);
    await flush();
    expect(h.sent()).toEqual(["[u1]", "[u2]", "[r]"]);
  });

  test("notices top the next envelope", async () => {
    const h = harness();
    h.session.notice("[Your request to run Bash `rm -rf build` expired unanswered.]");
    h.push("[Alex]\nhi");
    await flush();
    expect(h.sent()).toEqual(["[Your request to run Bash `rm -rf build` expired unanswered.]\n[Alex]\nhi"]);
  });

  test("options() throwing holds the queue for a retry without failing or using up anything queued", async () => {
    let broken = true;
    const h = harness({
      options: () => {
        if (broken) throw new Error("gate not ready");
        return { cwd: "/bots/b_1" };
      },
    });
    const a = h.push("[a]");
    const b = h.push("[b]", routine);
    await flush();
    expect([h.finals(a), h.finals(b), h.queries.length]).toEqual([[], [], 0]);
    expect(h.state.pending).toMatchObject([{ id: a, attempts: 0 }, { id: b, attempts: 0 }]);
    expect(h.disk.pending).toMatchObject([{ id: a, attempts: 0 }, { id: b, attempts: 0 }]);
    expect(h.session.nextDeadline()).toBe(later(30_000));
    await h.advance(30_000);
    await h.advance(60_000);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("gate not ready");
    await h.advance(120_000);
    await h.advance(300_000);
    expect(h.notes).toHaveLength(1);
    broken = false;
    await h.advance(300_000);
    expect(h.sent()).toEqual(["[a]"]);
    h.q().emit(resultMsg(1));
    await flush();
    h.q().emit(resultMsg(2));
    await flush();
    expect([h.finals(a), h.finals(b)]).toMatchObject([[{ end: { kind: "done" }, pending: { attempts: 1 } }], [{ end: { kind: "done" }, pending: { attempts: 1 } }]]);
  });

  test("a session that cannot start Claude Code is unavailable while it waits to retry, and stops being so once a query opens", async () => {
    const o: { executable: string | null | undefined } = { executable: null };
    const h = harness(o);
    h.push("[a]");
    await flush();
    expect(h.session.unavailable).toBe(true);
    expect(h.notes).toEqual([
      "Claude Code could not start: claude was not found on PATH, or CLAUDIOBOT_CLAUDE does not name an executable. Queued messages are kept, and it keeps trying.",
    ]);
    o.executable = undefined;
    await h.advance(START_RETRY_MS[0]);
    expect([h.sent(), h.session.unavailable, h.notes.length]).toEqual([["[a]"], false, 1]);
  });

  test("a missing claude executable is a start failure, not a failed turn", async () => {
    const h = harness({ executable: null });
    const a = h.push("[a]");
    await flush();
    expect(h.finals(a)).toEqual([]);
    expect(h.state.pending).toMatchObject([{ id: a, attempts: 0 }]);
    expect(h.state.lifecycle).toEqual({ kind: "backoff", until: later(30_000), attempt: 0 });
  });

  test("a CLAUDIOBOT_CLAUDE that names no executable is a start failure before any query is made", async () => {
    process.env.CLAUDIOBOT_CLAUDE = "/nonexistent/claude";
    const h = harness({ defaultExecutable: true });
    const a = h.push("[a]");
    await flush();
    expect([h.queries.length, h.finals(a)]).toEqual([0, []]);
    expect(h.state.lifecycle).toMatchObject({ kind: "backoff" });
  });

  test("Stop while the queue waits for the usage limit drops unattended work and resolves true", async () => {
    const until = later(60_000);
    const h = harness({ account: { parkedUntil: until } });
    const u = h.push("[u]");
    const r = h.push("[r]", routine, false, fired);
    await flush();
    expect(h.session.parkedFor).toBe("usage_limit");
    expect(await h.session.interrupt()).toBe(true);
    expect([h.finals(u), h.finals(r)]).toMatchObject([[], [{ end: { kind: "dropped" } }]]);
    expect(h.state.pending.map((p) => p.id as string)).toEqual([u]);
  });

  test("headroom that throws lets the user's turns run and holds unattended ones briefly, telling the hold once", async () => {
    let broken = true;
    const h = harness({
      headroom: () => {
        if (broken) throw new Error("index corrupt");
        return roomy();
      },
    });
    const r = h.push("[r]", routine);
    await flush();
    expect([h.sent(), h.session.parkedFor, h.session.nextDeadline()]).toEqual([[], "daily_cap", later(HEADROOM_RETRY_MS)]);
    h.push("[u]");
    await flush();
    expect(h.sent()).toEqual(["[u]"]);
    h.q().emit(resultMsg(1));
    await flush();
    await h.advance(HEADROOM_RETRY_MS);
    expect(h.sent()).toEqual(["[u]"]);
    expect(h.ends.filter((e) => e.id === r)).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("index corrupt"))).toBe(true);
    broken = false;
    await h.advance(1_000);
    expect(h.sent()).toEqual(["[u]", "[r]"]);
  });

  test("recheck() starts work the daily cap held as soon as the cap is raised", async () => {
    let cap = 1;
    const until = later(12 * 3_600_000);
    const h = harness({ headroom: (i) => (attendedNow(i) || cap > 1 ? roomy() : { ok: false, reason: "daily_cap", until }) });
    h.push("[r]", routine);
    await flush();
    expect(h.session.parkedFor).toBe("daily_cap");
    const changes = h.changes;
    cap = 5;
    h.session.recheck();
    await flush();
    expect(h.sent()).toEqual(["[r]"]);
    expect([h.session.parkedFor, h.session.working]).toEqual([null, true]);
    expect(h.changes).toBeGreaterThan(changes);
  });

  test("a usage limit on one model parks only that session; the account and other sessions keep running", async () => {
    const clock = { t: NOW.getTime() };
    const account: AccountState = { parkedUntil: null };
    const one = harness({ clock, account });
    const two = harness({ clock, account });
    const a = one.push("[a]", routine);
    await flush();
    const resetsAt = Math.floor(NOW.getTime() / 1000) + 3_600;
    one.q().emit(rejected(resetsAt, { rateLimitType: "seven_day_opus" }), apiErrorMessage("rate_limit"), apiErrorResult(0.1));
    await flush();
    expect(account.parkedUntil).toBeNull();
    expect(one.session.parkedFor).toBe("usage_limit");
    expect(one.state.pending).toMatchObject([{ id: a, attempts: 0 }]);
    two.push("[b]");
    await flush();
    expect(two.sent()).toEqual(["[b]"]);
  });

  test("a rejection while extra usage covers the turn is not a usage limit", async () => {
    const { h } = await started("[a]");
    h.q().emit(rejected(Math.floor(NOW.getTime() / 1000) + 3_600, { isUsingOverage: true }), apiErrorMessage("overloaded"), apiErrorResult(0));
    await flush();
    expect(h.account.parkedUntil).toBeNull();
    expect(h.state.lifecycle).toMatchObject({ kind: "backoff" });
  });

  test("a rejection whose resetsAt is not a number still parks for the fallback, and the turn still ends", async () => {
    const { h, id } = await started("[a]");
    h.q().emit(rejected("soon"), apiErrorMessage("rate_limit"), apiErrorResult(0));
    await flush();
    const until = later(USAGE_PARK_FALLBACK_MS + USAGE_PARK_SLACK_MS);
    expect(h.account.parkedUntil).toBe(until);
    expect(h.ends).toMatchObject([{ id, end: { kind: "deferred", why: "usage_limit", until } }]);
  });

  test("a secret in Claude Code's stderr is redacted before the error reaches the chat", async () => {
    const { h, id } = await started("[a]");
    const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    h.q().options.stderr?.(`auth failed for key ${secret}\nAuthorization: Bearer abcdefghijklmnop1234\n`);
    h.q().emit(said("Working."));
    await flush();
    h.q().exit();
    await flush();
    const [end] = h.finals(id);
    const error = end?.end.kind === "failed" ? end.end.error : "";
    expect(error).toContain("auth failed for key");
    expect(error).not.toContain(secret);
    expect(error).not.toContain("abcdefghijklmnop1234");
  });

  test("a session closed before its recovery runs still delivers the recovered turn ends", async () => {
    const before = harness();
    const a = before.push("[Routine Digest fired]", routine);
    await flush();
    before.q().emit(said("Working on it."));
    await flush();
    before.session.close();
    const h = harness({ state: structuredClone(before.disk) });
    h.session.close();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "failed", error: RESTARTED_ERROR } }]);
    await flush();
    expect(h.finals(a)).toHaveLength(1);
  });

  test("recovery reports the status it changed through onChange", async () => {
    const before = harness();
    before.push("[a]");
    await flush();
    await before.session.interrupt();
    before.session.close();
    const h = harness({ state: structuredClone(before.disk) });
    await flush();
    expect([h.session.working, h.changes]).toEqual([false, 1]);
  });

  test("a throwing ledger or persist is logged, not taken for a Claude crash", async () => {
    const h = harness({
      add: () => {
        throw new Error("usage file is read-only");
      },
      persist: () => {
        throw new Error("disk full");
      },
    });
    const a = h.push("[a]");
    await flush();
    h.q().emit(said("hi"), resultMsg(1));
    await flush();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "done" } }]);
    h.push("[b]");
    await flush();
    expect([h.queries.length, h.sent()]).toEqual([1, ["[a]", "[b]"]]);
    expect(h.logs.some((l) => l.includes("usage file is read-only"))).toBe(true);
    expect(h.logs.some((l) => l.includes("disk full"))).toBe(true);
  });

  test("output that arrives with no turn in flight still reaches onMessage", async () => {
    const { h } = await started("[a]");
    h.q().emit(resultMsg(1));
    await flush();
    const late = said("A background task finished.");
    h.q().emit(late);
    await flush();
    expect(h.messages.at(-1)).toEqual({ m: late, turn: null });
  });

  test("the run a routine's fire settles is carried through a retry and a replay untouched", async () => {
    const settles: RunRef = { routineId: "r_1" as RoutineId, runId: "run_1" as RunId };
    const h = harness();
    h.push("[r]", routine, false, settles);
    await flush();
    h.q().emit(apiErrorMessage("overloaded"), apiErrorResult(0));
    await flush();
    expect(h.state.pending[0]).toMatchObject({ settles, attempts: 1 });
    await h.advance(1_000);
    h.session.close();
    const after = harness({ state: structuredClone(h.disk) });
    await flush();
    after.q().emit(resultMsg(1));
    await flush();
    expect(after.ends[0]!.pending).toMatchObject({ settles, attempts: 3 });
  });
});

describe("claudeExecutable", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudio-exe-"));
  const runnable = join(dir, "claude");
  const plain = join(dir, "notes.txt");
  writeFileSync(runnable, "#!/bin/sh\n");
  chmodSync(runnable, 0o755);
  writeFileSync(plain, "");

  test.each([
    ["an executable file", runnable, runnable],
    ["a missing file", join(dir, "missing"), null],
    ["a file that is not executable", plain, null],
    ["a directory", dir, null],
  ])("CLAUDIOBOT_CLAUDE naming %s", (_, value, expected) => {
    process.env.CLAUDIOBOT_CLAUDE = value;
    expect(claudeExecutable()).toBe(expected);
  });
});

function clockTo(h: Harness, iso: string) {
  h.clock.t = Date.parse(iso);
  h.session.tick(new Date(h.clock.t));
}

// ─── The invariant, under random interleavings ──────────────────────────────────────────────────────────────────────

function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

test.each([1, 2, 3, 4, 5, 6, 7, 8])("exactly one TurnEnd per envelope that leaves the queue, and none for one still queued (seed %i)", async (seed) => {
  const random = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  let openFails = false;
  const h = harness({
    headroom: (i) => {
      const roll = random();
      if (roll < 0.03) throw new Error("ledger down");
      return attendedNow(i) || roll < 0.9 ? roomy() : { ok: false, reason: "daily_cap", until: new Date(h.clock.t + 60_000).toISOString() };
    },
    options: () => {
      if (openFails) throw new Error("gate not ready");
      return { cwd: "/bots/b_1" };
    },
  });
  const pushed = new Set<string>();
  let n = 0;
  const live = () => h.queries.findLast((q) => !q.closed);
  const ops: (() => void | Promise<unknown>)[] = [
    () => void pushed.add(h.push(`[e${++n}]`, pick([user, routine, botMail, manualRun]), random() < 0.2)),
    () => live()?.emit(said("text")),
    () => live()?.emit(resultMsg(random())),
    () => live()?.emit(apiErrorMessage("overloaded"), apiErrorResult(random())),
    () => live()?.emit(rejected(Math.floor(h.clock.t / 1000) + 30), apiErrorResult(random())),
    () => live()?.emit(interruptedResult(random())),
    () => live()?.exit(),
    () => live()?.crash(new Error("boom")),
    () => h.session.interrupt(),
    () => h.session.denied(),
    () => h.session.notice("[n]"),
    () => h.session.recheck(),
    () => void (openFails = random() < 0.3),
    () => live()?.emit(rejected(Math.floor(h.clock.t / 1000) + 600, { rateLimitType: "seven_day_opus" }), apiErrorResult(random())),
    () => h.advance(pick([500, 1_000, 3_000, 8_000, 15_000, 30_000, 120_000, 300_000])),
  ];
  for (let i = 0; i < 300; i++) {
    await pick(ops)();
    await flush();
    const queued = new Set(h.state.pending.map((p) => p.id as string));
    for (const id of pushed) expect([id, h.finals(id).length]).toEqual([id, queued.has(id) ? 0 : 1]);
    const t = h.state.lifecycle.kind === "working" || h.state.lifecycle.kind === "stopping" ? h.state.lifecycle.turn : null;
    if (t) expect(h.state.pending[0]?.id).toBe(t.pending);
  }
});
