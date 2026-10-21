import { z } from "zod";
import type { Agent, AgentId, AgentMessage, BotId, Message, MessageId } from "../protocol";
import { errorText } from "../text";
import { isOpenCard, type Card } from "../world";
import { readPrivate, writePrivate } from "./files";
import { agentMessageSchema, agentSchema, type Event, type MachineId } from "./wire";

// <bridgeHome>/machine/mirror.json, 0600, on the home: what each machine last said of its agents and of the cards its
// gate holds. Apart from World.agents, which the home's own runtime resumes and ticks. Written only from events, by
// this module alone. A cache: a machine's snapshot on each link refills it, so a file that does not parse starts empty.

export type Mirrored = { machine: MachineId; agent: Agent; messages: AgentMessage[] };

/** One machine's slice. cards: the open cards its gate holds, by id, with the bot whose chat shows them. */
type Slice = { agents: Record<AgentId, { agent: Agent; messages: AgentMessage[] }>; cards: Record<MessageId, BotId> };
export type MirrorState = { machines: Record<MachineId, Slice> };

/** What an event changed, for the home to show: agent frames, cards to post in a bot's chat, cards no longer held. */
export type MirrorChange = { agents: Mirrored[]; cards: { botId: BotId; message: Card }[]; closed: { botId: BotId; cardId: MessageId }[] };

const isCard = (m: Message): m is Card => m.kind === "permission" || m.kind === "question";

/** A snapshot sends only a thread's newest messages: the ones the mirror had from before them stay. */
function withOlder(known: readonly AgentMessage[], newest: readonly AgentMessage[]): AgentMessage[] {
  const first = newest[0];
  if (!first) return [...known];
  const sent = new Set(newest.map((m) => m.id));
  return [...known.filter((m) => !sent.has(m.id) && m.at <= first.at), ...newest];
}

/** Folds one event into the state, in place. null: the event is not about agents or cards. */
export function reduce(state: MirrorState, machine: MachineId, e: Event): MirrorChange | null {
  const slice = (state.machines[machine] ??= { agents: {}, cards: {} });
  switch (e.kind) {
    case "agent":
      slice.agents[e.agent.id] = { agent: e.agent, messages: e.messages };
      return { agents: [{ machine, agent: e.agent, messages: e.messages }], cards: [], closed: [] };
    case "card": {
      if (!isCard(e.message)) return null;
      if (e.message.answer === null) slice.cards[e.message.id] = e.botId;
      else delete slice.cards[e.message.id];
      return { agents: [], cards: [{ botId: e.botId, message: e.message }], closed: [] };
    }
    case "snapshot": {
      const agents = e.agents.map((a) => ({ agent: a.agent, messages: withOlder(slice.agents[a.agent.id]?.messages ?? [], a.messages) }));
      slice.agents = Object.fromEntries(agents.map((a) => [a.agent.id, a]));
      const open = e.openCards.flatMap((c) => (isCard(c.message) && isOpenCard(c.message) ? [{ botId: c.botId, message: c.message }] : []));
      const held = new Set<string>(open.map((c) => c.message.id));
      const closed = Object.entries(slice.cards).flatMap(([cardId, botId]) => (held.has(cardId) ? [] : [{ botId, cardId: cardId as MessageId }]));
      slice.cards = Object.fromEntries(open.map((c) => [c.message.id, c.botId]));
      return { agents: agents.map((a) => ({ machine, ...a })), cards: open, closed };
    }
    default:
      return null;
  }
}

const FILE: z.ZodType<MirrorState> = z.object({
  machines: z.record(
    z.string() as unknown as z.ZodType<MachineId>,
    z.object({
      agents: z.record(z.string() as unknown as z.ZodType<AgentId>, z.object({ agent: agentSchema, messages: z.array(agentMessageSchema) })),
      cards: z.record(z.string() as unknown as z.ZodType<MessageId>, z.string() as unknown as z.ZodType<BotId>),
    }),
  ),
}) as z.ZodType<MirrorState>;

export type Mirror = {
  /** Folds a machine's event in and saves. null: nothing changed. */
  apply(machine: MachineId, e: Event): MirrorChange | null;
  agents(): Mirrored[];
  agent(id: AgentId): Mirrored | null;
  /** The machine whose gate holds this open card, and the bot whose chat shows it; null for a card this home holds. */
  cardOwner(cardId: MessageId): { machine: MachineId; botId: BotId } | null;
  /** How many open cards other machines hold for this bot. */
  openCards(botId: BotId): number;
  /** Every open card each machine's gate holds, by machine. */
  held(): { machine: MachineId; cardId: MessageId; botId: BotId }[];
  /** The bot was deleted: its agents and cards go from every slice. */
  forgetBot(botId: BotId): void;
  /** Drops the machine's slice and saves. Returns the open cards it held, which can no longer be answered. */
  forget(machine: MachineId): { botId: BotId; cardId: MessageId }[];
};

function load(path: string, log: (line: string) => void): MirrorState {
  try {
    const raw = readPrivate(path);
    if (raw === null) return { machines: {} };
    const parsed = FILE.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log(`mirror: ${path} does not parse, so it starts empty until each machine's snapshot: ${z.prettifyError(parsed.error).split("\n")[0]}`);
  } catch (e) {
    log(`mirror: ${path} could not be read, so it starts empty until each machine's snapshot: ${errorText(e)}`);
  }
  return { machines: {} };
}

/**
 * owner: the machine the home placed an agent on, and the machine that posted a card (machine/placements.ts). A lookup
 * goes to that machine's slice only, so no other machine's copy of an id can stand in for it.
 */
export function createMirror(deps: {
  path: string;
  log: (line: string) => void;
  owner: { agent(id: AgentId): MachineId | null; card(id: MessageId): MachineId | null };
}): Mirror {
  const state = load(deps.path, deps.log);
  const slices = () => Object.entries(state.machines) as [MachineId, Slice][];

  function save() {
    try {
      writePrivate(deps.path, `${JSON.stringify(state)}\n`);
    } catch (e) {
      deps.log(`mirror: could not save ${deps.path}: ${errorText(e)}`);
    }
  }

  return {
    apply(machine, e) {
      const change = reduce(state, machine, e);
      if (change) save();
      return change;
    },
    agents: () => slices().flatMap(([machine, s]) => Object.values(s.agents).map((a) => ({ machine, ...a }))),
    agent(id) {
      const machine = deps.owner.agent(id);
      const a = machine === null ? undefined : state.machines[machine]?.agents[id];
      return machine !== null && a ? { machine, ...a } : null;
    },
    cardOwner(cardId) {
      const machine = deps.owner.card(cardId);
      const botId = machine === null ? undefined : state.machines[machine]?.cards[cardId];
      return machine !== null && botId ? { machine, botId } : null;
    },
    openCards: (botId) => slices().reduce((n, [, s]) => n + Object.values(s.cards).filter((b) => b === botId).length, 0),
    forgetBot(botId) {
      for (const s of Object.values(state.machines)) {
        for (const [id, a] of Object.entries(s.agents)) if (a.agent.botId === botId) delete s.agents[id as AgentId];
        for (const [id, b] of Object.entries(s.cards)) if (b === botId) delete s.cards[id as MessageId];
      }
      save();
    },
    forget(machine) {
      const slice = state.machines[machine];
      if (!slice) return [];
      delete state.machines[machine];
      save();
      return (Object.entries(slice.cards) as [MessageId, BotId][]).map(([cardId, botId]) => ({ botId, cardId }));
    },
    held: () => slices().flatMap(([machine, s]) => (Object.entries(s.cards) as [MessageId, BotId][]).map(([cardId, botId]) => ({ machine, cardId, botId }))),
  };
}
