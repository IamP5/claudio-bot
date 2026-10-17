// The rename from ~/.claudebot to ~/.claudiobot. Runs first, before anything opens a file in the home. Owner: U7.
// Resume finds transcripts by session id, so a symlink in either direction keeps every bot's session (probe Q8).
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { botMemory, DEFAULT_BOT, defaultBotJob } from "./prompts";

const OLD = ".claudebot";
const NEW = ".claudiobot";

type Outcome =
  /** CLAUDIOBOT_HOME is set, there is no old home, the link is already in place, or only the new home holds user data. */
  | { kind: "none" }
  /** The old home existed and the new one did not: linked. */
  | { kind: "linked"; from: string; to: string }
  /** Both existed and the new one was exactly what first run leaves (or empty, or a dangling link): moved aside, then linked. */
  | { kind: "moved_aside"; from: string; to: string; aside: string }
  /** Both hold user data, or the new path is not a directory. Nothing is touched; the caller prints message and uses the new home. */
  | { kind: "conflict"; from: string; to: string; message: string };

export type Migration = Outcome & {
  /** CLAUDEBOT_HOME, protocol 2's override, when still set. Only reported, so the caller can warn that it is ignored. */
  legacyEnv: string | null;
};

/** The only two writes. Injectable so a test can fail or crash either one. */
export type MigrationFs = { renameSync: typeof renameSync; symlinkSync: typeof symlinkSync };

/**
 * The caller must hold the bridge's single-instance lock before calling: two bridges migrating at once could both
 * judge the new home fresh and race the rename and the link.
 *
 * Every step is guarded by what exists on disk, so a second run, or a run after a crash mid-way, converges.
 * The old home is never written, so it resolves at every step. The link is relative, so `.claudiobot -> .claudebot`.
 * A failed rename or link throws with nothing else changed.
 */
export function migrateHome(deps: {
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  fs?: MigrationFs;
}): Migration {
  const legacyEnv = deps.env.CLAUDEBOT_HOME ?? null;
  if (deps.env.CLAUDIOBOT_HOME !== undefined) return { kind: "none", legacyEnv };
  return { ...decide(deps.home, deps.now(), deps.fs ?? { renameSync, symlinkSync }), legacyEnv };
}

function decide(home: string, at: Date, fs: MigrationFs): Outcome {
  const from = join(home, OLD);
  const to = join(home, NEW);
  if (!existsSync(from)) return { kind: "none" };

  const entry = entryAt(to);
  if (entry === "absent") {
    fs.symlinkSync(OLD, to);
    return { kind: "linked", from, to };
  }
  if (entry === "directory" && realpathSync(to) === realpathSync(from)) return { kind: "none" };
  if (entry === "dangling" || (entry === "directory" && !holdsUserData(to))) {
    const aside = freeAside(to, at);
    fs.renameSync(to, aside);
    fs.symlinkSync(OLD, to);
    return { kind: "moved_aside", from, to, aside };
  }
  if (entry === "directory" && !holdsUserData(from)) return { kind: "none" };
  return {
    kind: "conflict",
    from,
    to,
    message:
      `ClaudioBot found data in both ${from} and ${to}. It is using ${to} and has not touched ${from}. ` +
      `To use the data in ${from} instead, stop the bridge, move ${to} somewhere else, and start the bridge again: ` +
      `it will link ${to} to ${from}.`,
  };
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** A dangling link is an entry that must be moved before the link can be made; anything not a directory is not a home. */
function entryAt(path: string): "absent" | "dangling" | "directory" | "other" {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return "absent";
  }
  try {
    return statSync(path).isDirectory() ? "directory" : "other";
  } catch (e) {
    return isLink && errno(e) === "ENOENT" ? "dangling" : "other";
  }
}

function freeAside(to: string, at: Date): string {
  const base = `${to}.pre-migrate-${at.toISOString().replace(/[:.]/g, "-")}`;
  let aside = base;
  for (let n = 2; entryAt(aside) !== "absent"; n++) aside = `${base}-${n}`;
  return aside;
}

/**
 * A whitelist of what first run leaves, so anything else, or anything this cannot read or classify, is user data and
 * the home is never moved. Reads state.json, USER.md and each bot's CLAUDE.md; never the token; writes nothing.
 */
function holdsUserData(dir: string): boolean {
  try {
    return !isFreshHome(dir);
  } catch {
    return true;
  }
}

function isFreshHome(dir: string): boolean {
  const raw = readFileIfPresent(join(dir, "state.json"));
  const state: unknown = raw === null ? null : JSON.parse(raw);
  if (state !== null && !isFreshState(state)) return false;
  const botIds = state === null ? [] : state.bots.map((bot) => bot.id);

  for (const name of listIfPresent(join(dir, "bots"))) {
    const botHome = join(dir, "bots", name);
    if (!botIds.includes(name) || !lstatSync(botHome).isDirectory()) return false;
    if (!holdsNoFiles(join(botHome, "library")) || !holdsNoFiles(join(botHome, "inbox"))) return false;
    const memory = readFileIfPresent(join(botHome, "CLAUDE.md"));
    if (memory !== null && !DEFAULT_MEMORY.test(memory.trim())) return false;
  }
  const userMd = readFileIfPresent(join(dir, "USER.md"));
  if (userMd !== null && !/^# About [^\n]*$/.test(userMd.trim())) return false;
  return holdsNoFiles(join(dir, "trash"));
}

// The default bot as hub.ts boot creates it; first run differs only in the user's name.
const USER_NAME = "\u0000";
const DEFAULT_MEMORY = new RegExp(
  `^${escapeRegExp(botMemory({ name: DEFAULT_BOT.name, job: defaultBotJob(USER_NAME) }).trim()).replace(USER_NAME, "[^\\n]*")}$`,
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isEmptyArray = (v: unknown) => Array.isArray(v) && v.length === 0;
const emptyOrMissing = (v: unknown) => v === undefined || isEmptyArray(v);

/** A v2 or v3 state with no agents and at most one bot, the untouched default, and (v3) nothing in the gate, devices, pushes or parking. */
function isFreshState(file: unknown): file is { bots: { id: string }[] } {
  if (!isObject(file) || (file.version !== 2 && file.version !== 3)) return false;
  if (!isEmptyArray(file.agents) || !Array.isArray(file.bots) || file.bots.length > 1 || !file.bots.every(isFreshBot)) return false;
  if (file.version === 2) return true;
  const { gate, devices, push, account } = file;
  return (
    isObject(gate) &&
    isEmptyArray(gate.open) &&
    isEmptyArray(gate.grants) &&
    isEmptyArray(gate.daily) &&
    isEmptyArray(devices) &&
    isObject(push) &&
    isEmptyArray(push.sent) &&
    isObject(account) &&
    account.parkedUntil === null
  );
}

function isFreshBot(bot: unknown): boolean {
  return (
    isObject(bot) &&
    typeof bot.id === "string" &&
    bot.name === DEFAULT_BOT.name &&
    bot.title === null &&
    isObject(bot.avatar) &&
    bot.avatar.shape === DEFAULT_BOT.avatar.shape &&
    bot.avatar.color === DEFAULT_BOT.avatar.color &&
    bot.pinned === false &&
    bot.hidden === false &&
    (bot.dailyCapUsd === undefined || bot.dailyCapUsd === null) &&
    emptyOrMissing(bot.routines) &&
    emptyOrMissing(bot.rules) &&
    Array.isArray(bot.messages) &&
    bot.messages.every((m) => isObject(m) && m.kind === "bot")
  );
}

/** null when absent. Throws for anything that is there but not a regular file. */
function readFileIfPresent(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    throw e;
  }
  return readFileSync(path, "utf8");
}

function listIfPresent(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (errno(e) === "ENOENT") return [];
    throw e;
  }
}

/** Empty folders are fine; any other entry, at any depth, is a file someone put there. */
function holdsNoFiles(dir: string): boolean {
  return listIfPresent(dir).every((name) => lstatSync(join(dir, name)).isDirectory() && holdsNoFiles(join(dir, name)));
}
