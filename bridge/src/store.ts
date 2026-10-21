import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MIRROR_PREFS, type Agent, type AgentMessage, type Avatar, type BotId, type Message, type MessageId, type RoutineId, type RunId } from "./protocol";
import { errorText } from "./text";
import {
  emptySession,
  emptyWorld,
  own,
  type AccountState,
  type AgentRecord,
  type BotRecord,
  type DeviceRecord,
  type ExchangeLog,
  type GateState,
  type GroupRecord,
  type MoveRecord,
  type Owned,
  type PushState,
  type SessionPrefs,
  type SessionRecord,
  type SessionState,
  type World,
} from "./world";

export const bridgeHome = () => process.env.CLAUDIOBOT_HOME ?? join(homedir(), ".claudiobot");

const STATE_VERSION = 3;

/**
 * Debounced save. "now" writes synchronously before returning: the path for state that must precede an effect. It
 * throws when the write fails, and the caller must then skip the effect.
 */
export type Persist = (urgency?: "now") => void;

type StateFileV3 = {
  version: 3;
  bots: BotRecord[];
  agents: AgentRecord[];
  gate: Owned<GateState>;
  devices: Owned<DeviceRecord[]>;
  push: Owned<PushState>;
  account: Owned<AccountState>;
  /** Absent in files from before exchanges kept their text. */
  exchanges?: Owned<ExchangeLog[]>;
  /** Absent in files from before groups: every record in bots is a plain bot, and there are no groups. */
  groups?: GroupRecord[];
  /** Absent in files from before Sessions: no session was hidden or visited. */
  sessions?: SessionRecord[];
  sessionPrefs?: Owned<SessionPrefs>;
  /** Absent in files from before world moves: this home never exported or imported one. */
  moves?: Owned<MoveRecord[]>;
};

// Protocol 2's records, frozen here for the upgrade only.
type V2Routine = { id: RoutineId; name: string; schedule: string; describe: string; prompt: string; enabled: boolean; lastRunAt: string | null };
type V2Question = { kind: "question"; id: MessageId; at: string; question: string; options: string[]; answer: number | "dismissed" | null };
type V2Message = Exclude<Message, { kind: "question" | "permission" }> | V2Question;
type V2Bot = {
  id: BotId;
  name: string;
  title: string | null;
  avatar: Avatar;
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  routines: V2Routine[];
  messages: V2Message[];
  unread: number;
  sessionId: string | null;
};
type V2Agent = { agent: Omit<Agent, "status"> & { status: "working" | "waiting" | "failed" | "in_cloud" }; cwd: string; messages: AgentMessage[]; sessionId: string | null };
export type StateFileV2 = { version: 2; bots: V2Bot[]; agents: V2Agent[] };

/** loadWorld refused the state file. The file is untouched; the message says why and what to do. */
export class StateFileError extends Error {}

// Only what the bridge reads without a check. Keys not named here are kept as they are.
const text = z.string();
const maybeText = z.string().nullable();
const anyObject = z.looseObject({});
const profile = {
  id: text,
  name: text,
  title: maybeText,
  avatar: z.looseObject({ shape: text, color: text }),
  pinned: z.boolean(),
  hidden: z.boolean(),
  createdAt: text,
  messages: z.array(z.looseObject({ kind: text, id: text, at: text })),
  unread: z.number(),
};
const agentThread = {
  agent: z.looseObject({
    id: text,
    botId: text,
    title: text,
    where: z.enum(["mac", "cloud"]),
    status: text,
    evidence: anyObject.nullable().optional(),
    worktree: z.looseObject({ path: text, branch: text }).nullable().optional(),
  }),
  cwd: text,
  messages: z.array(z.looseObject({ id: text, at: text, from: text, text })),
};
const V2_FILE = z.looseObject({
  bots: z.array(
    z.looseObject({
      ...profile,
      routines: z.array(z.looseObject({ id: text, name: text, schedule: text, prompt: text, enabled: z.boolean(), lastRunAt: maybeText })),
      sessionId: maybeText,
    }),
  ),
  agents: z.array(z.looseObject({ ...agentThread, sessionId: maybeText })),
});
const initiator = z.looseObject({ kind: z.enum(["user", "routine", "bot", "agent", "system"]) });
const session = z.looseObject({
  id: maybeText,
  pending: z.array(
    z.looseObject({
      id: text,
      kind: z.enum(["envelope", "continuation", "command"]).optional(),
      text,
      initiator,
      settles: z.looseObject({ routineId: text, runId: text }).nullable(),
      attempts: z.number(),
    }),
  ),
  lifecycle: z.looseObject({ kind: z.enum(["idle", "working", "stopping", "backoff", "parked"]) }),
  notices: z.array(z.looseObject({ text })),
});
const V3_FILE = z.looseObject({
  bots: z.array(
    z.looseObject({
      ...profile,
      dailyCapUsd: z.number().nullable(),
      muted: z.boolean().optional(),
      connectorsOff: z.array(text).optional(),
      session,
      routines: z.array(
        z.looseObject({
          id: text,
          name: text,
          trigger: z.discriminatedUnion("kind", [
            z.looseObject({ kind: z.literal("cron"), schedule: text }),
            z.looseObject({ kind: z.literal("webhook"), tokenHash: maybeText }),
          ]),
          prompt: text,
          enabled: z.boolean(),
          nextRunAt: maybeText,
          runs: z.array(z.looseObject({ id: text, at: text, status: text })),
          failStreak: z.number(),
        }),
      ),
      rules: z.array(z.looseObject({ decision: z.enum(["allow", "deny"]), signature: text })),
    }),
  ),
  agents: z.array(
    z.looseObject({
      ...agentThread,
      session,
      cloudSession: maybeText,
      budgetUsd: z.number().nullable(),
      startedBy: initiator,
      unreported: z.array(z.looseObject({ status: text, text, by: initiator })).optional(),
    }),
  ),
  gate: z.looseObject({ open: z.array(anyObject), grants: z.array(anyObject), daily: z.array(anyObject), repos: z.array(anyObject).optional() }),
  devices: z.array(anyObject),
  push: z.looseObject({ sent: z.array(anyObject) }),
  account: z.looseObject({ parkedUntil: maybeText }),
  exchanges: z.array(z.looseObject({ bots: z.tuple([text, text]), messages: z.array(z.looseObject({ id: text, at: text, from: text, text })) })).optional(),
  groups: z.array(z.looseObject({ ...profile, muted: z.boolean(), members: z.array(text) })).optional(),
  sessions: z.array(z.looseObject({ id: text, hidden: z.boolean(), visitedAt: maybeText })).optional(),
  sessionPrefs: z.looseObject({ mirror: z.enum(MIRROR_PREFS) }).optional(),
  moves: z
    .array(
      z.discriminatedUnion("kind", [
        z.looseObject({ kind: z.literal("out"), moveId: text, at: text, phase: z.enum(["frozen", "done"]), held: z.looseObject({ bots: z.array(anyObject), groups: z.array(anyObject), exchanges: z.array(anyObject) }).optional() }),
        z.looseObject({ kind: z.literal("in"), moveId: text, at: text }),
      ]),
    )
    .optional(),
});

/**
 * v2 → v3, pure. Nothing is dropped:
 * - sessionId → session.id (mac agents) or cloudSession (cloud agents). The cost baseline lives in the ledger, so a
 *   session with no ledger row adopts its first result and charges nothing.
 * - routines get trigger {cron, schedule}; lastRunAt becomes one "ok" run; nextRunAt stays null for the scheduler.
 * - questions get expiresAt null: cards from before protocol 3 never expire.
 * - agents get startedBy system: protocol 2 never recorded who started them.
 * - no standing rules, default caps and budgets, an empty gate, no devices.
 */
export function upgradeV2(v2: StateFileV2): StateFileV3 {
  const bots = v2.bots.map(({ sessionId, routines, messages, ...profile }): BotRecord => ({
    ...profile,
    messages: messages.map((m): Message => (m.kind === "question" ? { ...m, expiresAt: null } : m)),
    dailyCapUsd: null,
    muted: false,
    connectorsOff: [],
    session: emptySession(sessionId),
    routines: routines.map((r) => ({
      id: r.id,
      name: r.name,
      trigger: { kind: "cron" as const, schedule: r.schedule },
      prompt: r.prompt,
      enabled: r.enabled,
      nextRunAt: null,
      runs: r.lastRunAt === null ? [] : [{ id: `run_v2_${r.id}` as RunId, at: r.lastRunAt, status: "ok" as const, late: false, manual: false, note: null }],
      failStreak: 0,
    })),
    rules: [],
  }));
  const agents = v2.agents.map(({ sessionId, ...rest }): AgentRecord => ({
    ...rest,
    agent: { ...rest.agent, evidence: null, worktree: null },
    session: emptySession(rest.agent.where === "mac" ? sessionId : null),
    cloudSession: rest.agent.where === "cloud" ? sessionId : null,
    budgetUsd: null,
    startedBy: { kind: "system" },
  }));
  const world = emptyWorld();
  return { version: 3, bots, agents, gate: world.gate, devices: world.devices, push: world.push, account: world.account, exchanges: world.exchanges };
}

/**
 * Writes the whole body to a fresh temp file, fsyncs it, checks its size, renames it over `path`, then fsyncs the
 * directory so the rename is recorded too. A crash of this process leaves the old file or the new one, never part of
 * one. That is the whole guarantee: on macOS fsync does not flush the drive's own cache (only F_FULLFSYNC does), so a
 * power loss can still lose the newest write.
 */
function writeAtomic(path: string, body: string | Uint8Array) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  // Unique per write, so two writers (an old process still exiting) never write into the same temp file.
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const size = fstatSync(fd).size;
      if (size !== bytes.length) throw new Error(`${tmp} holds ${size} of ${bytes.length} bytes`);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * Appends one JSON line per row to `path` (0600, in a 0700 directory) and fsyncs it, so a caller may drop the rows from
 * state.json once this returns. A crash before that save leaves the rows in both places, and they are archived again:
 * readers dedupe by id.
 */
export function appendArchive(path: string, rows: readonly unknown[]) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies these exact bytes to `name`, or to `name.1`, `name.2`, … when earlier backups with other bytes hold those
 * names. A backup is never overwritten and the same bytes are never backed up twice, so a rerun after a crash converges.
 */
function backUp(home: string, name: string, raw: Buffer) {
  for (let n = 0; ; n++) {
    const path = join(home, n === 0 ? name : `${name}.${n}`);
    if (!existsSync(path)) return writeAtomic(path, raw);
    if (readFileSync(path).equals(raw)) return;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function refuse(path: string, why: string): StateFileError {
  return new StateFileError(
    `ClaudioBot will not start: ${path} ${why}. The file was not changed. ` +
      `If a newer bridge wrote it, update this one; otherwise restore a backup or move the file aside to start fresh.`,
  );
}

/** Why the file does not have the shape, or null when it does. */
function shapeError(schema: z.ZodType, file: unknown): string | null {
  const result = schema.safeParse(file);
  if (result.success) return null;
  const issue = result.error.issues[0]!;
  const where = issue.path.map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("").replace(/^\./, "");
  return `has an invalid ${where || "shape"} (${issue.message})`;
}

export type StateCheck =
  | { kind: "v3"; bots: number; devices: number }
  | { kind: "v2"; bots: number }
  | { kind: "v1" }
  /** why reads after "state.json": "has version 4, which …". */
  | { kind: "refused"; why: string };

/** Pure: what loadWorld would do with this parsed state.json. The doctor asks the same question without loading it. */
export function checkStateFile(parsed: unknown): StateCheck {
  if (!isObject(parsed)) return { kind: "refused", why: "is not a JSON object" };
  switch (parsed.version) {
    case 3: {
      const why = shapeError(V3_FILE, parsed);
      return why ? { kind: "refused", why } : { kind: "v3", bots: (parsed.bots as unknown[]).length, devices: (parsed.devices as unknown[]).length };
    }
    case 2: {
      const why = shapeError(V2_FILE, parsed);
      return why ? { kind: "refused", why } : { kind: "v2", bots: (parsed.bots as unknown[]).length };
    }
    case 1:
      return { kind: "v1" };
    default:
      return { kind: "refused", why: `has version ${JSON.stringify(parsed.version)}, which this bridge (version ${STATE_VERSION}) does not know` };
  }
}

function fromV3(file: StateFileV3): World {
  // A file written before Pending.kind marked an approval continuation by the c_ prefix of its id.
  for (const rec of [...file.bots, ...file.agents])
    for (const p of own<SessionState>(rec.session).pending) p.kind ??= p.id.startsWith("c_") ? "continuation" : "envelope";
  own<GateState>(file.gate).repos ??= [];
  // Fields added after version 3 shipped. A file from before them reads as their empty value.
  for (const bot of file.bots) {
    bot.muted ??= false;
    if (bot.connectorsOff === undefined) Object.assign(bot, { connectorsOff: [] });
  }
  for (const rec of file.agents) rec.agent = { ...rec.agent, evidence: rec.agent.evidence ?? null, worktree: rec.agent.worktree ?? null };
  // A member is a bot of this file; a hand-edited file may name one that is gone.
  const botIds = new Set(file.bots.map((b) => b.id));
  for (const group of file.groups ?? []) group.members = group.members.filter((id) => botIds.has(id));
  return {
    bots: new Map(file.bots.map((b) => [b.id, b])),
    groups: new Map((file.groups ?? []).map((g) => [g.id, g])),
    agents: new Map(file.agents.map((a) => [a.agent.id, a])),
    gate: file.gate,
    devices: file.devices,
    push: file.push,
    account: file.account,
    exchanges: file.exchanges ?? [],
    sessions: new Map((file.sessions ?? []).map((r) => [r.id, r])),
    sessionPrefs: file.sessionPrefs ?? { mirror: "auto" },
    moves: file.moves ?? [],
  };
}

const toFile = (world: World): StateFileV3 => ({
  version: 3,
  bots: [...world.bots.values()],
  agents: [...world.agents.values()],
  gate: world.gate,
  devices: world.devices,
  push: world.push,
  account: world.account,
  exchanges: world.exchanges,
  groups: [...world.groups.values()],
  sessions: [...world.sessions.values()],
  sessionPrefs: world.sessionPrefs,
  moves: world.moves,
});

/**
 * Fails closed. No file: first run. Version 3: as is, once every record has the shape the bridge reads. Version 2:
 * check every record and upgrade in memory, back the exact bytes up to state.v2.json.bak (or the next free suffix),
 * then write v3 in place. Version 1 (the old task list, which v3 does not carry over): back up to state.v1.json.bak
 * the same way, then first run, as before. Anything else, including unreadable JSON, a malformed record or a failed
 * upgrade, throws StateFileError and writes nothing. Running it again after a crash at any point converges.
 */
export function loadWorld(home = bridgeHome()): { world: World; firstRun: boolean } {
  const path = join(home, "state.json");
  if (!existsSync(path)) return { world: emptyWorld(), firstRun: true };
  const raw = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw refuse(path, `is not valid JSON (${errorText(e)})`);
  }
  const checked = checkStateFile(parsed);
  switch (checked.kind) {
    case "refused":
      throw refuse(path, checked.why);
    case "v3":
      return { world: fromV3(parsed as StateFileV3), firstRun: false };
    case "v2": {
      let upgraded: StateFileV3;
      try {
        upgraded = upgradeV2(parsed as StateFileV2);
      } catch (e) {
        throw refuse(path, `could not be upgraded (${errorText(e)})`);
      }
      backUp(home, "state.v2.json.bak", raw);
      writeAtomic(path, JSON.stringify(upgraded));
      return { world: fromV3(upgraded), firstRun: false };
    }
    case "v1":
      backUp(home, "state.v1.json.bak", raw);
      return { world: emptyWorld(), firstRun: true };
  }
}

/** The synchronous save: returns once state.json is on disk. */
export function flushNow(world: World, home = bridgeHome()) {
  writeAtomic(join(home, "state.json"), JSON.stringify(toFile(world)));
}

const MAX_RETRY_MS = 30_000;

/**
 * The hub's Persist. schedule() writes within delayMs. A failed background write is logged, stays pending and is
 * retried with a doubling delay up to 30 s, so nothing is lost while the process lives. schedule("now") and flush()
 * write before returning and throw when the write fails, with the retry still armed.
 */
export function createSaver(world: World, home = bridgeHome(), delayMs = 250, log: (line: string) => void = console.error) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = delayMs;
  const arm = (ms: number) => {
    timer ??= setTimeout(background, ms);
  };
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      flushNow(world, home);
      retryMs = delayMs;
    } catch (e) {
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      arm(retryMs);
      throw e;
    }
  }
  function background() {
    timer = null;
    try {
      flush();
    } catch (e) {
      log(`state.json was not saved, retrying in ${retryMs} ms: ${errorText(e)}`);
    }
  }
  const schedule: Persist = (urgency) => {
    if (urgency === "now") return flush();
    arm(delayMs);
  };
  return { schedule, flush };
}
