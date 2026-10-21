import { z } from "zod";
import type { AgentId, BotId, MessageId, SessionId } from "../protocol";
import { errorText } from "../text";
import type { Initiator } from "../world";
import { readPrivate, writePrivate } from "./files";
import { initiatorSchema, type Event, type MachineId } from "./wire";

// <bridgeHome>/machine/placements.json, 0600, on the home: which machine the home placed each agent on, for which bot,
// and the initiator of the last turn the home sent it. Not a cache: the home writes it as it dispatches, and it is the
// only thing that lets a machine speak for an agent. Every event a machine sends passes admit() against it first.

/** by: the initiator of the newest turn the home sent the agent, which its report is delivered under. */
export type Placement = { machine: MachineId; botId: BotId; by: Initiator };

/** cards: each card id a machine posted, so no other machine, and no home message, can be answered or replaced by it. */
export type PlacementState = { agents: Record<AgentId, Placement>; cards: Record<MessageId, MachineId> };

/** What the home knows outside the table, for the rules that need it. */
export type AdmitContext = {
  /** The bot's chat on the home holds a message with this id. */
  chatHas(botId: BotId, messageId: MessageId): boolean;
  /** The machine whose Sessions tab lists the session, if any. */
  sessionOwner(id: SessionId): MachineId | null;
  /** The home's local day, YYYY-MM-DD, and the day before it. */
  days(): { today: string; yesterday: string };
};

/** The event as the home may believe it, or why it is dropped. */
export type Admitted = { ok: true; event: Event } | { ok: false; reason: string };

type Rule<K extends Event["kind"]> = (state: PlacementState, machine: MachineId, e: Extract<Event, { kind: K }>, ctx: AdmitContext) => Admitted;

const keep = (event: Event): Admitted => ({ ok: true, event });
const drop = (reason: string): Admitted => ({ ok: false, reason });

/** The agent the event names, if the home placed it on this machine for this bot. */
function placed(state: PlacementState, machine: MachineId, agentId: AgentId, botId: BotId): Placement | string {
  const p = state.agents[agentId];
  if (!p || p.machine !== machine) return `agent ${agentId} was not placed on this machine`;
  if (p.botId !== botId) return `agent ${agentId} belongs to another bot`;
  return p;
}

const botsOn = (state: PlacementState, machine: MachineId) => new Set(Object.values(state.agents).flatMap((p) => (p.machine === machine ? [p.botId] : [])));

/**
 * A card a machine may post: in the chat of a bot with an agent there, from that bot's agent there when it names one,
 * and never under an id the chat already holds from the home or another machine. Records the id as the machine's.
 */
function card(state: PlacementState, machine: MachineId, botId: BotId, message: Extract<Event, { kind: "card" }>["message"], ctx: AdmitContext): string | null {
  if (message.kind !== "permission" && message.kind !== "question") return `a ${message.kind} message is not a card`;
  if (!botsOn(state, machine).has(botId)) return `bot ${botId} has no agent on this machine`;
  if (message.kind === "permission" && message.from) {
    const p = placed(state, machine, message.from.id, botId);
    if (typeof p === "string") return p;
  }
  const owner = state.cards[message.id];
  if (owner !== undefined && owner !== machine) return `card ${message.id} is another machine's`;
  if (owner === undefined && ctx.chatHas(botId, message.id)) return `card ${message.id} is already in the chat`;
  state.cards[message.id] = machine;
  return null;
}

const clampDay = (day: string, { today, yesterday }: ReturnType<AdmitContext["days"]>) => (day > today ? today : day < yesterday ? yesterday : day);

/** One rule per event kind: what a machine may say, and how much of it the home believes. */
const RULES: { [K in Event["kind"]]: Rule<K> } = {
  agent(state, machine, e) {
    const p = placed(state, machine, e.agent.id, e.agent.botId);
    return typeof p === "string" ? drop(p) : keep(e);
  },
  report(state, machine, e) {
    const p = placed(state, machine, e.agentId, e.botId);
    // The hops and origin are the home's: a machine's own would let it lift a bot's chain limit or cap.
    return typeof p === "string" ? drop(p) : keep({ ...e, by: p.by });
  },
  note(state, machine, e) {
    const p = placed(state, machine, e.agentId, e.botId);
    return typeof p === "string" ? drop(p) : keep(e);
  },
  card(state, machine, e, ctx) {
    const why = card(state, machine, e.botId, e.message, ctx);
    return why === null ? keep(e) : drop(why);
  },
  reminder(state, machine, e) {
    return state.cards[e.cardId] === machine ? keep(e) : drop(`card ${e.cardId} is not this machine's`);
  },
  sessionCard(_, machine, e, ctx) {
    return ctx.sessionOwner(e.sessionId) === machine ? keep(e) : drop(`session ${e.sessionId} is not this machine's`);
  },
  usage(state, machine, e, ctx) {
    const { row } = e;
    const agentId = row.actor.startsWith("agent:") ? (row.actor.slice("agent:".length) as AgentId) : null;
    if (agentId === null || row.botId === null) return drop(`a ${row.actor.split(":")[0]} row is the machine's own`);
    const p = placed(state, machine, agentId, row.botId);
    if (typeof p === "string") return drop(p);
    // Its own session ids, so a row never moves the baseline of a session on the home or another machine.
    return keep({ ...e, row: { ...row, sessionId: `${machine}/${row.sessionId}`, day: clampDay(row.day, ctx.days()) } });
  },
  profile: (_, __, e) => keep(e),
  refused: (_, __, e) => keep(e),
  snapshot(state, machine, e, ctx) {
    const agents = e.agents.filter((a) => typeof placed(state, machine, a.agent.id, a.agent.botId) !== "string");
    const openCards = e.openCards.filter((c) => card(state, machine, c.botId, c.message, ctx) === null);
    return keep({ ...e, agents, openCards });
  },
};

export function admit(state: PlacementState, machine: MachineId, e: Event, ctx: AdmitContext): Admitted {
  return (RULES[e.kind] as Rule<typeof e.kind>)(state, machine, e as never, ctx);
}

const FILE: z.ZodType<PlacementState> = z.object({
  agents: z.record(
    z.string() as unknown as z.ZodType<AgentId>,
    z.object({ machine: z.string().min(1) as unknown as z.ZodType<MachineId>, botId: z.string().min(1) as unknown as z.ZodType<BotId>, by: initiatorSchema }),
  ),
  cards: z.record(z.string() as unknown as z.ZodType<MessageId>, z.string().min(1) as unknown as z.ZodType<MachineId>),
}) as z.ZodType<PlacementState>;

export type Placements = {
  /** At dispatch of agent.start, before the machine can say anything of the agent. */
  place(agentId: AgentId, p: Placement): void;
  /** A turn the home sent the agent: its report goes to the bot under this initiator. */
  turn(agentId: AgentId, by: Initiator): void;
  of(agentId: AgentId): Placement | null;
  /** The machine that posted this card, if one did. */
  cardOn(cardId: MessageId): MachineId | null;
  /** The agents placed for a bot, by machine. */
  ofBot(botId: BotId): { agentId: AgentId; machine: MachineId }[];
  /** A card the home saw from this machine before placements were kept. */
  adoptCard(cardId: MessageId, machine: MachineId): void;
  forgetAgent(agentId: AgentId): void;
  forgetBot(botId: BotId): void;
  forgetMachine(machine: MachineId): void;
  /** Every machine some agent or card is placed on. */
  machines(): MachineId[];
  /** The event checked against the table: dropped, or as the home may believe it. A card it admits becomes the machine's. */
  admit(machine: MachineId, e: Event, ctx: AdmitContext): Admitted;
};

/**
 * The file is read once and rewritten whole on each change. One that does not parse is refused loudly and the bridge
 * runs with no placements, so every remote event is dropped until each agent is started again; it never trusts more.
 */
export function createPlacements(deps: { path: string; log: (line: string) => void }): Placements {
  const state = load(deps.path, deps.log);
  const save = () => {
    try {
      writePrivate(deps.path, `${JSON.stringify(state)}\n`);
    } catch (e) {
      deps.log(`placements: could not save ${deps.path}, so a restart forgets what changed: ${errorText(e)}`);
    }
  };
  const forget = (keep: (p: Placement, id: AgentId) => boolean) => {
    const before = Object.keys(state.agents).length;
    for (const [id, p] of Object.entries(state.agents) as [AgentId, Placement][]) if (!keep(p, id)) delete state.agents[id];
    return Object.keys(state.agents).length !== before;
  };

  return {
    place(agentId, p) {
      state.agents[agentId] = p;
      save();
    },
    turn(agentId, by) {
      const p = state.agents[agentId];
      if (!p) return;
      p.by = by;
      save();
    },
    of: (agentId) => state.agents[agentId] ?? null,
    cardOn: (cardId) => state.cards[cardId] ?? null,
    ofBot: (botId) => (Object.entries(state.agents) as [AgentId, Placement][]).flatMap(([agentId, p]) => (p.botId === botId ? [{ agentId, machine: p.machine }] : [])),
    adoptCard(cardId, machine) {
      if (state.cards[cardId] !== undefined) return;
      state.cards[cardId] = machine;
      save();
    },
    forgetAgent(agentId) {
      if (forget((_, id) => id !== agentId)) save();
    },
    forgetBot(botId) {
      if (forget((p) => p.botId !== botId)) save();
    },
    forgetMachine(machine) {
      forget((p) => p.machine !== machine);
      for (const [id, m] of Object.entries(state.cards)) if (m === machine) delete state.cards[id as MessageId];
      save();
    },
    machines: () => [...new Set([...Object.values(state.agents).map((p) => p.machine), ...Object.values(state.cards)])],
    admit(machine, e, ctx) {
      const cards = Object.keys(state.cards).length;
      const admitted = admit(state, machine, e, ctx);
      if (Object.keys(state.cards).length !== cards) save();
      return admitted;
    },
  };
}

function load(path: string, log: (line: string) => void): PlacementState {
  try {
    const raw = readPrivate(path);
    if (raw === null) return { agents: {}, cards: {} };
    const parsed = FILE.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log(`placements: ${path} does not parse, so no machine's agent is heard until it is started again: ${z.prettifyError(parsed.error).split("\n")[0]}`);
  } catch (e) {
    log(`placements: ${path} could not be read, so no machine's agent is heard until it is started again: ${errorText(e)}`);
  }
  return { agents: {}, cards: {} };
}
