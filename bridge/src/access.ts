type AccessEnv = Readonly<Record<string, string | undefined>>;

/**
 * How much of the Mac and of Claude Code the bots and their mac agents reach. Read from the bridge's environment as
 * each query opens and each call is checked, so `claudiobot install` with new values takes effect on restart.
 *
 * CLAUDIOBOT_ACCESS=guarded (the default): the gate's floors refuse private paths, every held row waits for a tap, the
 *   sandbox is on and a repo's own Claude Code config waits for a trust card.
 * CLAUDIOBOT_ACCESS=full: only the bridge's own state stays off limits. Keys, credentials, ~/.claude (memory, history,
 *   transcripts), browsers, Messages, localhost and the env are reachable, routine work such as a command built at
 *   runtime or a write outside the bot's folder passes, and every repo's Claude Code config loads. What leaves the Mac
 *   for good still waits for a tap (FULL_HELD in policy.ts): pushes to the default branch, history rewrites, publish,
 *   deploy, secrets, GitHub admin and posts, deletes outside the folder, USER.md and the claudio tools' unattended asks.
 * CLAUDIOBOT_SANDBOX=on|off: the OS sandbox for Bash. It defaults to on when guarded and off when full.
 */
export type Access = { full: boolean; sandbox: boolean };

const ON = new Set(["1", "on", "true", "yes"]);
const OFF = new Set(["0", "off", "false", "no"]);

export function accessOf(env: AccessEnv): Access {
  const full = (env.CLAUDIOBOT_ACCESS ?? "").trim().toLowerCase() === "full";
  const asked = (env.CLAUDIOBOT_SANDBOX ?? "").trim().toLowerCase();
  const sandbox = ON.has(asked) ? true : OFF.has(asked) ? false : !full;
  return { full, sandbox };
}

/** One line for the startup banner and doctor. */
export const accessLine = (a: Access) => `access: ${a.full ? "full" : "guarded"}, sandbox ${a.sandbox ? "on" : "off"}`;
