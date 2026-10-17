import { expect, test } from "bun:test";
import type { BotId, Peer, RoutineId, RunId } from "../src/protocol";
import type { Envelope } from "../src/prompts";
import { createScheduler, DISABLE_AFTER_FAILURES, ROUTINES_PER_BOT, RUNS_KEPT, type RunOutcome } from "../src/scheduler";
import { emptyWorld, newBot, type EnvelopeId, type RoutineRecord, type RunRef } from "../src/world";

// Local wall-clock times. 2026-10-19 is a Monday, away from any DST change.
const local = (d: number, h: number, mi = 0, s = 0) => new Date(2026, 9, d, h, mi, s);
const BOT = "b_eng" as BotId;
type RoutineEnvelope = Extract<Envelope, { from: "routine" }>;

function harness(start: Date) {
  let now = start;
  let limit: "none" | "daily_cap" | "usage_limit" = "none";
  const world = emptyWorld();
  const bot = newBot({ id: BOT, name: "Eng", avatar: { shape: "circle", color: "white" }, at: start.toISOString() });
  world.bots.set(bot.id, bot);
  const delivered: { e: RoutineEnvelope; flushedBefore: RoutineRecord[] | null }[] = [];
  const notes: string[] = [];
  let flushed: RoutineRecord[] | null = null;
  const scheduler = createScheduler({
    world,
    deliver: (_bot, e) => {
      if (e.from !== "routine") throw new Error(`unexpected ${e.from}`);
      delivered.push({ e, flushedBefore: flushed });
    },
    note: (_bot, text, refs: Peer[] = []) => notes.push(text.replace(/\{(\d+)\}/g, (_, i) => refs[Number(i)]?.kind === "routine" ? (refs[Number(i)] as { name: string }).name : "?")),
    changed: (b, urgency) => {
      if (urgency === "now") flushed = structuredClone(b.routines) as RoutineRecord[];
    },
    parked: (_bot, attended) => limit === "usage_limit" || (limit === "daily_cap" && !attended),
    now: () => now,
  });
  const routine = (name: string) => {
    const r = bot.routines.find((r) => r.name === name);
    if (!r) throw new Error(`no routine ${name}`);
    return r;
  };
  const add = (name: string, schedule: string) => {
    const reply = scheduler.upsert(BOT, { name, schedule, prompt: `do ${name}` });
    expect(reply).toStartWith(`Routine ${name}`);
    return routine(name);
  };
  return {
    scheduler,
    bot,
    world,
    delivered,
    notes,
    routine,
    add,
    at(t: Date) {
      now = t;
      scheduler.tick(t);
    },
    setLimit(l: typeof limit) {
      limit = l;
    },
    lastRef(): RunRef {
      const last = delivered.at(-1);
      if (!last) throw new Error("nothing delivered");
      return last.e.run;
    },
  };
}

const settle = (h: ReturnType<typeof harness>, ref: RunRef, status: RunOutcome["status"], note: string | null = null) =>
  h.scheduler.settle(BOT, ref, { status, note });

test("a new routine is scheduled for its next time and fires once when it arrives", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  expect(r.nextRunAt).toBe(local(19, 9).toISOString());
  expect(h.scheduler.nextDeadline()).toBe(local(19, 9).toISOString());

  h.at(local(19, 8, 59, 59));
  expect(h.delivered).toHaveLength(0);

  h.at(local(19, 9));
  h.at(local(19, 9));
  h.at(local(19, 9, 0, 30));
  expect(h.delivered.map((d) => d.e)).toEqual([
    { from: "routine", name: "digest", prompt: "do digest", run: { routineId: r.id, runId: r.runs[0]!.id }, manual: false, late: false },
  ]);
  expect(r.nextRunAt).toBe(local(20, 9).toISOString());
  expect(r.runs.map((run) => [run.status, run.late, run.manual])).toEqual([["running", false, false]]);
});

test("the fire's urgent persist already holds the advanced nextRunAt and the running run when it is delivered", () => {
  const h = harness(local(19, 8, 30));
  h.add("digest", "0 9 * * *");
  h.at(local(19, 9));
  const [fire] = h.delivered;
  const persisted = fire!.flushedBefore?.find((r) => r.name === "digest");
  expect(persisted?.nextRunAt).toBe(local(20, 9).toISOString());
  expect(persisted?.runs[0]).toMatchObject({ id: fire!.e.run.runId, status: "running" });
});

test.each([
  ["daily 7:00, woke 30 min after it", "fire", "0 7 * * *", local(20, 7, 30)],
  ["daily 7:00, woke 1 h 59 min after it (grace clamps to 2 h)", "fire", "0 7 * * *", local(20, 8, 59)],
  ["daily 1:00, woke 6 h 30 min after it", "skip", "0 1 * * *", local(20, 7, 30)],
  ["daily 5:29, woke 2 h 1 min after it", "skip", "29 5 * * *", local(20, 7, 30)],
  ["hourly, woke 10 min after the newest missed time", "fire", "0 * * * *", local(20, 7, 10)],
  ["hourly, woke 40 min after the newest missed time (grace is 30 min)", "skip", "0 * * * *", local(20, 7, 40)],
  ["every 15 min, woke 5 min after the newest missed time", "fire", "*/15 * * * *", local(20, 7, 20)],
  ["every 15 min, woke 10 min after the newest missed time", "skip", "*/15 * * * *", local(20, 7, 25)],
])("after an 8 h sleep, %s: one %s", (_, expected, schedule, wake) => {
  const h = harness(local(19, 23, 30));
  const r = h.add("r", schedule);
  h.at(local(19, 23, 30));
  h.at(wake);

  expect(r.runs).toHaveLength(1);
  const run = r.runs[0]!;
  if (expected === "fire") {
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.e.late).toBe(true);
    expect(run).toMatchObject({ status: "running", late: true, manual: false });
  } else {
    expect(h.delivered).toHaveLength(0);
    expect(run.status).toBe("skipped");
    expect(run.note).toContain("asleep");
  }
  expect(new Date(r.nextRunAt!) > wake).toBe(true);

  h.at(wake);
  expect(r.runs).toHaveLength(1);
});

test.each(["daily_cap", "usage_limit"] as const)("a scheduled fire at the %s is recorded skipped and not delivered", (limit) => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  h.setLimit(limit);
  h.at(local(19, 9));
  expect(h.delivered).toHaveLength(0);
  expect(r.runs[0]).toMatchObject({ status: "skipped", note: "Paused by a limit" });
  expect(r.nextRunAt).toBe(local(20, 9).toISOString());
});

test(`history keeps the newest ${RUNS_KEPT} runs, newest first`, () => {
  const h = harness(local(19, 0, 1));
  const r = h.add("poll", "*/15 * * * *");
  for (let i = 1; i <= 25; i++) {
    h.at(new Date(local(19, 0).getTime() + i * 15 * 60_000));
    settle(h, h.lastRef(), "ok");
  }
  expect(h.delivered).toHaveLength(25);
  expect(r.runs).toHaveLength(RUNS_KEPT);
  expect(r.runs[0]!.id).toBe(h.delivered[24]!.e.run.runId);
  expect(r.runs.at(-1)!.id).toBe(h.delivered[5]!.e.run.runId);
});

test("failures note once after a success, and the tenth in a row turns the routine off", () => {
  const h = harness(local(19, 0, 1));
  const r = h.add("poll", "*/15 * * * *");
  h.notes.length = 0;
  const fireAndSettle = (i: number, status: RunOutcome["status"], note: string | null = null) => {
    h.at(new Date(local(19, 0).getTime() + i * 15 * 60_000));
    settle(h, h.lastRef(), status, note);
  };

  fireAndSettle(1, "failed", "timeout");
  expect(h.notes).toEqual(["Routine poll failed: timeout"]);
  fireAndSettle(2, "ok");
  fireAndSettle(3, "failed", "boom");
  expect(h.notes).toEqual(["Routine poll failed: timeout", "Routine poll failed: boom"]);

  for (let i = 4; i < 2 + DISABLE_AFTER_FAILURES; i++) fireAndSettle(i, "failed");
  expect(h.notes).toHaveLength(2);
  expect(r.enabled).toBe(true);

  fireAndSettle(2 + DISABLE_AFTER_FAILURES, "failed");
  expect(r.enabled).toBe(false);
  expect(r.nextRunAt).toBeNull();
  expect(h.notes.at(-1)).toBe(`Turned off poll after ${DISABLE_AFTER_FAILURES} failures in a row`);

  const fired = h.delivered.length;
  h.at(local(19, 23));
  expect(h.delivered).toHaveLength(fired);
});

test("re-enabling resets the fail streak and schedules from now without catching up", () => {
  const h = harness(local(19, 0, 1));
  const r = h.add("poll", "*/15 * * * *");
  for (let i = 1; i <= DISABLE_AFTER_FAILURES; i++) {
    h.at(new Date(local(19, 0).getTime() + i * 15 * 60_000));
    settle(h, h.lastRef(), "failed");
  }
  expect(r.enabled).toBe(false);

  h.at(local(19, 12, 5));
  expect(h.scheduler.setEnabled(BOT, r.id, true)).toBeNull();
  expect(r.nextRunAt).toBe(local(19, 12, 15).toISOString());
  h.notes.length = 0;

  h.at(local(19, 12, 15));
  settle(h, h.lastRef(), "failed", "again");
  expect(r.enabled).toBe(true);
  expect(h.notes).toEqual(["Routine poll failed: again"]);
});

test("a stopped run settles skipped and neither counts as a failure nor resets the streak", () => {
  const h = harness(local(19, 0, 1));
  const r = h.add("poll", "*/15 * * * *");
  let i = 0;
  const fireAndSettle = (status: RunOutcome["status"], note: string | null = null) => {
    i += 1;
    h.at(new Date(local(19, 0).getTime() + i * 15 * 60_000));
    settle(h, h.lastRef(), status, note);
  };
  for (let n = 1; n < DISABLE_AFTER_FAILURES; n++) fireAndSettle("failed");
  h.notes.length = 0;

  fireAndSettle("skipped", "Stopped by Alex");
  expect(r.runs[0]).toMatchObject({ status: "skipped", note: "Stopped by Alex" });
  expect(r.enabled).toBe(true);
  expect(h.notes).toEqual([]);

  fireAndSettle("failed");
  expect(r.enabled).toBe(false);
});

test("settle applies once: a repeated or late settle of the same run changes nothing", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  h.at(local(19, 9));
  const ref = h.lastRef();
  settle(h, ref, "ok");
  settle(h, ref, "failed", "late duplicate");
  expect(r.runs[0]).toMatchObject({ status: "ok", note: null });
  settle(h, { routineId: r.id, runId: "run_unknown" as RunId }, "failed");
  expect(r.runs).toHaveLength(1);
});

test("quiet settles a scheduled run quiet and resets the streak", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  h.at(local(19, 9));
  settle(h, h.lastRef(), "failed");
  h.at(local(20, 9));
  settle(h, h.lastRef(), "quiet");
  expect(r.runs.map((run) => run.status)).toEqual(["quiet", "failed"]);
  h.notes.length = 0;
  h.at(local(21, 9));
  settle(h, h.lastRef(), "failed");
  expect(h.notes).toEqual(["Routine digest failed"]);
  expect(h.scheduler.noUpdate(BOT)).toBe("OK. End your turn.");
});

test("run now delivers a manual run that never settles quiet and leaves the schedule alone", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  expect(h.scheduler.runNow(BOT, r.id)).toBeNull();
  expect(h.delivered.map((d) => [d.e.manual, d.e.late])).toEqual([[true, false]]);
  expect(h.delivered[0]!.flushedBefore?.[0]?.runs[0]).toMatchObject({ status: "running", manual: true });
  expect(r.nextRunAt).toBe(local(19, 9).toISOString());

  settle(h, h.lastRef(), "quiet");
  expect(r.runs[0]).toMatchObject({ status: "ok", manual: true });
  expect(h.scheduler.runNow(BOT, "r_missing" as RoutineId)).toBe("Unknown routine");
});

test.each([
  ["*/10 * * * *", "at most every 15 minutes"],
  ["0,5 9 * * *", "at most every 15 minutes"],
  ["* * * * *", "at most every 15 minutes"],
  ["0 0 31 2 *", "never runs"],
  ["0 25 * * *", "Invalid schedule"],
])("upsert refuses %s", (schedule, reason) => {
  const h = harness(local(19, 8));
  expect(h.scheduler.upsert(BOT, { name: "r", schedule, prompt: "p" })).toContain(reason);
  expect(h.bot.routines).toHaveLength(0);
});

test(`upsert accepts the 15-minute floor and caps a bot at ${ROUTINES_PER_BOT} routines`, () => {
  const h = harness(local(19, 8));
  for (let i = 0; i < ROUTINES_PER_BOT; i++) h.add(`r${i}`, "*/15 * * * *");
  expect(h.scheduler.upsert(BOT, { name: "one more", schedule: "0 9 * * *", prompt: "p" })).toContain(`at most ${ROUTINES_PER_BOT} routines`);
  expect(h.bot.routines).toHaveLength(ROUTINES_PER_BOT);
  expect(h.scheduler.upsert(BOT, { name: "r3", schedule: "0 9 * * *", prompt: "new" })).toStartWith("Routine r3: Every day at 9:00 AM");
  expect(h.routine("r3").nextRunAt).toBe(local(19, 9).toISOString());
});

test("pausing clears the next run and nothing fires until it is enabled again", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  expect(h.scheduler.setEnabled(BOT, r.id, false)).toBeNull();
  expect(r.nextRunAt).toBeNull();
  expect(h.scheduler.nextDeadline()).toBeNull();
  h.at(local(19, 9));
  expect(h.delivered).toHaveLength(0);
  expect(h.scheduler.setEnabled(BOT, "r_missing" as RoutineId, true)).toBe("Unknown routine");
});

test("nextDeadline is the earliest enabled routine across bots", () => {
  const h = harness(local(19, 8, 30));
  h.add("late", "0 18 * * *");
  h.add("soon", "45 8 * * *");
  const other = newBot({ id: "b_other" as BotId, name: "Other", avatar: { shape: "circle", color: "white" }, at: local(19, 8).toISOString() });
  h.world.bots.set(other.id, other);
  h.scheduler.upsert(other.id, { name: "sooner", schedule: "40 8 * * *", prompt: "p" });
  expect(h.scheduler.nextDeadline()).toBe(local(19, 8, 40).toISOString());
});

test("a routine loaded without nextRunAt is scheduled from now at the first tick, not fired", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  (r as RoutineRecord).nextRunAt = null;
  h.at(local(19, 10));
  expect(h.delivered).toHaveLength(0);
  expect(r.nextRunAt).toBe(local(20, 9).toISOString());
});

test("the first tick settles a run a crash left running unless its envelope is still queued", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *") as RoutineRecord;
  const run = (id: string) => ({ id: id as RunId, at: local(19, 8).toISOString(), status: "running" as const, late: false, manual: false, note: null });
  r.runs = [run("run_queued"), run("run_orphan")];
  const pending = h.bot.session.pending as unknown as { id: EnvelopeId; at: string; text: string; initiator: unknown; attempts: number }[];
  pending.push({ id: "e1" as EnvelopeId, at: local(19, 8).toISOString(), text: "", initiator: { kind: "routine", run: { routineId: r.id, runId: "run_queued" }, manual: false }, attempts: 0 });

  h.at(local(19, 8, 31));
  expect(r.runs.map((x) => [x.id as string, x.status as string])).toEqual([
    ["run_queued", "running"],
    ["run_orphan", "skipped"],
  ]);
});

test("run now is attended: it runs at the daily cap and is refused under the usage limit", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  h.setLimit("daily_cap");
  expect(h.scheduler.runNow(BOT, r.id)).toBeNull();
  expect(h.delivered.map((d) => d.e.manual)).toEqual([true]);

  h.setLimit("usage_limit");
  expect(h.scheduler.runNow(BOT, r.id)).toContain("usage limit");
  expect(h.delivered).toHaveLength(1);
  expect(r.runs).toHaveLength(1);
});

test("changing a routine's schedule or re-enabling it through set_routine recomputes nextRunAt from now", () => {
  const h = harness(local(19, 8, 30));
  const r = h.add("digest", "0 9 * * *");
  h.scheduler.upsert(BOT, { name: "digest", schedule: "0 10 * * *", prompt: "p" });
  expect(r.nextRunAt).toBe(local(19, 10).toISOString());
  h.scheduler.upsert(BOT, { name: "digest", schedule: "0 10 * * *", prompt: "p", enabled: false });
  expect(r.nextRunAt).toBeNull();
  h.at(local(19, 11));
  h.scheduler.upsert(BOT, { name: "digest", schedule: "0 10 * * *", prompt: "p", enabled: true });
  expect(r.nextRunAt).toBe(local(20, 10).toISOString());
  expect(h.delivered).toHaveLength(0);
});
