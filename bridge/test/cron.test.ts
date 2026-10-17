import { expect, test } from "bun:test";
import { describe, isDue, matches, parseCron } from "../src/cron";

const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0);
// 2026-10-19 is a Monday.
const monday = (h: number, mi: number) => local(2026, 10, 19, h, mi);

test.each([
  ["0 9 * * *", "Every day at 9:00 AM"],
  ["57 7 * * 1-5", "Weekdays at 7:57 AM"],
  ["1 9 * * 1", "Mondays at 9:01 AM"],
  ["19,49 * * * *", "Every hour at :19 and :49"],
  ["*/15 * * * *", "Every 15 minutes"],
  ["* * * * *", "Every minute"],
  ["30 18 * * 0,6", "Weekends at 6:30 PM"],
  ["0 0 * * *", "Every day at 12:00 AM"],
  ["0 12 * * 1,3,5", "Mondays, Wednesdays and Fridays at 12:00 PM"],
  ["0 9 1 * *", "0 9 1 * *"],
])("describe %s", (schedule, expected) => {
  expect(describe(schedule)).toBe(expected);
});

test.each(["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 7", "*/0 * * * *", "5-1 * * * *", "a * * * *"])(
  "rejects %p",
  (schedule) => {
    expect(parseCron(schedule)).toHaveProperty("error");
  },
);

const cron = (s: string) => {
  const c = parseCron(s);
  if ("error" in c) throw new Error(c.error);
  return c;
};

test("weekday schedule matches Monday at that minute only", () => {
  expect(matches(cron("57 7 * * 1-5"), monday(7, 57))).toBe(true);
  expect(matches(cron("57 7 * * 1-5"), monday(7, 58))).toBe(false);
  expect(matches(cron("57 7 * * 1-5"), local(2026, 10, 18, 7, 57))).toBe(false);
});

test("steps, ranges with steps and lists", () => {
  expect(matches(cron("*/15 * * * *"), monday(10, 45))).toBe(true);
  expect(matches(cron("*/15 * * * *"), monday(10, 46))).toBe(false);
  expect(matches(cron("0 9-17/4 * * *"), monday(13, 0))).toBe(true);
  expect(matches(cron("0 9-17/4 * * *"), monday(15, 0))).toBe(false);
  expect(matches(cron("19,49 * * * *"), monday(3, 49))).toBe(true);
});

test("with both day fields restricted, either one matching is enough", () => {
  expect(matches(cron("0 9 1 * 1"), monday(9, 0))).toBe(true);
  expect(matches(cron("0 9 1 * 1"), local(2026, 10, 1, 9, 0))).toBe(true);
  expect(matches(cron("0 9 1 * 1"), local(2026, 10, 2, 9, 0))).toBe(false);
});

test("a routine is due once per matching minute and never when paused", () => {
  const routine = { schedule: "* * * * *", enabled: true, lastRunAt: null as string | null };
  const now = monday(9, 0);
  expect(isDue(routine, now)).toBe(true);
  routine.lastRunAt = new Date(now.getTime() + 20_000).toISOString();
  expect(isDue(routine, new Date(now.getTime() + 40_000))).toBe(false);
  expect(isDue(routine, monday(9, 1))).toBe(true);
  expect(isDue({ ...routine, enabled: false }, monday(9, 1))).toBe(false);
  expect(isDue({ ...routine, schedule: "nonsense" }, monday(9, 1))).toBe(false);
});
