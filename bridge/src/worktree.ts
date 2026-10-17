import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBranch, hardenedGit, inRepo } from "./evidence";
import type { Worktree } from "./protocol";
import { refused, type Result } from "./result";
import type { Isolate } from "./tools";

// A mac agent may work in its own git worktree under ~/.claudiobot-worktrees, outside the
// bridge home and every bot home (the floors and the sandbox keep those private). Made with hardened git calls;
// removed only when the user asks (remove_worktree), never with --force and never while it holds uncommitted work.

export const worktreesRoot = () => join(homedir(), ".claudiobot-worktrees");

/** base: the commit a worktree started from. note: a line for the bot's chat about where the agent ended up. */
export type Workspace = { cwd: string; worktree: Worktree | null; base: string | null; note: string | null };

/** claudio/<first 8 of the agent's uuid>. */
export const branchOf = (agentId: string) => `claudio/${agentId.replace(/^a_/, "").slice(0, 8)}`;

const folderName = (name: string) => name.replace(/[^\w.-]/g, "-").replace(/^\.+/, "") || "project";

/**
 * Where the agent works. none: the project folder. worktree: always a new worktree on claudio/<id> from the default
 * branch. auto: a worktree when the checkout has uncommitted work or `busy` (another live mac agent works in the
 * folder), else the folder; the folder too, with a note, when there is no default branch to start one from. Throws
 * when a worktree was asked for and git could not make one.
 */
export async function prepareWorkspace(
  project: { path: string; name: string },
  agentId: string,
  isolate: Isolate,
  opts: { busy?: boolean; root?: string } = {},
): Promise<Workspace> {
  const folder: Workspace = { cwd: project.path, worktree: null, base: null, note: null };
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
  const branches = await defaultBranch(git);
  const base = branches.local ?? branches.remote;
  if (base === null) {
    if (isolate === "auto") return { ...folder, note: `${project.name} has no main or master branch to start a worktree from, so the agent works in the project folder.` };
    throw new Error(`${project.name} has no main or master branch to start a worktree from.`);
  }
  const parent = join(opts.root ?? worktreesRoot(), folderName(project.name));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, agentId);
  const branch = branchOf(agentId);
  if ((await git(["worktree", "add", "-b", branch, "--end-of-options", path, base])) === null) {
    throw new Error(`git could not make a worktree for ${project.name} on ${branch}.`);
  }
  const real = realpathSync(path);
  return { cwd: real, worktree: { path: real, branch }, base, note: null };
}

/** Ignored folders a build or package install makes again; git worktree remove deletes ignored files with the folder. */
export const REGENERABLE = ["node_modules", ".build", "dist", "build", "DerivedData"];

/**
 * git worktree remove, run from the project's checkout, without --force: refused while the worktree holds uncommitted
 * or untracked work, or ignored files outside REGENERABLE (an .env would go with it). Its branch stays.
 */
export async function removeWorktree(repo: string, worktree: Worktree): Promise<Result> {
  const git = await hardenedGit(repo);
  if (!existsSync(worktree.path)) {
    await git(["worktree", "prune"]);
    return { ok: true };
  }
  const status = await (await hardenedGit(worktree.path))(["status", "--porcelain", "-z", "--ignored", "--ignore-submodules=dirty"]);
  if (status === null) return refused("git could not read the worktree, so it was left in place.");
  const entries = status.split("\0").filter((e) => e !== "");
  if (entries.some((e) => !e.startsWith("!! "))) return refused(`The worktree has uncommitted changes. Its branch ${worktree.branch} keeps every commit; commit or discard the rest first.`);
  const kept = entries.map((e) => e.slice(3)).filter((p) => !p.split("/").some((part) => REGENERABLE.includes(part)));
  if (kept.length > 0) {
    const named = kept.slice(0, 3).join(", ") + (kept.length > 3 ? ` and ${kept.length - 3} more` : "");
    return refused(`The worktree holds ignored files that removing it would delete: ${named}. Move or delete them first; only ${REGENERABLE.join(", ")} may go with it.`);
  }
  if ((await git(["worktree", "remove", "--end-of-options", worktree.path])) === null) return refused("git refused to remove the worktree, so it was left in place.");
  return { ok: true };
}
