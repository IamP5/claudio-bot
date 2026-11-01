// What the Mac's process table says about Claude Code's background commands. Claude Code runs each one in a shell that
// leads a process group of its own and writes to <task id>.output (CLI 2.1.305), so killing Claude Code's group, as
// the bridge does when it closes a query or exits, leaves the command running. Only the process table can tell
// whether it outlived Claude Code. A saved group number can belong to another process by the time it is read again, so
// a group counts as the command's only while its leader still writes to that command's output file. A live group whose
// leader no longer does may or may not be the command, and is never signalled.

const READ_TIMEOUT_MS = 5_000;
const READ_TRIES = 3;
const READ_RETRY_MS = 200;

/**
 * A command's output; null when it could not run, failed with nothing to say, or ran past the timeout. The timeout is
 * final: a process its child outlives, holding the output pipe open, is not waited on past it.
 */
export async function read(argv: string[], timeoutMs = READ_TIMEOUT_MS, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  let kill = () => {};
  const done = (async () => {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
    kill = () => p.kill("SIGKILL");
    const out = await new Response(p.stdout).text();
    await p.exited;
    return p.exitCode !== 0 && out === "" ? null : out;
  })().catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      kill();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
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

/**
 * The processes Claude Code (process `pid`) started that lead a process group of their own, with their command lines
 * as ps writes them in the C locale (see psText).
 */
export async function shellLeaders(pid: number): Promise<{ group: number; command: string }[]> {
  return ((await read(["ps", "-axww", "-o", "pid=,ppid=,pgid=,command="], READ_TIMEOUT_MS, { ...process.env, LC_ALL: "C" })) ?? "")
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[2]) === pid && m[1] === m[3])
    .map((m) => ({ group: Number(m[1]), command: m[4]! }));
}

/**
 * The command a shell Claude Code started runs, from its command line: Claude Code hands it to `eval '<command>'` with
 * each single quote written as '"'"' or '\'', and adds `< /dev/null` unless the command reads input of its own. null
 * when the line is not of that form.
 */
export function evalArg(commandLine: string): string | null {
  const m = /\beval '((?:[^']|'"'"'|'\\'')*)'(?: < \/dev\/null)?(?: && |$)/.exec(commandLine);
  return m ? m[1]!.replace(/'"'"'|'\\''/g, "'") : null;
}

const octal = (b: number) => `\\${b.toString(8).padStart(3, "0")}`;

/**
 * A command as macOS ps writes it in the C locale, byte by byte (vis(3)): tab and newline in octal, other control
 * bytes as ^X, a byte above 0x7f as M- or M^ before its low seven bits, and one whose low bits are a space in octal.
 * Two commands can read alike this way; that only makes a pairing that needs a single match less likely.
 */
export function psText(command: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(command)) {
    if (b === 0x09 || b === 0x0a || b === 0xa0) out += octal(b);
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else {
      const low = b & 0x7f;
      const meta = b & 0x80 ? "M" : "";
      out += low < 0x20 || low === 0x7f ? `${meta}^${low === 0x7f ? "?" : String.fromCharCode(low + 0x40)}` : `${meta}-${String.fromCharCode(low)}`;
    }
  }
  return out;
}

/**
 * Programs and shell words that can make a command's work outlive or replace the shell that ran it, or run text the
 * bridge cannot read: a simple command led by one of them is never taken as plain.
 */
const HIDERS = new Set([
  ..."exec eval source . builtin command nohup setsid disown coproc trap env sh bash zsh dash ksh xargs script nice time timeout caffeinate".split(" "),
  // Shell keywords group commands (if, while, { }, case), so the word that leads a simple command is not its command.
  ..."if then else elif fi do done while until for in case esac select function".split(" "),
]);
const PLAIN_TOKEN = /\s+|2>&1|2>|>>|&&|\|\||[;|<>]|[A-Za-z0-9_./:=,@%+-]+|./gy;
const SEPARATORS = new Set([";", "&&", "||", "|"]);
const REDIRECTS = new Set([">", ">>", "2>", "<"]);

/**
 * Whether a count of no process running `command` means it ended: all of its text is plain, so its shell is the only
 * place its work runs. Plain is words of [A-Za-z0-9_./:=,@%+-] (no quotes, escapes, expansions or globs), separated by
 * ; && || or |, with redirects > >> 2> 2>&1 < to a plain word, and no simple command led (after VAR=value words) by a
 * program in HIDERS. An exec with nothing but redirects changes no process, so it is plain. Anything else, the bridge
 * cannot tell.
 */
export function countable(command: string): boolean {
  const tokens: string[] = [];
  for (const m of command.matchAll(PLAIN_TOKEN)) {
    if (m[0].length === 1 && /[^;|<>A-Za-z0-9_./:=,@%+-]/.test(m[0]) && !/\s/.test(m[0])) return false;
    if (/^\s+$/.test(m[0])) {
      if (m[0].includes("\n")) return false;
      continue;
    }
    tokens.push(m[0]);
  }
  let words: string[] = [];
  let redirected = false;
  const simple = () => {
    const at = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const program = at < 0 ? undefined : words[at]!;
    const name = program?.split("/").at(-1);
    const ok = (words.length > 0 || redirected) && (name === undefined || !HIDERS.has(name) || (name === "exec" && words.length === at + 1 && redirected));
    words = [];
    redirected = false;
    return ok;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (SEPARATORS.has(t)) {
      if (!simple()) return false;
    } else if (t === "2>&1") redirected = true;
    else if (REDIRECTS.has(t)) {
      const target = tokens[++i];
      if (target === undefined || SEPARATORS.has(target) || REDIRECTS.has(target) || target === "2>&1") return false;
      redirected = true;
    } else words.push(t);
  }
  return simple();
}

/**
 * How many processes run each command as Claude Code's shells run one (evalArg of their command line), whoever started
 * them; null when the process table could not be read. A count can only say a command may still run, never which
 * process is it.
 */
export async function commandCounts(commands: readonly string[]): Promise<Map<string, number> | null> {
  const out = await read(["ps", "-axww", "-o", "command="], READ_TIMEOUT_MS, { ...process.env, LC_ALL: "C" });
  // ps lists itself at least, so an empty table was not read.
  if (out === null || out.trim() === "") return null;
  const counts = new Map(commands.map((c) => [c, 0]));
  const wanted = new Map(commands.map((c) => [psText(c), c]));
  for (const line of out.split("\n")) {
    const command = wanted.get(evalArg(line) ?? "");
    if (command !== undefined) counts.set(command, counts.get(command)! + 1);
  }
  return counts;
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
