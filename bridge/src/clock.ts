// The one clock. Every timed thing is a deadline stored as data by the module that owns it: card reminder and expiry,
// grant expiry, backoff end, park end, stop deadline, routine nextRunAt. The clock only decides when to look.
// Catch-up after a sleep and after a restart is the same path: a late look sees every overdue deadline at once.
// Owner: U4.
//
// The scaffold body wakes at the start of every minute and ticks everything, as the bridge always has.

/** A module with stored deadlines. */
export type Tickable = {
  /** Handle everything due at or before `now`. Level-triggered: a second call at the same `now` changes nothing. */
  tick(now: Date): void;
  /** The earliest stored deadline still ahead, as an ISO string, or null when there is none. */
  nextDeadline(): string | null;
};

export type Clock = {
  /** Ticks every Tickable now, then again at the earliest deadline any reports, never more than 60 s apart. */
  start(): void;
  /** A deadline may have moved earlier (a card opened, a routine changed): re-arm. Cheap and idempotent. */
  poke(): void;
  stop(): void;
};

export const MAX_SLEEP_MS = 60_000;

export function createClock(deps: { tickers: readonly Tickable[]; now?: () => Date }): Clock {
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    timer = setTimeout(() => {
      const at = now();
      for (const t of deps.tickers) t.tick(at);
      arm();
    }, MAX_SLEEP_MS - (Date.now() % MAX_SLEEP_MS) + 50);
  };
  return {
    start() {
      if (timer === null) arm();
    },
    poke() {},
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
