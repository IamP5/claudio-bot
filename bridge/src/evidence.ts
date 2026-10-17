import type { AgentEvidence } from "./protocol";

// After a mac agent's turn the bridge reads what git says the agent did (branch, commits ahead
// of the default branch, diffstat, uncommitted work, a PR URL the agent named) so the bot checks the claim against
// facts. git only, with hooks, fsmonitor and other repo-configured programs turned off; the bridge never runs the
// repo's own commands or a test command from the model or repo config.

/** null when the folder is not a git checkout or git fails. Must not throw. */
export async function readEvidence(_cwd: string, _finalText: string, _now: Date): Promise<AgentEvidence | null> {
  return null;
}
