import { homedir } from "node:os";
import { join } from "node:path";
import type { Worktree } from "./protocol";
import type { Isolate } from "./tools";

// A mac agent may work in its own git worktree under ~/.claudiobot-worktrees, outside the
// bridge home and every bot home (the floors and the sandbox keep those private). Made with hardened git calls;
// removed only when the user asks (remove_worktree), never with --force and never while it holds uncommitted work.

export const worktreesRoot = () => join(homedir(), ".claudiobot-worktrees");

/** Where the agent works. A stub that always works in the project folder. */
export async function prepareWorkspace(project: { path: string; name: string }, _agentId: string, _isolate: Isolate): Promise<{ cwd: string; worktree: Worktree | null }> {
  return { cwd: project.path, worktree: null };
}
