// What the Mac's process table says about Claude Code's background commands. Claude Code runs each one in a shell that
// leads a process group of its own and writes to <task id>.output (CLI 2.1.305), so killing Claude Code's group, as
// the bridge does when it closes a query or exits, leaves the command running. Only the process table can tell
// whether it outlived Claude Code. A saved group number can belong to another process by the time it is read again, so
// a group counts as the command's only while its leader still writes to that command's output file. A live group whose
// leader no longer does may or may not be the command, and is never signalled.

const READ_TIMEOUT_MS = 5_000;

async function read(argv: string[]): Promise<string> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), READ_TIMEOUT_MS);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    return out;
  } catch {
    return "";
  }
}

/** The output files the processes have open on stdout, by pid. */
async function outputs(pids: readonly number[]): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>();
  if (pids.length === 0) return found;
  let at = 0;
  for (const line of (await read(["lsof", "-w", "-a", "-p", pids.join(","), "-d", "1", "-Fpn"])).split("\n")) {
    if (line.startsWith("p")) at = Number(line.slice(1));
    else if (line.startsWith("n") && pids.includes(at)) found.set(at, [...(found.get(at) ?? []), line.slice(1)]);
  }
  return found;
}

const taskOf = (path: string) => /\/([^/]+)\.output$/.exec(path)?.[1];

/** By task id, the process group of each background shell Claude Code (process `pid`) runs. Empty when none is found. */
export async function shellGroups(pid: number): Promise<Map<string, number>> {
  const leaders = (await read(["ps", "-axo", "pid=,ppid=,pgid="]))
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([p, parent, group]) => parent === pid && p === group)
    .map(([p]) => p!);
  const found = new Map<string, number>();
  for (const [leader, paths] of await outputs(leaders)) for (const id of paths.map(taskOf)) if (id !== undefined) found.set(id, leader);
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

/** runs: the group's leader still writes to <id>.output. gone: no process of the group runs. unsure: it runs, unproven. */
export type TaskRun = "runs" | "gone" | "unsure";

export async function taskRun(group: number, id: string): Promise<TaskRun> {
  if (!groupAlive(group)) return "gone";
  return ((await outputs([group])).get(group) ?? []).some((path) => taskOf(path) === id) ? "runs" : "unsure";
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
  if (run !== "runs") return run;
  signal(group, "SIGTERM");
  if (await gone(group, TERM_WAIT_MS)) return "stopped";
  signal(group, "SIGKILL");
  return (await gone(group, KILL_WAIT_MS)) ? "stopped" : "survived";
}
