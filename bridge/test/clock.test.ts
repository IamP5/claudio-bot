import { expect, test } from "bun:test";
import { createClock, MAX_SLEEP_MS, RETRY_OVERDUE_MS, type Tickable, type Timers } from "../src/clock";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

function fakeTimers() {
  let nextId = 0;
  const armed = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers = {
    set(fn, ms) {
      armed.set(++nextId, { fn, ms });
      return nextId;
    },
    clear(handle) {
      armed.delete(handle as number);
    },
  };
  return {
    timers,
    /** The delays of the timers still armed. */
    delays: () => [...armed.values()].map((t) => t.ms),
    fire() {
      const [entry] = [...armed.entries()];
      if (!entry) throw new Error("no timer armed");
      armed.delete(entry[0]);
      entry[1].fn();
    },
  };
}

function ticker(deadline: () => string | null) {
  const ticks: Date[] = [];
  const t: Tickable = { tick: (at) => void ticks.push(at), nextDeadline: deadline };
  return { t, ticks };
}

function setup(tickers: Tickable[], log: string[] = []) {
  let now = T0;
  const fake = fakeTimers();
  const clock = createClock({ tickers, now: () => now, timers: fake.timers, log: (line) => log.push(line) });
  return { clock, fake, setNow: (d: Date) => (now = d) };
}

test("start ticks everything at once, then sleeps until the earliest deadline", () => {
  const a = ticker(() => plus(30_000).toISOString());
  const b = ticker(() => plus(10_000).toISOString());
  const c = ticker(() => null);
  const { clock, fake } = setup([a.t, b.t, c.t]);
  clock.start();
  expect([a.ticks, b.ticks, c.ticks]).toEqual([[T0], [T0], [T0]]);
  expect(fake.delays()).toEqual([10_000]);
  clock.start();
  expect(a.ticks).toHaveLength(1);
  expect(fake.delays()).toEqual([10_000]);
});

test("it never sleeps longer than 60 s, with no deadline or a far one", () => {
  const far = ticker(() => plus(3_600_000).toISOString());
  const none = ticker(() => null);
  for (const t of [far.t, none.t]) {
    const { clock, fake } = setup([t]);
    clock.start();
    expect(fake.delays()).toEqual([MAX_SLEEP_MS]);
  }
});

test("waking ticks every ticker with the current time and re-arms", () => {
  let deadline = plus(10_000).toISOString();
  const a = ticker(() => deadline);
  const { clock, fake, setNow } = setup([a.t]);
  clock.start();
  setNow(plus(10_000));
  deadline = plus(40_000).toISOString();
  fake.fire();
  expect(a.ticks).toEqual([T0, plus(10_000)]);
  expect(fake.delays()).toEqual([30_000]);
});

test("a timer that fires hours late after a sleep ticks everything once with the late time", () => {
  const a = ticker(() => plus(10_000).toISOString());
  const b = ticker(() => null);
  const { clock, fake, setNow } = setup([a.t, b.t]);
  clock.start();
  const wake = plus(8 * 3_600_000);
  setNow(wake);
  fake.fire();
  expect(a.ticks).toEqual([T0, wake]);
  expect(b.ticks).toEqual([T0, wake]);
});

test("poke re-arms for a deadline that moved earlier, replacing the armed timer", () => {
  let deadline: string | null = null;
  const a = ticker(() => deadline);
  const { clock, fake } = setup([a.t]);
  clock.start();
  expect(fake.delays()).toEqual([MAX_SLEEP_MS]);
  deadline = plus(5_000).toISOString();
  clock.poke();
  clock.poke();
  expect(fake.delays()).toEqual([5_000]);
  expect(a.ticks).toHaveLength(1);
});

test("a deadline still overdue after a tick is retried after a second, not in a spin", () => {
  const stuck = ticker(() => plus(-1).toISOString());
  const { clock, fake } = setup([stuck.t]);
  clock.start();
  expect(fake.delays()).toEqual([RETRY_OVERDUE_MS]);
});

test("a throwing ticker is logged and cannot starve the others or stop the clock", () => {
  const log: string[] = [];
  const bad: Tickable = {
    tick: () => {
      throw new Error("tick broke");
    },
    nextDeadline: () => {
      throw new Error("deadline broke");
    },
  };
  const good = ticker(() => plus(20_000).toISOString());
  const { clock, fake } = setup([bad, good.t], log);
  clock.start();
  expect(good.ticks).toEqual([T0]);
  expect(fake.delays()).toEqual([20_000]);
  expect(log.some((l) => l.includes("tick broke"))).toBe(true);
  expect(log.some((l) => l.includes("deadline broke"))).toBe(true);
  fake.fire();
  expect(good.ticks).toHaveLength(2);
});

test("stop disarms, and poke after stop does nothing", () => {
  const a = ticker(() => plus(5_000).toISOString());
  const { clock, fake } = setup([a.t]);
  clock.poke();
  expect(fake.delays()).toEqual([]);
  clock.start();
  clock.stop();
  expect(fake.delays()).toEqual([]);
  clock.poke();
  expect(fake.delays()).toEqual([]);
});
