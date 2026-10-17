import type { Tickable } from "./clock";
import { describe, minGapMinutes, nextAfter, parseCron, type Cron } from "./cron";
import type { BotId, Peer, RoutineId, RoutineRun, RunId } from "./protocol";
import type { Envelope } from "./prompts";
import { routinePeer, upsertRoutine, type BotRecord, type RoutineRecord, type RunRef, type Trigger, type World } from "./world";

// Routines: definitions, nextRunAt, run history, fatigue. The only writer of BotRecord.routines. Owner: U4.
//
// nextRunAt is advanced, and the running run recorded, in one urgent persist before the fire is delivered, so a crash
// can lose a fire but never repeat one. However many times were missed while the Mac slept, that is one decision: the
// newest missed time fires once, marked late, if it is inside the grace window (half the period, clamped to 2 min–2 h),
// else one skipped run is recorded. A parked bot's fire is recorded skipped. Run now is a manual run: attended, never
// quiet, runs at the daily cap, and leaves nextRunAt alone. A null nextRunAt (a new, changed or upgraded routine) is
// computed from now at the next tick, never fired for a time before it.

export const ROUTINE_FLOOR_MINUTES = 15;
export const ROUTINES_PER_BOT = 20;
export const RUNS_KEPT = 20;
export const DISABLE_AFTER_FAILURES = 10;

const MIN_GRACE_MS = 2 * 60_000;
const MAX_GRACE_MS = 2 * 60 * 60_000;
/** A fire this far past its time was delayed by sleep or downtime, not by the clock's own latency. */
const LATE_AFTER_MS = 60_000;

/** How a run ended. skipped covers a fire Stop dropped before it ran, with the note saying so. */
export type RunOutcome = { status: "ok" | "quiet" | "failed" | "skipped"; note: string | null };

export type Scheduler = Tickable & {
  /** The set_routine tool. Validates the cron, the 15-minute floor and the 20-per-bot cap. Returns the tool's reply. */
  upsert(botId: BotId, a: { name: string; schedule: string; prompt: string; enabled?: boolean }): string;
  /** The delete_routine tool. Returns the tool's reply. */
  remove(botId: BotId, name: string): string;
  /** The phone's toggle. Re-enabling resets the fail streak and recomputes nextRunAt. Null on success, else the error. */
  setEnabled(botId: BotId, routineId: RoutineId, enabled: boolean): string | null;
  /** Run now from the phone. Null on success, else the error. */
  runNow(botId: BotId, routineId: RoutineId): string | null;
  /** The routine_no_update tool's reply. The turn reader marks the turn quiet from the tool call itself. */
  noUpdate(botId: BotId): string;
  /**
   * The run's outcome, from the hub's turn end. Never called for a deferred turn. failed: note on the first failure
   * after a success, silence after that, and at 10 in a row turn the routine off with a note. ok/quiet reset the streak.
   * skipped (Stop) leaves the streak alone. Only a running run settles, so a repeated call changes nothing.
   */
  settle(botId: BotId, run: RunRef, outcome: RunOutcome): void;
};

export type SchedulerDeps = {
  world: World;
  deliver: (bot: BotRecord, e: Envelope) => void;
  note: (bot: BotRecord, text: string, refs?: Peer[]) => void;
  /** Broadcast and persist the bot after a routine change. "now" must flush synchronously before returning. */
  changed: (bot: BotRecord, urgency?: "now") => void;
  /** No turn of this attendance can start now: the usage limit holds every turn, the daily cap only unattended ones. */
  parked: (bot: BotRecord, attended: boolean) => boolean;
  now: () => Date;
};

/** What the clock owes a routine at `now`. One decision, however many times were missed. */
type Due =
  | { kind: "off" }
  | { kind: "wait" }
  | { kind: "schedule"; next: Date | null }
  | { kind: "fire"; at: Date; late: boolean; next: Date | null }
  | { kind: "miss"; at: Date; next: Date | null };

function cronOf(trigger: Trigger): Cron | null {
  switch (trigger.kind) {
    case "cron": {
      const cron = parseCron(trigger.schedule);
      return "error" in cron ? null : cron;
    }
    default: {
      const unhandled: never = trigger.kind;
      return unhandled;
    }
  }
}

const graceMs = (cron: Cron) => Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, (minGapMinutes(cron) * 60_000) / 2));

function due(r: RoutineRecord, now: Date): Due {
  const cron = r.enabled ? cronOf(r.trigger) : null;
  if (cron === null) return { kind: "off" };
  if (r.nextRunAt === null) return { kind: "schedule", next: nextAfter(cron, now) };
  let at = new Date(r.nextRunAt);
  if (at > now) return { kind: "wait" };
  let next = nextAfter(cron, at);
  while (next !== null && next <= now) {
    at = next;
    next = nextAfter(cron, at);
  }
  const lag = now.getTime() - at.getTime();
  return lag <= graceMs(cron) ? { kind: "fire", at, late: lag > LATE_AFTER_MS, next } : { kind: "miss", at, next };
}

const routinesOf = (bot: BotRecord) => bot.routines as unknown as RoutineRecord[];
const iso = (d: Date | null) => d?.toISOString() ?? null;
const newRunId = () => `run_${crypto.randomUUID()}` as RunId;

function addRun(r: RoutineRecord, run: Omit<RoutineRun, "id">): RoutineRun {
  const recorded = { id: newRunId(), ...run };
  r.runs = [recorded, ...r.runs].slice(0, RUNS_KEPT);
  return recorded;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { world } = deps;
  let booted = false;

  function botOf(botId: BotId): BotRecord {
    const bot = world.bots.get(botId);
    if (!bot) throw new Error("This bot no longer exists.");
    return bot;
  }

  const firstRun = (cron: Cron) => iso(nextAfter(cron, deps.now()));

  function fire(bot: BotRecord, r: RoutineRecord, run: RoutineRun) {
    deps.changed(bot, "now");
    deps.deliver(bot, { from: "routine", name: r.name, prompt: r.prompt, run: { routineId: r.id, runId: run.id }, manual: run.manual, late: run.late });
  }

  /** A run left running by a crash between the fire's persist and its delivery has no envelope that will settle it. */
  function settleOrphans(bot: BotRecord): boolean {
    const queued = new Set(bot.session.pending.flatMap((p) => (p.initiator.kind === "routine" ? [p.initiator.run.runId] : [])));
    let found = false;
    for (const r of routinesOf(bot)) {
      for (const run of r.runs) {
        if (run.status !== "running" || queued.has(run.id)) continue;
        run.status = "skipped";
        run.note = "Interrupted by a restart";
        found = true;
      }
    }
    return found;
  }

  return {
    upsert(botId, a) {
      const bot = botOf(botId);
      const schedule = a.schedule.trim();
      const cron = parseCron(schedule);
      if ("error" in cron) return `Invalid schedule: ${cron.error}`;
      if (minGapMinutes(cron) < ROUTINE_FLOOR_MINUTES) return `Routines can run at most every ${ROUTINE_FLOOR_MINUTES} minutes.`;
      const routines = routinesOf(bot);
      const existing = routines.find((r) => r.name === a.name);
      if (!existing && routines.length >= ROUTINES_PER_BOT) return `A bot can have at most ${ROUTINES_PER_BOT} routines. Delete one first.`;
      const next = firstRun(cron);
      if (next === null) return `Invalid schedule: "${schedule}" never runs.`;
      const enabled = a.enabled ?? existing?.enabled ?? true;
      const reenabled = existing !== undefined && !existing.enabled && enabled;
      const { routine, created } = upsertRoutine(
        routines,
        { name: a.name, trigger: { kind: "cron", schedule }, prompt: a.prompt, enabled },
        () => `r_${crypto.randomUUID()}` as RoutineId,
      );
      routine.nextRunAt = enabled ? next : null;
      if (reenabled) routine.failStreak = 0;
      deps.note(bot, created ? "Created routine {0}" : "Updated routine {0}", [routinePeer(routine)]);
      return `Routine ${routine.name}: ${describe(schedule)}${routine.enabled ? "" : " (paused)"}.`;
    },

    remove(botId, name) {
      const bot = botOf(botId);
      const routines = routinesOf(bot);
      const i = routines.findIndex((r) => r.name === name);
      if (i === -1) return `No routine named ${name}.`;
      routines.splice(i, 1);
      deps.note(bot, `Deleted routine ${name}`);
      return `Deleted ${name}.`;
    },

    setEnabled(botId, routineId, enabled) {
      const bot = botOf(botId);
      const r = routinesOf(bot).find((r) => r.id === routineId);
      if (!r) return "Unknown routine";
      if (r.enabled === enabled) return null;
      r.enabled = enabled;
      if (enabled) r.failStreak = 0;
      const cron = enabled ? cronOf(r.trigger) : null;
      r.nextRunAt = cron === null ? null : firstRun(cron);
      deps.changed(bot);
      return null;
    },

    runNow(botId, routineId) {
      const bot = botOf(botId);
      const r = routinesOf(bot).find((r) => r.id === routineId);
      if (!r) return "Unknown routine";
      if (deps.parked(bot, true)) return "Paused by the usage limit. Try again when it resets.";
      fire(bot, r, addRun(r, { at: deps.now().toISOString(), status: "running", late: false, manual: true, note: null }));
      return null;
    },

    noUpdate: () => "OK. End your turn.",

    settle(botId, ref, outcome) {
      const bot = world.bots.get(botId);
      const r = bot && routinesOf(bot).find((r) => r.id === ref.routineId);
      const run = r?.runs.find((run) => run.id === ref.runId);
      if (!bot || !r || !run || run.status !== "running") return;
      run.status = outcome.status === "quiet" && run.manual ? "ok" : outcome.status;
      run.note = outcome.note;
      switch (run.status) {
        case "ok":
        case "quiet":
          r.failStreak = 0;
          break;
        case "failed":
          r.failStreak += 1;
          if (r.failStreak >= DISABLE_AFTER_FAILURES) {
            r.enabled = false;
            r.nextRunAt = null;
            deps.note(bot, `Turned off {0} after ${DISABLE_AFTER_FAILURES} failures in a row`, [routinePeer(r)]);
          } else if (r.failStreak === 1) {
            deps.note(bot, `Routine {0} failed${outcome.note ? `: ${outcome.note}` : ""}`, [routinePeer(r)]);
          }
          break;
      }
      deps.changed(bot);
    },

    tick(now) {
      const boot = !booted;
      booted = true;
      for (const bot of world.bots.values()) {
        let dirty = boot && settleOrphans(bot);
        for (const r of routinesOf(bot)) {
          const d = due(r, now);
          switch (d.kind) {
            case "off":
            case "wait":
              break;
            case "schedule":
              r.nextRunAt = iso(d.next);
              dirty = true;
              break;
            case "miss":
              r.nextRunAt = iso(d.next);
              addRun(r, { at: d.at.toISOString(), status: "skipped", late: false, manual: false, note: "Missed while the Mac was asleep or the bridge was off" });
              dirty = true;
              break;
            case "fire":
              r.nextRunAt = iso(d.next);
              if (deps.parked(bot, false)) {
                addRun(r, { at: now.toISOString(), status: "skipped", late: d.late, manual: false, note: "Paused by a limit" });
                dirty = true;
              } else {
                fire(bot, r, addRun(r, { at: now.toISOString(), status: "running", late: d.late, manual: false, note: null }));
              }
              break;
          }
        }
        if (dirty) deps.changed(bot);
      }
    },

    nextDeadline() {
      let earliest: string | null = null;
      for (const bot of world.bots.values()) {
        for (const r of bot.routines) {
          if (r.enabled && r.nextRunAt !== null && (earliest === null || r.nextRunAt < earliest)) earliest = r.nextRunAt;
        }
      }
      return earliest;
    },
  };
}
