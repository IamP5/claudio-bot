// What the Mac's process table says about Claude Code's background commands. Claude Code runs each one in a shell that
// leads a process group of its own and writes to <task id>.output (CLI 2.1.305), so killing Claude Code's group, as
// the bridge does when it closes a query or exits, leaves the command running. Only the process table can tell
// whether it outlived Claude Code.

async function read(argv: string[]): Promise<string> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch {
    return "";
  }
}

/** By task id, the process group of each background shell Claude Code (process `pid`) runs. Empty when none is found. */
export async function shellGroups(pid: number): Promise<Map<string, number>> {
  const leaders = (await read(["ps", "-axo", "pid=,ppid=,pgid="]))
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([p, parent, group]) => parent === pid && p === group)
    .map(([p]) => p!);
  const found = new Map<string, number>();
  if (leaders.length === 0) return found;
  let at = 0;
  for (const line of (await read(["lsof", "-a", "-p", leaders.join(","), "-d", "1", "-Fpn"])).split("\n")) {
    if (line.startsWith("p")) at = Number(line.slice(1));
    const id = line.startsWith("n") ? /\/([^/]+)\.output$/.exec(line)?.[1] : undefined;
    if (id !== undefined && leaders.includes(at)) found.set(id, at);
  }
  return found;
}

/** Whether any process of the group still runs. */
export function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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

/** Stops every process of the group: SIGTERM, then SIGKILL for what is left. True once none runs. */
export async function endGroup(group: number): Promise<boolean> {
  signal(group, "SIGTERM");
  if (await gone(group, TERM_WAIT_MS)) return true;
  signal(group, "SIGKILL");
  return gone(group, KILL_WAIT_MS);
}
