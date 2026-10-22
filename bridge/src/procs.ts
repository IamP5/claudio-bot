// What the Mac's process table says about Claude Code's background commands. Claude Code runs each one in a shell that
// leads a process group of its own and writes to <task id>.output (CLI 2.1.305), so killing Claude Code's group, as
// the bridge does when it closes a query or exits, leaves the command running. Only the process table can tell
// whether it outlived Claude Code. A saved group number can belong to another process by the time it is read again, so
// a group counts as the command's only while its leader still writes to that command's output file. A live group whose
// leader no longer does may or may not be the command, and is never signalled.

const READ_TIMEOUT_MS = 5_000;
const READ_TRIES = 3;
const READ_RETRY_MS = 200;

/** A command's output; null when it could not run, failed with nothing to say, or ran past the timeout. */
async function read(argv: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: process.env });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      p.kill("SIGKILL");
    }, READ_TIMEOUT_MS);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    return late || (p.exitCode !== 0 && out === "") ? null : out;
  } catch {
    return null;
  }
}

/** The output files the processes have open on stdout, by pid; null when lsof could not be read, after a few tries. */
async function outputs(pids: readonly number[]): Promise<Map<number, string[]> | null> {
  const found = new Map<number, string[]>();
  if (pids.length === 0) return found;
  let out: string | null = null;
  for (let i = 0; i < READ_TRIES && out === null; i++) {
    if (i > 0) await Bun.sleep(READ_RETRY_MS);
    out = await read(["lsof", "-w", "-a", "-p", pids.join(","), "-d", "1", "-Fpn"]);
  }
  if (out === null) return null;
  let at = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) at = Number(line.slice(1));
    else if (line.startsWith("n") && pids.includes(at)) found.set(at, [...(found.get(at) ?? []), line.slice(1)]);
  }
  return found;
}

const taskOf = (path: string) => /\/([^/]+)\.output$/.exec(path)?.[1];

/** The processes Claude Code (process `pid`) started that lead a process group of their own, with their command lines. */
export async function shellLeaders(pid: number): Promise<{ group: number; command: string }[]> {
  return ((await read(["ps", "-axww", "-o", "pid=,ppid=,pgid=,command="])) ?? "")
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[2]) === pid && m[1] === m[3])
    .map((m) => ({ group: Number(m[1]), command: m[4]! }));
}

/** By task id, the process group of each background shell Claude Code (process `pid`) runs. Empty when none is found. */
export async function shellGroups(pid: number): Promise<Map<string, number>> {
  const leaders = (await shellLeaders(pid)).map((l) => l.group);
  const found = new Map<string, number>();
  for (const [leader, paths] of (await outputs(leaders)) ?? []) for (const id of paths.map(taskOf)) if (id !== undefined) found.set(id, leader);
  return found;
}

/** Whether a process of the group runs and is the user's own. One the bridge may not signal is not the bridge's. */
export function groupAlive(group: number): boolean {
  if (group <= 1) return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * runs: the group's leader still writes to <id>.output. gone: no process of the group runs. unsure: it runs, but its
 * leader writes elsewhere. unread: it runs, and the process table could not be read to tell.
 */
export type TaskRun = "runs" | "gone" | "unsure" | "unread";

export async function taskRun(group: number, id: string): Promise<TaskRun> {
  if (!groupAlive(group)) return "gone";
  const found = await outputs([group]);
  if (found === null) return "unread";
  return (found.get(group) ?? []).some((path) => taskOf(path) === id) ? "runs" : "unsure";
}

const TERM_WAIT_MS = 3_000;
const KILL_WAIT_MS = 1_000;

async function gone(group: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!groupAlive(group)) return true;
    await Bun.sleep(50);
  }
  return !groupAlive(group);
}

function signal(group: number, sig: NodeJS.Signals) {
  try {
    process.kill(-group, sig);
  } catch {}
}

/**
 * Stops background task `id` running as group `group`: SIGTERM, then SIGKILL for what is left. Only a group proven to
 * run the task is signalled. stopped: it ran and no longer does; gone or unsure: as taskRun found it, nothing was sent;
 * survived: it still runs after SIGKILL.
 */
export async function endGroup(group: number, id: string): Promise<"stopped" | "gone" | "unsure" | "survived"> {
  const run = await taskRun(group, id);
  if (run === "unread") return "unsure";
  if (run !== "runs") return run;
  signal(group, "SIGTERM");
  if (await gone(group, TERM_WAIT_MS)) return "stopped";
  signal(group, "SIGKILL");
  return (await gone(group, KILL_WAIT_MS)) ? "stopped" : "survived";
}
