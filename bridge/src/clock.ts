// The one clock. Every timed thing is a deadline stored as data by the module that owns it: card reminder and expiry,
// grant expiry, backoff end, park end, stop deadline, routine nextRunAt. The clock only decides when to look.
// Catch-up after a sleep and after a restart is the same path: a late look sees every overdue deadline at once. There is
// no power-event hook, so a wake is noticed at the next look, at most MAX_SLEEP_MS later.
// Owner: U4.

/** A module with stored deadlines. */
export type Tickable = {
  /** Handle everything due at or before `now`. Level-triggered: a second call at the same `now` changes nothing. */
  tick(now: Date): void;
  /** The earliest stored deadline still ahead, as an ISO string, or null when there is none. */
  nextDeadline(): string | null;
  /**
   * The machine slept: `gapMs` of wall-clock time passed unobserved, between two looks more than 2x the max sleep apart.
   * Called before `tick`, so a module can push deadlines it should not count against the sleep (an unseen card) forward
   * by the gap, and they survive the tick that follows.
   */
  wake?(gapMs: number): void;
};

export type Clock = {
  /** Ticks every Tickable now, then again at the earliest deadline any reports, never more than 60 s apart. */
  start(): void;
  /** A deadline may have moved earlier (a card opened, a routine changed): re-arm for the earliest one. Cheap and idempotent. */
  poke(): void;
  stop(): void;
};

export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const MAX_SLEEP_MS = 60_000;
/** A deadline still overdue right after a tick is a ticker that cannot handle it yet; looking again at once would spin. */
export const RETRY_OVERDUE_MS = 1_000;

const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createClock(deps: {
  tickers: readonly Tickable[];
  now?: () => Date;
  timers?: Timers;
  log?: (line: string) => void;
}): Clock {
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? systemTimers;
  const log = deps.log ?? ((line) => console.error(line));
  let running = false;
  let timer: unknown = null;
  let lastLookMs: number | null = null;
  let lastDelay = 0;

  function guarded<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch (error) {
      log(`clock: a ticker threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return null;
    }
  }

  function delayToNext(): number {
    const at = now().getTime();
    let earliest: number | null = null;
    for (const t of deps.tickers) {
      const deadline = guarded(() => t.nextDeadline());
      if (deadline === null) continue;
      const ms = Date.parse(deadline);
      if (!Number.isNaN(ms) && (earliest === null || ms < earliest)) earliest = ms;
    }
    if (earliest === null) return MAX_SLEEP_MS;
    if (earliest <= at) return RETRY_OVERDUE_MS;
    return Math.min(earliest - at, MAX_SLEEP_MS);
  }

  function arm(ms: number) {
    if (timer !== null) timers.clear(timer);
    lastDelay = ms;
    timer = timers.set(look, ms);
  }

  // A fire that comes hours late because the Mac slept takes this same path: one tick sees everything overdue. When the
  // look is more than 2x the max sleep later than the one before it, the gap is reported to the tickers before the tick,
  // so a module can carry deadlines it should not count against the sleep (an unseen card) forward and keep them alive.
  function look() {
    timer = null;
    if (!running) return;
    try {
      const at = now();
      const atMs = at.getTime();
      if (lastLookMs !== null && atMs - lastLookMs > 2 * MAX_SLEEP_MS) {
        const gap = atMs - lastLookMs - lastDelay;
        if (gap > 0) for (const t of deps.tickers) guarded(() => t.wake?.(gap));
      }
      lastLookMs = atMs;
      for (const t of deps.tickers) guarded(() => t.tick(at));
    } finally {
      if (running) arm(delayToNext());
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      look();
    },
    poke() {
      if (running) arm(delayToNext());
    },
    stop() {
      running = false;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
}
