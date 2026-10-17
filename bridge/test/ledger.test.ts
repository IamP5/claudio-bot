import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, BotId, RoutineId, RunId } from "../src/protocol";
import { createLedger, DEFAULT_AGENT_BUDGET_USD, DEFAULT_DAILY_CAP_USD, type UsageRow } from "../src/ledger";
import type { Actor, Initiator } from "../src/world";

// bun test runs in UTC unless TZ is set, where local and UTC days coincide. A zone 3 h behind UTC puts 23:50 local on
// the next UTC day, so a ledger that used UTC days would fail here.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Sao_Paulo";
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const B1 = "b1" as BotId;
const B2 = "b2" as BotId;
const A1 = "a1" as AgentId;
const A2 = "a2" as AgentId;
const bot1: Actor = { kind: "bot", botId: B1 };
const bot2: Actor = { kind: "bot", botId: B2 };
const agent1: Actor = { kind: "agent", botId: B1, agentId: A1 };
const agent2: Actor = { kind: "agent", botId: B1, agentId: A2 };

const user: Initiator = { kind: "user" };
const routine: Initiator = { kind: "routine", run: { routineId: "r1" as RoutineId, runId: "u1" as RunId }, manual: false };
const manual: Initiator = { ...routine, manual: true };
const fromBot: Initiator = { kind: "bot", botId: B2, hops: 1, origin: { kind: "user" } };
const system: Initiator = { kind: "system" };

// Local wall-clock times, so the day boundaries hold in whatever zone the test runs.
const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);

function harness(opts: { caps?: Record<string, number>; budgets?: Record<string, number>; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "claudiobot-ledger-"));
  if (!opts.dir) dirs.push(dir);
  const clock = { now: local(2026, 10, 17) };
  const logs: string[] = [];
  const open = () =>
    createLedger({
      dir,
      capFor: (id) => opts.caps?.[id] ?? null,
      budgetFor: (id) => opts.budgets?.[id] ?? null,
      now: () => clock.now,
      log: (l) => logs.push(l),
    });
  return { dir, clock, logs, ledger: open(), reopen: open };
}

const rowsIn = (dir: string): UsageRow[] =>
  readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as UsageRow];
      } catch {
        return [];
      }
    });

let sessions = 0;
/** Charges exactly `usd` with one result from a fresh session. */
function spend(ledger: ReturnType<typeof createLedger>, actor: Actor, usd: number, initiator: Initiator = user) {
  ledger.add({ actor, sessionId: `s_spend_${++sessions}`, initiator, cumulativeUsd: usd, fresh: true });
}

function withEnv(name: string, value: string | undefined, body: () => void) {
  const before = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

test.each([
  ["adopts the first result of a session with no row", [2.5, 3, 3.75], [0, 0.5, 0.75]],
  ["a cumulative below the baseline charges nothing and rebaselines", [1, 1.5, 0.4, 0.9], [0, 0.5, 0, 0.5]],
  ["a crash zero charges nothing and keeps the baseline", [1, 0, 1.2], [0, 0, 0.2]],
  ["a zero before any baseline adopts nothing", [0, 0.3, 0.5], [0, 0, 0.2]],
  ["a negative or non-finite cumulative charges nothing", [1, -1, Number.NaN, 1.25], [0, 0, 0, 0.25]],
  ["an unchanged cumulative charges nothing", [2, 2, 2], [0, 0, 0]],
] as const)("delta: %s", (_name, cumulatives, deltas) => {
  const { dir, ledger } = harness();
  for (const c of cumulatives) ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: c });
  const got = rowsIn(dir).map((r) => r.deltaUsd);
  expect(got).toHaveLength(deltas.length);
  got.forEach((d, i) => expect(d).toBeCloseTo(deltas[i]!, 9));
});

test.each([
  ["a fresh session is charged its first result in full", [[0.8, true], [1.1, false]], [0.8, 0.3]],
  ["a fresh session whose first result is zero still starts from 0", [[0, true], [0.3, false]], [0, 0.3]],
  ["a fresh result ignores any baseline under its id", [[2, false], [0.5, true], [0.75, false]], [0, 0.5, 0.25]],
] as const)("fresh: %s", (_name, results, deltas) => {
  const { dir, ledger } = harness();
  for (const [c, fresh] of results) ledger.add({ actor: bot1, sessionId: "s1", initiator: routine, cumulativeUsd: c, fresh });
  const got = rowsIn(dir).map((r) => r.deltaUsd);
  expect(got).toHaveLength(deltas.length);
  got.forEach((d, i) => expect(d).toBeCloseTo(deltas[i]!, 9));
});

test("a cumulative below the baseline is logged as an anomaly", () => {
  const { logs, ledger } = harness();
  ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: 3 });
  expect(logs.filter((l) => l.startsWith("usage: WARNING"))).toEqual([]);
  ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: 1 });
  expect(logs.filter((l) => l.startsWith("usage: WARNING"))).toEqual([
    "usage: WARNING session=s1 totalCostUsd=1 is below its baseline 3; charged 0 and rebaselined (a stale total, or two queries resuming one session)",
  ]);
});

test("each session keeps its own baseline", () => {
  const { dir, ledger } = harness();
  ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: 4 });
  ledger.add({ actor: bot2, sessionId: "s2", initiator: user, cumulativeUsd: 1 });
  ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: 4.5 });
  ledger.add({ actor: bot2, sessionId: "s2", initiator: user, cumulativeUsd: 1.25 });
  expect(rowsIn(dir).map((r) => r.deltaUsd)).toEqual([0, 0, 0.5, 0.25]);
});

test("a row records the decided values in a 0600 month file named for the local day", () => {
  const { dir, clock, ledger } = harness();
  clock.now = local(2026, 10, 17, 9, 30);
  ledger.add({ actor: agent1, sessionId: "s1", initiator: routine, cumulativeUsd: 0.5, fresh: true });
  ledger.add({ actor: agent1, sessionId: "s1", initiator: routine, cumulativeUsd: 0.75 });
  expect(readdirSync(dir)).toEqual(["2026-10.jsonl"]);
  expect(statSync(join(dir, "2026-10.jsonl")).mode & 0o777).toBe(0o600);
  expect(rowsIn(dir)[0]).toMatchObject({ cumulativeUsd: 0.5, deltaUsd: 0.5, fresh: true });
  expect(rowsIn(dir)[1]).toEqual({
    at: clock.now.toISOString(),
    actor: "agent:a1",
    botId: B1,
    sessionId: "s1",
    initiator: routine,
    cumulativeUsd: 0.75,
    deltaUsd: 0.25,
    day: "2026-10-17",
  });
});

test("the daily cap holds unattended turns and lets attended turns run with capReached", () => {
  const { clock, ledger } = harness({ caps: { b1: 1 } });
  clock.now = local(2026, 10, 17, 23, 50);
  spend(ledger, bot1, 0.6, routine);
  expect(ledger.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
  spend(ledger, agent1, 0.4, fromBot);

  const until = local(2026, 10, 18, 0, 0).toISOString();
  for (const i of [routine, fromBot, system, { kind: "agent", agentId: A2 } as Initiator]) {
    expect(ledger.headroom(bot1, i)).toEqual({ ok: false, reason: "daily_cap", until });
    expect(ledger.headroom(agent1, i)).toEqual({ ok: false, reason: "daily_cap", until });
  }
  expect(ledger.headroom(bot1, user)).toEqual({ ok: true, capReached: true });
  expect(ledger.headroom(bot1, manual)).toEqual({ ok: true, capReached: true });
  expect(ledger.headroom(bot2, routine)).toEqual({ ok: true, capReached: false });

  clock.now = local(2026, 10, 18, 0, 5);
  expect(ledger.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
});

test("a turn that crosses local midnight counts on the day its result lands", () => {
  const { dir, clock, ledger } = harness({ caps: { b1: 1 } });
  clock.now = local(2026, 10, 17, 23, 59);
  ledger.add({ actor: bot1, sessionId: "s1", initiator: routine, cumulativeUsd: 1 });
  clock.now = local(2026, 10, 18, 0, 1);
  ledger.add({ actor: bot1, sessionId: "s1", initiator: routine, cumulativeUsd: 2.5 });
  expect(rowsIn(dir).map((r) => r.day)).toEqual(["2026-10-17", "2026-10-18"]);
  expect(ledger.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });
});

test("without its own cap a bot uses the default, which CLAUDIOBOT_DAILY_USD overrides", () => {
  withEnv("CLAUDIOBOT_DAILY_USD", undefined, () => {
    const plain = harness();
    spend(plain.ledger, bot1, DEFAULT_DAILY_CAP_USD - 0.01);
    expect(plain.ledger.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
    spend(plain.ledger, bot1, 0.01);
    expect(plain.ledger.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });
  });
  withEnv("CLAUDIOBOT_DAILY_USD", "2", () => {
    const overridden = harness({ caps: { b2: 50 } });
    spend(overridden.ledger, bot1, 2);
    spend(overridden.ledger, bot2, 2);
    expect(overridden.ledger.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(overridden.ledger.headroom(bot2, routine)).toEqual({ ok: true, capReached: false });
  });
});

test("a cap or budget that is not a finite non-negative number falls back to the default", () => {
  withEnv("CLAUDIOBOT_DAILY_USD", undefined, () =>
    withEnv("CLAUDIOBOT_AGENT_USD", undefined, () => {
      const bad = [Number.NaN, -1, Number.POSITIVE_INFINITY];
      const { ledger } = harness({
        caps: { b1: bad[0]!, b2: bad[1]! },
        budgets: { a1: bad[0]!, a2: bad[2]! },
      });
      expect(ledger.dailyLeft(B1)).toBe(DEFAULT_DAILY_CAP_USD);
      expect(ledger.dailyLeft(B2)).toBe(DEFAULT_DAILY_CAP_USD);
      expect(ledger.headroom(bot2, routine)).toEqual({ ok: true, capReached: false });
      expect(ledger.budgetLeft(A1)).toBe(DEFAULT_AGENT_BUDGET_USD);
      expect(ledger.budgetLeft(A2)).toBe(DEFAULT_AGENT_BUDGET_USD);
    }),
  );
});

test("dailyLeft is the bot's cap minus today's spend by it and its agents, never below 0", () => {
  const { clock, ledger } = harness({ caps: { b1: 3 } });
  expect(ledger.dailyLeft(B1)).toBe(3);
  spend(ledger, bot1, 1.25, routine);
  spend(ledger, agent1, 0.5, fromBot);
  expect(ledger.dailyLeft(B1)).toBeCloseTo(1.25, 9);
  spend(ledger, bot1, 2, user);
  expect(ledger.dailyLeft(B1)).toBe(0);
  clock.now = local(2026, 10, 18, 0, 1);
  expect(ledger.dailyLeft(B1)).toBe(3);
});

test("spend after a future-dated row counts on today, live and after a restart", () => {
  const h = harness({ caps: { b1: 1 } });
  h.clock.now = local(2026, 10, 20, 9);
  spend(h.ledger, bot1, 5, routine);
  h.clock.now = local(2026, 10, 17, 9);
  spend(h.ledger, bot1, 0.6, routine);
  expect(h.ledger.dailyLeft(B1)).toBeCloseTo(0.4, 9);
  spend(h.ledger, bot1, 0.4, routine);
  expect(h.ledger.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });
  expect(h.reopen().headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });

  h.clock.now = local(2026, 10, 18, 9);
  expect(h.reopen().dailyLeft(B1)).toBe(1);
});

// Bun caches a Date's zone offset on first use, so each phase builds its Date after setting TZ.
test("a westward time zone change keeps counting spend on the new local day", () => {
  const { clock, ledger } = harness({ caps: { b1: 1 } });
  try {
    process.env.TZ = "Asia/Tokyo";
    clock.now = new Date("2026-10-17T23:00:00Z");
    spend(ledger, bot1, 0.5, routine);
  } finally {
    process.env.TZ = "America/Sao_Paulo";
  }
  clock.now = new Date("2026-10-17T23:00:00Z");
  spend(ledger, bot1, 0.6, routine);
  expect(ledger.dailyLeft(B1)).toBeCloseTo(0.4, 9);
  spend(ledger, bot1, 0.4, routine);
  expect(ledger.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });

  clock.now = new Date("2026-10-18T13:00:00Z");
  expect(ledger.dailyLeft(B1)).toBeCloseTo(0.5, 9);
});

test("on a DST day with no local midnight the cap lifts at the first local instant of the day", () => {
  const { dir, clock, ledger } = harness({ caps: { b1: 1 } });
  clock.now = local(2018, 11, 3, 23, 30);
  spend(ledger, bot1, 1, routine);
  expect(ledger.headroom(bot1, routine)).toEqual({ ok: false, reason: "daily_cap", until: "2018-11-04T03:00:00.000Z" });

  clock.now = new Date("2018-11-04T03:05:00Z");
  expect(ledger.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
  spend(ledger, bot1, 0.25, routine);
  expect(rowsIn(dir).map((r) => r.day)).toEqual(["2018-11-03", "2018-11-04"]);
  expect(ledger.dailyLeft(B1)).toBeCloseTo(0.75, 9);
});

test("a failed append never throws, still counts the spend, and is logged", () => {
  const h = harness({ caps: { b1: 1 } });
  chmodSync(h.dir, 0o500);
  try {
    h.ledger.add({ actor: bot1, sessionId: "s1", initiator: routine, cumulativeUsd: 1.5, fresh: true });
  } finally {
    chmodSync(h.dir, 0o700);
  }
  expect(h.ledger.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });
  expect(h.logs.filter((l) => l.startsWith("usage: could not append"))).toHaveLength(1);
  expect(h.logs.find((l) => l.startsWith("usage: could not append"))).toContain("EACCES");
  expect(readdirSync(h.dir)).toEqual([]);

  h.ledger.add({ actor: bot1, sessionId: "s1", initiator: routine, cumulativeUsd: 2 });
  expect(rowsIn(h.dir).map((r) => r.deltaUsd)).toEqual([0.5]);
});

test("budgetLeft is the agent's budget minus its lifetime spend, and a spent agent is held even when attended", () => {
  withEnv("CLAUDIOBOT_AGENT_USD", undefined, () => {
    const { ledger } = harness({ budgets: { a1: 2 }, caps: { b1: 100 } });
    expect(ledger.budgetLeft(A1)).toBe(2);
    expect(ledger.budgetLeft(A2)).toBe(DEFAULT_AGENT_BUDGET_USD);
    spend(ledger, agent1, 0.5);
    expect(ledger.budgetLeft(A1)).toBeCloseTo(1.5, 9);
    expect(ledger.headroom(agent1, user)).toEqual({ ok: true, capReached: false });
    spend(ledger, agent1, 1.75);
    expect(ledger.budgetLeft(A1)).toBe(0);
    expect(ledger.headroom(agent1, user)).toEqual({ ok: false, reason: "agent_budget" });
    expect(ledger.headroom(agent2, user)).toEqual({ ok: true, capReached: false });
    expect(ledger.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
  });
  withEnv("CLAUDIOBOT_AGENT_USD", "1", () => expect(harness().ledger.budgetLeft(A2)).toBe(1));
});

test("rows rotate into the next month file and a session's baseline carries across", () => {
  const { dir, clock, ledger } = harness();
  clock.now = local(2026, 10, 31, 23, 0);
  ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: 3 });
  clock.now = local(2026, 11, 1, 1, 0);
  ledger.add({ actor: bot1, sessionId: "s1", initiator: user, cumulativeUsd: 3.5 });
  expect(readdirSync(dir).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
  expect(rowsIn(dir).map((r) => r.deltaUsd)).toEqual([0, 0.5]);
});

test("after a restart, an agent's spend from months ago still counts and an old session keeps its baseline", () => {
  const h = harness({ budgets: { a1: 3 } });
  h.clock.now = local(2026, 5, 10);
  h.ledger.add({ actor: agent1, sessionId: "s_old", initiator: user, cumulativeUsd: 1 });
  h.ledger.add({ actor: agent1, sessionId: "s_old", initiator: user, cumulativeUsd: 2 });
  h.clock.now = local(2026, 10, 17);
  spend(h.ledger, agent1, 0.5);

  const after = h.reopen();
  expect(readdirSync(h.dir).sort()).toEqual(["2026-05.jsonl", "2026-10.jsonl"]);
  expect(after.budgetLeft(A1)).toBeCloseTo(1.5, 9);
  after.add({ actor: agent1, sessionId: "s_old", initiator: user, cumulativeUsd: 2.25 });
  expect(rowsIn(h.dir).at(-1)!.deltaUsd).toBeCloseTo(0.25, 9);
});

test("a torn last line is skipped on read and the next row starts on its own line", () => {
  const h = harness({ caps: { b1: 1 } });
  spend(h.ledger, bot1, 0.75, routine);
  const file = join(h.dir, "2026-10.jsonl");
  appendFileSync(file, '{"at":"2026-10-17T10:00:00.000Z","actor":"bot:b1","botId":"b1","sess');

  const after = h.reopen();
  expect(h.logs.some((l) => l.includes("unreadable line"))).toBe(true);
  expect(after.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
  spend(after, bot1, 0.25, routine);
  expect(after.headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });

  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
  expect(lines).toHaveLength(3);
  expect(rowsIn(h.dir)).toHaveLength(2);
  expect(h.reopen().headroom(bot1, routine)).toMatchObject({ ok: false, reason: "daily_cap" });
});

test("a missing usage directory is created and starts empty", () => {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-ledger-"));
  dirs.push(root);
  const h = harness({ dir: join(root, "usage") });
  expect(h.ledger.budgetLeft(A1)).toBe(DEFAULT_AGENT_BUDGET_USD);
  expect(h.ledger.headroom(bot1, routine)).toEqual({ ok: true, capReached: false });
});

test("files that are not month files are ignored", () => {
  const h = harness();
  writeFileSync(join(h.dir, "notes.jsonl"), JSON.stringify({ actor: "agent:a1", deltaUsd: 99 }) + "\n");
  expect(h.reopen().budgetLeft(A1)).toBe(DEFAULT_AGENT_BUDGET_USD);
});

test("a rebuild after restart gives the same totals and baselines as the live index", () => {
  const h = harness({ caps: { b1: 2, b2: 2 }, budgets: { a1: 4, a2: 4 } });
  const ops: [Date, Actor, string, Initiator, number, boolean?][] = [
    [local(2026, 9, 28), bot2, "s_z", routine, 0, true],
    [local(2026, 9, 29), agent1, "s_a1", fromBot, 0.5],
    [local(2026, 9, 30), agent1, "s_a1", fromBot, 1.5],
    [local(2026, 10, 16), bot1, "s_b1", routine, 0.2],
    [local(2026, 10, 17, 8), bot1, "s_b1", routine, 0.9],
    [local(2026, 10, 17, 9), agent2, "s_a2", user, 0.4],
    [local(2026, 10, 17, 10), agent2, "s_a2", user, 1.1],
    [local(2026, 10, 17, 11), bot2, "s_b2", routine, 3],
    [local(2026, 10, 17, 12), bot2, "s_b2", routine, 0],
    [local(2026, 10, 17, 13), bot2, "s_b2", routine, 1.2],
    [local(2026, 10, 17, 14), agent1, "s_a1", user, 2.5],
  ];
  for (const [at, actor, sessionId, initiator, cumulativeUsd, fresh] of ops) {
    h.clock.now = at;
    h.ledger.add({ actor, sessionId, initiator, cumulativeUsd, fresh });
  }
  const snapshot = (l: ReturnType<typeof createLedger>) => ({
    a1: l.budgetLeft(A1),
    a2: l.budgetLeft(A2),
    b1: l.headroom(bot1, routine),
    b2: l.headroom(bot2, routine),
    agent1: l.headroom(agent1, routine),
  });
  const live = snapshot(h.ledger);
  const rebuilt = h.reopen();
  expect(snapshot(rebuilt)).toEqual(live);
  expect(live.b1).toMatchObject({ ok: false, reason: "daily_cap" });
  expect(live.b2).toEqual({ ok: true, capReached: false });
  expect(live.a1).toBeCloseTo(4 - 1 - 1, 9);

  for (const l of [h.ledger, rebuilt]) {
    l.add({ actor: bot2, sessionId: "s_b2", initiator: routine, cumulativeUsd: 1.5 });
    l.add({ actor: bot2, sessionId: "s_z", initiator: routine, cumulativeUsd: 0.2 });
  }
  const tail = rowsIn(h.dir).slice(-4).map((r) => r.deltaUsd);
  [0.3, 0.2, 0.3, 0.2].forEach((d, i) => expect(tail[i]).toBeCloseTo(d, 9));
});
