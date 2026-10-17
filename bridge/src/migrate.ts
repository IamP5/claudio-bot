// The rename from ~/.claudebot to ~/.claudiobot. Runs first, before anything opens a file in the home. Owner: U7.
// Resume finds transcripts by session id, so a symlink in either direction keeps every bot's session (probe Q8).

export type Migration =
  /** CLAUDIOBOT_HOME is set, there is no old home, or the link is already in place. */
  | { kind: "none" }
  /** The old home existed and the new one did not: linked. */
  | { kind: "linked"; from: string; to: string }
  /** Both existed and the new one held no user bots (only a token and the default bot, or nothing): moved aside, then linked. */
  | { kind: "moved_aside"; from: string; to: string; aside: string }
  /** Both hold user bots. Nothing is touched; the caller warns loudly and uses the new home. */
  | { kind: "conflict"; from: string; to: string };

/** Every step is guarded by what exists on disk, so a second run, or a run after a crash mid-way, converges. */
export function migrateHome(deps: { env: Record<string, string | undefined>; home: string; now: () => Date }): Migration {
  throw new Error("not implemented");
}
