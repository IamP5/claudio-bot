// Five-field cron in local time: minute hour day-of-month month day-of-week (Sunday 0).
// Each field is a list of *, n, a-b, */s or a-b/s.

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
  return { values: [...values].sort((a, b) => a - b), star: text === "*" };
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

export function matches(cron: Cron, at: Date): boolean {
  const has = (f: Field, v: number) => f.values.includes(v);
  const dom = has(cron.dom, at.getDate());
  const dow = has(cron.dow, at.getDay());
  // Standard cron: when both day fields are restricted, either one matching is enough.
  const day = !cron.dom.star && !cron.dow.star ? dom || dow : dom && dow;
  return has(cron.minute, at.getMinutes()) && has(cron.hour, at.getHours()) && has(cron.month, at.getMonth() + 1) && day;
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const time = (hour: number, minute: number) =>
  `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

const and = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function step(f: Field, min: number, max: number): number | null {
  const [first, second] = f.values;
  if (first !== min || second === undefined) return null;
  const s = second - first;
  const expected = Math.floor((max - min) / s) + 1;
  return f.values.length === expected && f.values.every((v, i) => v === min + i * s) ? s : null;
}

export function describe(schedule: string): string {
  const cron = parseCron(schedule);
  if ("error" in cron) return schedule;
  const { minute, hour, dom, month, dow } = cron;
  const everyDay = dom.star && month.star;
  if (!everyDay) return schedule;

  if (hour.star && dow.star) {
    if (minute.star) return "Every minute";
    const s = step(minute, 0, 59);
    if (s !== null) return `Every ${s} minutes`;
    return `Every hour at ${and(minute.values.map((m) => `:${String(m).padStart(2, "0")}`))}`;
  }

  if (minute.values.length !== 1 || hour.values.length !== 1) return schedule;
  const at = time(hour.values[0]!, minute.values[0]!);
  const days = dow.values.join(",");
  if (dow.star) return `Every day at ${at}`;
  if (days === "1,2,3,4,5") return `Weekdays at ${at}`;
  if (days === "0,6") return `Weekends at ${at}`;
  return `${and(dow.values.map((d) => DAYS[d]!))} at ${at}`;
}

const minuteOf = (d: Date) => Math.floor(d.getTime() / 60_000);

export function isDue(routine: { schedule: string; enabled: boolean; lastRunAt: string | null }, now: Date): boolean {
  if (!routine.enabled) return false;
  if (routine.lastRunAt !== null && minuteOf(new Date(routine.lastRunAt)) === minuteOf(now)) return false;
  const cron = parseCron(routine.schedule);
  return !("error" in cron) && matches(cron, now);
}
