import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultBranch, hardenedGit, inRepo } from "./evidence";
import type { Worktree } from "./protocol";
import { refused, type Result } from "./result";
import type { Isolate } from "./tools";

// A mac agent may work in its own git worktree under ~/.claudiobot-worktrees, outside the
// bridge home and every bot home (the floors and the sandbox keep those private). Made with hardened git calls;
// removed only when the user asks (remove_worktree), never with --force and never while it holds uncommitted work.

export const worktreesRoot = () => join(homedir(), ".claudiobot-worktrees");

export type Workspace = { cwd: string; worktree: Worktree | null };

/** claudio/<first 8 of the agent's uuid>. */
export const branchOf = (agentId: string) => `claudio/${agentId.replace(/^a_/, "").slice(0, 8)}`;

const folderName = (name: string) => name.replace(/[^\w.-]/g, "-").replace(/^\.+/, "") || "project";

/**
 * Where the agent works. none: the project folder. worktree: always a new worktree on claudio/<id> from the default
 * branch. auto: a worktree when the checkout has uncommitted work or `busy` (another live mac agent works in the
 * folder), else the folder. Throws when a worktree was called for and git could not make one.
 */
export async function prepareWorkspace(
  project: { path: string; name: string },
  agentId: string,
  isolate: Isolate,
  opts: { busy?: boolean; root?: string } = {},
): Promise<Workspace> {
  const folder: Workspace = { cwd: project.path, worktree: null };
  if (isolate === "none") return folder;
  if (!inRepo(project.path)) {
    if (isolate === "worktree") throw new Error(`${project.name} is not a git repository, so it cannot have a worktree.`);
    return folder;
  }
  const git = await hardenedGit(project.path);
  if (isolate === "auto" && !opts.busy) {
    const status = await git(["status", "--porcelain", "--ignore-submodules=dirty"]);
    if (status === "") return folder;
  }
  const base = await defaultBranch(git);
  const start = base.local ?? base.remote;
  if (start === null) throw new Error(`${project.name} has no main or master branch to start a worktree from.`);
  const parent = join(opts.root ?? worktreesRoot(), folderName(project.name));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, agentId);
  const branch = branchOf(agentId);
  // --no-track: a branch made from origin/main would otherwise push to main.
  if ((await git(["worktree", "add", "--no-track", "-b", branch, path, start])) === null) {
    throw new Error(`git could not make a worktree for ${project.name} on ${branch}.`);
  }
  const real = realpathSync(path);
  return { cwd: real, worktree: { path: real, branch } };
}

/** The main checkout a linked worktree belongs to, read from its .git file. null when cwd is not a linked worktree. */
export function mainCheckoutOf(cwd: string): string | null {
  try {
    const dot = join(cwd, ".git");
    if (statSync(dot).isDirectory()) return null;
    const gitDir = resolve(cwd, readFileSync(dot, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1] ?? "");
    const commonFile = join(gitDir, "commondir");
    const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    return basename(common) === ".git" ? realpathSync(dirname(common)) : null;
  } catch {
    return null;
  }
}

/** git worktree remove, without --force: refused while the worktree holds uncommitted or untracked work. Its branch stays. */
export async function removeWorktree(main: string, worktree: Worktree): Promise<Result> {
  const git = await hardenedGit(main);
  if (!existsSync(worktree.path)) {
    await git(["worktree", "prune"]);
    return { ok: true };
  }
  const status = await (await hardenedGit(worktree.path))(["status", "--porcelain", "--ignore-submodules=dirty"]);
  if (status === null) return refused("git could not read the worktree, so it was left in place.");
  if (status !== "") return refused(`The worktree has uncommitted changes. Its branch ${worktree.branch} keeps every commit; commit or discard the rest first.`);
  if ((await git(["worktree", "remove", worktree.path])) === null) return refused("git refused to remove the worktree, so it was left in place.");
  return { ok: true };
}
