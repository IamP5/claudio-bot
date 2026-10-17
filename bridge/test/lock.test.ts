import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHome, pidIn } from "../src/lock";

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-lock-")));
  scratches.push(dir);
  const home = join(dir, "home");
  mkdirSync(home);
  return { dir, home, lock: `${home}.lock` };
}

const deadPid = () => Bun.spawnSync(["true"]).pid;
const noWait = () => {};
const startOf = (pid: number) => Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]).stdout.toString().trim();
const mine = () => `${process.pid}\n${startOf(process.pid)}\n`;

test("a free home is locked with this process's pid and start time, and release frees it", () => {
  const { dir, home, lock } = scratch();
  const held = lockHome(home);
  expect(held.kind).toBe("held");
  expect(readFileSync(lock, "utf8")).toBe(mine());
  if (held.kind === "held") held.release();
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(dir)).toEqual(["home"]);
});

test("a lock held by a live process is left alone", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, `${process.ppid}\n`);
  expect(lockHome(home, { sleep: noWait })).toEqual({ kind: "busy", path: lock, pid: process.ppid });
  expect(readFileSync(lock, "utf8")).toBe(`${process.ppid}\n`);
});

test("a lock left by a dead process is taken over", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, `${deadPid()}\n`);
  expect(lockHome(home, { sleep: noWait }).kind).toBe("held");
  expect(readFileSync(lock, "utf8")).toBe(mine());
});

test("a lock holding this process's own pid is stale: a crashed run reused it", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, `${process.pid}\n`);
  expect(lockHome(home, { sleep: noWait }).kind).toBe("held");
  expect(readFileSync(lock, "utf8")).toBe(mine());
});

test("an empty or unreadable lock is waited on, never taken over", () => {
  for (const body of ["", "12ab\n", "\n"]) {
    const { home, lock } = scratch();
    writeFileSync(lock, body);
    let waits = 0;
    expect(lockHome(home, { sleep: () => waits++ })).toEqual({ kind: "unclear", path: lock });
    expect(waits).toBeGreaterThan(0);
    expect(readFileSync(lock, "utf8")).toBe(body);
  }
});

test("an empty lock that its writer fills in while we wait is judged by that pid", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, "");
  const result = lockHome(home, { sleep: () => writeFileSync(lock, `${process.ppid}\n`) });
  expect(result).toEqual({ kind: "busy", path: lock, pid: process.ppid });
});

test("two paths to the same home share one lock", () => {
  const { dir, home } = scratch();
  const link = join(dir, "link");
  symlinkSync(home, link);
  const first = lockHome(link);
  expect(first).toMatchObject({ kind: "held", path: `${home}.lock` });
  expect(lockHome(home, { pid: deadPid(), sleep: noWait })).toEqual({ kind: "busy", path: `${home}.lock`, pid: process.pid });
});

test("a home that does not exist yet is locked under its resolved parent", () => {
  const { dir } = scratch();
  const link = join(dir, "parent-link");
  symlinkSync(dir, link);
  expect(lockHome(join(link, "fresh"))).toMatchObject({ kind: "held", path: join(dir, "fresh.lock") });
});

test("locking a home this process already holds keeps it held", () => {
  const { home, lock } = scratch();
  expect(lockHome(home).kind).toBe("held");
  expect(lockHome(home, { sleep: noWait }).kind).toBe("held");
  expect(readFileSync(lock, "utf8")).toBe(mine());
});

test("a lock whose live pid started at another time is stale: the pid was reused", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, `${process.ppid}\nMon Jan  1 00:00:00 2001\n`);
  expect(lockHome(home, { sleep: noWait }).kind).toBe("held");
  expect(readFileSync(lock, "utf8")).toBe(mine());
});

test("a lock whose live pid started when it says is busy", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, `${process.ppid}\n${startOf(process.ppid)}\n`);
  expect(lockHome(home, { sleep: noWait })).toEqual({ kind: "busy", path: lock, pid: process.ppid });
});

test("a lock written before the Mac booted is stale, though its pid is alive again (power loss)", () => {
  const { home, lock } = scratch();
  writeFileSync(lock, `${process.ppid}\n`);
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(lock, hourAgo, hourAgo);
  expect(lockHome(home, { sleep: noWait, bootedAt: Date.now() - 600_000 }).kind).toBe("held");
  expect(readFileSync(lock, "utf8")).toBe(mine());
});

test("pidIn reads the pid of both lock formats", () => {
  expect([pidIn("42\n"), pidIn("42\nSat Oct 17 14:54:01 2026\n"), pidIn("42\n\n"), pidIn("x\n")]).toEqual([42, 42, null, null]);
});
