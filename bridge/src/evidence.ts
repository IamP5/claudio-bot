import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentEvidence } from "./protocol";

// After a mac agent's turn the bridge reads what git says the agent did (branch, commits ahead
// of the default branch, diffstat, uncommitted work, a PR URL the agent named) so the bot checks the claim against
// facts. git only, with hooks, fsmonitor and other repo-configured programs turned off; the bridge never runs the
// repo's own commands or a test command from the model or repo config.

const GIT_TIMEOUT_MS = 10_000;

type Overrides = readonly (readonly [key: string, value: string])[];

const HARDENED: Overrides = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["protocol.file.allow", "never"],
  ["core.pager", "cat"],
];

/**
 * The agent can write the repo's .git/config, so the bridge's own git calls never take GIT_* from its environment.
 * Overrides go in as GIT_CONFIG_KEY_n/VALUE_n rather than -c, which splits at the first = and so cannot name a
 * filter called a=b.
 */
function gitEnv(overrides: Overrides): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  overrides.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { ...env, GIT_CONFIG_COUNT: String(overrides.length), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** stdout without its trailing newline, or null when git failed, timed out or could not start. Never throws. */
async function spawnGit(cwd: string, args: readonly string[], overrides: Overrides): Promise<string | null> {
  let timer: Timer | undefined;
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, env: gitEnv(overrides), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.replace(/\n$/, "") : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type Git = (args: readonly string[]) => Promise<string | null>;

/**
 * The one way the bridge runs git in a repo. Repo config can name programs git runs for us: hooks and fsmonitor are
 * switched off by name, and every filter driver the config defines is blanked and made optional, so checkout and
 * status pass content through instead of running it or failing on it (git-lfs). Diff callers add --no-ext-diff and
 * --no-textconv. A ref or path the repo could name goes after --end-of-options.
 */
export async function hardenedGit(cwd: string): Promise<Git> {
  const listed = await spawnGit(cwd, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."], HARDENED);
  const drivers = new Set((listed ?? "").split("\0").flatMap((k) => k.match(/^filter\.(.+)\.[^.]+$/s)?.[1] ?? []));
  const blanked = [...drivers].flatMap((d): [string, string][] => [
    [`filter.${d}.clean`, ""],
    [`filter.${d}.smudge`, ""],
    [`filter.${d}.process`, ""],
    [`filter.${d}.required`, "false"],
  ]);
  const overrides = [...HARDENED, ...blanked];
  return (args) => spawnGit(cwd, args, overrides);
}

/** The default branch's commit as full SHAs, so no name the repo chose ever reaches git as an argument. */
export type DefaultBranch = { local: string | null; remote: string | null };

const commitOf = (git: Git, ref: string) => git(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]);

/** The branch origin names (origin/HEAD), else main or master: the commit of its local branch and of origin's copy. */
export async function defaultBranch(git: Git): Promise<DefaultBranch> {
  const originHead = await git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const named = originHead?.startsWith("refs/remotes/origin/") ? originHead.slice("refs/remotes/origin/".length) : null;
  for (const name of [named, "main", "master"]) {
    if (name === null || name.startsWith("-")) continue;
    const [local, remote] = await Promise.all([commitOf(git, `refs/heads/${name}`), commitOf(git, `refs/remotes/origin/${name}`)]);
    if (local !== null || remote !== null) return { local, remote };
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

/**
 * null when the folder is not a git checkout or git fails. Must not throw. base: the commit a worktree started from;
 * without one, ahead counts against the default branch.
 */
export async function readEvidence(cwd: string, finalText: string, now: Date, base: string | null = null): Promise<AgentEvidence | null> {
  try {
    if (!existsSync(cwd) || !inRepo(cwd)) return null;
    const git = await hardenedGit(cwd);
    if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
    const [branch, head, status, against] = await Promise.all([
      git(["symbolic-ref", "--short", "-q", "HEAD"]),
      git(["rev-parse", "--short", "-q", "--verify", "HEAD"]),
      git(["status", "--porcelain", "--ignore-submodules=dirty"]),
      // Against what origin has when there is a remote, so commits made straight on the default branch still count.
      base ?? defaultBranch(git).then((b) => b.remote ?? b.local),
    ]);
    if (status === null) return null;
    const [ahead, stat] =
      against !== null && head !== null
        ? await Promise.all([
            git(["rev-list", "--count", "--end-of-options", `${against}..HEAD`]),
            git(["diff", "--no-ext-diff", "--no-textconv", "--shortstat", "--end-of-options", `${against}...HEAD`]),
          ])
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

/** An agent line that opens like the bridge's own is marked as the agent's, so the bot never mistakes it for git's facts. */
const SPOOF = /^(\s*)\[Git\b/i;

/** What the bot reads for a turn's report: the bridge's git line, then the agent's words. */
export function reportText(evidence: AgentEvidence | null, text: string): string {
  const words = text
    .split("\n")
    .map((line) => line.replace(SPOOF, "$1(the agent wrote this, not the bridge) [Git"))
    .join("\n");
  return `${evidence ? evidenceLine(evidence) : "[Git: not readable]"}\n${words}`;
}
