import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { createHomes } from "./home";
import { lockHome } from "./lock";
import { mergeFacts } from "./memory";
import { notices } from "./prompts";
import { readIdentity } from "./machine/identity";
import { createPlacements } from "./machine/placements";
import type { MachineId } from "./machine/wire";
import type { AgentId, BotId } from "./protocol";
import { checkStateFile, flushNow, loadWorld, writeAtomic } from "./store";
import {
  EXCHANGE_KEEP,
  own,
  type BotRecord,
  type DeviceRecord,
  type ExchangeLog,
  type GroupRecord,
  type MoveId,
  type MoveRecord,
  type PushState,
  type SessionState,
  type World,
} from "./world";

// Moving a world from one bridge home to another (docs/world-move.md). Export freezes this home's bots and packs them
// with their files into one bundle; import unions it into another home by id; finish trashes the frozen bots' homes.
// Each step runs with the bridge stopped and converges when rerun.

export type BundleWorld = {
  bots: BotRecord[];
  groups: GroupRecord[];
  exchanges: ExchangeLog[];
  devices: DeviceRecord[];
  push: PushState;
};

/** data: the file's bytes, base64. path: relative to the bridge home. */
export type BundleFile = { path: string; data: string };

/**
 * from.machineId: the exporting bridge's id in its machine.json, when it has one. agents: the agents that stay on it, by
 * their moved bot, so the importing home hears them once that bridge enrolls as its machine.
 */
export type MoveBundle = {
  format: 1;
  moveId: MoveId;
  from: { machine: string; at: string; machineId?: MachineId };
  world: BundleWorld;
  files: BundleFile[];
  agents?: { id: AgentId; botId: BotId }[];
};

type Frozen = Extract<MoveRecord, { phase: "frozen" }>;

const newMoveId = () => `mv_${crypto.randomUUID()}` as MoveId;

// ---- Pure merges over the slices. Incoming wins on a shared id, since the move is newer than any earlier copy.

/** Union by id, oldest first. A message on both sides is the incoming one; no message on either side is dropped. */
export function mergeMessages<M extends { id: string; at: string }>(local: readonly M[], incoming: readonly M[]): M[] {
  const byId = new Map<string, M>();
  for (const m of local) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Union by key: a record on both sides keeps the local one when `prefer` is "local", else the incoming one. */
export function unionBy<T>(local: readonly T[], incoming: readonly T[], key: (t: T) => string, prefer: "local" | "incoming"): T[] {
  const byKey = new Map<string, T>();
  for (const t of local) byKey.set(key(t), t);
  for (const t of incoming) if (prefer === "incoming" || !byKey.has(key(t))) byKey.set(key(t), t);
  return [...byKey.values()];
}

/**
 * The bot as it lands on the new machine. Its Claude Code transcript stayed behind, so the session starts fresh (id
 * null) with a notice that says why, rather than failing a resume first. Its queued inbox comes along. Permission cards
 * still open expire: the gate that held them is on the old machine. Open questions stay open, and the new gate adopts them.
 */
export function arrive(bot: BotRecord, move: { from: string; to: string; at: string }): BotRecord {
  const expired: { tool: string; detail: string }[] = [];
  const messages = bot.messages.map((m) => {
    if (m.kind !== "permission" || m.answer !== null) return m;
    if (m.from === null) expired.push({ tool: m.tool, detail: m.detail });
    return { ...m, answer: "expired" as const };
  });
  const old = own<SessionState>(bot.session);
  const session: SessionState = {
    id: null,
    pending: old.pending,
    lifecycle: { kind: "idle" },
    notices: [...old.notices, { at: move.at, text: notices.moved(move.from, move.to, expired) }],
  };
  return { ...bot, messages, session };
}

/** A bot on both sides: the incoming record, with every local message and queued envelope kept. */
export function mergeBot(local: BotRecord | undefined, incoming: BotRecord): BotRecord {
  if (!local) return incoming;
  const session = own<SessionState>(incoming.session);
  const pending = unionBy(own<SessionState>(local.session).pending, session.pending, (p) => p.id, "incoming");
  return { ...incoming, messages: mergeMessages(local.messages, incoming.messages), session: { ...session, pending } };
}

export function mergeGroup(local: GroupRecord | undefined, incoming: GroupRecord): GroupRecord {
  return local ? { ...incoming, messages: mergeMessages(local.messages, incoming.messages) } : incoming;
}

export function mergeExchanges(local: readonly ExchangeLog[], incoming: readonly ExchangeLog[]): ExchangeLog[] {
  const key = (l: ExchangeLog) => l.bots.join("|");
  const out = local.map((l) => ({ ...l }));
  for (const log of incoming) {
    const mine = out.find((l) => key(l) === key(log));
    if (!mine) out.push(log);
    else mine.messages = mergeMessages(mine.messages, log.messages).slice(-EXCHANGE_KEEP);
  }
  return out;
}

/** The phone's token works on both sides. Protocol 2's shared-token device stays with its token file and never moves. */
export const mergeDevices = (local: readonly DeviceRecord[], incoming: readonly DeviceRecord[]): DeviceRecord[] =>
  unionBy(
    local,
    incoming.filter((d) => !d.legacy),
    (d) => d.id,
    "local",
  );

/**
 * An append-only jsonl file after a move: the local lines, then each incoming line not already there. Usage rows are
 * summed on read with no dedupe (ledger.ts), so a replayed line must never be appended twice.
 */
export function unionLines(local: string, incoming: string): string {
  const have = new Set(local.split("\n"));
  const add: string[] = [];
  for (const line of incoming.split("\n")) {
    if (line === "" || have.has(line)) continue;
    have.add(line);
    add.push(line);
  }
  if (add.length === 0) return local;
  return `${local}${local === "" || local.endsWith("\n") ? "" : "\n"}${add.join("\n")}\n`;
}

/**
 * A bot or group coming back to the bridge that froze it (a round trip before finish) is live here again: it leaves the
 * frozen move, and a move with nothing left frozen is done, so finish trashes nothing that came back.
 */
function thaw(world: World, ids: ReadonlySet<string>) {
  const moves = own<MoveRecord[]>(world.moves);
  moves.forEach((m, i) => {
    if (m.kind !== "out" || m.phase !== "frozen") return;
    const bots = m.held.bots.filter((b) => !ids.has(b.id));
    const groups = m.held.groups.filter((g) => !ids.has(g.id));
    moves[i] =
      bots.length === 0 && groups.length === 0
        ? { kind: "out", moveId: m.moveId, at: m.at, machine: m.machine, phase: "done" }
        : { ...m, held: { ...m.held, bots, groups } };
  });
}

/** The incoming world unioned into this one, and the move recorded. Mutates world. */
export function applyBundle(world: World, bundle: MoveBundle, to: string, at: string) {
  thaw(world, new Set([...bundle.world.bots.map((b) => b.id as string), ...bundle.world.groups.map((g) => g.id as string)]));
  const move = { from: bundle.from.machine, to, at };
  for (const bot of bundle.world.bots) world.bots.set(bot.id, mergeBot(world.bots.get(bot.id), arrive(bot, move)));
  for (const group of bundle.world.groups) {
    const merged = mergeGroup(world.groups.get(group.id), group);
    world.groups.set(group.id, { ...merged, members: merged.members.filter((id) => world.bots.has(id)) });
  }
  const swap = <T>(slice: T[], next: T[]) => slice.splice(0, slice.length, ...next);
  swap(own<ExchangeLog[]>(world.exchanges), mergeExchanges(own<ExchangeLog[]>(world.exchanges), bundle.world.exchanges));
  swap(own<DeviceRecord[]>(world.devices), mergeDevices(own<DeviceRecord[]>(world.devices), bundle.world.devices));
  const push = own<PushState>(world.push);
  swap(push.sent, unionBy(push.sent, bundle.world.push.sent, (s) => s.key, "local"));
  own<MoveRecord[]>(world.moves).push({ kind: "in", moveId: bundle.moveId, at, from: bundle.from.machine });
}

/** Takes every bot, group and exchange out of World.bots into a frozen move. Mutates world. */
export function freeze(world: World, moveId: MoveId, at: string, machine: string): Frozen {
  const move: Frozen = {
    kind: "out",
    moveId,
    at,
    machine,
    phase: "frozen",
    held: { bots: [...world.bots.values()], groups: [...world.groups.values()], exchanges: [...own<ExchangeLog[]>(world.exchanges)] },
  };
  world.bots.clear();
  world.groups.clear();
  own<ExchangeLog[]>(world.exchanges).splice(0);
  own<MoveRecord[]>(world.moves).push(move);
  return move;
}

/** A bot's scratch clones (work/) and Claude Code's own marker stay with the machine. */
const STAYS = new Set(["work", ".claude/.cc-writes"]);

function walk(root: string, dir: string, out: string[]) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (STAYS.has(relative(root, path))) continue;
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(root, path, out);
    else if (stat.isFile()) out.push(path);
  }
}

function filesOf(home: string, bots: readonly BotRecord[]): BundleFile[] {
  const paths: string[] = [];
  if (lstatSync(join(home, "USER.md"), { throwIfNoEntry: false })?.isFile()) paths.push(join(home, "USER.md"));
  for (const dir of ["usage", "audit", "groups"]) {
    const full = join(home, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) if (name.endsWith(".jsonl") && lstatSync(join(full, name)).isFile()) paths.push(join(full, name));
  }
  for (const bot of bots) {
    const root = join(home, "bots", bot.id);
    if (existsSync(root)) walk(root, root, paths);
  }
  return paths.map((path) => ({ path: relative(home, path), data: readFileSync(path).toString("base64") }));
}

/** Where a bundle path may land: the kinds of file export packs, and only under a bot the bundle brings. */
function allowedPath(path: string, bots: ReadonlySet<string>): boolean {
  if (path !== normalize(path) || path.startsWith("/") || path.split("/").includes("..")) return false;
  if (path === "USER.md" || /^(usage|audit|groups)\/[^/]+\.jsonl$/.test(path)) return true;
  const m = /^bots\/([^/]+)\/.+/.exec(path);
  return m !== null && bots.has(m[1]!);
}

/**
 * The folders from the home down to the file's, made one at a time. A symlink on the way is refused: it could point
 * the write anywhere, and the bundle's paths are checked only as text.
 */
function folderUnder(home: string, relDir: string): string {
  let dir = home;
  for (const part of relDir === "." ? [] : relDir.split("/")) {
    dir = join(dir, part);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`${dir} is a symlink, so nothing from the bundle is written through it`);
    if (stat && !stat.isDirectory()) throw new Error(`${dir} is in the way: it is not a folder`);
    if (!stat) mkdirSync(dir, { mode: 0o700 });
  }
  const real = realpathSync(dir);
  const root = realpathSync(home);
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${dir} resolves outside ${home}`);
  return dir;
}

function landFile(home: string, file: BundleFile) {
  const path = join(folderUnder(home, dirname(file.path)), file.path.split("/").at(-1)!);
  const incoming = Buffer.from(file.data, "base64");
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error(`${path} is in the way: it is not a regular file`);
  const local = existing ? readFileSync(path, "utf8") : null;
  let body: string | Buffer = incoming;
  if (local !== null && file.path === "USER.md") body = mergeFacts(local, incoming.toString("utf8"));
  else if (local !== null && file.path.endsWith(".jsonl")) body = unionLines(local, incoming.toString("utf8"));
  if (local !== null && Buffer.from(body).equals(Buffer.from(local))) return;
  writeAtomic(path, body);
}

const BUNDLE = z.object({
  format: z.literal(1),
  moveId: z.string().regex(/^mv_[\w-]+$/),
  from: z.object({ machine: z.string(), at: z.string(), machineId: z.string().regex(/^m_[0-9a-f-]{36}$/).optional() }),
  agents: z.array(z.object({ id: z.string().min(1), botId: z.string().min(1) })).optional(),
  world: z.object({
    bots: z.array(z.unknown()),
    groups: z.array(z.unknown()),
    exchanges: z.array(z.unknown()),
    devices: z.array(z.looseObject({ id: z.string(), tokenHash: z.string(), legacy: z.boolean() })),
    push: z.object({ sent: z.array(z.object({ key: z.string(), at: z.string() })) }),
  }),
  files: z.array(z.object({ path: z.string(), data: z.string() })),
});

/** The bundle, once its envelope and every record have the shapes the bridge reads; else why not. */
export function parseBundle(raw: unknown): MoveBundle | { error: string } {
  const outer = BUNDLE.safeParse(raw);
  if (!outer.success) return { error: `This is not a ClaudioBot world bundle (${outer.error.issues[0]!.message} at ${outer.error.issues[0]!.path.join(".")}).` };
  const w = outer.data.world;
  // The records go through the same check as a state.json, so an import never lands a record loadWorld would refuse.
  const check = checkStateFile({
    version: 3,
    bots: w.bots,
    groups: w.groups,
    exchanges: w.exchanges,
    devices: w.devices,
    push: w.push,
    agents: [],
    gate: { open: [], grants: [], daily: [] },
    account: { parkedUntil: null },
  });
  if (check.kind === "refused") return { error: `The bundle's world ${check.why}.` };
  const bots = new Set((w.bots as BotRecord[]).map((b) => b.id as string));
  const stray = outer.data.files.find((f) => !allowedPath(f.path, bots));
  if (stray) return { error: `The bundle names a file outside what a move carries: ${stray.path}` };
  return outer.data as unknown as MoveBundle;
}

// ---- The three commands. The caller holds the home lock.

export type MoveDeps = { home: string; machine: string; now: () => Date };

export type Exported = { kind: "exported"; moveId: MoveId; bundle: MoveBundle; fresh: boolean; left: number } | { kind: "empty" } | { kind: "machine"; home: string };

/**
 * Freezes this home's bots (once: a rerun packs the same frozen move again, with the same moveId) and returns the
 * bundle. The freeze is saved before the bundle is made, so a crash in between is finished by a rerun.
 */
export function exportWorld(deps: MoveDeps): Exported {
  const identity = readIdentity(deps.home);
  if (identity?.home) return { kind: "machine", home: identity.home.name };
  const { world, firstRun } = loadWorld(deps.home);
  if (firstRun) return { kind: "empty" };
  let move = own<MoveRecord[]>(world.moves).find((m): m is Frozen => m.kind === "out" && m.phase === "frozen");
  const fresh = move === undefined;
  if (!move) {
    if (world.bots.size === 0 && world.groups.size === 0) return { kind: "empty" };
    move = freeze(world, newMoveId(), deps.now().toISOString(), deps.machine);
    flushNow(world, deps.home);
  }
  const moved = new Set<string>(move.held.bots.map((b) => b.id));
  const bundle: MoveBundle = {
    format: 1,
    moveId: move.moveId,
    from: { machine: move.machine, at: move.at, ...(identity && { machineId: identity.machineId }) },
    agents: [...world.agents.values()].flatMap((r) => (moved.has(r.agent.botId) ? [{ id: r.agent.id, botId: r.agent.botId }] : [])),
    world: {
      bots: move.held.bots,
      groups: move.held.groups,
      exchanges: move.held.exchanges,
      devices: own<DeviceRecord[]>(world.devices).filter((d) => !d.legacy),
      push: own<PushState>(world.push),
    },
    files: filesOf(deps.home, move.held.bots),
  };
  return { kind: "exported", moveId: move.moveId, bundle, fresh, left: world.bots.size };
}

export type Imported =
  | { kind: "imported"; moveId: MoveId; from: string; bots: string[]; routines: number; devices: number }
  | { kind: "already"; moveId: MoveId; at: string }
  | { kind: "own"; moveId: MoveId }
  | { kind: "refused"; error: string };

/**
 * Lands the files, then saves the merged state.json with the move recorded. The save is the commit point: a crash
 * before it leaves a rerun to land the same files again, which changes nothing, and merge the state.
 */
export function importWorld(deps: MoveDeps, raw: unknown): Imported {
  const bundle = parseBundle(raw);
  if ("error" in bundle) return { kind: "refused", error: bundle.error };
  const { world } = loadWorld(deps.home);
  const seen = own<MoveRecord[]>(world.moves).find((m) => m.moveId === bundle.moveId);
  if (seen?.kind === "in") return { kind: "already", moveId: bundle.moveId, at: seen.at };
  if (seen?.kind === "out") return { kind: "own", moveId: bundle.moveId };
  mkdirSync(deps.home, { recursive: true, mode: 0o700 });
  for (const file of bundle.files) landFile(deps.home, file);
  const before = new Set(own<DeviceRecord[]>(world.devices).map((d) => d.id));
  applyBundle(world, bundle, deps.machine, deps.now().toISOString());
  const from = bundle.from.machineId;
  if (from) {
    // Before the state save, so a crash in between is redone by the rerun, which places them again.
    const placements = createPlacements({ path: join(deps.home, "machine", "placements.json"), log: () => {} });
    for (const a of bundle.agents ?? []) placements.place(a.id, { machine: from, botId: a.botId, by: { kind: "system" } });
  }
  flushNow(world, deps.home);
  return {
    kind: "imported",
    moveId: bundle.moveId,
    from: bundle.from.machine,
    bots: bundle.world.bots.map((b) => b.name),
    routines: bundle.world.bots.reduce((n, b) => n + b.routines.length, 0),
    devices: own<DeviceRecord[]>(world.devices).filter((d) => !before.has(d.id)).length,
  };
}

export type Finished = { kind: "finished"; bots: number } | { kind: "already" } | { kind: "unknown" };

/**
 * Trashes the frozen bots' homes, as delete does, then marks the move done. Homes go first: a crash before the save
 * leaves the move frozen, and a rerun finds the homes already gone. The agents of those bots stay, with their worktrees.
 */
export function finishMove(deps: MoveDeps, moveId: string): Finished {
  const { world } = loadWorld(deps.home);
  const moves = own<MoveRecord[]>(world.moves);
  const i = moves.findIndex((m) => m.kind === "out" && m.moveId === moveId);
  const move = moves[i];
  if (move?.kind !== "out") return { kind: "unknown" };
  if (move.phase === "done") return { kind: "already" };
  const homes = createHomes(deps.home);
  const at = deps.now();
  // A bot that came back before finish runs here again, from the home finish would trash.
  const gone = move.held.bots.filter((b) => !world.bots.has(b.id));
  for (const bot of gone) homes.trash(bot.id as BotId, at);
  moves[i] = { kind: "out", moveId: move.moveId, at: move.at, machine: move.machine, phase: "done" };
  flushNow(world, deps.home);
  return { kind: "finished", bots: gone.length };
}

export type WorldCommandDeps = MoveDeps & { cwd: string; out: (text: string) => void };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const WORLD_USAGE = `usage: claudiobot world <export [--out <file>] | import <file> | finish <moveId>>

  export  freeze this bridge's bots and write them, with their files, to one bundle
  import  union a bundle into this bridge's world; a bundle already imported changes nothing
  finish  on the machine that exported: trash the frozen bots' homes once they answer on the new one
`;

/** Runs one step with the home locked, so no bridge rewrites state.json under it. */
export function worldCommand(argv: string[], deps: WorldCommandDeps): number {
  const [step, arg] = argv;
  if ((step !== "export" && step !== "import" && step !== "finish") || (step !== "export" && arg === undefined)) {
    deps.out(WORLD_USAGE);
    return 2;
  }
  const lock = lockHome(deps.home);
  if (lock.kind !== "held") {
    const who = lock.kind === "busy" ? `A bridge (pid ${lock.pid}) is running on ${deps.home}` : `Something holds ${lock.path}`;
    deps.out(`${who}. Stop it first, then run this again: a move rewrites state.json, and a running bridge would overwrite it.\n`);
    return 1;
  }
  try {
    if (step === "export") return exportStep(deps, argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : undefined);
    if (step === "import") return importStep(deps, arg!);
    return finishStep(deps, arg!);
  } finally {
    lock.release();
  }
}

function exportStep(deps: WorldCommandDeps, out: string | undefined): number {
  const result = exportWorld(deps);
  if (result.kind === "empty") {
    deps.out(`No bots on ${deps.home} to move.\n`);
    return 1;
  }
  if (result.kind === "machine") {
    deps.out(`This bridge is a machine of "${result.home}", which holds the world. Export from the home.\n`);
    return 1;
  }
  const { bundle, moveId } = result;
  const path = resolve(deps.cwd, out ?? `claudiobot-world-${moveId}.json`);
  writeAtomic(path, JSON.stringify(bundle));
  const names = bundle.world.bots.map((b) => b.name).join(", ");
  deps.out(
    (result.fresh
      ? `Froze ${count(bundle.world.bots.length, "bot")} (${names}). They no longer run, fire routines or push here. Agents stay on this machine.\n`
      : `These bots were frozen earlier (${names}). This is the same move again.\n`) +
      `Wrote ${path}\n` +
      `Move ${moveId}. The file holds your chats and paired devices, so keep it private and delete it after the import.\n` +
      (result.left > 0 ? `${count(result.left, "bot")} made after the freeze did not move. Finish this move, then export again to move them.\n` : "") +
      `\nNext:\n` +
      `  1. Copy the file to the new home machine and stop the bridge there.\n` +
      `  2. There, run claudiobot world import <file>, then start the bridge. Your phone's pairing works there too.\n` +
      `  3. Here, once the bots answer there, run claudiobot world finish ${moveId}\n`,
  );
  return 0;
}

function importStep(deps: WorldCommandDeps, file: string): number {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(deps.cwd, file), "utf8"));
  } catch (e) {
    deps.out(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const result = importWorld(deps, raw);
  switch (result.kind) {
    case "refused":
      deps.out(`${result.error} Nothing was changed.\n`);
      return 1;
    case "own":
      deps.out(`This bridge exported move ${result.moveId}. Import it on the other machine.\n`);
      return 1;
    case "already":
      deps.out(`Move ${result.moveId} was already imported at ${result.at}. Nothing changed.\n`);
      return 0;
    case "imported":
      deps.out(
        `Imported move ${result.moveId} from ${result.from}: ${count(result.bots.length, "bot")} (${result.bots.join(", ")}), ` +
          `${count(result.routines, "routine")}, ${count(result.devices, "paired device")}.\n` +
          `Start the bridge. Then, on ${result.from}, run claudiobot world finish ${result.moveId}\n`,
      );
      return 0;
  }
}

function finishStep(deps: WorldCommandDeps, moveId: string): number {
  const result = finishMove(deps, moveId);
  switch (result.kind) {
    case "unknown":
      deps.out(`This bridge never exported move ${moveId}.\n`);
      return 1;
    case "already":
      deps.out(`Move ${moveId} was already finished. Nothing changed.\n`);
      return 0;
    case "finished":
      deps.out(`Finished move ${moveId}. The homes of its ${count(result.bots, "bot")} went to ${join(deps.home, "trash")}.\n`);
      return 0;
  }
}
