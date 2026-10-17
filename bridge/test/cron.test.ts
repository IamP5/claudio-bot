import { expect, test } from "bun:test";
import { describe, matches, minGapMinutes, nextAfter, parseCron } from "../src/cron";

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

const next = (schedule: string, after: Date) => nextAfter(cron(schedule), after);

test.each([
  ["0 9 * * *", local(2026, 10, 19, 8, 59), local(2026, 10, 19, 9, 0)],
  ["0 9 * * *", local(2026, 10, 19, 9, 0), local(2026, 10, 20, 9, 0)],
  ["57 7 * * 1-5", local(2026, 10, 23, 8, 0), local(2026, 10, 26, 7, 57)],
  ["*/15 * * * *", local(2026, 10, 19, 10, 44), local(2026, 10, 19, 10, 45)],
  ["*/15 * * * *", local(2026, 10, 19, 23, 50), local(2026, 10, 20, 0, 0)],
  ["0 0 1 * *", local(2026, 12, 15, 12, 0), local(2027, 1, 1, 0, 0)],
  ["0 9 1 * 1", local(2026, 10, 20, 9, 0), local(2026, 10, 26, 9, 0)],
  ["0 12 29 2 *", local(2026, 10, 19, 0, 0), local(2028, 2, 29, 12, 0)],
  ["0 9 31 * *", local(2026, 11, 1, 0, 0), local(2026, 12, 31, 9, 0)],
])("next run of %s after %s", (schedule, after, expected) => {
  expect(next(schedule, after)).toEqual(expected);
});

test("a time between minutes rounds up to the next matching minute", () => {
  expect(next("30 9 * * *", new Date(2026, 9, 19, 9, 29, 59, 999))).toEqual(local(2026, 10, 19, 9, 30));
  expect(next("30 9 * * *", new Date(2026, 9, 19, 9, 30, 0, 1))).toEqual(local(2026, 10, 20, 9, 30));
});

test("a schedule that never fires has no next run", () => {
  expect(next("0 0 31 2 *", local(2026, 10, 19, 0, 0))).toBeNull();
});

test.each([
  ["*/15 * * * *", 15],
  ["0 * * * *", 60],
  ["0,5 9 * * *", 5],
  ["0 9 * * *", 1440],
  ["57 7 * * 1-5", 1440],
  ["0 9 * * 1", 10080],
  ["59 23 * * *", 1440],
  ["0,59 0,23 * * *", 1],
  ["0 9,21 * * *", 720],
  ["0 12 29 2 *", 1461 * 1440],
  ["0 0 31 2 *", Infinity],
])("smallest gap of %s is %d minutes", (schedule, minutes) => {
  expect(minGapMinutes(cron(schedule))).toBe(minutes);
});

const realZone = process.env.TZ;
const zoned = (zone: string, body: () => void) => () => {
  process.env.TZ = zone;
  try {
    body();
  } finally {
    process.env.TZ = realZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
};
const utc = (s: string) => new Date(s);

// America/New_York: 2026-03-08 02:00 EST jumps to 03:00 EDT; 2026-11-01 02:00 EDT falls back to 01:00 EST.
test(
  "spring forward: a skipped wall-clock time fires once, shifted by the gap, and the day after is unaffected",
  zoned("America/New_York", () => {
    const first = next("30 2 * * *", utc("2026-03-08T05:00:00Z"));
    expect(first).toEqual(utc("2026-03-08T07:30:00Z"));
    expect(next("30 2 * * *", first!)).toEqual(utc("2026-03-09T06:30:00Z"));
    expect(next("0 9 * * *", utc("2026-03-07T15:00:00Z"))).toEqual(utc("2026-03-08T13:00:00Z"));
  }),
);

test(
  "spring forward: hourly runs skip the missing hour without repeating any instant",
  zoned("America/New_York", () => {
    const fires: string[] = [];
    let at = utc("2026-03-08T05:30:00Z");
    for (let i = 0; i < 4; i++) {
      at = next("0 * * * *", at)!;
      fires.push(at.toISOString());
    }
    expect(fires).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z"]);
  }),
);

test(
  "fall back: a repeated wall-clock time fires once, at its first occurrence",
  zoned("America/New_York", () => {
    const first = next("30 1 * * *", utc("2026-11-01T04:00:00Z"));
    expect(first).toEqual(utc("2026-11-01T05:30:00Z"));
    expect(next("30 1 * * *", first!)).toEqual(utc("2026-11-02T06:30:00Z"));
    expect(next("30 1 * * *", utc("2026-11-01T06:10:00Z"))).toEqual(utc("2026-11-02T06:30:00Z"));
  }),
);

test(
  "fall back: a schedule that runs every hour keeps its real-time rhythm through the repeated hour",
  zoned("America/New_York", () => {
    const run = (schedule: string, from: string, count: number) => {
      let at = utc(from);
      const fires: string[] = [];
      for (let i = 0; i < count; i++) {
        at = next(schedule, at)!;
        fires.push(at.toISOString());
      }
      return fires;
    };
    expect(run("*/30 * * * *", "2026-11-01T04:50:00Z", 5)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
    ]);
    expect(run("0 1-3 * * *", "2026-11-01T04:50:00Z", 3)).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
  }),
);
