import type { UsageRead } from "./claudeCode";
import type { Tickable } from "./clock";
import type { PlanUsage } from "./protocol";
import { errorText } from "./text";

// The plan usage the phones see: when to read it, what to keep when a read fails, and when to tell the phones. Every
// deadline is data that tick reads, on the hub's one clock. One read runs at a time.
//
// - The first tick reads, whether or not a phone is connected.
// - While a phone is live: a read every 5 minutes, one 10 s after a turn ends or a rate limit event comes, and retries
//   after a failure at 1, 2, then 5 minutes. With no phone live none of these run; a phone that connects reads then.
// - A phone that connects gets the latest usage at once, and a read starts when the last one began over 60 s ago.
// - A read that fails keeps the last good windows, marked stale. A read that takes over 15 s has failed.
// - The phones hear a read when it changes what they show, or when theirs is over 4 minutes old, so "Updated" stays true.

export const USAGE_REFRESH_MS = 5 * 60_000;
export const USAGE_FRESH_MS = 60_000;
export const USAGE_SETTLE_MS = 10_000;
export const USAGE_TIMEOUT_MS = 15_000;
export const USAGE_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000] as const;
const RESEND_UNCHANGED_MS = 4 * 60_000;

export type UsageMonitor = Tickable & {
  /** A phone connected. The latest usage to send it after its hello, or null before the first read ends. */
  opened(): PlanUsage | null;
  /** A turn ended or a rate limit event came. Reads 10 s later while a phone is live; nudges inside those 10 s join it. */
  nudge(): void;
  /** Reads now, or joins the read in flight, and resolves with the usage once it ends. Pull-to-refresh. */
  refresh(): Promise<PlanUsage>;
};

export type UsageMonitorDeps = {
  /** Throws, or rejects, on a failed read. */
  read: () => Promise<UsageRead>;
  /** A phone is live. */
  watched: () => boolean;
  /** What the phones show changed, or their copy is old. */
  changed: (usage: PlanUsage) => void;
  /** A deadline moved earlier, so the clock should look again. */
  poke: () => void;
  now: () => Date;
  log: (line: string) => void;
};

type Good = Extract<PlanUsage, { state: "ok" }>;
type Flight = { startedAt: number };

const sameAs = (a: PlanUsage, b: PlanUsage) => JSON.stringify({ ...a, fetchedAt: "" }) === JSON.stringify({ ...b, fetchedAt: "" });

/** What the phones see after a read, and the good read kept for a failure after it. */
function afterRead(good: Good | null, outcome: UsageRead | Error, fetchedAt: string): { usage: PlanUsage; good: Good | null } {
  if (outcome instanceof Error) return { usage: good ? { ...good, stale: true } : { state: "unavailable", reason: "failed", fetchedAt }, good };
  if (outcome.state === "unavailable") return { usage: { ...outcome, fetchedAt }, good: null };
  const fresh: Good = { ...outcome, fetchedAt, stale: false };
  return { usage: fresh, good: fresh };
}

export function createUsageMonitor(deps: UsageMonitorDeps): UsageMonitor {
  let flight: Flight | null = null;
  let attemptedAt: number | null = null;
  let settleAt: number | null = null;
  let retryAt: number | null = null;
  let failures = 0;
  let good: Good | null = null;
  let current: PlanUsage | null = null;
  let sent: PlanUsage | null = null;
  let waiting: ((usage: PlanUsage) => void)[] = [];

  function begin(at: number) {
    if (flight) return;
    const mine: Flight = { startedAt: at };
    flight = mine;
    attemptedAt = at;
    settleAt = null;
    retryAt = null;
    let reading: Promise<UsageRead>;
    try {
      reading = deps.read();
    } catch (e) {
      reading = Promise.reject(e);
    }
    reading.then(
      (read) => settle(mine, read),
      (e: unknown) => settle(mine, e instanceof Error ? e : new Error(String(e))),
    );
    deps.poke();
  }

  function settle(mine: Flight, outcome: UsageRead | Error) {
    // A read that timed out was settled already; its late answer changes nothing.
    if (flight !== mine) return;
    flight = null;
    const at = deps.now();
    if (outcome instanceof Error) {
      failures += 1;
      retryAt = at.getTime() + USAGE_BACKOFF_MS[Math.min(failures, USAGE_BACKOFF_MS.length) - 1]!;
      deps.log(`usage: read failed (${failures} in a row): ${errorText(outcome)}`);
    } else {
      failures = 0;
    }
    const next = afterRead(good, outcome, at.toISOString());
    good = next.good;
    current = next.usage;
    const usage = next.usage;
    if (!sent || !sameAs(sent, usage) || (usage.fetchedAt !== sent.fetchedAt && Date.parse(usage.fetchedAt) - Date.parse(sent.fetchedAt) >= RESEND_UNCHANGED_MS)) {
      sent = usage;
      deps.changed(usage);
    }
    const answered = waiting;
    waiting = [];
    for (const resolve of answered) resolve(usage);
    deps.poke();
  }

  return {
    tick(now) {
      const at = now.getTime();
      if (flight && at - flight.startedAt >= USAGE_TIMEOUT_MS) settle(flight, new Error(`the read took over ${USAGE_TIMEOUT_MS / 1000} s`));
      if (flight) return;
      if (attemptedAt === null) return begin(at);
      if (!deps.watched()) {
        settleAt = null;
        return;
      }
      const due = (settleAt !== null && at >= settleAt) || at >= (retryAt ?? attemptedAt + USAGE_REFRESH_MS);
      if (due) begin(at);
    },

    nextDeadline() {
      if (flight) return new Date(flight.startedAt + USAGE_TIMEOUT_MS).toISOString();
      if (attemptedAt === null || !deps.watched()) return null;
      const next = Math.min(settleAt ?? Infinity, retryAt ?? attemptedAt + USAGE_REFRESH_MS);
      return new Date(next).toISOString();
    },

    opened() {
      const at = deps.now().getTime();
      if (attemptedAt === null || at - attemptedAt > USAGE_FRESH_MS) begin(at);
      else deps.poke();
      return current;
    },

    nudge() {
      if (settleAt !== null || !deps.watched()) return;
      settleAt = deps.now().getTime() + USAGE_SETTLE_MS;
      deps.poke();
    },

    refresh() {
      return new Promise((resolve) => {
        waiting.push(resolve);
        begin(deps.now().getTime());
      });
    },
  };
}
