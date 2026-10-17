import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// One bridge per home. Owner: U5.

export type HomeLock =
  | { kind: "held"; path: string; release(): void }
  | { kind: "busy"; path: string; pid: number }
  | { kind: "unclear"; path: string };

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The lock sits beside the home rather than in it, so the migration can move or link the home while the lock is held.
 * A lock whose pid is gone was left by a crash and is taken over.
 */
export function lockHome(home: string, deps: { pid?: number; sleep?: (ms: number) => void } = {}): HomeLock {
  const pid = deps.pid ?? process.pid;
  const path = `${home}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return {
        kind: "held",
        path,
        release: () => {
          if (existsSync(path) && readFileSync(path, "utf8").trim() === String(pid)) rmSync(path, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : NaN;
    if (alive(holder)) return { kind: "busy", path, pid: holder };
    rmSync(path, { force: true });
  }
  return { kind: "unclear", path };
}
