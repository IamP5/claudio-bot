import { expect, test } from "bun:test";
import type { UsageRead } from "../src/claudeCode";
import type { PlanUsage } from "../src/protocol";
import { createUsageMonitor, USAGE_BACKOFF_MS, USAGE_REFRESH_MS, USAGE_SETTLE_MS, USAGE_TIMEOUT_MS } from "../src/usage";

const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 0));

const session = (utilization: number): UsageRead => ({
  state: "ok",
  plan: "max",
  windows: [{ id: "session", kind: "session", label: "Current session", utilization, resetsAt: "2026-10-18T15:00:00.000Z", severity: "normal" }],
});

/** A monitor over a fake read whose answers the test hands out one by one. */
function harness(opts: { watched?: boolean } = {}) {
  const clock = { t: T0 };
  const state = { watched: opts.watched ?? true };
  const pending: { resolve: (r: UsageRead) => void; reject: (e: Error) => void }[] = [];
  const sent: PlanUsage[] = [];
  const logs: string[] = [];
  let reads = 0;
  const monitor = createUsageMonitor({
    read: () => {
      reads++;
      return new Promise<UsageRead>((resolve, reject) => pending.push({ resolve, reject }));
    },
    watched: () => state.watched,
    changed: (u) => sent.push(u),
    poke: () => {},
    now: () => new Date(clock.t),
    log: (l) => logs.push(l),
  });
  const tick = () => monitor.tick(new Date(clock.t));
  const answer = async (r: UsageRead | Error) => {
    await flush();
    const p = pending.shift()!;
    if (r instanceof Error) p.reject(r);
    else p.resolve(r);
    await flush();
  };
  const at = (ms: number) => {
    clock.t = T0 + ms;
    tick();
  };
  return { monitor, clock, state, sent, logs, tick, answer, at, reads: () => reads };
}

test("the first tick reads even with no phone, and the phones hear it once with when it was read", async () => {
  const h = harness({ watched: false });
  h.tick();
  h.tick();
  expect(h.reads()).toBe(1);
  h.clock.t = T0 + 700;
  await h.answer(session(0.37));
  expect(h.sent).toEqual([{ ...session(0.37), fetchedAt: "2026-10-18T12:00:00.700Z", stale: false } as PlanUsage]);
  expect(h.monitor.nextDeadline()).toBeNull();
});

test("while a phone is live it reads every 5 minutes, and with none it stops", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.1));
  expect(h.monitor.nextDeadline()).toBe(new Date(T0 + USAGE_REFRESH_MS).toISOString());
  h.at(USAGE_REFRESH_MS - 1);
  expect(h.reads()).toBe(1);
  h.at(USAGE_REFRESH_MS);
  expect(h.reads()).toBe(2);
  await h.answer(session(0.2));
  h.state.watched = false;
  h.at(3 * USAGE_REFRESH_MS);
  expect([h.reads(), h.monitor.nextDeadline()]).toEqual([2, null]);
});

test("one read runs at a time: ticks, nudges, connects and refreshes during a read start no other", async () => {
  const h = harness();
  h.tick();
  h.monitor.nudge();
  h.monitor.opened();
  const refreshed = h.monitor.refresh();
  h.at(USAGE_TIMEOUT_MS - 1);
  expect(h.reads()).toBe(1);
  await h.answer(session(0.4));
  expect((await refreshed).state).toBe("ok");
});

test("a turn's nudge reads 10 s later, and nudges inside those 10 s join it", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.1));
  h.at(1_000);
  h.monitor.nudge();
  h.at(5_000);
  h.monitor.nudge();
  expect(h.monitor.nextDeadline()).toBe(new Date(T0 + 1_000 + USAGE_SETTLE_MS).toISOString());
  h.at(1_000 + USAGE_SETTLE_MS - 1);
  expect(h.reads()).toBe(1);
  h.at(1_000 + USAGE_SETTLE_MS);
  expect(h.reads()).toBe(2);
});

test("with no phone live a nudge reads nothing", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.1));
  h.state.watched = false;
  h.monitor.nudge();
  h.at(USAGE_SETTLE_MS * 3);
  expect(h.reads()).toBe(1);
});

test("a phone that connects gets the latest at once and reads again only when the last read began over 60 s ago", async () => {
  const h = harness({ watched: false });
  expect(h.monitor.opened()).toBeNull();
  expect(h.reads()).toBe(1);
  await h.answer(session(0.3));
  h.clock.t = T0 + 60_000;
  expect(h.monitor.opened()).toMatchObject({ state: "ok", windows: [{ utilization: 0.3 }] });
  expect(h.reads()).toBe(1);
  h.clock.t = T0 + 60_001;
  expect(h.monitor.opened()).toMatchObject({ state: "ok", windows: [{ utilization: 0.3 }] });
  expect(h.reads()).toBe(2);
});

test("a failed read keeps the last good windows marked stale, says so once, and retries at 1, 2, then 5 minutes", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.5));
  h.at(USAGE_REFRESH_MS);
  await h.answer(new Error("Claude Code exited"));
  expect(h.sent.map((u) => u.state === "ok" && [u.stale, u.fetchedAt])).toEqual([
    [false, "2026-10-18T12:00:00.000Z"],
    [true, "2026-10-18T12:00:00.000Z"],
  ]);
  expect(h.logs).toEqual(["usage: read failed (1 in a row): Claude Code exited"]);
  let failedAt = USAGE_REFRESH_MS;
  for (const backoff of USAGE_BACKOFF_MS.slice(0, 2)) {
    h.at(failedAt + backoff - 1);
    const before = h.reads();
    h.at(failedAt + backoff);
    expect(h.reads()).toBe(before + 1);
    failedAt += backoff;
    await h.answer(new Error("again"));
  }
  expect(h.monitor.nextDeadline()).toBe(new Date(T0 + failedAt + USAGE_BACKOFF_MS[2]).toISOString());
  expect(h.sent).toHaveLength(2);
  h.at(failedAt + USAGE_BACKOFF_MS[2]);
  await h.answer(session(0.5));
  expect(h.sent.at(-1)).toMatchObject({ stale: false, windows: [{ utilization: 0.5 }] });
});

test("with no good read yet a failure shows as unavailable, failed", async () => {
  const h = harness();
  h.tick();
  await h.answer(new Error("nope"));
  expect(h.sent).toEqual([{ state: "unavailable", reason: "failed", fetchedAt: "2026-10-18T12:00:00.000Z" }]);
});

test("a read that takes over 15 s has failed, and its late answer is dropped", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.2));
  h.at(USAGE_REFRESH_MS);
  expect(h.monitor.nextDeadline()).toBe(new Date(T0 + USAGE_REFRESH_MS + USAGE_TIMEOUT_MS).toISOString());
  h.at(USAGE_REFRESH_MS + USAGE_TIMEOUT_MS);
  expect(h.sent.at(-1)).toMatchObject({ state: "ok", stale: true });
  await h.answer(session(0.9));
  expect(h.sent.at(-1)).toMatchObject({ stale: true, windows: [{ utilization: 0.2 }] });
  expect(h.logs).toEqual(["usage: read failed (1 in a row): the read took over 15 s"]);
});

test("an unchanged read is not sent again until the phones' copy is over 4 minutes old", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.2));
  h.at(30_000);
  h.monitor.nudge();
  h.at(30_000 + USAGE_SETTLE_MS);
  await h.answer(session(0.2));
  expect(h.sent).toHaveLength(1);
  h.at(30_000 + USAGE_SETTLE_MS + USAGE_REFRESH_MS);
  await h.answer(session(0.2));
  expect(h.sent.map((u) => u.fetchedAt)).toEqual(["2026-10-18T12:00:00.000Z", "2026-10-18T12:05:40.000Z"]);
});

test("a login with no plan limits is shown as unavailable with its reason, and drops the windows it had", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.2));
  h.at(USAGE_REFRESH_MS);
  await h.answer({ state: "unavailable", reason: "logged_out" });
  h.at(2 * USAGE_REFRESH_MS);
  await h.answer(new Error("down"));
  expect(h.sent.slice(1)).toEqual([
    { state: "unavailable", reason: "logged_out", fetchedAt: "2026-10-18T12:05:00.000Z" },
    { state: "unavailable", reason: "failed", fetchedAt: "2026-10-18T12:10:00.000Z" },
  ]);
});

test("refresh reads now and resolves with the result, also when the read fails", async () => {
  const h = harness();
  h.tick();
  await h.answer(session(0.2));
  h.clock.t = T0 + 5_000;
  const ok = h.monitor.refresh();
  await h.answer(session(0.25));
  expect(await ok).toMatchObject({ windows: [{ utilization: 0.25 }], fetchedAt: "2026-10-18T12:00:05.000Z" });
  const failed = h.monitor.refresh();
  await h.answer(new Error("x"));
  expect(await failed).toMatchObject({ stale: true, windows: [{ utilization: 0.25 }] });
});

test("a read that throws before it starts counts as a failed read", async () => {
  const sent: PlanUsage[] = [];
  const monitor = createUsageMonitor({
    read: () => {
      throw new Error("no claude");
    },
    watched: () => true,
    changed: (u) => sent.push(u),
    poke: () => {},
    now: () => new Date(T0),
    log: () => {},
  });
  monitor.tick(new Date(T0));
  await flush();
  expect(sent).toEqual([{ state: "unavailable", reason: "failed", fetchedAt: "2026-10-18T12:00:00.000Z" }]);
});
