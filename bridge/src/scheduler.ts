import type { Tickable } from "./clock";
import { describe, minGapMinutes, nextAfter, parseCron, type Cron } from "./cron";
import type { BotId, Peer, RoutineId, RoutineRun, RunId } from "./protocol";
import type { Envelope } from "./prompts";
import { own, routinePeer, upsertRoutine, type BotRecord, type RoutineRecord, type RunRef, type Trigger, type World } from "./world";

// Routines: definitions, nextRunAt, run history, fatigue. The only writer of BotRecord.routines.
//
// nextRunAt is advanced, and the running run recorded, in one urgent persist before the fire is delivered, so a crash
// can lose a fire but never repeat one. However many times were missed while the Mac slept, that is one decision: the
// newest missed time fires once, marked late, if it is inside the grace window (half the period, clamped to 2 min–2 h),
// else one skipped run is recorded at the first missed time. A fire is recorded skipped while the bot is parked or the
// routine's previous run is still queued. Run now is a manual run: attended, never quiet, runs at the daily cap, skips
// the overlap check, leaves nextRunAt alone, and its failures never count toward turning the routine off. A null
// nextRunAt (a new, changed or upgraded routine) is computed from now at the next tick, never fired for a time before
// it. An enabled routine whose schedule cannot run (unparsable, or under the 15-minute floor after the v2 upgrade) is
// turned off with a note at the next tick; editing its schedule turns it back on.
//
// The clock has no power-event hook: it notices a wake at its next look, at most 60 s later, so a fire due during
// sleep is up to a minute later than the wake.

const ROUTINE_FLOOR_MINUTES = 15;
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
  /** The set_routine tool with trigger webhook: no schedule, no nextRunAt; the routine-per-bot cap applies. */
  upsertHook(botId: BotId, a: { name: string; prompt: string; enabled?: boolean }): string;
  /** Stores the sha256 of a new webhook token on the routine. Null on success, else the error. */
  setHookToken(botId: BotId, routineId: RoutineId, tokenHash: string): string | null;
  /**
   * A webhook call that presented a valid token: one fire, persisted before delivery like a cron fire, with the payload
   * as data. Null when it fired. refused: the routine cannot run now (unknown, paused, still running, parked); failed: the
   * run was recorded but could not start.
   */
  hook(botId: BotId, routineId: RoutineId, payload: string): HookRefusal | null;
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
   * skipped (Stop) and a failed Run now leave the streak alone; the latter is always noted. Only a running run settles,
   * so a repeated call changes nothing.
   */
  settle(botId: BotId, run: RunRef, outcome: RunOutcome): void;
};

export type HookRefusal = { kind: "refused" | "failed"; why: string };

export type SchedulerDeps = {
  world: World;
  /** Defaults to stderr. */
  log?: (line: string) => void;
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
  | { kind: "refuse"; why: string }
  | { kind: "wait" }
  | { kind: "schedule"; next: Date | null }
  | { kind: "fire"; at: Date; late: boolean; next: Date | null }
  | { kind: "miss"; at: Date; next: Date | null };

/** A trigger the scheduler can run, or why it cannot (as the end of a sentence). onDemand: only a call fires it. */
type Plan = { cron: Cron; graceMs: number } | { refused: string } | { onDemand: true };

function planOf(trigger: Trigger): Plan {
  switch (trigger.kind) {
    case "cron": {
      const cron = parseCron(trigger.schedule);
      if ("error" in cron) return { refused: `its schedule "${trigger.schedule}" is invalid: ${cron.error}` };
      const gap = minGapMinutes(cron);
      if (gap < ROUTINE_FLOOR_MINUTES) return { refused: `it runs more often than every ${ROUTINE_FLOOR_MINUTES} minutes, which routines no longer allow` };
      return { cron, graceMs: Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, (gap * 60_000) / 2)) };
    }
    case "webhook":
      return { onDemand: true };
  }
}

function due(r: RoutineRecord, now: Date): Due {
  if (!r.enabled) return { kind: "off" };
  const plan = planOf(r.trigger);
  if ("refused" in plan) return { kind: "refuse", why: plan.refused };
  if ("onDemand" in plan) return { kind: "wait" };
  const { cron } = plan;
  if (r.nextRunAt === null) return { kind: "schedule", next: nextAfter(cron, now) };
  const first = new Date(r.nextRunAt);
  if (first > now) return { kind: "wait" };
  // Times older than the widest grace can only be missed, so the walk to the newest one starts there, not at `first`.
  const horizon = new Date(now.getTime() - MAX_GRACE_MS - 1);
  let at = first;
  let next = first < horizon ? nextAfter(cron, horizon) : nextAfter(cron, first);
  while (next !== null && next <= now) {
    at = next;
    next = nextAfter(cron, at);
  }
  const lag = now.getTime() - at.getTime();
  return lag <= plan.graceMs ? { kind: "fire", at, late: lag > LATE_AFTER_MS, next } : { kind: "miss", at: first, next };
}

const routinesOf = (bot: BotRecord) => own<RoutineRecord[]>(bot.routines);
const iso = (d: Date | null) => d?.toISOString() ?? null;
const newRunId = () => `run_${crypto.randomUUID()}` as RunId;

function addRun(r: RoutineRecord, run: Omit<RoutineRun, "id">): RoutineRun {
  const recorded = { id: newRunId(), ...run };
  r.runs = [recorded, ...r.runs].slice(0, RUNS_KEPT);
  return recorded;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { world } = deps;
  const log = deps.log ?? ((line) => console.error(line));
  let booted = false;

  function botOf(botId: BotId): BotRecord {
    const bot = world.bots.get(botId);
    if (!bot) throw new Error("This bot no longer exists.");
    return bot;
  }

  const firstRun = (cron: Cron) => iso(nextAfter(cron, deps.now()));

  /** True when the run reached the bot's queue; otherwise it is settled failed. */
  function fire(bot: BotRecord, r: RoutineRecord, run: RoutineRun, payload: string | null): boolean {
    try {
      deps.changed(bot, "now");
      deps.deliver(bot, { from: "routine", name: r.name, prompt: r.prompt, run: { routineId: r.id, runId: run.id }, manual: run.manual, late: run.late, payload });
      return true;
    } catch (error) {
      log(`scheduler: could not start ${r.name} for ${bot.id}: ${message(error)}`);
      try {
        settleRun(bot, r, run, { status: "failed", note: `The bridge could not start it: ${message(error)}` });
      } catch (again) {
        log(`scheduler: could not record the failed start of ${r.name}: ${message(again)}`);
      }
      return false;
    }
  }

  function settleRun(bot: BotRecord, r: RoutineRecord, run: RoutineRun, outcome: RunOutcome) {
    run.status = outcome.status === "quiet" && run.manual ? "ok" : outcome.status;
    run.note = outcome.note;
    switch (run.status) {
      case "ok":
      case "quiet":
        r.failStreak = 0;
        break;
      case "failed":
        if (run.manual) {
          deps.note(bot, `Routine {0} failed${outcome.note ? `: ${outcome.note}` : ""}`, [routinePeer(r)]);
          break;
        }
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
  }

  /** Runs whose own fire is still queued. An approval continuation carries a routine's initiator but settles nothing. */
  const queuedRuns = (bot: BotRecord) => new Set(bot.session.pending.flatMap((p) => (p.settles ? [p.settles.runId] : [])));

  /** A run left running by a crash between the fire's persist and its delivery has no envelope that will settle it. */
  function settleOrphans(bot: BotRecord): boolean {
    const queued = queuedRuns(bot);
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
      const refused = existing !== undefined && !existing.enabled && "refused" in planOf(existing.trigger);
      const enabled = a.enabled ?? (refused || (existing?.enabled ?? true));
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

    upsertHook(botId, a) {
      const bot = botOf(botId);
      const routines = routinesOf(bot);
      const existing = routines.find((r) => r.name === a.name);
      if (!existing && routines.length >= ROUTINES_PER_BOT) return `A bot can have at most ${ROUTINES_PER_BOT} routines. Delete one first.`;
      const tokenHash = existing?.trigger.kind === "webhook" ? existing.trigger.tokenHash : null;
      const refused = existing !== undefined && !existing.enabled && "refused" in planOf(existing.trigger);
      const { routine, created } = upsertRoutine(
        routines,
        { name: a.name, trigger: { kind: "webhook", tokenHash }, prompt: a.prompt, enabled: a.enabled ?? (refused || (existing?.enabled ?? true)) },
        () => `r_${crypto.randomUUID()}` as RoutineId,
      );
      routine.nextRunAt = null;
      deps.note(bot, created ? "Created routine {0}" : "Updated routine {0}", [routinePeer(routine)]);
      const state = routine.enabled ? "" : " (paused)";
      const token = tokenHash === null ? " The user makes its token on the phone, in the routine's screen." : "";
      return `Routine ${routine.name}: when its webhook is called${state}.${token}`;
    },

    setHookToken(botId, routineId, tokenHash) {
      const bot = botOf(botId);
      const r = routinesOf(bot).find((r) => r.id === routineId);
      if (!r) return "Unknown routine";
      if (r.trigger.kind !== "webhook") return "This routine runs on a schedule, not a webhook.";
      const old = r.trigger.tokenHash;
      r.trigger.tokenHash = tokenHash;
      try {
        deps.changed(bot, "now");
        return null;
      } catch (error) {
        r.trigger.tokenHash = old;
        log(`scheduler: could not save the webhook token of ${r.name}: ${message(error)}`);
        return "Could not save the token. Check the bridge log.";
      }
    },

    hook(botId, routineId, payload) {
      const bot = botOf(botId);
      const r = routinesOf(bot).find((r) => r.id === routineId);
      const refused = (why: string): HookRefusal => ({ kind: "refused", why });
      if (!r || r.trigger.kind !== "webhook") return refused("Unknown routine");
      if (!r.enabled) return refused("The routine is paused.");
      const queued = queuedRuns(bot);
      if (r.runs.some((run) => run.status === "running" && queued.has(run.id))) return refused("Its previous run is still going.");
      if (deps.parked(bot, false)) return refused("Paused by a limit. Try again later.");
      const run = addRun(r, { at: deps.now().toISOString(), status: "running", late: false, manual: false, note: null });
      return fire(bot, r, run, payload) ? null : { kind: "failed", why: "Could not start the run. Check the bridge log." };
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
      const plan = planOf(r.trigger);
      if (enabled && "refused" in plan) return `Edit the schedule first: ${plan.refused}.`;
      r.enabled = enabled;
      if (enabled) r.failStreak = 0;
      r.nextRunAt = enabled && "cron" in plan ? firstRun(plan.cron) : null;
      deps.changed(bot);
      return null;
    },

    runNow(botId, routineId) {
      const bot = botOf(botId);
      const r = routinesOf(bot).find((r) => r.id === routineId);
      if (!r) return "Unknown routine";
      if (deps.parked(bot, true)) return "Paused by the usage limit. Try again when it resets.";
      const started = fire(bot, r, addRun(r, { at: deps.now().toISOString(), status: "running", late: false, manual: true, note: null }), null);
      return started ? null : "Could not start the run. Check the bridge log.";
    },

    noUpdate: () => "OK. End your turn.",

    settle(botId, ref, outcome) {
      const bot = world.bots.get(botId);
      const r = bot && routinesOf(bot).find((r) => r.id === ref.routineId);
      const run = r?.runs.find((run) => run.id === ref.runId);
      if (!bot || !r || !run || run.status !== "running") return;
      settleRun(bot, r, run, outcome);
    },

    tick(now) {
      const boot = !booted;
      booted = true;
      for (const bot of world.bots.values()) {
        try {
          tickBot(bot, now, boot);
        } catch (error) {
          log(`scheduler: tick failed for ${bot.id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        }
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

  function tickBot(bot: BotRecord, now: Date, boot: boolean) {
    let dirty = boot && settleOrphans(bot);
    const queued = queuedRuns(bot);
    for (const r of routinesOf(bot)) {
      const d = due(r, now);
      switch (d.kind) {
        case "off":
        case "wait":
          break;
        case "refuse":
          r.enabled = false;
          r.nextRunAt = null;
          deps.note(bot, `Turned off {0}: ${d.why}. Editing its schedule turns it back on.`, [routinePeer(r)]);
          dirty = true;
          break;
        case "schedule":
          if (r.nextRunAt !== iso(d.next)) {
            r.nextRunAt = iso(d.next);
            dirty = true;
          }
          break;
        case "miss":
          r.nextRunAt = iso(d.next);
          addRun(r, { at: d.at.toISOString(), status: "skipped", late: false, manual: false, note: "Missed while the Mac was asleep or the bridge was off" });
          dirty = true;
          break;
        case "fire":
          r.nextRunAt = iso(d.next);
          if (r.runs.some((run) => run.status === "running" && queued.has(run.id))) {
            addRun(r, { at: now.toISOString(), status: "skipped", late: d.late, manual: false, note: "Previous run still going" });
            dirty = true;
          } else if (deps.parked(bot, false)) {
            addRun(r, { at: now.toISOString(), status: "skipped", late: d.late, manual: false, note: "Paused by a limit" });
            dirty = true;
          } else {
            fire(bot, r, addRun(r, { at: now.toISOString(), status: "running", late: d.late, manual: false, note: null }), null);
          }
          break;
      }
    }
    if (dirty) deps.changed(bot);
  }
}
