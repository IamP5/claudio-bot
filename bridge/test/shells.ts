import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A background command as Claude Code starts one: a process leading a group of its own, writing to <id>.output.
 * redirect() makes it point its output elsewhere and keep running, as `exec >/dev/null` in the command does.
 */
export function backgroundCommand(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "shell-"));
  mkdirSync(join(dir, "tasks"));
  const out = openSync(join(dir, "tasks", `${id}.output`), "w");
  const go = join(dir, "redirect");
  const script = `while [ ! -f '${go}' ]; do sleep 0.05; done; exec >/dev/null 2>&1; sleep 30`;
  const p = spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  const exited = new Promise<void>((r) => p.once("exit", () => r()));
  return {
    pid: p.pid!,
    exited,
    async redirect() {
      writeFileSync(go, "");
      await Bun.sleep(300);
    },
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

/** A shell that runs `command` as Claude Code's shells do, through eval, so ps shows it on its command line. */
export function evalShell(command: string) {
  const p = spawn("/bin/sh", ["-c", `eval '${command}' < /dev/null && true`], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>((r) => p.once("exit", () => r()));
  return {
    pid: p.pid!,
    async end() {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {}
      await exited;
    },
  };
}
