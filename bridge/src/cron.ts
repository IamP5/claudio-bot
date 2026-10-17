// Five-field cron in local time: minute hour day-of-month month day-of-week (Sunday 0).
// Each field is a list of *, n, a-b, */s or a-b/s.

// star follows Vixie cron: a field starting with "*" (so "*/2" too) is unrestricted for the day-of-month/day-of-week
// OR rule. "0 9 */2 * 1" therefore means odd days that are Mondays, not odd days or Mondays.
type Field = { values: number[]; star: boolean };
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const FIELDS = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 6],
] as const;

function parseField(text: string, name: string, min: number, max: number): Field | string {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return `${name} "${part}" is not a number, range, list or step`;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
    if (step < 1 || from < min || to > max || from > to) return `${name} "${part}" is outside ${min}-${max}`;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values: [...values].sort((a, b) => a - b), star: text.startsWith("*") };
}

export function parseCron(schedule: string): Cron | { error: string } {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return { error: `"${schedule}" needs 5 fields: minute hour day-of-month month day-of-week` };
  const cron: Partial<Cron> = {};
  for (const [i, [name, min, max]] of FIELDS.entries()) {
    const field = parseField(parts[i]!, name, min, max);
    if (typeof field === "string") return { error: field };
    cron[name] = field;
  }
  return cron as Cron;
}

const dayMatches = (cron: Cron, month: number, dom: number, dow: number): boolean => {
  if (!cron.month.values.includes(month)) return false;
  const d = cron.dom.values.includes(dom);
  const w = cron.dow.values.includes(dow);
  // When both day fields are restricted, either one matching is enough.
  return !cron.dom.star && !cron.dow.star ? d || w : d && w;
};

export function matches(cron: Cron, at: Date): boolean {
  return (
    cron.minute.values.includes(at.getMinutes()) &&
    cron.hour.values.includes(at.getHours()) &&
    dayMatches(cron, at.getMonth() + 1, at.getDate(), at.getDay())
  );
}

// Two leap days apart, so a February 29 schedule still has a next run.
const SEARCH_DAYS = 8 * 366;
const DAY_MS = 86_400_000;

/** The same wall-clock time an hour or so later, when a fall-back change makes it happen twice; else null. */
function repeatOf(at: Date): Date | null {
  const shiftMs = (new Date(at.getTime() + 3 * 3_600_000).getTimezoneOffset() - at.getTimezoneOffset()) * 60_000;
  if (shiftMs <= 0) return null;
  const again = new Date(at.getTime() + shiftMs);
  return again.getHours() === at.getHours() && again.getMinutes() === at.getMinutes() ? again : null;
}

/**
 * The first fire strictly after `after`, or null when the schedule never fires. The search walks local wall-clock
 * days and times, as cron does:
 * - A time skipped by a spring-forward change fires once, shifted forward by the gap (2:30 becomes 3:30).
 * - A time repeated by a fall-back change fires once, at its first occurrence, unless the schedule runs every hour,
 *   which keeps its real-time rhythm through the repeated hour.
 */
export function nextAfter(cron: Cron, after: Date): Date | null {
  const everyHour = cron.hour.values.length === 24;
  // UTC is only a calendar here: stepping it by whole days never meets a DST change.
  const first = Date.UTC(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(first + i * DAY_MS);
    if (!dayMatches(cron, day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay())) continue;
    let best: Date | null = null;
    const consider = (at: Date | null) => {
      if (at !== null && at > after && (best === null || at < best)) best = at;
    };
    for (const hour of cron.hour.values) {
      for (const minute of cron.minute.values) {
        const at = new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
        consider(at);
        if (everyHour) consider(repeatOf(at));
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * The smallest wall-clock gap in minutes between two consecutive fires, or Infinity when it fires at most once. Used
 * for the 15-minute floor and the grace window. It ignores DST, so "every day at 9" is 1440. A DST day can undercut the
 * floor once a year: "0,50 1,3 * * *" passes at 50 minutes, but where clocks jump from 2:00 to 3:00, 1:50 to 3:00 is 10.
 */
export function minGapMinutes(cron: Cron): number {
  const times = cron.hour.values.flatMap((h) => cron.minute.values.map((m) => h * 60 + m));
  let gap = Infinity;
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i]! - times[i - 1]!);
  // Every firing day shares the same times, so the gap across days only depends on the closest two firing days.
  const start = Date.UTC(2024, 0, 1);
  let previous: number | null = null;
  let closestDays = Infinity;
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(start + i * DAY_MS);
    if (!dayMatches(cron, day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay())) continue;
    if (previous !== null) closestDays = Math.min(closestDays, i - previous);
    previous = i;
  }
  return Math.min(gap, closestDays * 1440 - (times.at(-1)! - times[0]!));
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const time = (hour: number, minute: number) =>
  `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

const and = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

const full = (f: Field, min: number, max: number) => f.values.length === max - min + 1;

/** The step of an evenly spaced field that also wraps evenly ("*\/20" but not "*\/7", whose last gap is shorter). */
function step(f: Field, min: number, max: number): number | null {
  const [first, second] = f.values;
  if (first !== min || second === undefined) return null;
  const s = second - first;
  const span = max - min + 1;
  return span % s === 0 && f.values.length === span / s && f.values.every((v, i) => v === min + i * s) ? s : null;
}

const atMinute = (m: number) => `:${String(m).padStart(2, "0")}`;

export function describe(schedule: string): string {
  const cron = parseCron(schedule);
  if ("error" in cron) return schedule;
  const { minute, hour, dom, month, dow } = cron;
  const everyDay = full(dom, 1, 31) && full(month, 1, 12);
  if (!everyDay) return schedule;
  const allWeek = full(dow, 0, 6);

  if (full(hour, 0, 23) && allWeek) {
    if (full(minute, 0, 59)) return "Every minute";
    const s = step(minute, 0, 59);
    if (s !== null) return `Every ${s} minutes`;
    return `Every hour at ${and(minute.values.map(atMinute))}`;
  }

  if (minute.values.length !== 1) return schedule;
  const hours = step(hour, 0, 23);
  if (hours !== null && allWeek) return `Every ${hours} hours${minute.values[0] === 0 ? "" : ` at ${atMinute(minute.values[0]!)}`}`;

  if (hour.values.length !== 1) return schedule;
  const at = time(hour.values[0]!, minute.values[0]!);
  const days = dow.values.join(",");
  if (allWeek) return `Every day at ${at}`;
  if (days === "1,2,3,4,5") return `Weekdays at ${at}`;
  if (days === "0,6") return `Weekends at ${at}`;
  return `${and(dow.values.map((d) => DAYS[d]!))} at ${at}`;
}
