import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// One bridge per home. Owner: U5.

export type HomeLock =
  | { kind: "held"; path: string; release(): void }
  | { kind: "busy"; path: string; pid: number }
  /** Still empty or not a pid after waiting: nothing to judge it by, so it is never taken over. */
  | { kind: "unclear"; path: string };

const ATTEMPTS = 20;
const RETRY_MS = 100;

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

const pidIn = (body: string) => (/^[1-9]\d*\n?$/.test(body) ? Number(body.trim()) : null);

const unique = (path: string, pid: number, tag: string) => `${path}.${pid}.${crypto.randomUUID().slice(0, 8)}.${tag}`;

/** Two names for one home (a symlink, CLAUDIOBOT_HOME spelled another way) must find the same lock. */
function lockPath(home: string): string {
  try {
    return `${realpathSync(home)}.lock`;
  } catch (e) {
    if (errno(e) !== "ENOENT") throw e;
    return `${join(realpathSync(dirname(home)), basename(home))}.lock`;
  }
}

/** The pid is written in full before the lock appears, so a reader never sees a half-made lock of ours. */
function create(path: string, pid: number): boolean {
  const tmp = unique(path, pid, "new");
  writeFileSync(tmp, `${pid}\n`, { mode: 0o600 });
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

/**
 * The lock sits beside the home rather than in it, so the migration can move or link the home while the lock is held.
 * A lock whose pid is gone, or is this process's own (a crashed run whose pid came back), was left by a crash and is
 * taken over. Locking a home this process already holds is therefore harmless.
 */
export function lockHome(home: string, deps: { pid?: number; sleep?: (ms: number) => void } = {}): HomeLock {
  const pid = deps.pid ?? process.pid;
  const sleep = deps.sleep ?? Bun.sleepSync;
  mkdirSync(dirname(home), { recursive: true });
  const path = lockPath(home);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (create(path, pid)) {
      return {
        kind: "held",
        path,
        release: () => {
          if (readOrNull(path) === `${pid}\n`) rmSync(path, { force: true });
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
    if (holder !== pid && alive(holder)) return { kind: "busy", path, pid: holder };
    removeStale(path, body, pid);
  }
  return { kind: "unclear", path };
}
