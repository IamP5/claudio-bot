import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A background command as Claude Code starts one: a process leading a group of its own, writing to <id>.output. */
export function backgroundCommand(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "shell-"));
  mkdirSync(join(dir, "tasks"));
  const out = openSync(join(dir, "tasks", `${id}.output`), "w");
  const p = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  const exited = new Promise<void>((r) => p.once("exit", () => r()));
  return {
    pid: p.pid!,
    exited,
    async end() {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {}
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function alive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}
