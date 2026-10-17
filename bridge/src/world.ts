import { describe } from "./cron";
import {
  COLORS,
  SHAPES,
  type Agent,
  type AgentId,
  type AgentMessage,
  type AgentPeer,
  type Avatar,
  type Bot,
  type BotId,
  type BotStatus,
  type DeviceId,
  type Link,
  type Message,
  type MessageId,
  type Peer,
  type PermissionChoice,
  type Routine,
  type RoutineId,
  type RoutineRun,
  type RunId,
} from "./protocol";

// The records in state.json (version 3) and the pure rules over them. Every persisted shape is declared here, so the
// file's schema has one home; each slice names the one module that writes it.


/** Who runs a turn. An agent belongs to a bot: its cards show in the bot's chat and the bot's standing rules apply. */
export type Actor = { kind: "bot"; botId: BotId } | { kind: "agent"; botId: BotId; agentId: AgentId };
export type BotActor = Extract<Actor, { kind: "bot" }>;
export type ActorKey = `bot:${string}` | `agent:${string}`;
export const actorKey = (a: Actor): ActorKey => (a.kind === "bot" ? `bot:${a.botId}` : `agent:${a.agentId}`);
export const botActor = (botId: BotId): BotActor => ({ kind: "bot", botId });

export type RunRef = { routineId: RoutineId; runId: RunId };

/**
 * Who started the work a turn is doing. Derived from the envelope (prompts.initiatorOf), never passed around by hand,
 * and recorded on every audit and usage row.
 * - routine.manual: Run now from the phone. Attended and never quiet, but still a routine for initiator bans.
 * - bot.hops: how many bot-to-bot hops led here. message_bot and create_bot are refused at 2 or more.
 * - system: no turn in flight, or work the bridge made itself. Treated as unattended.
 */
export type Initiator =
  | { kind: "user" }
  | { kind: "routine"; run: RunRef; manual: boolean }
  | { kind: "bot"; botId: BotId; hops: number }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "system" };

/** Someone is at the phone. Unattended work gets the policy's stricter column and is held by the daily cap. */
export const attended = (i: Initiator): boolean => i.kind === "user" || (i.kind === "routine" && i.manual);

/** The hop count of a bot message or a bot creation made during a turn that `by` started. */
export const hopsAfter = (by: Initiator | null): number => (by?.kind === "bot" ? by.hops + 1 : 1);

/**
 * A slice another module owns: a readonly field holding deeply readonly data, so `bot.routines.push(…)` or
 * `bot.routines = …` outside the scheduler fails to compile. The owner keeps a module-private `own()` cast and
 * mutates in place; nothing else may make a slice writable.
 */
export type Owned<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly Owned<U>[]
    : { readonly [K in keyof T]: Owned<T[K]> };


export type EnvelopeId = string & { readonly __brand: "EnvelopeId" };

/** One envelope waiting for a turn, or in one. The queue head is the turn in flight or the next to start. */
export type Pending = {
  /** Stable across replays. */
  id: EnvelopeId;
  at: string;
  /** The rendered envelope. Notices are prepended when it starts, not stored here. */
  text: string;
  initiator: Initiator;
  /** Starts so far. A replay after a crash or a transient error bumps it; 3 is the poison limit. */
  attempts: number;
};

/** The turn in flight. Persisted so a restart can apply the replay rule. */
export type ActiveTurn = {
  pending: EnvelopeId;
  startedAt: string;
  /** An assistant message arrived for this turn. A turn with output is never replayed: it may have had effects. */
  output: boolean;
  /** Calls the gate held or denied this turn. The third moves the session to stopping and leaves a note. */
  denials: number;
};

export type ParkReason = "usage_limit" | "daily_cap";

/**
 * What a session is doing, as one value. Only working and stopping carry a turn, and every deadline is stored here as
 * data so the one clock can handle it, after a sleep or a restart alike.
 * - stopping: Stop was pressed. The gate denies every call. The turn's next result ends it as stopped (an interrupt's
 *   result is subtype error_during_execution, which is never a failure and never retried). If no result arrives by
 *   `deadline` (15 s after Stop) the query is killed.
 * - backoff: a transient failure with no output. The same queue head runs again at `until`.
 * - parked: no turn starts before `until`. daily_cap holds unattended envelopes only; attended ones still run.
 *   usage_limit mirrors the account-wide AccountState.parkedUntil, and the envelope stays at the head.
 */
export type Lifecycle =
  | { kind: "idle" }
  | { kind: "working"; turn: ActiveTurn }
  | { kind: "stopping"; turn: ActiveTurn; deadline: string }
  | { kind: "backoff"; until: string; attempt: number }
  | { kind: "parked"; reason: ParkReason; until: string };

/** A line told to the actor at the top of its next envelope. How expiry and Stop reach it without spending a turn. */
export type Notice = { at: string; text: string };

/** The SDK session of a bot or a mac agent: resume id, durable inbox, lifecycle, pending notices. Writer: session.ts. */
export type SessionState = { id: string | null; pending: Pending[]; lifecycle: Lifecycle; notices: Notice[] };

export const emptySession = (id: string | null = null): SessionState => ({ id, pending: [], lifecycle: { kind: "idle" }, notices: [] });

/** Account-wide pause after a usage-limit rejection (resetsAt + 30 s). No session starts a turn before it. Writer: session.ts. */
export type AccountState = { parkedUntil: string | null };


/** A union so a webhook trigger can join later; the scheduler switches over it exhaustively. */
export type Trigger = { kind: "cron"; schedule: string };

/** Writer: scheduler.ts. */
export type RoutineRecord = {
  id: RoutineId;
  name: string;
  trigger: Trigger;
  prompt: string;
  enabled: boolean;
  /** Advanced before each fire, so a fire happens at most once. null until the scheduler computes it. */
  nextRunAt: string | null;
  /** Newest first, at most 20. */
  runs: RoutineRun[];
  /** Consecutive failed runs. 10 turns the routine off; an ok or quiet run, or re-enabling, resets it. */
  failStreak: number;
};


/** What Always and Never cover: a tool plus the meaningful shape of its call, such as "Bash:gh pr merge". */
export type Signature = string & { readonly __brand: "Signature" };
/** A hash of the call's meaningful input. The key of one-shot grants and of card dedupe. */
export type Fingerprint = string & { readonly __brand: "Fingerprint" };

/**
 * "Always" and "Never" for one bot, covering its agents too. Writer: gate.ts. Never beats a grant, and a grant beats Always.
 * An Always set on a card from an attended turn covers attended turns only ("attended"); one set on a card from an
 * unattended turn covers every turn ("all").
 */
export type StandingRule =
  | { decision: "allow"; appliesTo: "attended" | "all"; signature: Signature; label: string; cardId: MessageId; at: string }
  | { decision: "deny"; signature: Signature; label: string; cardId: MessageId; at: string };

/** "Allow once": this exact call may run one time before expiresAt (10 minutes). Consumed on use. */
export type Grant = { actor: ActorKey; fingerprint: Fingerprint; cardId: MessageId; expiresAt: string };

/** What a permission decision applies to. The card message is what the user sees; this is the match key behind it. */
export type HeldCall = {
  initiator: Initiator;
  tool: string;
  signature: Signature;
  fingerprint: Fingerprint;
  label: string;
  detail: string;
  always: string;
};

/** An open card's deadlines. The card shows in actor.botId's chat; a question is always the bot's own. */
export type OpenCard =
  | { kind: "question"; cardId: MessageId; actor: BotActor; remindAt: string | null; expiresAt: string }
  | { kind: "permission"; cardId: MessageId; actor: Actor; remindAt: string | null; expiresAt: string; call: HeldCall };

/** Allowed calls of a capped tool (create_bot, start_agent) per bot per local day. */
export type DailyCount = { botId: BotId; tool: string; day: string; count: number };

/** Writer: gate.ts. */
export type GateState = { open: OpenCard[]; grants: Grant[]; daily: DailyCount[] };


/** Writer: devices.ts. */
export type DeviceRecord = {
  id: DeviceId;
  name: string;
  /** sha256 of the device token. The token itself is never stored or printed. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Imported from the shared token of protocol 2. Accepted for one release only. */
  legacy: boolean;
};

/** Pushes already sent, recorded before sending so a crash never double-pushes. key: `${cardId}|card` or `${cardId}|reminder`. Writer: push.ts. */
export type PushState = { sent: { key: string; at: string }[] };


export type BotRecord = {
  id: BotId;
  name: string;
  title: string | null;
  avatar: Avatar;
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  /** Writer: hub.say → post. Status is not stored: it is derived from the session and the gate. */
  messages: Message[];
  unread: number;
  /** null: the bridge default. Writer: hub (update_bot). */
  dailyCapUsd: number | null;
  readonly session: Owned<SessionState>;
  readonly routines: Owned<RoutineRecord[]>;
  readonly rules: Owned<StandingRule[]>;
};

export type AgentRecord = {
  /** Writer: agents.ts. */
  agent: Agent;
  cwd: string;
  messages: AgentMessage[];
  /** Mac agents' SDK session. Writer: session.ts. */
  readonly session: Owned<SessionState>;
  /** Cloud agents' claude.ai session. Writer: agents.ts. */
  cloudSession: string | null;
  /** null: the bridge default. */
  budgetUsd: number | null;
};

export type World = {
  bots: Map<BotId, BotRecord>;
  agents: Map<AgentId, AgentRecord>;
  readonly gate: Owned<GateState>;
  readonly devices: Owned<DeviceRecord[]>;
  readonly push: Owned<PushState>;
  readonly account: Owned<AccountState>;
};

export const emptyWorld = (): World => ({
  bots: new Map(),
  agents: new Map(),
  gate: { open: [], grants: [], daily: [] },
  devices: [],
  push: { sent: [] },
  account: { parkedUntil: null },
});

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
    messages: [],
    unread: 0,
    dailyCapUsd: null,
    session: emptySession(),
    routines: [],
    rules: [],
  };
}

export function randomAvatar(random = Math.random): Avatar {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  return { shape: pick(SHAPES), color: pick(COLORS) };
}

export const botPeer = (bot: BotRecord): Peer => ({ kind: "bot", id: bot.id, name: bot.name, avatar: bot.avatar });
export const agentPeer = (agent: Agent): AgentPeer => ({ kind: "agent", id: agent.id, title: agent.title });
export const routinePeer = (routine: { id: RoutineId; name: string }): Peer => ({ kind: "routine", id: routine.id, name: routine.name });


export function unreadDelta(previous: Message | undefined, next: Message): number {
  switch (next.kind) {
    case "bot":
    case "question":
    case "permission":
      return previous ? 0 : 1;
    case "exchange":
      return Math.max(0, next.received - (previous?.kind === "exchange" ? previous.received : 0));
    default:
      return 0;
  }
}

// Replaying the same message changes nothing, so a retried broadcast never double-counts unread.
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

export type Card = Extract<Message, { kind: "question" | "permission" }>;

/** The newest card with no answer. Drives Bot.question and the attention badge. */
export function openCard(messages: Message[]): Card | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if ((m.kind === "question" || m.kind === "permission") && m.answer === null) return m;
  }
  return null;
}

export type CardAnswer =
  | { kind: "question"; answer: number | "dismissed" | "expired" }
  | { kind: "permission"; answer: PermissionChoice | "expired" };

const cardWord = { question: "question", permission: "request" } as const;

/** First-wins transition of a card's answer. A second answer, or any answer after expiry, is refused. */
export function settleCard<A extends CardAnswer>(
  message: Message | undefined,
  a: A,
): { ok: true; card: Extract<Card, { kind: A["kind"] }> } | { ok: false; error: string } {
  const word = cardWord[a.kind];
  if (message?.kind !== a.kind) return { ok: false, error: `Unknown ${word}` };
  if (message.answer === "expired") return { ok: false, error: `That ${word} expired` };
  if (message.answer !== null) return { ok: false, error: `That ${word} was already answered` };
  if (message.kind === "question" && typeof a.answer === "number" && a.answer >= message.options.length) return { ok: false, error: "Unknown option" };
  return { ok: true, card: { ...message, answer: a.answer } as Extract<Card, { kind: A["kind"] }> };
}

/** parked wins (nothing will start), then working, then awaiting_approval (resting with its own permission card open). */
export function botStatus(s: { parked: boolean; working: boolean; awaitingApproval: boolean }): BotStatus {
  if (s.parked) return "parked";
  if (s.working) return "working";
  return s.awaitingApproval ? "awaiting_approval" : "idle";
}

/** The wire view of a routine. describe and lastRunAt are derived, never stored. */
/** The newest run that actually fired. */
export const lastRunAt = (r: Owned<RoutineRecord>): string | null => r.runs.find((run) => run.status !== "skipped")?.at ?? null;

export function routineView(r: Owned<RoutineRecord>): Routine {
  return {
    id: r.id,
    name: r.name,
    schedule: r.trigger.schedule,
    describe: describe(r.trigger.schedule),
    prompt: r.prompt,
    enabled: r.enabled,
    lastRunAt: lastRunAt(r),
    trigger: r.trigger.kind,
    nextRunAt: r.nextRunAt,
    runs: r.runs.map((run) => ({ ...run })),
  };
}

export function toBot(bot: BotRecord, status: BotStatus): Bot {
  const lastBot = bot.messages.findLast((m) => m.kind === "bot");
  const card = openCard(bot.messages);
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    avatar: bot.avatar,
    pinned: bot.pinned,
    hidden: bot.hidden,
    status,
    unread: bot.unread,
    question: card === null ? null : card.kind === "question" ? card.question : `${card.label}: ${card.detail}`,
    preview: lastBot?.kind === "bot" ? (lastBot.text.trim().split("\n")[0] ?? "") : "",
    lastAt: bot.messages.at(-1)?.at ?? bot.createdAt,
    createdAt: bot.createdAt,
    routines: bot.routines.map(routineView),
    dailyCapUsd: bot.dailyCapUsd,
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

/** Upsert by name into the scheduler's own (writable) list. An update keeps the id, runs and fail streak. */
export function upsertRoutine(
  routines: RoutineRecord[],
  fields: { name: string; trigger: Trigger; prompt: string; enabled: boolean },
  newId: () => RoutineId,
): { routine: RoutineRecord; created: boolean } {
  const existing = routines.find((r) => r.name === fields.name);
  if (existing) {
    Object.assign(existing, fields);
    return { routine: existing, created: false };
  }
  const routine: RoutineRecord = { id: newId(), ...fields, nextRunAt: null, runs: [], failStreak: 0 };
  routines.push(routine);
  return { routine, created: true };
}
