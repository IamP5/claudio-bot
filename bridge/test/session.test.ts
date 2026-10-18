import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { Headroom, Ledger } from "../src/ledger";
import type { AgentId, BotId, RoutineId, RunId } from "../src/protocol";
import {
  BACKGROUND_WAIT_MS,
  BREAKER_NOTE,
  CAP_NOTE,
  HEADROOM_RETRY_MS,
  RESTARTED_ERROR,
  START_RETRY_MS,
  STOP_DEADLINE_MS,
  USAGE_PARK_FALLBACK_MS,
  USAGE_PARK_MAX_MS,
  USAGE_PARK_SLACK_MS,
  WAKE_WAIT_MS,
  classify,
  claudeExecutable,
  createSession,
  freshMemo,
  noSignals,
  spawnGroup,
  step,
  type Core,
  type Effect,
  type Event,
  type Outcome,
  type SessionSpec,
  type TurnEnd,
  GONE_ERROR,
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

  test("a command carries the notices like an envelope, so the envelope after it does not repeat them", () => {
    const c = core({ kind: "idle" }, []);
    c.session.notices = [{ at: NOW.toISOString(), text: "[Your question expired.]" }];
    const command: Pending = { ...env("c"), kind: "command", text: "/greet Ana" };
    const started = run(c, { kind: "push", pending: command });
    expect(started.effects).toEqual([{ kind: "send", pending: { ...command, attempts: 1 }, text: "[Your question expired.]\n/greet Ana" }]);
    const answered = run(run(started.core, { kind: "output" }).core, { kind: "end", outcome: { kind: "result", result: {} as never } });
    const next = run(answered.core, { kind: "push", pending: env("a") });
    expect(next.effects).toContainEqual({ kind: "send", pending: env("a", user, 1), text: "[a]" });
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

  test("a daily cap whose end the ledger reports as already past still parks the head, and attended work behind it runs", () => {
    const until = later(-60_000);
    const headroom = (i: Initiator): Headroom => (attendedNow(i) ? roomy() : { ok: false, reason: "daily_cap", until });
    const t = run(core({ kind: "idle" }, [env("r", routine)]), { kind: "push", pending: env("u") }, headroom);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("u") });
    expect(endsOf(t.effects)).toEqual([["r", "deferred"]]);
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

type Content = SDKUserMessage["message"]["content"];
const textOf = (c: Content) => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n\n"));

/** Claude Code's process as the session's spawner sees it. It exits when its query closes, unless it lingers. */
class FakeProcess {
  alive = true;
  lingers = false;
  constructor(private readonly exited: () => void) {}
  exit() {
    if (!this.alive) return;
    this.alive = false;
    this.exited();
  }
}

class FakeQuery {
  readonly received: { text: string; content: Content; uuid: string | undefined; disk: SessionState }[] = [];
  readonly stoppedTasks: string[] = [];
  readonly process: FakeProcess;
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
    const spawned = options.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal: new AbortController().signal });
    this.process = spawned as unknown as FakeProcess;
    void (async () => {
      for await (const m of prompt) this.received.push({ text: textOf(m.message.content), content: m.message.content, uuid: m.uuid, disk: disk() });
    })();
  }

  emit(...ms: SDKMessage[]) {
    this.queue.push(...ms);
    this.wake?.();
  }
  exit() {
    this.ended = true;
    this.process.exit();
    this.wake?.();
  }
  crash(error: Error) {
    this.failure = error;
    this.process.exit();
    this.wake?.();
  }
  async interrupt() {
    this.interrupts++;
  }
  async stopTask(id: string) {
    this.stoppedTasks.push(id);
  }
  close() {
    this.closed = true;
    if (!this.process.lingers) this.process.exit();
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
const SANDBOX_DOWN = "Sandbox is required but failed to initialize: sandbox-exec: execvp() failed. Restart to retry.";
const toolFailed = (content: string) =>
  ({ type: "user", uuid: `u${++uuid}`, session_id: "s_1", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${uuid}`, is_error: true, content }] } }) as unknown as SDKMessage;
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
    dailyLeft?: () => number | null;
    context?: () => string;
    brief?: () => string;
    spec?: Partial<SessionSpec>;
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
  let dormant = 0;
  const session = createSession({
    actor: { kind: "bot", botId: "b_1" as BotId },
    state,
    account,
    options: opts.options ?? (() => ({ cwd: "/bots/b_1", resume: state.id ?? undefined })),
    context: opts.context,
    brief: opts.brief,
    ledger: {
      add: opts.add ?? ((row) => void usage.push(row as Record<string, unknown>)),
      headroom: (_, i) => (opts.headroom ?? roomy)(i),
      budgetLeft: () => 5,
      dailyLeft: opts.dailyLeft ?? (() => 10),
    },
    onMessage: (m, t) => messages.push({ m, turn: t }),
    onTurnEnd: (p, end) => ends.push({ id: p.id, text: p.text, pending: p, end }),
    onChange: () => changes++,
    onDormant: () => dormant++,
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
    spawn: (_o, _stderr, exited) => new FakeProcess(exited) as unknown as SpawnedProcess,
    ...(!opts.defaultExecutable && { executable: () => (opts.executable === undefined ? "/fake/claude" : opts.executable) }),
    now: () => new Date(clock.t),
    ...opts.spec,
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
    get dormant() {
      return dormant;
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

describe("a phone's own session", () => {
  test("the bridge's notices never ride on its turns, which are the user's own words", async () => {
    const h = harness({ spec: { actor: { kind: "own", sessionId: "s_1" as never }, notices: false } });
    h.session.notice("[A bridge notice]");
    h.push("hello");
    await flush();
    expect(h.sent()).toEqual(["hello"]);
  });

  test("a taken id reported as a failed result is resumed too", async () => {
    const h = harness({ options: () => ({ cwd: "/x", sessionId: "s_new" }) });
    h.push("hello");
    await flush();
    h.q().emit(resultMsg(0, { subtype: "error_during_execution", is_error: true, errors: ["Error: Session ID s_new is already in use."] }));
    await flush();
    await flush();
    expect(h.queries.map((q) => [q.options.sessionId, q.options.resume])).toEqual([["s_new", undefined], [undefined, "s_new"]]);
  });

  test("a turn waits while another Claude Code is busy on the session, then runs once it is not", async () => {
    let busy: string | null = "Working in the Claude app.";
    const h = harness({ spec: { actor: { kind: "own", sessionId: "s_1" as never }, blocked: () => busy } });
    const a = h.push("hello");
    await flush();
    expect([h.queries.length, h.session.lifecycle.kind, h.state.pending.length]).toEqual([0, "backoff", 1]);
    expect(h.ends).toMatchObject([{ id: a, end: { kind: "deferred", why: "retry" } }]);
    busy = null;
    await h.advance(START_RETRY_MS[0]);
    expect(h.sent()).toEqual(["hello"]);
  });

  test("its query closes after its own idle time, and its turns are metered with no bot", async () => {
    const h = harness({ spec: { actor: { kind: "own", sessionId: "s_1" as never }, idleMs: 10 * 60_000 } });
    h.push("hello");
    await flush();
    h.q().emit(resultMsg(0.2));
    await flush();
    expect(h.usage).toMatchObject([{ actor: { kind: "own", sessionId: "s_1" }, cumulativeUsd: 0.2 }]);
    await h.advance(10 * 60_000 - 1000);
    expect(h.q().closed).toBe(false);
    await h.advance(2000);
    expect(h.q().closed).toBe(true);
  });
});

describe("session", () => {
  test("the context rides on a turn's message when it changed since this session last sent it, even on an open query", async () => {
    let context = "";
    const h = harness({ context: () => context });
    h.push("[Alex]\none");
    await flush();
    h.q().emit(resultMsg(0.1));
    await flush();
    context = "Facts: likes tea";
    h.push("[Alex]\ntwo");
    await flush();
    h.q().emit(resultMsg(0.2));
    await flush();
    h.push("[Alex]\nthree");
    await flush();
    h.q().emit(resultMsg(0.3));
    await flush();
    context = "";
    h.push("[Alex]\nfour");
    await flush();
    expect(h.queries).toHaveLength(1);
    expect(h.sent()).toEqual([
      "[Alex]\none",
      "Facts: likes tea\n\n[Alex]\ntwo",
      "[Alex]\nthree",
      "[No facts about the user are on file now. The list sent earlier no longer applies.]\n\n[Alex]\nfour",
    ]);
  });

  test("the context and brief count as sent only once a turn carrying them produced output, so a retry carries them again", async () => {
    let context = "";
    let brief = "[Standing brief] v1";
    const h = harness({ state: { ...emptySession(), id: "s_1" }, context: () => context, brief: () => brief });
    h.push("[Alex]\none");
    await flush();
    h.q().emit(said("hi"), resultMsg(0.1));
    await flush();
    context = "Facts: likes tea";
    brief = "[Standing brief] v2";
    h.push("[Alex]\ntwo");
    await flush();
    h.q().emit(apiErrorMessage("overloaded"), apiErrorResult(0));
    await flush();
    await h.advance(1_000);
    expect(h.sent().at(-1)).toBe("[Standing brief] v2\n\nFacts: likes tea\n\n[Alex]\ntwo");
    h.q().emit(said("ok"), resultMsg(0.2));
    await flush();
    h.push("[Alex]\nthree");
    await flush();
    expect(h.sent().at(-1)).toBe("[Alex]\nthree");
  });

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

  test("with no daily cap an unattended turn's query carries no maxBudgetUsd, and an agent's keeps its own budget", async () => {
    const bot = harness({ dailyLeft: () => null });
    const agent = harness({ dailyLeft: () => null, options: () => ({ cwd: "/code/shop", maxBudgetUsd: 4.5 }) });
    for (const h of [bot, agent]) {
      h.push("[r]", routine);
      await flush();
      h.q().emit(resultMsg(1));
      await flush();
    }
    expect([Object.hasOwn(bot.q().options, "maxBudgetUsd"), agent.q().options.maxBudgetUsd]).toEqual([false, 4.5]);
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

  test("a sandbox that cannot start is told once, is no denial, and the next turn gets a new query", async () => {
    const { h, id } = await started("[a]");
    const first = h.q();
    first.emit(toolFailed(SANDBOX_DOWN), toolFailed(SANDBOX_DOWN), toolFailed(SANDBOX_DOWN), toolFailed(SANDBOX_DOWN));
    await flush();
    expect([h.notes, h.state.lifecycle.kind]).toEqual([["Ana cannot run commands: the sandbox could not start (sandbox-exec: execvp() failed)."], "working"]);
    first.emit(resultMsg(0.1, { result: "Commands are failing." }));
    await flush();
    expect([h.finals(id).map((e) => e.end.kind), first.closed]).toEqual([["done"], true]);
    h.push("[b]");
    await flush();
    expect([h.queries.length, h.q().received.map((r) => r.text)]).toEqual([2, ["[b]"]]);
  });

  test("a command whose own output names the sandbox error is not a sandbox failure", async () => {
    const { h } = await started("[a]");
    h.q().emit({ ...(toolFailed(SANDBOX_DOWN) as object), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: false, content: SANDBOX_DOWN }] } } as unknown as SDKMessage);
    await flush();
    expect(h.notes).toEqual([]);
  });

  test("a query that ends because its sandbox could not start is a start failure: the envelope waits the long backoff", async () => {
    const { h, id } = await started("[a]");
    h.q().emit(resultMsg(0, { subtype: "error_during_execution", is_error: true, errors: ["sandbox is enabled but dependencies are missing: ripgrep (rg) not found"] }));
    await flush();
    expect(h.state.pending.map((p) => [p.id as string, p.attempts])).toEqual([[id, 0]]);
    expect(h.state.lifecycle).toEqual({ kind: "backoff", until: new Date(h.clock.t + START_RETRY_MS[0]).toISOString(), attempt: 0 });
    expect([h.notes, h.session.unavailable, h.q().closed]).toEqual([
      ["Claude Code could not start: the sandbox could not start (ripgrep (rg) not found). Queued messages are kept, and it keeps trying."],
      true,
      true,
    ]);
    await h.advance(START_RETRY_MS[0]);
    expect(h.queries.map((q) => q.options.sandbox ?? null)).toEqual([null, null]);
    expect(h.q().received.map((r) => r.text)).toEqual(["[a]"]);
  });

  test("reopen closes an idle query now, and a busy one when its turn ends", async () => {
    const { h, id } = await started("[a]");
    const busy = h.q();
    h.session.reopen();
    expect(busy.closed).toBe(false);
    busy.emit(resultMsg(0.1));
    await flush();
    expect([h.finals(id).map((e) => e.end.kind), busy.closed]).toEqual([["done"], true]);
    h.push("[b]");
    await flush();
    const idle = h.q();
    idle.emit(resultMsg(0.2));
    await flush();
    h.session.reopen();
    expect([h.queries.length, idle.closed]).toEqual([2, true]);
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

describe("what rides on a turn's message survives a restart", () => {
  async function turn(h: Harness, text: string) {
    h.push(text);
    await flush();
    h.q().emit(resultMsg(0.1));
    await flush();
  }
  const restarted = (h: Harness, over: Parameters<typeof harness>[0] = {}) => {
    h.session.close();
    return harness({ state: structuredClone(h.state), ...over });
  };
  const CLEARED = "[No facts about the user are on file now. The list sent earlier no longer applies.]";

  test("forgetting the last fact while the bridge was down still sends the cleared notice", async () => {
    const before = harness({ state: emptySession("s_1"), context: () => "Facts: likes tea" });
    await turn(before, "[one]");
    const h = restarted(before, { context: () => "" });
    await turn(h, "[two]");
    expect([before.sent(), h.sent()]).toEqual([["Facts: likes tea\n\n[one]"], [`${CLEARED}\n\n[two]`]]);
  });

  test("facts already sent are not sent again after a restart", async () => {
    const before = harness({ state: emptySession("s_1"), context: () => "Facts: likes tea" });
    await turn(before, "[one]");
    const h = restarted(before, { context: () => "Facts: likes tea" });
    await turn(h, "[two]");
    expect(h.sent()).toEqual(["[two]"]);
  });

  test("a query that starts a new session gets the facts whatever was sent to the old one", async () => {
    const before = harness({ state: emptySession("s_1"), context: () => "Facts: likes tea" });
    await turn(before, "[one]");
    const h = restarted(before, { state: { ...structuredClone(before.state), id: null }, context: () => "Facts: likes tea" });
    await turn(h, "[two]");
    expect(h.sent()).toEqual(["Facts: likes tea\n\n[two]"]);
  });

  test("the standing brief is not sent on a new session's first turn, then rides on the first turn after it changes", async () => {
    let brief = "[Brief: you are Ana]";
    const h = harness({ brief: () => brief, context: () => "Facts: likes tea" });
    await turn(h, "[one]");
    await turn(h, "[two]");
    brief = "[Brief: you are Bea]";
    await turn(h, "[three]");
    await turn(h, "[four]");
    expect(h.sent()).toEqual(["Facts: likes tea\n\n[one]", "[two]", "[Brief: you are Bea]\n\n[three]", "[four]"]);
  });

  test("a resumed session that never got the brief gets it once, and a restart does not repeat it", async () => {
    const before = harness({ state: emptySession("s_1"), brief: () => "[Brief: you are Ana]" });
    await turn(before, "[one]");
    await turn(before, "[two]");
    const h = restarted(before, { brief: () => "[Brief: you are Ana]" });
    await turn(h, "[three]");
    expect([...before.sent(), ...h.sent()]).toEqual(["[Brief: you are Ana]\n\n[one]", "[two]", "[three]"]);
  });
});

describe("a conversation Claude Code no longer has", () => {
  // What claude 2.1.301 sends for --resume of a purged transcript (probe, 2026-10-17): this result, then the query throws.
  const gone = (id: string) => {
    const text = `No conversation found with session ID: ${id}`;
    return resultMsg(0, { subtype: "error_during_execution", is_error: true, result: text, errors: [text], session_id: id });
  };

  test("a session that must not be replaced fails its turn instead, and starts nothing new", async () => {
    const h = harness({ state: emptySession("s_old"), spec: { forgotten: "fail" } });
    const a = h.push("hello");
    await flush();
    h.q().emit(gone("s_old"));
    await flush();
    expect(h.queries).toHaveLength(1);
    expect(h.finals(a)).toMatchObject([{ end: { kind: "failed", error: GONE_ERROR } }]);
    expect([h.state.id, h.notes]).toEqual(["s_old", []]);
  });

  test("the session id is cleared, the user is told, and the same envelope runs on a fresh session without spending an attempt", async () => {
    const h = harness({ state: emptySession("s_old") });
    const a = h.push("[Alex]\nhello");
    await flush();
    expect(h.q().options.resume).toBe("s_old");
    h.q().emit(gone("s_old"));
    await flush();
    expect(h.queries).toHaveLength(2);
    expect([h.queries[0]!.closed, h.q().options.resume]).toEqual([true, undefined]);
    expect(h.state.id).toBeNull();
    expect(h.state.pending).toMatchObject([{ id: a, attempts: 1 }]);
    expect(h.ends).toEqual([]);
    expect(h.notes).toEqual(["Ana's earlier conversation was cleared by Claude Code, so it starts a new one. Its notes and memory are kept."]);
    expect(h.sent()).toEqual([
      "[Alex]\nhello",
      "[Your earlier conversation history is gone: Claude Code deleted it. Your notes and the facts about the user are kept; ask if you need something from before.]\n[Alex]\nhello",
    ]);
    h.q().emit(said("hi"), resultMsg(0.1, { session_id: "s_new" }));
    await flush();
    expect(h.finals(a)).toMatchObject([{ end: { kind: "done" } }]);
    expect(h.state.id).toBe("s_new");
  });

  test("a fresh query that fails the same way is not retried as lost: it ends like any error result", async () => {
    const { h, id } = await started("[a]");
    h.q().emit(gone("s_1"));
    await flush();
    expect(h.queries).toHaveLength(1);
    expect(h.finals(id)).toMatchObject([{ end: { kind: "done" } }]);
  });

  test("only the first turn on the resumed query, naming the resumed id, counts as a lost conversation", async () => {
    const h = harness({ state: emptySession("s_old") });
    const a = h.push("[a]");
    await flush();
    h.q().emit(gone("s_other"));
    await flush();
    expect([h.queries.length, h.state.id]).toEqual([1, "s_other"]);
    expect(h.finals(a)).toMatchObject([{ end: { kind: "done" } }]);
    const b = h.push("[b]");
    await flush();
    h.q().emit(gone("s_old"));
    await flush();
    expect(h.queries).toHaveLength(1);
    expect(h.finals(b)).toMatchObject([{ end: { kind: "done" } }]);
    expect(h.notes).toEqual([]);
  });

  test("the context is sent again on the fresh session", async () => {
    const h = harness({ state: emptySession("s_old"), context: () => "Facts: likes tea" });
    h.push("[a]");
    await flush();
    h.q().emit(gone("s_old"));
    await flush();
    expect(h.sent()[1]).toStartWith("Facts: likes tea\n\n");
  });
});

const tasks = (...ts: { task_id: string; description: string; ambient?: boolean }[]) =>
  ({ type: "system", subtype: "background_tasks_changed", tasks: ts.map((t) => ({ task_type: "local_bash", ...t })), uuid: "bg", session_id: "s_1" }) as unknown as SDKMessage;
const build = { task_id: "t1", description: "npm run build" };
const lint = { task_id: "t2", description: "npm run lint" };
/** A frame as Claude Code stamps it with the uuids of the user messages its turn consumed. */
const echoing = (m: SDKMessage, ...uuids: string[]) => ({ ...m, user_message_uuid: uuids.at(-1), user_message_uuids: uuids }) as SDKMessage;
const lastUuid = (h: Harness) => h.q().received.at(-1)!.uuid!;
const allowed = (status: "allowed" | "allowed_warning", info: object = {}) =>
  ({ type: "rate_limit_event", uuid: "rl", session_id: "s_1", rate_limit_info: { status, ...info } }) as unknown as SDKMessage;

describe("background work", () => {
  test("a query with background work is not closed when idle; the 15 minutes start once the work is done", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    expect(h.session.nextDeadline()).toBeNull();
    await h.advance(60 * 60_000);
    expect(h.q().closed).toBe(false);
    h.q().emit(tasks());
    await flush();
    await h.advance(15 * 60_000);
    expect(h.q().closed).toBe(true);
  });

  test("ambient tasks are not background work", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks({ task_id: "w", description: "watch", ambient: true }), resultMsg(0.1));
    await flush();
    await h.advance(15 * 60_000);
    expect(h.q().closed).toBe(true);
  });

  test("a new query starts with no background work, whatever the last one had", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    h.q().exit();
    await flush();
    h.push("[b]");
    await flush();
    h.q().emit(resultMsg(0.2));
    await flush();
    await h.advance(15 * 60_000);
    expect([h.queries.length, h.q().closed]).toEqual([2, true]);
  });

  test("reopen waits for background work: an idle query closes once its set empties", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    h.session.reopen();
    expect(h.q().closed).toBe(false);
    h.q().emit(tasks());
    await flush();
    expect(h.q().closed).toBe(true);
  });

  test("a stale query is not closed after its turn while background work runs, and closes once the work is done", async () => {
    const { h } = await started("[a]");
    h.session.reopen();
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    expect(h.q().closed).toBe(false);
    h.q().emit(tasks());
    await flush();
    expect(h.q().closed).toBe(true);
  });

  test("an unattended turn waits while background work runs, then runs on a query of its own", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(tasks(build), resultMsg(0.1));
    await flush();
    const r = h.push("[r]", routine);
    await flush();
    expect([first.closed, h.queries.length, h.session.current?.id as string | undefined]).toEqual([false, 1, r]);
    first.emit(tasks());
    await flush();
    expect([first.closed, h.queries.length, h.q().received.map((x) => x.text), h.q().options.maxBudgetUsd]).toEqual([true, 2, ["[r]"], 10]);
    expect(h.notes).toEqual([]);
  });

  test("an unattended turn waits for background work at most BACKGROUND_WAIT_MS, then the work is stopped with a note", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(tasks(build, lint), resultMsg(0.1));
    await flush();
    h.push("[r]", routine);
    await flush();
    expect(h.session.nextDeadline()).toBe(new Date(h.clock.t + BACKGROUND_WAIT_MS).toISOString());
    await h.advance(BACKGROUND_WAIT_MS - 1);
    expect([first.stoppedTasks, h.notes]).toEqual([[], []]);
    await h.advance(1);
    expect(first.stoppedTasks).toEqual(["t1", "t2"]);
    expect(h.notes).toEqual(["Ana's background work stopped: npm run build; npm run lint."]);
  });

  test("a result while an unattended turn waits is not that turn's", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    const r = h.push("[r]", routine);
    await flush();
    h.q().emit(said("The build finished."), resultMsg(0.2));
    await flush();
    expect([h.finals(r), h.session.current?.id as string | undefined]).toEqual([[], r]);
  });

  test("an attended turn on a stale query with background work runs on it rather than kill the work", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    h.session.reopen();
    h.push("[b]");
    await flush();
    expect([h.queries.length, h.q().closed, h.sent()]).toEqual([1, false, ["[a]", "[b]"]]);
  });

  test("Stop stops every background task, and stops them even when no turn runs", async () => {
    const { h, id } = await started("[a]");
    h.q().emit(tasks(build, lint));
    await flush();
    expect(await h.session.interrupt()).toBe(true);
    expect(h.q().stoppedTasks).toEqual(["t1", "t2"]);
    h.q().emit(interruptedResult(0.1));
    await flush();
    expect(h.finals(id)).toMatchObject([{ end: { kind: "stopped" } }]);
    h.q().emit(tasks(lint));
    await flush();
    expect(await h.session.interrupt()).toBe(true);
    expect(h.q().stoppedTasks).toEqual(["t1", "t2", "t2"]);
  });

  test("Stop while an unattended turn waits on background work ends it as stopped, and nothing is sent", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    const r = h.push("[r]", routine, false, fired);
    await flush();
    await h.session.interrupt();
    await flush();
    h.q().emit(tasks());
    await flush();
    expect(h.finals(r).map((e) => e.end.kind)).toEqual(["stopped"]);
    expect([h.queries.length, h.sent()]).toEqual([1, ["[a]"]]);
  });

  test("background work a restart stopped is named in one note, once", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build, { task_id: "t3", description: "x".repeat(200) }), resultMsg(0.1));
    await flush();
    h.session.close();
    const after = harness({ state: structuredClone(h.state) });
    await flush();
    expect(after.notes).toEqual([`The bridge restarted, so Ana's background work stopped: npm run build; ${"x".repeat(79)}….`]);
    after.session.close();
    const again = harness({ state: structuredClone(after.state) });
    await flush();
    expect(again.notes).toEqual([]);
  });

  test("background work that ends on its own leaves nothing for a restart to name", async () => {
    const { h } = await started("[a]");
    h.q().emit(tasks(build), resultMsg(0.1));
    await flush();
    h.q().emit(tasks());
    await flush();
    h.session.close();
    const after = harness({ state: structuredClone(h.state) });
    await flush();
    expect(after.notes).toEqual([]);
  });
});

describe("turns a background task wakes", () => {
  test("every turn's message carries its own uuid", async () => {
    const { h } = await started("[a]");
    h.q().emit(resultMsg(0.1));
    await flush();
    h.push("[b]");
    await flush();
    const [a, b] = h.q().received.map((r) => r.uuid);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  test("a result that echoes other uuids does not end the user's turn, and its cost is the system's", async () => {
    const { h, id } = await started("[a]");
    const mine = lastUuid(h);
    h.q().emit(echoing(said("The build finished."), "wake"), echoing(resultMsg(0.3), "wake"));
    await flush();
    expect([h.finals(id), h.session.current?.id as string | undefined]).toEqual([[], id]);
    expect(h.usage.map((u) => [u.cumulativeUsd, (u.initiator as Initiator).kind])).toEqual([[0.3, "system"]]);
    expect(h.messages.map((x) => x.turn)).toEqual([null, null]);
    h.q().emit(echoing(said("hi"), mine), echoing(resultMsg(0.5), "wake", mine));
    await flush();
    expect(h.finals(id).map((e) => e.end.kind)).toEqual(["done"]);
  });

  test("an assistant message that echoes other uuids is no output of the user's turn, so its error still retries", async () => {
    const { h, id } = await started("[a]");
    const mine = lastUuid(h);
    h.q().emit(echoing(said("Woke up."), "wake"), echoing(apiErrorMessage("overloaded"), mine), apiErrorResult(0));
    await flush();
    expect(h.ends.filter((e) => e.id === id).map((e) => e.end.kind)).toEqual(["deferred"]);
  });

  test("a result with no echo that a task notification started does not end the user's turn", async () => {
    const { h, id } = await started("[a]");
    h.q().emit(resultMsg(0.3, { origin: { kind: "task-notification" } }));
    await flush();
    expect(h.finals(id)).toEqual([]);
    h.q().emit(resultMsg(0.4));
    await flush();
    expect(h.finals(id).map((e) => e.end.kind)).toEqual(["done"]);
  });

  test("an account-wide usage limit a wake turn hits parks the account, with or without a turn in flight", async () => {
    const resetsAt = Math.floor(NOW.getTime() / 1000) + 3_600;
    const until = new Date(resetsAt * 1000 + USAGE_PARK_SLACK_MS).toISOString();
    const busy = await started("[a]");
    busy.h.q().emit(rejected(resetsAt), echoing(apiErrorResult(0), "wake"));
    await flush();
    expect([busy.h.account.parkedUntil, busy.h.finals(busy.id), busy.h.session.current?.id as string | undefined]).toEqual([until, [], busy.id]);
    const idle = await started("[a]");
    idle.h.q().emit(resultMsg(0.1));
    await flush();
    idle.h.q().emit(rejected(resetsAt), apiErrorResult(0));
    await flush();
    expect(idle.h.account.parkedUntil).toBe(until);
  });
});

const notified = (status = "completed") =>
  ({ type: "system", subtype: "task_notification", task_id: "t1", status, output_file: "", summary: "done", uuid: `n${++uuid}`, session_id: "s_1" }) as unknown as SDKMessage;
/** A turn's init frame. Unless echoing() stamps it with a user message's uuid, Claude Code started the turn on its own. */
const wakeInit = () => ({ type: "system", subtype: "init", uuid: `i${++uuid}`, session_id: "s_1" }) as unknown as SDKMessage;
const wakeResult = (cost: number) => resultMsg(cost, { result: "The build finished.", origin: { kind: "task-notification" } });
const texts = (h: Harness) => h.messages.flatMap(({ m, turn }) => (m.type === "assistant" ? [[textOf(m.message.content as Content), turn?.text ?? null]] : []));

describe("handing a query over to a new one", () => {
  test("a held routine waits for the wake turn its background work announced, then for the old process to exit", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(tasks(build), resultMsg(0.1));
    await flush();
    const r = h.push("[r]", routine, false, fired);
    await flush();
    first.process.lingers = true;
    first.emit(notified(), tasks());
    await flush();
    expect([first.closed, h.queries.length]).toEqual([false, 1]);
    first.emit(wakeInit(), said("The build finished."));
    await flush();
    await h.advance(WAKE_WAIT_MS);
    expect([first.closed, h.queries.length]).toEqual([false, 1]);
    first.emit(wakeResult(0.15));
    await flush();
    expect([first.closed, h.queries.length]).toEqual([true, 1]);
    first.process.exit();
    await flush();
    expect([h.queries.length, h.q().received.map((x) => x.text)]).toEqual([2, ["[r]"]]);
    h.q().emit(echoing(resultMsg(0.2), lastUuid(h)));
    await flush();
    expect(h.usage.map((u) => [u.cumulativeUsd, (u.initiator as Initiator).kind])).toEqual([
      [0.1, "user"],
      [0.15, "system"],
      [0.2, "routine"],
    ]);
    expect(texts(h)).toEqual([["The build finished.", null]]);
    expect(h.finals(r).map((e) => e.end.kind)).toEqual(["done"]);
    expect(h.notes).toEqual([]);
  });

  test("a wake turn the notification announced but Claude Code never starts holds the routine for WAKE_WAIT_MS at most", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(tasks(build), resultMsg(0.1));
    await flush();
    h.push("[r]", routine);
    await flush();
    first.emit(notified(), tasks());
    await flush();
    expect(h.session.nextDeadline()).toBe(new Date(h.clock.t + WAKE_WAIT_MS).toISOString());
    await h.advance(WAKE_WAIT_MS - 1);
    expect([first.closed, h.queries.length]).toEqual([false, 1]);
    await h.advance(1);
    expect([first.closed, h.q().received.map((x) => x.text)]).toEqual([true, ["[r]"]]);
  });

  test("a notification during the user's turn makes a held close wait for the wake turn that follows its result", async () => {
    const { h, id } = await started("[a]");
    const first = h.q();
    first.emit(echoing(wakeInit(), lastUuid(h)), tasks(build));
    await flush();
    h.session.reopen();
    first.emit(notified(), tasks(), echoing(resultMsg(0.1), lastUuid(h)));
    await flush();
    expect([h.finals(id).length, first.closed]).toEqual([1, false]);
    first.emit(wakeInit(), said("The build finished."), wakeResult(0.15));
    await flush();
    expect(first.closed).toBe(true);
    expect(texts(h)).toEqual([["The build finished.", null]]);
  });

  test("the idle close never cuts off a turn Claude Code runs on its own", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(resultMsg(0.1), wakeInit());
    await flush();
    await h.advance(60 * 60_000);
    expect(first.closed).toBe(false);
    first.emit(wakeResult(0.15));
    await flush();
    await h.advance(15 * 60_000);
    expect(first.closed).toBe(true);
  });

  test("an unattended turn whose background wait ran out stops the work, lets the old query report it, and opens after it exited", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(tasks(build), resultMsg(0.1));
    await flush();
    const r = h.push("[r]", routine, false, fired);
    await flush();
    first.process.lingers = true;
    await h.advance(BACKGROUND_WAIT_MS);
    expect([first.stoppedTasks, first.closed, h.queries.length]).toEqual([["t1"], false, 1]);
    expect(h.notes).toEqual(["Ana's background work stopped: npm run build."]);
    first.emit(notified("stopped"), tasks(), wakeInit(), wakeResult(0.12));
    await flush();
    expect([first.closed, h.queries.length]).toEqual([true, 1]);
    first.process.exit();
    await flush();
    expect(h.q().received.map((x) => x.text)).toEqual(["[r]"]);
    h.q().emit(echoing(resultMsg(0.2), lastUuid(h)));
    await flush();
    expect(h.usage.map((u) => [u.cumulativeUsd, (u.initiator as Initiator).kind])).toEqual([
      [0.1, "user"],
      [0.12, "system"],
      [0.2, "routine"],
    ]);
    expect(h.finals(r).map((e) => e.end.kind)).toEqual(["done"]);
    expect(h.notes).toEqual(["Ana's background work stopped: npm run build."]);
  });

  test("background work that ignores the stop is cut off by closing the query, after WAKE_WAIT_MS more", async () => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(tasks(build), resultMsg(0.1));
    await flush();
    h.push("[r]", routine);
    await flush();
    await h.advance(BACKGROUND_WAIT_MS);
    await h.advance(WAKE_WAIT_MS - 1);
    expect([first.closed, h.queries.length]).toEqual([false, 1]);
    await h.advance(1);
    expect([first.closed, h.q().received.map((x) => x.text)]).toEqual([true, ["[r]"]]);
    expect(h.notes).toEqual(["Ana's background work stopped: npm run build."]);
  });

  test.each([
    ["an unattended turn", routine, () => {}],
    ["an attended turn on a stale query", user, (h: Harness) => h.session.reopen()],
  ] as const)("%s never opens a new query while the old one's process still runs", async (_, initiator, before) => {
    const { h } = await started("[a]");
    const first = h.q();
    first.emit(resultMsg(0.1));
    await flush();
    first.process.lingers = true;
    before(h);
    h.push("[b]", initiator);
    await flush();
    await h.advance(60_000);
    expect([first.closed, h.queries.length]).toEqual([true, 1]);
    first.process.exit();
    await flush();
    expect([h.queries.length, h.q().received.map((x) => x.text)]).toEqual([2, ["[b]"]]);
  });

  test("a closed query whose process still runs keeps the session from going dormant, so no new session resumes it", async () => {
    const { h } = await started("[a]");
    h.q().emit(resultMsg(0.1));
    await flush();
    h.q().process.lingers = true;
    h.session.reopen();
    await h.advance(1_000);
    expect([h.q().closed, h.dormant]).toEqual([true, 0]);
    h.q().process.exit();
    await flush();
    await h.advance(1_000);
    expect(h.dormant).toBeGreaterThan(0);
  });
});

describe("usage limit signals", () => {
  const resetsAt = Math.floor(NOW.getTime() / 1000) + 3_600;
  test.each([
    ["overageStatus allowed", { overageStatus: "allowed" }],
    ["overageStatus allowed_warning", { overageStatus: "allowed_warning" }],
    ["overageInUse", { overageInUse: true }],
  ])("a rejection with %s is not a usage limit", async (_, info) => {
    const { h } = await started("[a]");
    h.q().emit(rejected(resetsAt, info), apiErrorMessage("overloaded"), apiErrorResult(0));
    await flush();
    expect(h.account.parkedUntil).toBeNull();
    expect(h.state.lifecycle).toMatchObject({ kind: "backoff" });
  });

  test("a later allowance of the same limit clears the rejection; another limit's does not", async () => {
    const cleared = await started("[a]");
    cleared.h.q().emit(rejected(resetsAt, { rateLimitType: "five_hour" }), allowed("allowed", { rateLimitType: "five_hour" }), apiErrorMessage("overloaded"), apiErrorResult(0));
    await flush();
    expect(cleared.h.account.parkedUntil).toBeNull();
    const other = await started("[a]");
    other.h.q().emit(rejected(resetsAt, { rateLimitType: "five_hour" }), allowed("allowed_warning", { rateLimitType: "seven_day" }), apiErrorResult(0));
    await flush();
    expect(other.h.account.parkedUntil).not.toBeNull();
  });

  test("a warning past a threshold is noted once per limit and reset", async () => {
    const { h } = await started("[a]");
    const warn = (over: object) => allowed("allowed_warning", { rateLimitType: "seven_day", resetsAt: resetsAt + 7, surpassedThreshold: 0.9, ...over });
    h.q().emit(warn({}), warn({ utilization: 0.93 }), warn({ rateLimitType: "five_hour" }), allowed("allowed_warning", { rateLimitType: "seven_day_opus" }));
    await flush();
    expect(h.notes).toHaveLength(2);
    expect(h.notes[0]).toMatch(/^Weekly limit at 90%, resets [A-Z][a-z]{2} \d{2}:\d{2}\.$/);
    expect(h.notes[1]).toMatch(/^Session limit at 90%, resets /);
    expect(h.state.lifecycle.kind).toBe("working");
  });
});

describe("compaction", () => {
  const boundary = (trigger: "auto" | "manual") =>
    ({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens: 1 }, uuid: "cb", session_id: "s_1" }) as unknown as SDKMessage;
  test("an automatic compaction leaves one note; one the user asked for does not", async () => {
    const { h } = await started("[a]");
    h.q().emit(boundary("manual"), boundary("auto"));
    await flush();
    expect(h.notes).toEqual(["Ana's conversation was compacted to make room; older details are summarized now."]);
  });
});

describe("commands", () => {
  const command = (text: string): SessionInput => ({ kind: "command", text, initiator: user, settles: null });
  test("a command runs last, behind the notices and context it carries as their own block", async () => {
    const h = harness({ context: () => "Facts: likes tea" });
    h.session.notice("[Your question expired.]");
    h.session.push(command("/greet Ana"));
    await flush();
    expect(h.q().received[0]!.content).toEqual([
      { type: "text", text: "Facts: likes tea\n\n[Your question expired.]" },
      { type: "text", text: "/greet Ana" },
    ]);
    h.q().emit(said("Hi Ana"), resultMsg(0.1));
    await flush();
    h.push("[b]");
    await flush();
    expect(h.sent().at(-1)).toBe("[b]");
  });

  test("a command with nothing to carry is sent as its bare text", async () => {
    const h = harness();
    h.session.push(command("/greet Ana"));
    await flush();
    expect(h.q().received[0]!.content).toBe("/greet Ana");
  });
});

describe("the Claude Code process group", () => {
  test("every query spawns Claude Code through the group spawner", async () => {
    const { h } = await started("[a]");
    expect(typeof h.q().options.spawnClaudeCodeProcess).toBe("function");
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function gone(pid: number) {
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    return !alive(pid);
  }
  const spawnOf = (script: string, signal = new AbortController().signal, stderr: (d: string) => void = () => {}) =>
    spawnGroup({ command: "/bin/sh", args: ["-c", script], env: { ...process.env }, signal }, stderr, () => {});
  async function grandchild(p: ReturnType<typeof spawnOf>): Promise<number> {
    let out = "";
    for await (const chunk of p.stdout) {
      out += String(chunk);
      if (out.includes("\n")) break;
    }
    return Number(out.trim());
  }

  test("a grandchild dies when Claude Code exits, and the session hears of the exit", async () => {
    let exited = 0;
    const p = spawnGroup({ command: "/bin/sh", args: ["-c", "sleep 30 & echo $!; read _"], env: { ...process.env }, signal: new AbortController().signal }, () => {}, () => exited++);
    const pid = await grandchild(p);
    expect([alive(pid), exited]).toEqual([true, 0]);
    p.stdin.end();
    expect(await gone(pid)).toBe(true);
    expect(exited).toBe(1);
  });

  test("a grandchild dies when the query's signal aborts, and stderr reaches the session", async () => {
    const abort = new AbortController();
    let err = "";
    const p = spawnOf("echo oops >&2; sleep 30 & echo $!; wait", abort.signal, (d) => (err += d));
    const pid = await grandchild(p);
    abort.abort();
    expect(await gone(pid)).toBe(true);
    expect(err).toBe("oops\n");
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
    () => h.session.reopen(),
    () => live()?.emit(toolFailed(SANDBOX_DOWN)),
    () => live()?.emit(resultMsg(random(), { subtype: "error_during_execution", is_error: true, errors: [SANDBOX_DOWN] })),
    () => void (openFails = random() < 0.3),
    () => live()?.emit(resultMsg(0, { subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: s_1"] })),
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
}, 30_000); // 300 steps take about half a second; a loaded machine must not fail them on bun's 5 s default
