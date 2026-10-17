// The rename from ~/.claudebot to ~/.claudiobot. Runs first, before anything opens a file in the home. Owner: U7.
// Resume finds transcripts by session id, so a symlink in either direction keeps every bot's session (probe Q8).
import * as nodeFs from "node:fs";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const OLD = ".claudebot";
const NEW = ".claudiobot";

export type Migration =
  /** CLAUDIOBOT_HOME is set, there is no old home, the link is already in place, or only the new home holds bots. */
  | { kind: "none" }
  /** The old home existed and the new one did not: linked. */
  | { kind: "linked"; from: string; to: string }
  /** Both existed and the new one held no user bots (only a token and the default bot, or nothing): moved aside, then linked. */
  | { kind: "moved_aside"; from: string; to: string; aside: string }
  /** Both hold user bots. Nothing is touched; the caller prints message and uses the new home. */
  | { kind: "conflict"; from: string; to: string; message: string };

/** The only two writes. Injectable so a test can crash between them. */
export type MigrationFs = Pick<typeof nodeFs, "renameSync" | "symlinkSync">;

/**
 * Every step is guarded by what exists on disk, so a second run, or a run after a crash mid-way, converges.
 * The old home is never written, so it resolves at every step. The link is relative, so `.claudiobot -> .claudebot`.
 */
export function migrateHome(deps: {
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  fs?: MigrationFs;
}): Migration {
  if (deps.env.CLAUDIOBOT_HOME !== undefined) return { kind: "none" };
  const fs = deps.fs ?? nodeFs;
  const from = join(deps.home, OLD);
  const to = join(deps.home, NEW);
  if (!existsSync(from)) return { kind: "none" };

  if (!entryAt(to)) {
    fs.symlinkSync(OLD, to);
    return { kind: "linked", from, to };
  }
  if (existsSync(to) && realpathSync(to) === realpathSync(from)) return { kind: "none" };

  if (!holdsUserBots(to)) {
    const aside = freeAside(to, deps.now());
    fs.renameSync(to, aside);
    fs.symlinkSync(OLD, to);
    return { kind: "moved_aside", from, to, aside };
  }
  if (!holdsUserBots(from)) return { kind: "none" };
  return {
    kind: "conflict",
    from,
    to,
    message:
      `ClaudioBot found bots in both ${from} and ${to}. It is using ${to} and has not touched ${from}. ` +
      `To use the bots in ${from} instead, stop the bridge, move ${to} somewhere else, and start the bridge again: ` +
      `it will link ${to} to ${from}.`,
  };
}

/** lstat, so a dangling link counts as an entry that must be moved before the link can be made. */
function entryAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function freeAside(to: string, at: Date): string {
  const base = `${to}.pre-migrate-${at.toISOString().replace(/[:.]/g, "-")}`;
  let aside = base;
  for (let n = 2; entryAt(aside); n++) aside = `${base}-${n}`;
  return aside;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const emptyOrMissing = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * Reads state.json only, never the token, and never writes it. Anything this cannot read as a v2 or v3 state counts
 * as user bots, so an unreadable home is never moved. Fresh: no agents and at most one bot, which has no routines,
 * no standing rules and no message the user typed. That is the default bot after first run, greeting included.
 */
function holdsUserBots(dir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "state.json"), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
  let file: unknown;
  try {
    file = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!isObject(file) || (file.version !== 2 && file.version !== 3)) return true;
  const { bots, agents } = file;
  if (!Array.isArray(bots) || !Array.isArray(agents) || agents.length > 0 || bots.length > 1) return true;
  return !bots.every(
    (bot) =>
      isObject(bot) &&
      emptyOrMissing(bot.routines) &&
      emptyOrMissing(bot.rules) &&
      Array.isArray(bot.messages) &&
      bot.messages.every((m) => isObject(m) && m.kind !== "user"),
  );
}
