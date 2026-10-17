import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Debounced save. "now" writes synchronously before returning: the path for state that must precede an effect. */
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

/**
 * v2 → v3, pure. Nothing is dropped:
 * - sessionId → session.id (mac agents) or cloudSession (cloud agents). The cost baseline lives in the ledger, so a
 *   session with no ledger row adopts its first result and charges nothing.
 * - routines get trigger {cron, schedule}; lastRunAt becomes one "ok" run; nextRunAt stays null for the scheduler.
 * - questions get expiresAt null: cards from before protocol 3 never expire.
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
  }));
  const world = emptyWorld();
  return { version: 3, bots, agents, gate: world.gate, devices: world.devices, push: world.push, account: world.account };
}

/** Write to a temp file, fsync, then rename: a crash leaves the old file or the new one, never half of one. */
function writeAtomic(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function refuse(path: string, why: string): StateFileError {
  return new StateFileError(
    `ClaudioBot will not start: ${path} ${why}. The file was not changed. ` +
      `If a newer bridge wrote it, update this one; otherwise restore a backup or move the file aside to start fresh.`,
  );
}

function checkShape(file: Record<string, unknown>, path: string, keys: Record<string, "array" | "object">) {
  for (const [key, kind] of Object.entries(keys)) {
    const ok = kind === "array" ? Array.isArray(file[key]) : isObject(file[key]);
    if (!ok) throw refuse(path, `has no valid "${key}"`);
  }
}

const V2_KEYS = { bots: "array", agents: "array" } as const;
const V3_KEYS = { bots: "array", agents: "array", gate: "object", devices: "array", push: "object", account: "object" } as const;

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
 * Fails closed. No file: first run. Version 3: as is. Version 2: copy the exact bytes to state.v2.json.bak, then
 * upgrade in place. Version 1 (the old task list, which v3 does not carry over): back up to state.v1.json.bak, then
 * first run, as before. Anything else, including unreadable JSON, throws StateFileError and writes nothing.
 * Running it again after a crash at any point converges: the backup is rewritten from the same v2 bytes.
 */
export function loadWorld(home = bridgeHome()): { world: World; firstRun: boolean } {
  const path = join(home, "state.json");
  if (!existsSync(path)) return { world: emptyWorld(), firstRun: true };
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw refuse(path, `is not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(parsed)) throw refuse(path, "is not a JSON object");
  switch (parsed.version) {
    case 3:
      checkShape(parsed, path, V3_KEYS);
      return { world: fromV3(parsed as StateFileV3), firstRun: false };
    case 2: {
      checkShape(parsed, path, V2_KEYS);
      writeAtomic(join(home, "state.v2.json.bak"), raw);
      const upgraded = upgradeV2(parsed as StateFileV2);
      writeAtomic(path, JSON.stringify(upgraded));
      return { world: fromV3(upgraded), firstRun: false };
    }
    case 1:
      writeAtomic(join(home, "state.v1.json.bak"), raw);
      return { world: emptyWorld(), firstRun: true };
    default:
      throw refuse(path, `has version ${JSON.stringify(parsed.version)}, which this bridge (version ${STATE_VERSION}) does not know`);
  }
}

/** The synchronous save: returns once state.json is on disk. */
export function flushNow(world: World, home = bridgeHome()) {
  writeAtomic(join(home, "state.json"), JSON.stringify(toFile(world)));
}

export function createSaver(world: World, home = bridgeHome(), delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    flushNow(world, home);
  };
  const schedule: Persist = (urgency) => {
    if (urgency === "now") return flush();
    timer ??= setTimeout(flush, delayMs);
  };
  return { schedule, flush };
}

export async function loadOrCreateToken(home = bridgeHome()): Promise<string> {
  const file = Bun.file(join(home, "token"));
  if (await file.exists()) {
    const token = (await file.text()).trim();
    if (token !== "") return token;
  }
  mkdirSync(home, { recursive: true });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  await Bun.write(file, token + "\n");
  chmodSync(join(home, "token"), 0o600);
  return token;
}
