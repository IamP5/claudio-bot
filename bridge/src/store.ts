import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Agent, AgentMessage, Avatar, BotId, Message, MessageId, RoutineId, RunId } from "./protocol";
import {
  emptySession,
  emptyWorld,
  type AccountState,
  type AgentRecord,
  type BotRecord,
  type DeviceRecord,
  type GateState,
  type Owned,
  type PushState,
  type World,
} from "./world";

export const bridgeHome = () => process.env.CLAUDIOBOT_HOME ?? join(homedir(), ".claudiobot");

export const STATE_VERSION = 3;

/**
 * Debounced save. "now" writes synchronously before returning: the path for state that must precede an effect. It
 * throws when the write fails, and the caller must then skip the effect.
 */
export type Persist = (urgency?: "now") => void;

export type StateFileV3 = {
  version: 3;
  bots: BotRecord[];
  agents: AgentRecord[];
  gate: Owned<GateState>;
  devices: Owned<DeviceRecord[]>;
  push: Owned<PushState>;
  account: Owned<AccountState>;
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
  agent: z.looseObject({ id: text, botId: text, title: text, where: z.enum(["mac", "cloud"]), status: text }),
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
  pending: z.array(z.looseObject({ id: text, text, initiator, settles: z.looseObject({ routineId: text, runId: text }).nullable(), attempts: z.number() })),
  lifecycle: z.looseObject({ kind: z.enum(["idle", "working", "stopping", "backoff", "parked"]) }),
  notices: z.array(z.looseObject({ text })),
});
const V3_FILE = z.looseObject({
  bots: z.array(
    z.looseObject({
      ...profile,
      dailyCapUsd: z.number().nullable(),
      session,
      routines: z.array(
        z.looseObject({
          id: text,
          name: text,
          trigger: z.looseObject({ kind: z.literal("cron"), schedule: text }),
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
  agents: z.array(z.looseObject({ ...agentThread, session, cloudSession: maybeText, budgetUsd: z.number().nullable(), startedBy: initiator })),
  gate: z.looseObject({ open: z.array(anyObject), grants: z.array(anyObject), daily: z.array(anyObject) }),
  devices: z.array(anyObject),
  push: z.looseObject({ sent: z.array(anyObject) }),
  account: z.looseObject({ parkedUntil: maybeText }),
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
    session: emptySession(rest.agent.where === "mac" ? sessionId : null),
    cloudSession: rest.agent.where === "cloud" ? sessionId : null,
    budgetUsd: null,
    startedBy: { kind: "system" },
  }));
  const world = emptyWorld();
  return { version: 3, bots, agents, gate: world.gate, devices: world.devices, push: world.push, account: world.account };
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

function check(schema: z.ZodType, file: unknown, path: string) {
  const result = schema.safeParse(file);
  if (result.success) return;
  const issue = result.error.issues[0]!;
  const where = issue.path.map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("").replace(/^\./, "");
  throw refuse(path, `has an invalid ${where || "shape"} (${issue.message})`);
}

function fromV3(file: StateFileV3): World {
  return {
    bots: new Map(file.bots.map((b) => [b.id, b])),
    agents: new Map(file.agents.map((a) => [a.agent.id, a])),
    gate: file.gate,
    devices: file.devices,
    push: file.push,
    account: file.account,
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
    throw refuse(path, `is not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(parsed)) throw refuse(path, "is not a JSON object");
  switch (parsed.version) {
    case 3:
      check(V3_FILE, parsed, path);
      return { world: fromV3(parsed as StateFileV3), firstRun: false };
    case 2: {
      check(V2_FILE, parsed, path);
      let upgraded: StateFileV3;
      try {
        upgraded = upgradeV2(parsed as StateFileV2);
      } catch (e) {
        throw refuse(path, `could not be upgraded (${(e as Error).message})`);
      }
      backUp(home, "state.v2.json.bak", raw);
      writeAtomic(path, JSON.stringify(upgraded));
      return { world: fromV3(upgraded), firstRun: false };
    }
    case 1:
      backUp(home, "state.v1.json.bak", raw);
      return { world: emptyWorld(), firstRun: true };
    default:
      throw refuse(path, `has version ${JSON.stringify(parsed.version)}, which this bridge (version ${STATE_VERSION}) does not know`);
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
      log(`state.json was not saved, retrying in ${retryMs} ms: ${(e as Error).message}`);
    }
  }
  const schedule: Persist = (urgency) => {
    if (urgency === "now") return flush();
    arm(delayMs);
  };
  return { schedule, flush };
}
