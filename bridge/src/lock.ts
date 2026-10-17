import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";

// One bridge per home.

export type HomeLock =
  | { kind: "held"; path: string; release(): void }
  | { kind: "busy"; path: string; pid: number }
  /** Still empty or not a pid after waiting: nothing to judge it by, so it is never taken over. */
  | { kind: "unclear"; path: string };

const ATTEMPTS = 20;
const RETRY_MS = 100;
/** A lock last written this long before the boot time is from before it; the slack covers uptime's rounding. */
const BOOT_SLACK_MS = 5_000;

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errno(e) === "EPERM";
  }
};

const readOrNull = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    throw e;
  }
};

// A lock is "<pid>\n<start>\n": the pid and when that process started, as ps prints it in UTC. After a reboot or a
// crash the pid can belong to another process; the start time tells them apart. Older bridges wrote the pid alone, or
// the start in the Mac's time zone.
const LOCK = /^([1-9]\d*)(?:\n([^\n]+))?\n?$/;

/** The pid a lock file names, or null while it is empty or garbled. */
export const pidIn = (body: string) => {
  const m = LOCK.exec(body);
  return m ? Number(m[1]) : null;
};

/** When the process started, as `ps -o lstart=` prints it in a time zone (the Mac's when tz is null), or null when ps
 *  cannot tell: no such process, or ps failed. */
function processStart(pid: number, tz: string | null = "UTC"): string | null {
  const env = tz === null ? process.env : { ...process.env, TZ: tz };
  const ran = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stderr: "ignore", env });
  const start = ran.exitCode === 0 ? ran.stdout.toString().trim() : "";
  return start === "" ? null : start;
}

const bodyOf = (pid: number, start: string | null) => (start === null ? `${pid}\n` : `${pid}\n${start}\n`);

const unique = (path: string, pid: number, tag: string) => `${path}.${pid}.${crypto.randomUUID().slice(0, 8)}.${tag}`;

/** Two names for one home (a symlink, CLAUDIOBOT_HOME spelled another way) must find the same lock. */
export function lockPathOf(home: string, realpath: (path: string) => string = realpathSync): string {
  try {
    return `${realpath(home)}.lock`;
  } catch (e) {
    if (errno(e) !== "ENOENT") throw e;
    return `${join(realpath(dirname(home)), basename(home))}.lock`;
  }
}

/** The body is written in full before the lock appears, so a reader never sees a half-made lock of ours. */
function create(path: string, pid: number, body: string): boolean {
  const tmp = unique(path, pid, "new");
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (errno(e) === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Removes the lock only if it is still the stale one we judged. A rival may have replaced it since; the rename moves
 * whatever is there, so a lock that turns out fresh is linked back.
 */
function removeStale(path: string, judged: string, pid: number) {
  const aside = unique(path, pid, "stale");
  try {
    renameSync(path, aside);
  } catch (e) {
    if (errno(e) === "ENOENT") return;
    throw e;
  }
  try {
    if (readFileSync(aside, "utf8") !== judged) linkSync(aside, path);
  } catch (e) {
    if (errno(e) !== "EEXIST") throw e;
  } finally {
    rmSync(aside, { force: true });
  }
}

const writtenBefore = (path: string, ms: number) => {
  try {
    return statSync(path).mtimeMs < ms - BOOT_SLACK_MS;
  } catch {
    return false;
  }
};

/**
 * The lock sits beside the home rather than in it, so the migration can move or link the home while the lock is held.
 * A lock was left by a crash, and is taken over, when its pid is gone, is this process's own, or names a process that
 * started at another time than the lock says. A lock with no recorded start (an older bridge's) is also stale when it
 * was written before the Mac booted (a power loss: launchd may hand the old pid to anything). A live holder whose start
 * ps cannot read is busy: nothing proves it is someone else. Locking a home this process already holds is harmless.
 */
export function lockHome(home: string, deps: { pid?: number; sleep?: (ms: number) => void; bootedAt?: number; startOf?: (pid: number, tz: string | null) => string | null } = {}): HomeLock {
  const pid = deps.pid ?? process.pid;
  const sleep = deps.sleep ?? Bun.sleepSync;
  const bootedAt = deps.bootedAt ?? Date.now() - uptime() * 1000;
  const startOf = deps.startOf ?? processStart;
  mkdirSync(dirname(home), { recursive: true });
  const path = lockPathOf(home);
  const own = bodyOf(pid, startOf(pid, "UTC"));
  const live = (holder: number, recorded: string | null) => {
    if (holder === pid || !alive(holder)) return false;
    if (recorded === null) return !writtenBefore(path, bootedAt);
    const utc = startOf(holder, "UTC");
    return utc === null || utc === recorded || startOf(holder, null) === recorded;
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (create(path, pid, own)) {
      return {
        kind: "held",
        path,
        release: () => {
          if (readOrNull(path) === own) rmSync(path, { force: true });
        },
      };
    }
    const body = readOrNull(path);
    if (body === null) continue;
    const holder = pidIn(body);
    if (holder === null) {
      sleep(RETRY_MS);
      continue;
    }
    if (live(holder, LOCK.exec(body)?.[2] ?? null)) return { kind: "busy", path, pid: holder };
    removeStale(path, body, pid);
  }
  return { kind: "unclear", path };
}
