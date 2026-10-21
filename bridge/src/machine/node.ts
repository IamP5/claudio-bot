import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "../clock";
import { connectorSettings } from "../connectors";
import { createGate, type Gate, type GateDeps } from "../gate";
import { createLedger, type UsageRow } from "../ledger";
import type { Scope } from "../policy";
import type { Project } from "../projects";
import type { AgentId, BotId, Message } from "../protocol";
import { inputOf, NO_AUTO_MEMORY, type Envelope } from "../prompts";
import { gitDirsOf, sandboxFor } from "../sandbox";
import type { Session, SessionSpec } from "../session";
import { appendArchive, type Persist } from "../store";
import { errorText } from "../text";
import { transcriptExists } from "../transcript";
import { isOpenCard, newBot, own, post, splitHistory, type Actor, type AgentActor, type AgentRecord, type BotRecord, type World } from "../world";
import type { Journal } from "./journal";
import { scopeFor, type MachineProfile } from "./profile";
import { createAgentRuntime, type AgentRuntime } from "./runtime";
import type { BotStandIn } from "./wire";

// What runs agents, built one way for both kinds of bridge: the ledger, the gate and the agent runtime over one World.
// The home adds bots around it (hub.ts); a machine adds only stand-ins (createMachineNode).

/** Ten years: as long as the bot lives, in practice. */
const KEEP_TRANSCRIPTS = { cleanupPeriodDays: 3650 } as const;

/**
 * The flag settings of every query a bot and its agents open. Claude Code deletes transcripts older than
 * cleanupPeriodDays (30 by default) at startup, and a bot's session lives far longer. The user's own claude runs still
 * sweep with their setting, so session.ts also recovers from a transcript that is gone.
 */
export const settingsFor = (world: World, botId: BotId): Settings => ({
  ...NO_AUTO_MEMORY,
  ...KEEP_TRANSCRIPTS,
  ...connectorSettings(world.bots.get(botId)?.connectorsOff ?? []),
});

/** Moves a thread's oldest messages to its archive. Written there first: when that fails they stay in state. */
export function trimThread<M>(messages: M[], file: string, pinned: (m: M) => boolean, log: (line: string) => void) {
  const split = splitHistory(messages, pinned);
  if (split === null) return;
  try {
    appendArchive(file, split.archived);
  } catch (e) {
    log(`history: could not archive to ${file}, keeping it in state.json: ${errorText(e)}`);
    return;
  }
  messages.splice(0, messages.length, ...split.kept);
}

/** What the gate needs from whoever owns the bots' chats and sessions. */
export type BotSide = {
  /** A bot's own folder, for a bot actor's scope. */
  folder(botId: BotId): string;
  session(botId: BotId): Session | null;
  /** The single writer of a bot's chat. */
  say(bot: BotRecord, message: Message): void;
  deliver(botId: BotId, e: Envelope): void;
  notice(botId: BotId, text: string): void;
  notify: GateDeps["notify"];
};

export type NodeDeps = {
  world: World;
  profile: MachineProfile;
  userName: string;
  model: string | undefined;
  claude: Pick<SessionSpec, "query" | "executable">;
  persist: Persist;
  log: (line: string) => void;
  now: () => Date;
  /** The bridge home, where usage/ and audit/ live. */
  root: string;
  agentConfig: (id: AgentId) => string;
  /** Claude Code's transcripts, which tell a new session from one to resume. */
  projectsDir: string;
  scan: () => Promise<Project[]>;
  journal: Journal;
  standIn: (bot: BotStandIn) => boolean;
  forgetBot?: (botId: BotId) => void;
  bots: BotSide;
  /** Each usage row the ledger charges. */
  rowed?: (row: UsageRow) => void;
  elsewhere?: GateDeps["elsewhere"];
  observe?: (actor: AgentActor, m: SDKMessage) => void;
  idle?: (actor: AgentActor) => void;
  turnDone?: (rec: AgentRecord) => void;
};

export type Node = {
  ledger: ReturnType<typeof createLedger>;
  gate: Gate;
  runtime: AgentRuntime;
  scopeOf(actor: Actor): Scope;
  sessionOf(actor: Actor): Session | null;
};

export function createNode(deps: NodeDeps): Node {
  const { world, bots } = deps;
  const iso = () => deps.now().toISOString();

  const ledger = createLedger({
    dir: join(deps.root, "usage"),
    capFor: (id) => world.bots.get(id)?.dailyCapUsd ?? null,
    budgetFor: (id) => world.agents.get(id)?.budgetUsd ?? null,
    now: deps.now,
    log: deps.log,
    rowed: deps.rowed,
  });

  function scopeOf(actor: Actor): Scope {
    const machine = scopeFor(deps.profile);
    if (actor.kind === "bot") return { ...machine, own: realpathSync(bots.folder(actor.botId)), userMd: join(machine.bridgeHome, "USER.md") };
    const rec = world.agents.get(actor.agentId);
    if (!rec) throw new Error(`Unknown agent ${actor.agentId}`);
    return { ...machine, own: realpathSync(rec.cwd), userMd: null };
  }

  const sessionOf = (actor: Actor): Session | null => (actor.kind === "bot" ? bots.session(actor.botId) : runtime.local.session(actor.agentId));

  const gate = createGate({
    world,
    scopeOf,
    turnOf(actor) {
      const session = sessionOf(actor);
      const current = session?.current;
      return session && current ? { initiator: current.initiator, stopping: session.lifecycle.kind === "stopping" } : null;
    },
    headroom: (actor, initiator) => ledger.headroom(actor, initiator),
    say: bots.say,
    deliver(actor, e) {
      if (actor.kind === "bot") return bots.deliver(actor.botId, e);
      const rec = world.agents.get(actor.agentId);
      if (!rec) return;
      const input = inputOf(e, deps.userName);
      deps.log(`envelope ${rec.agent.id} ${input.text.split("\n")[0]}`);
      runtime.local.deliver(rec, input);
    },
    notice(actor, text) {
      if (actor.kind === "bot") return bots.notice(actor.botId, text);
      const rec = world.agents.get(actor.agentId);
      if (rec) runtime.local.notice(rec, text);
    },
    denied: (actor) => sessionOf(actor)?.denied(),
    notify: bots.notify,
    trusted: (root) => runtime.local.trusted(root),
    elsewhere: deps.elsewhere,
    persist: deps.persist,
    auditDir: join(deps.root, "audit"),
    userName: deps.userName,
    now: deps.now,
    log: deps.log,
  });

  const runtime = createAgentRuntime({
    world,
    profile: deps.profile,
    userName: deps.userName,
    model: deps.model,
    ledger,
    log: deps.log,
    claude: deps.claude,
    hooks: (actor) => gate.hooks(actor),
    canUseTool: (actor) => gate.canUseTool(actor),
    beginTurn: (actor) => gate.beginTurn(actor),
    sandbox(actor) {
      const scope = scopeOf(actor);
      return sandboxFor(actor, scope, deps.profile, process.env, gitDirsOf(scope.own));
    },
    configRoot: deps.agentConfig,
    transcriptExists: (id, cwd) => transcriptExists(deps.projectsDir, id, cwd),
    turnDone: (rec) => deps.turnDone?.(rec),
    trustCard: (actor, repo) => gate.trustCard(actor, repo),
    settings: (actor) => settingsFor(world, actor.botId),
    observe: (actor, m) => deps.observe?.(actor, m),
    idle: (actor) => deps.idle?.(actor),
    persist: deps.persist,
    now: iso,
    scan: deps.scan,
    answer: (botId, cardId, reply) => gate.answer(botId, cardId, reply),
    standIn: deps.standIn,
    ...(deps.forgetBot && { forgetBot: deps.forgetBot }),
    journal: deps.journal,
  });

  return { ledger, gate, runtime, scopeOf, sessionOf };
}

/** agent.start's bot on a machine: created on first use, and its home-owned fields kept current after. */
export function upsertStandIn(world: World, bot: BotStandIn, at: string): BotRecord {
  const rec = world.bots.get(bot.id) ?? newBot({ id: bot.id, name: bot.name, avatar: { shape: "circle", color: "gray" }, at });
  rec.name = bot.name;
  rec.dailyCapUsd = bot.dailyCapUsd;
  // On a machine the stand-in is the only writer of connectorsOff: connectors.ts runs on the home.
  own<string[]>(rec.connectorsOff).splice(0, Infinity, ...bot.connectorsOff);
  world.bots.set(bot.id, rec);
  return rec;
}

/**
 * A bridge that became a machine after a world move keeps its agents, but their bots moved to the home (frozen in
 * moves[], or gone after finish). Each such agent's bot gets a stand-in, from the frozen record when there is one, so
 * its gate, cap and reports keep working; the home, which now has the real bot, receives its events.
 */
export function adoptOrphans(world: World, at: string, log: (line: string) => void) {
  const frozen = new Map(world.moves.flatMap((m) => (m.kind === "out" && m.phase === "frozen" ? m.held.bots.map((b) => [b.id, b] as const) : [])));
  for (const rec of world.agents.values()) {
    const id = rec.agent.botId;
    if (world.bots.has(id)) continue;
    const held = frozen.get(id);
    upsertStandIn(world, { id, name: held?.name ?? id, dailyCapUsd: held?.dailyCapUsd ?? null, connectorsOff: held ? [...held.connectorsOff] : [] }, at);
    log(`machine: agent ${rec.agent.id}'s bot ${held?.name ?? id} lives on the home now, so it runs here under a stand-in`);
  }
}

export type MachineNode = Node & {
  /** Card expiry and the agents' turn deadlines. */
  tickers: Tickable[];
  boot(): void;
  close(): void;
};

/**
 * A machine: no bots, only a stand-in per bot that has agents here. A stand-in's chat holds the cards this machine's
 * gate posts, which go to the home as card events; the home pushes and shows them. Nothing a bot does runs here.
 */
export function createMachineNode(deps: Omit<NodeDeps, "bots" | "standIn" | "forgetBot" | "rowed" | "elsewhere" | "idle">): MachineNode {
  const { world } = deps;
  /** A stand-in's chat, or an agent's thread. */
  const archiveOf = (id: BotId | AgentId) => join(deps.root, "machine", "history", `${id}.jsonl`);
  const node: Node = createNode({
    ...deps,
    // The home counts the row toward the bot's daily cap; this machine's ledger already holds it to its own.
    rowed: (row) => node.runtime.emit({ kind: "usage", row }),
    standIn(bot) {
      upsertStandIn(world, bot, deps.now().toISOString());
      deps.persist();
      return true;
    },
    // Records and stand-in go too, so nothing resumes them; worktrees and transcripts stay on disk.
    forgetBot(botId) {
      node.runtime.local.stopFor(botId);
      node.gate.forgetBot(botId);
      for (const rec of [...world.agents.values()]) if (rec.agent.botId === botId) world.agents.delete(rec.agent.id);
      world.bots.delete(botId);
      deps.persist("now");
      deps.log(`machine: the home deleted bot ${botId}, so its agents here stopped for good`);
    },
    bots: {
      folder() {
        throw new Error("A machine runs no bot turns.");
      },
      session: () => null,
      say(bot, message) {
        post(bot, message);
        trimThread(bot.messages, archiveOf(bot.id), isOpenCard, deps.log);
        deps.persist();
        node.runtime.emit({ kind: "card", botId: bot.id, message });
      },
      // A stand-in's cards are its agents', so their answers and notices go to the agents; nothing reaches a bot here.
      deliver: (botId) => deps.log(`machine: dropped an envelope for bot ${botId}, which runs on the home`),
      notice: () => {},
      // The home pushes: a new card from its card event, and a reminder from this one.
      notify(bot, reason, id) {
        if (reason === "reminder") node.runtime.emit({ kind: "reminder", botId: bot.id, cardId: id });
      },
    },
  });

  // The home saves an agent's record on each of its events; here nothing else would, so a restart would find it stale.
  // A report is saved at once: the outbox already holds it, and a restart that found its turn unfinished would run it
  // again and report twice.
  node.runtime.subscribe((e) => {
    if (e.kind === "report") return deps.persist("now");
    if (e.kind !== "agent") return;
    const rec = world.agents.get(e.agent.id);
    if (rec) trimThread(rec.messages, archiveOf(rec.agent.id), () => false, deps.log);
    deps.persist();
  });

  const turns: Tickable = {
    tick: (at) => node.runtime.local.sessions().forEach((s) => s.tick(at)),
    nextDeadline: () => node.runtime.local.sessions().reduce<string | null>((min, s) => {
      const d = s.nextDeadline();
      return d !== null && (min === null || d < min) ? d : min;
    }, null),
  };

  return {
    ...node,
    tickers: [node.gate, turns],
    boot() {
      adoptOrphans(world, deps.now().toISOString(), deps.log);
      deps.persist();
      node.gate.resume(deps.now());
      node.runtime.local.resume();
    },
    close() {
      for (const bot of world.bots.values()) node.runtime.local.stopFor(bot.id);
    },
  };
}
