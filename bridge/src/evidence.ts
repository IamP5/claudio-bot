import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentEvidence } from "./protocol";

// After a mac agent's turn the bridge reads what git says the agent did (branch, commits ahead
// of the default branch, diffstat, uncommitted work, a PR URL the agent named) so the bot checks the claim against
// facts. git only, with hooks, fsmonitor and other repo-configured programs turned off; the bridge never runs the
// repo's own commands or a test command from the model or repo config.

const GIT_TIMEOUT_MS = 10_000;

const HARDENED = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "core.pager=cat"];

/** The agent can write the repo's .git/config, so the bridge's own git calls never take GIT_* from its environment. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** stdout without its trailing newline, or null when git failed, timed out or could not start. Never throws. */
async function spawnGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? out.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}

export type Git = (args: readonly string[]) => Promise<string | null>;

/**
 * The one way the bridge runs git in a repo. Repo config can name programs git runs for us: hooks and fsmonitor are
 * switched off by name, and every filter driver the config defines is blanked so checkout and status pass content
 * through instead of running it. Diff callers add --no-ext-diff and --no-textconv.
 */
export async function hardenedGit(cwd: string): Promise<Git> {
  const listed = await spawnGit(cwd, [...HARDENED, "config", "--name-only", "--get-regexp", "^filter\\."]);
  const drivers = new Set((listed ?? "").split("\n").flatMap((k) => k.match(/^filter\.(.+)\.[^.]+$/)?.[1] ?? []));
  const blanked = [...drivers].flatMap((d) => ["clean", "smudge", "process"].flatMap((key) => ["-c", `filter.${d}.${key}=`]));
  return (args) => spawnGit(cwd, [...HARDENED, ...blanked, ...args]);
}

export type DefaultBranch = { local: string | null; remote: string | null };

/** The default branch as origin names it (origin/HEAD), else main or master: its local branch and its remote ref. */
export async function defaultBranch(git: Git): Promise<DefaultBranch> {
  const originHead = await git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  const named = originHead?.startsWith("origin/") ? originHead.slice("origin/".length) : null;
  for (const name of [named, "main", "master"]) {
    if (name === null) continue;
    const [local, remote] = await Promise.all([
      git(["rev-parse", "--verify", "-q", `refs/heads/${name}`]),
      git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`]),
    ]);
    if (local !== null || remote !== null) return { local: local === null ? null : name, remote: remote === null ? null : `origin/${name}` };
  }
  return { local: null, remote: null };
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export const prOf = (text: string): string | null => text.match(PR_URL)?.[0] ?? null;

function shortstat(out: string | null) {
  const n = (re: RegExp) => Number(out?.match(re)?.[1] ?? 0);
  return { changed: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
}

/** A .git in the folder or above it. Checked before spawning so a folder outside any repo answers at once. */
export function inRepo(cwd: string): boolean {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** null when the folder is not a git checkout or git fails. Must not throw. */
export async function readEvidence(cwd: string, finalText: string, now: Date): Promise<AgentEvidence | null> {
  try {
    if (!existsSync(cwd) || !inRepo(cwd)) return null;
    const git = await hardenedGit(cwd);
    if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
    const [branch, head, status, base] = await Promise.all([
      git(["symbolic-ref", "--short", "-q", "HEAD"]),
      git(["rev-parse", "--short", "-q", "--verify", "HEAD"]),
      git(["status", "--porcelain", "--ignore-submodules=dirty"]),
      defaultBranch(git),
    ]);
    if (status === null) return null;
    // Against what origin has when there is a remote, so commits made straight on the default branch still count.
    const against = base.remote ?? base.local;
    const [ahead, stat] =
      against !== null && head !== null
        ? await Promise.all([git(["rev-list", "--count", `${against}..HEAD`]), git(["diff", "--no-ext-diff", "--no-textconv", "--shortstat", `${against}...HEAD`])])
        : [null, null];
    return {
      at: now.toISOString(),
      branch: branch || null,
      head: head || null,
      ahead: Number(ahead ?? 0),
      ...shortstat(stat),
      dirty: status.trim() !== "",
      pr: prOf(finalText),
    };
  } catch {
    return null;
  }
}

/** The bridge's own line on top of an agent's report, so the bot reads git's facts before the agent's words. */
export function evidenceLine(e: AgentEvidence): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    `branch ${e.branch ?? "(detached)"}${e.head ? ` at ${e.head}` : ""}`,
    `${plural(e.ahead, "commit")} ahead of the default branch`,
    `${plural(e.changed, "file")} changed (+${e.insertions} -${e.deletions})`,
    e.dirty ? "uncommitted changes in the checkout" : "nothing uncommitted",
    e.pr ? `PR named: ${e.pr}` : "no PR URL in its message",
  ];
  return `[Git, read by the bridge after this turn: ${parts.join("; ")}.]`;
}
