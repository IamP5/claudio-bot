import { describe, expect, test } from "bun:test";
import type { Options, query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Headroom, Ledger } from "../src/ledger";
import type { AgentId, BotId, RoutineId, RunId } from "../src/protocol";
import {
  BREAKER_NOTE,
  CAP_NOTE,
  RESTARTED_ERROR,
  STOP_DEADLINE_MS,
  USAGE_PARK_FALLBACK_MS,
  USAGE_PARK_SLACK_MS,
  classify,
  createSession,
  freshMemo,
  noSignals,
  step,
  type Core,
  type Effect,
  type Event,
  type Outcome,
  type TurnEnd,
} from "../src/session";
import { emptySession, type AccountState, type ActiveTurn, type EnvelopeId, type Initiator, type Lifecycle, type Pending, type SessionState } from "../src/world";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const user: Initiator = { kind: "user" };
const routine: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_1" as RunId }, manual: false };
const manualRun: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_2" as RunId }, manual: true };
const botMail: Initiator = { kind: "bot", botId: "b_2" as BotId, hops: 1 };
const agentMail: Initiator = { kind: "agent", agentId: "a_1" as AgentId };
const attendedNow = (i: Initiator) => i.kind === "user" || (i.kind === "routine" && i.manual);

const roomy = (): Headroom => ({ ok: true, capReached: false });

// ─── step(): the lifecycle as a table ───────────────────────────────────────────────────────────────────────────────

const env = (id: string, initiator: Initiator = user, attempts = 0): Pending => ({
  id: id as EnvelopeId,
  at: NOW.toISOString(),
  text: `[${id}]`,
  initiator,
  attempts,
});
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
    const t = run(core({ kind: "idle" }, []), { kind: "push", pending: env("a"), ahead: false });
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("a") });
    expect(t.core.session.pending).toEqual([env("a", user, 1)]);
    expect(t.effects).toEqual([{ kind: "send", pending: env("a", user, 1), text: "[a]" }]);
  });

  test("an approval continuation goes right behind the turn in flight, before everything queued", () => {
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", user, 1), env("b")]), { kind: "push", pending: env("c", routine), ahead: true });
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
    const t = run(core({ kind: "working", turn: turn("a") }, [env("a", routine, 1)]), { kind: "end", outcome: { kind: "usage_limit", error: "limit", until } });
    expect(t.core.parkedUntil).toBe(until);
    expect(t.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
    expect(t.core.session.pending).toEqual([env("a", routine, 0)]);
    expect(t.effects).toEqual([{ kind: "end", pending: env("a", routine, 0), end: { kind: "deferred", until, why: "usage_limit" } }]);
  });

  test("a usage limit after output fails the turn but still parks the account for what is queued", () => {
    const until = later(3_600_000);
    const t = run(core({ kind: "working", turn: turn("a", { output: true }) }, [env("a", user, 1), env("b")]), { kind: "end", outcome: { kind: "usage_limit", error: "limit", until } });
    expect(endsOf(t.effects)).toEqual([
      ["a", "failed"],
      ["b", "deferred"],
    ]);
    expect(t.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
  });

  test.each([ok(), { kind: "transient", error: "x" }, { kind: "terminal", error: "x" }] as Outcome[])("any end while stopping is stopped, never retried (%#)", (outcome) => {
    const stopping: Lifecycle = { kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) };
    const t = run(core(stopping, [env("a", user, 1)]), { kind: "end", outcome });
    expect(t.effects).toEqual([{ kind: "end", pending: env("a", user, 1), end: { kind: "stopped", by: "user" } }]);
    expect(t.core.session).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
  });

  test("Stop on a working turn interrupts it and drops queued unattended envelopes, each with a notice", () => {
    const pending = [env("a", routine, 1), env("u1"), env("r", routine), env("b", botMail), env("m", manualRun), env("g", agentMail)];
    const t = run(core({ kind: "working", turn: turn("a") }, pending), { kind: "stop" });
    expect(t.core.session.lifecycle).toEqual({ kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) });
    expect(t.core.session.pending.map((p) => p.id as string)).toEqual(["a", "u1", "m"]);
    expect(kinds(t.effects)).toEqual(["interrupt", "end", "end", "end"]);
    expect(endsOf(t.effects)).toEqual([
      ["r", "dropped"],
      ["b", "dropped"],
      ["g", "dropped"],
    ]);
    expect(t.core.session.notices.map((n) => n.text)).toEqual([
      "[Alex pressed Stop, so this never ran: [r]]",
      "[Alex pressed Stop, so this never ran: [b]]",
      "[Alex pressed Stop, so this never ran: [g]]",
    ]);
  });

  test("Stop on a head waiting in backoff ends it as stopped and runs the user's queued message", () => {
    const t = run(core({ kind: "backoff", until: later(3_000), attempt: 2 }, [env("a", routine, 2), env("u")]), { kind: "stop" });
    expect(endsOf(t.effects)).toEqual([["a", "stopped"]]);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("u") });
  });

  test.each([
    { kind: "idle" },
    { kind: "parked", reason: "daily_cap", until: later(60_000) },
    { kind: "stopping", turn: turn("a"), deadline: later(STOP_DEADLINE_MS) },
  ] as Lifecycle[])("Stop changes nothing in $kind", (lifecycle) => {
    const c = core(lifecycle, lifecycle.kind === "idle" ? [] : [env("a", routine, 1), env("r", routine)]);
    const t = run(c, { kind: "stop" });
    expect(t.core).toEqual(c);
    expect(t.effects).toEqual([]);
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
    { kind: "parked", reason: "daily_cap", until: later(1_000) },
  ] as Lifecycle[])("$kind holds the head until its deadline, then starts it", (lifecycle) => {
    const c = core(lifecycle, [env("a", routine, 1)]);
    expect(run(c, { kind: "tick" }, roomy, new Date(later(999))).core.session.lifecycle).toEqual(lifecycle);
    const t = run(c, { kind: "tick" }, roomy, new Date(later(1_000)));
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("a", { startedAt: later(1_000) }) });
    expect(t.core.session.pending[0]!.attempts).toBe(2);
  });

  test("a tick at the same moment twice changes nothing the second time", () => {
    const first = run(core({ kind: "backoff", until: later(1_000), attempt: 1 }, [env("a", user, 1)]), { kind: "tick" }, roomy, new Date(later(1_000)));
    const second = run(first.core, { kind: "tick" }, roomy, new Date(later(1_000)));
    expect(second.core).toEqual(first.core);
    expect(second.effects).toEqual([]);
  });

  test("while the account is parked nothing starts, and the park is told once", () => {
    const until = later(60_000);
    const first = run(core({ kind: "idle" }, [], { parkedUntil: until }), { kind: "push", pending: env("a"), ahead: false });
    expect(first.core.session.lifecycle).toEqual({ kind: "parked", reason: "usage_limit", until });
    expect(endsOf(first.effects)).toEqual([["a", "deferred"]]);
    expect(run(first.core, { kind: "push", pending: env("b"), ahead: false }).effects).toEqual([]);
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
    const again = run(after.core, { kind: "push", pending: env("u2"), ahead: false }, headroom);
    expect(kinds(again.effects)).toEqual(["send"]);
  });

  test("an exhausted agent budget fails the envelope without starting it", () => {
    const t = run(core({ kind: "idle" }, []), { kind: "push", pending: env("a", botMail), ahead: false }, () => ({ ok: false, reason: "agent_budget" }));
    expect(endsOf(t.effects)).toEqual([["a", "failed"]]);
    expect(t.core.session).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
  });

  test("an envelope out of attempts fails instead of starting a fifth time", () => {
    const t = run(core({ kind: "idle" }, [env("a", user, 4), env("b")]), { kind: "pump" });
    expect(endsOf(t.effects)).toEqual([["a", "failed"]]);
    expect(t.core.session.lifecycle).toEqual({ kind: "working", turn: turn("b") });
  });

  test("notices ride on the next envelope, are kept for a retry, and are dropped once the turn has output", () => {
    const c = core({ kind: "idle" }, []);
    c.session.notices = [{ at: NOW.toISOString(), text: "[Your question expired.]" }];
    const started = run(c, { kind: "push", pending: env("a"), ahead: false });
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
    ["a rate_limit error", apiFailure(), signals({ apiError: "rate_limit" }), "usage_limit"],
    ["an error subtype after a rejected rate limit", interruptResult, signals({ rejected: true, resetsAt }), "usage_limit"],
  ] as const)("%s → %s", (_, result, s, kind) => {
    expect(classify(result, s, NOW).kind).toBe(kind);
  });

  test("the usage park ends 30 s after resetsAt (epoch seconds), or after the fallback when no reset is known", () => {
    expect(classify(apiFailure(), signals({ rejected: true, resetsAt }), NOW)).toMatchObject({ until: new Date(resetsAt * 1000 + USAGE_PARK_SLACK_MS).toISOString() });
    expect(classify(apiFailure(), signals({ apiError: "rate_limit" }), NOW)).toMatchObject({ until: later(USAGE_PARK_FALLBACK_MS + USAGE_PARK_SLACK_MS) });
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
const rejected = (resetsAt: number) => ({ type: "rate_limit_event", uuid: "rl", session_id: "s_1", rate_limit_info: { status: "rejected", resetsAt } }) as unknown as SDKMessage;

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
    clock?: { t: number };
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
    options: opts.options ?? (() => ({ cwd: "/bots/b_1" })),
    ledger: {
      add: opts.add ?? ((row) => void usage.push(row as Record<string, unknown>)),
      headroom: (_, i) => (opts.headroom ?? roomy)(i),
      budgetLeft: () => null,
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
    log: (line) => logs.push(line),
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const q = new FakeQuery(options, prompt, () => structuredClone(disk));
      queries.push(q);
      return q;
    }) as unknown as typeof query,
    executable: () => (opts.executable === undefined ? "/fake/claude" : opts.executable),
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
    push(text: string, initiator: Initiator = user, ahead = false) {
      session.push({ text, initiator, ahead });
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
    expect(disk.pending).toMatchObject([{ id, text: "[Alex]\nhello", attempts: 1 }]);
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
    expect([h.session.nextDeadline(), h.session.working, h.sent().length]).toEqual([null, false, 1]);
    expect(await h.session.interrupt()).toBe(false);
  });

  test("while stopping nothing new is sent; queued unattended mail is dropped and the user's queued message runs after", async () => {
    const { h, id: a } = await started("[a]");
    const r = h.push("[Routine Digest fired]\nsummarize", routine);
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
      "[Alex pressed Stop, so this never ran: [Routine Digest fired]]\n[Alex pressed Stop, so this never ran: [Message from bot Scout]]\n[Alex]\nactually, wait",
    ]);
    expect(h.queries).toHaveLength(1);
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

  test("options() throwing fails the envelope cleanly instead of throwing out of push", async () => {
    const h = harness({
      options: () => {
        throw new Error("gate not ready");
      },
    });
    const a = h.push("[a]");
    const b = h.push("[b]");
    await flush();
    expect([h.finals(a), h.finals(b)]).toMatchObject([[{ end: { kind: "failed", error: "gate not ready" } }], [{ end: { kind: "failed" } }]]);
    expect(h.queries).toHaveLength(0);
    expect(h.state).toMatchObject({ pending: [], lifecycle: { kind: "idle" } });
  });

  test("a missing claude executable fails the envelope", async () => {
    const h = harness({ executable: null });
    const a = h.push("[a]");
    expect(h.finals(a)).toMatchObject([{ end: { kind: "failed", error: "claude was not found on PATH. Set CLAUDIOBOT_CLAUDE." } }]);
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

  test("Pending fields beyond the session's own are carried through a retry and a replay untouched", async () => {
    const settles = { routineId: "r_1", runId: "run_1" };
    const h = harness();
    h.session.push({ text: "[r]", initiator: routine, ahead: false, settles } as unknown as Parameters<typeof h.session.push>[0]);
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
  const h = harness({ headroom: (i) => (attendedNow(i) || random() < 0.9 ? roomy() : { ok: false, reason: "daily_cap", until: new Date(h.clock.t + 60_000).toISOString() }) });
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
    () => h.advance(pick([500, 1_000, 3_000, 8_000, 15_000, 120_000])),
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
