import {
  COLORS,
  SHAPES,
  type Agent,
  type AgentId,
  type AgentMessage,
  type Avatar,
  type Bot,
  type BotId,
  type Link,
  type Message,
  type MessageId,
  type Peer,
  type Routine,
  type RoutineId,
} from "./protocol";

// What the bridge keeps about a bot. Status is not here: it belongs to the live session, and every bot is idle after a restart.
export type BotRecord = {
  id: BotId;
  name: string;
  title: string | null;
  avatar: Avatar;
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  routines: Routine[];
  messages: Message[];
  unread: number;
  sessionId: string | null;
};

export type AgentRecord = {
  agent: Agent;
  cwd: string;
  messages: AgentMessage[];
  // The SDK session for mac agents, the claude.ai session for cloud agents.
  sessionId: string | null;
};

export type World = { bots: Map<BotId, BotRecord>; agents: Map<AgentId, AgentRecord> };

export const newMessageId = () => `m_${crypto.randomUUID()}` as MessageId;

export function newBot(fields: { id: BotId; name: string; avatar: Avatar; at: string }): BotRecord {
  return {
    id: fields.id,
    name: fields.name,
    title: null,
    avatar: fields.avatar,
    pinned: false,
    hidden: false,
    createdAt: fields.at,
    routines: [],
    messages: [],
    unread: 0,
    sessionId: null,
  };
}

export function randomAvatar(random = Math.random): Avatar {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  return { shape: pick(SHAPES), color: pick(COLORS) };
}

export const botPeer = (bot: BotRecord): Peer => ({ kind: "bot", id: bot.id, name: bot.name, avatar: bot.avatar });
export const agentPeer = (agent: Agent): Peer => ({ kind: "agent", id: agent.id, title: agent.title });
export const routinePeer = (routine: Routine): Peer => ({ kind: "routine", id: routine.id, name: routine.name });

// How many unread messages a change adds: a new bot bubble or card, or a message received in an exchange.
export function unreadDelta(previous: Message | undefined, next: Message): number {
  switch (next.kind) {
    case "bot":
    case "question":
      return previous ? 0 : 1;
    case "exchange":
      return Math.max(0, next.received - (previous?.kind === "exchange" ? previous.received : 0));
    default:
      return 0;
  }
}

// Inserts or replaces by id, keeping unread in step. Replaying the same message changes nothing.
export function post(bot: BotRecord, message: Message): Message {
  const i = bot.messages.findIndex((m) => m.id === message.id);
  const previous = i === -1 ? undefined : bot.messages[i];
  bot.unread += unreadDelta(previous, message);
  if (i === -1) bot.messages.push(message);
  else bot.messages[i] = message;
  return message;
}

// Messages between a bot and one peer group into one exchange while nothing else is said.
export function exchangeFor(
  last: Message | undefined,
  peer: Peer,
  direction: "sent" | "received",
  fresh: { id: MessageId; at: string },
): Message {
  if (last?.kind === "exchange" && last.peer.kind === peer.kind && last.peer.id === peer.id) {
    return { ...last, at: fresh.at, peer, [direction]: last[direction] + 1 };
  }
  return { kind: "exchange", id: fresh.id, at: fresh.at, peer, sent: direction === "sent" ? 1 : 0, received: direction === "received" ? 1 : 0 };
}

export const recordExchange = (bot: BotRecord, peer: Peer, direction: "sent" | "received", at: string) =>
  post(bot, exchangeFor(bot.messages.at(-1), peer, direction, { id: newMessageId(), at }));

export function openQuestion(messages: Message[]): Extract<Message, { kind: "question" }> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "question" && m.answer === null) return m;
  }
  return null;
}

export function settleQuestion(
  message: Message | undefined,
  answer: number | "dismissed",
): { ok: true; message: Extract<Message, { kind: "question" }> } | { ok: false; error: string } {
  if (message?.kind !== "question") return { ok: false, error: "Unknown question" };
  if (message.answer !== null) return { ok: false, error: "That question was already answered" };
  if (answer !== "dismissed" && answer >= message.options.length) return { ok: false, error: "Unknown option" };
  return { ok: true, message: { ...message, answer } };
}

export function toBot(bot: BotRecord, status: Bot["status"]): Bot {
  const lastBot = bot.messages.findLast((m) => m.kind === "bot");
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    avatar: bot.avatar,
    pinned: bot.pinned,
    hidden: bot.hidden,
    status,
    unread: bot.unread,
    question: openQuestion(bot.messages)?.question ?? null,
    preview: lastBot?.kind === "bot" ? (lastBot.text.trim().split("\n")[0] ?? "") : "",
    lastAt: bot.messages.at(-1)?.at ?? bot.createdAt,
    createdAt: bot.createdAt,
    routines: bot.routines,
  };
}

export const sortBots = (bots: Bot[]): Bot[] =>
  [...bots].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt.localeCompare(a.lastAt));

export function findBot(world: World, ref: string): BotRecord | undefined {
  const byId = world.bots.get(ref as BotId);
  if (byId) return byId;
  const name = ref.trim().toLowerCase();
  return [...world.bots.values()].find((b) => b.name.toLowerCase() === name);
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

export function extractUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, ""));
}

export function linksOf(bot: BotRecord, agents: Agent[]): Link[] {
  const found: { url: string; at: string }[] = [];
  for (const m of bot.messages) if (m.kind === "bot") for (const url of extractUrls(m.text)) found.push({ url, at: m.at });
  for (const a of agents) if (a.url) found.push({ url: a.url, at: a.createdAt });
  const newest = new Map<string, Link>();
  for (const { url, at } of found.sort((a, b) => b.at.localeCompare(a.at))) {
    if (!newest.has(url) && URL.canParse(url)) newest.set(url, { url, host: new URL(url).host, at });
  }
  return [...newest.values()];
}

export function upsertRoutine(
  bot: BotRecord,
  fields: { name: string; schedule: string; describe: string; prompt: string; enabled: boolean },
  newId: () => RoutineId,
): { routine: Routine; created: boolean } {
  const existing = bot.routines.find((r) => r.name === fields.name);
  if (existing) {
    Object.assign(existing, fields);
    return { routine: existing, created: false };
  }
  const routine: Routine = { id: newId(), ...fields, lastRunAt: null };
  bot.routines.push(routine);
  return { routine, created: true };
}
