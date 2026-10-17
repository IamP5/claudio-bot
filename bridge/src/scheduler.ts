import type { Tickable } from "./clock";
import { describe, isDue, parseCron } from "./cron";
import type { BotId, Peer, RoutineId, RunId } from "./protocol";
import type { Envelope } from "./prompts";
import { lastRunAt, routinePeer, upsertRoutine, type BotRecord, type RoutineRecord, type RunRef, type World } from "./world";

// Routines: definitions, nextRunAt, run history, fatigue. The only writer of BotRecord.routines. Owner: U4.
//
// U4's body: nextRunAt is advanced before each fire (at most once per due time). An overdue routine fires once if
// it is within the grace window (half its period, clamped to 2 min–2 h) and is marked late, else it records a skipped
// run; however many times were missed while the Mac slept, that is one decision. A parked bot's fire is recorded
// skipped. Run now is a manual run: attended, never quiet. The scaffold body keeps today's minute-matching fire.

export const ROUTINE_FLOOR_MINUTES = 15;
export const ROUTINES_PER_BOT = 20;
export const RUNS_KEPT = 20;
export const DISABLE_AFTER_FAILURES = 10;

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
   */
  settle(botId: BotId, run: RunRef, outcome: RunOutcome): void;
};

export type SchedulerDeps = {
  world: World;
  deliver: (bot: BotRecord, e: Envelope) => void;
  note: (bot: BotRecord, text: string, refs?: Peer[]) => void;
  /** Broadcast and persist the bot after a routine change. */
  changed: (bot: BotRecord) => void;
  /** No turn can start now (usage limit or, for unattended work, the daily cap). */
  parked: (bot: BotRecord) => boolean;
  now: () => Date;
};

const routinesOf = (bot: BotRecord) => bot.routines as unknown as RoutineRecord[];

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { world } = deps;

  function botOf(botId: BotId): BotRecord {
    const bot = world.bots.get(botId);
    if (!bot) throw new Error("This bot no longer exists.");
    return bot;
  }

  return {
    upsert(botId, a) {
      const bot = botOf(botId);
      const cron = parseCron(a.schedule);
      if ("error" in cron) return `Invalid schedule: ${cron.error}`;
      const enabled = a.enabled ?? bot.routines.find((r) => r.name === a.name)?.enabled ?? true;
      const schedule = a.schedule.trim();
      const { routine, created } = upsertRoutine(
        routinesOf(bot),
        { name: a.name, trigger: { kind: "cron", schedule }, prompt: a.prompt, enabled },
        () => `r_${crypto.randomUUID()}` as RoutineId,
      );
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
      const routine = routinesOf(bot).find((r) => r.id === routineId);
      if (!routine) return "Unknown routine";
      routine.enabled = enabled;
      deps.changed(bot);
      return null;
    },

    runNow() {
      throw new Error("not implemented");
    },

    noUpdate: () => "OK. End your turn.",

    settle(botId, run, outcome) {
      const bot = world.bots.get(botId);
      const record = bot && routinesOf(bot).find((r) => r.id === run.routineId)?.runs.find((r) => r.id === run.runId);
      if (!bot || !record) return;
      record.status = outcome.status;
      record.note = outcome.note;
      deps.changed(bot);
    },

    tick(now) {
      for (const bot of world.bots.values()) {
        for (const routine of routinesOf(bot)) {
          if (!isDue({ schedule: routine.trigger.schedule, enabled: routine.enabled, lastRunAt: lastRunAt(routine) }, now)) continue;
          const run = { id: `run_${crypto.randomUUID()}` as RunId, at: now.toISOString(), status: "running" as const, late: false, manual: false, note: null };
          routine.runs = [run, ...routine.runs].slice(0, RUNS_KEPT);
          deps.changed(bot);
          deps.deliver(bot, { from: "routine", name: routine.name, prompt: routine.prompt, run: { routineId: routine.id, runId: run.id }, manual: false, late: false });
        }
      }
    },

    nextDeadline: () => null,
  };
}
