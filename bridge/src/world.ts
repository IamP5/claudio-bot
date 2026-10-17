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
  type Routine,
  type RoutineId,
  type RoutineRun,
  type RunId,
} from "./protocol";

// The records in state.json (version 3) and the pure rules over them. Every persisted shape is declared here, so the
// file's schema has one home; each slice names the one module that writes it.


/** Who runs a turn. An agent belongs to a bot: its cards show in the bot's chat and the bot's standing rules apply. */
export type Actor = { kind: "bot"; botId: BotId } | { kind: "agent"; botId: BotId; agentId: AgentId };
type BotActor = Extract<Actor, { kind: "bot" }>;
export type AgentActor = Extract<Actor, { kind: "agent" }>;
export type ActorKey = `bot:${string}` | `agent:${string}`;
export const actorKey = (a: Actor): ActorKey => (a.kind === "bot" ? `bot:${a.botId}` : `agent:${a.agentId}`);
export const botActor = (botId: BotId): BotActor => ({ kind: "bot", botId });

export type RunRef = { routineId: RoutineId; runId: RunId };

/** Where a chain of work began. Bot and agent hops inherit it, so lineage survives any number of hops. */
export type Origin = { kind: "user" } | { kind: "routine"; run: RunRef; manual: boolean } | { kind: "system" };

/**
 * Who started the work a turn is doing. Derived from the envelope (prompts.initiatorOf), never passed around by hand,
 * and recorded on every audit and usage row.
 * - routine.manual: Run now from the phone. Attended and never quiet, but still a routine for initiator bans.
 * - bot, agent: a hop. hops counts the bot-to-bot hops along the whole chain, and an agent hop carries the count
 *   through without adding one. message_bot and create_bot are refused at 2 or more. origin is where the chain began,
 *   so a chain that began as a routine stays routine-banned however many hops later.
 * - system: no turn in flight, or work the bridge made itself. Treated as unattended.
 */
export type Initiator =
  | Origin
  | { kind: "bot"; botId: BotId; hops: number; origin: Origin }
  | { kind: "agent"; agentId: AgentId; hops: number; origin: Origin };

/** Someone is at the phone. Unattended work gets the policy's stricter column and is held by the daily cap. */
export const attended = (i: Initiator): boolean => i.kind === "user" || (i.kind === "routine" && i.manual);

export const rootOf = (i: Initiator): Origin => (i.kind === "bot" || i.kind === "agent" ? i.origin : i);

/** The routine bans (no set_routine or delete_routine) apply to every turn of a chain a routine began. */
export const isRoutineChain = (i: Initiator): boolean => rootOf(i).kind === "routine";

/** Bot-to-bot hops that led to this turn. The policy refuses message_bot and create_bot at 2 or more. */
export const hopsOf = (i: Initiator): number => (i.kind === "bot" || i.kind === "agent" ? i.hops : 0);

/** The hop count of a bot message or a bot creation made during a turn that `by` started. */
export const hopsAfter = (by: Initiator | null): number => (by === null ? 0 : hopsOf(by)) + 1;

/**
 * A slice another module owns: a readonly field holding deeply readonly data, so `bot.routines.push(…)` or
 * `bot.routines = …` outside the scheduler fails to compile. The owner calls `own()` and mutates in place.
 */
export type Owned<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly Owned<U>[]
    : { readonly [K in keyof T]: Owned<T[K]> };

/** The writable view of a slice. Only the slice's writer, named on its type, calls this. */
export const own = <T>(slice: Owned<T>): T => slice as unknown as T;


export type EnvelopeId = string & { readonly __brand: "EnvelopeId" };

/** One envelope waiting for a turn, or in one. The queue head is the turn in flight or the next to start. */
export type Pending = {
  /** Stable across replays. */
  id: EnvelopeId;
  /**
   * continuation: the decision envelope after a permission card was answered. It runs ahead of other queued work,
   * Stop keeps it, and its turn's start arms the grant's short window (gate.beginTurn).
   */
  kind: "envelope" | "continuation";
  at: string;
  /** The rendered envelope. Notices are prepended when it starts, not stored here. */
  text: string;
  initiator: Initiator;
  /**
   * The routine run this envelope's turn end settles. Set only for a routine's own fire, so an approval continuation
   * that carries the routine's initiator never settles the run a second time.
   */
  settles: RunRef | null;
  /**
   * Starts so far. A replay after a crash or a transient error bumps it. session.MAX_STARTS (4: the first start and
   * three retries) is the poison limit.
   */
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
 *   usage_limit mirrors the account-wide AccountState.parkedUntil, or parks this session alone when the limit is a
 *   model's (a weekly Opus or Sonnet limit), because another model may still run. The envelope stays at the head.
 */
export type Lifecycle =
  | { kind: "idle" }
  | { kind: "working"; turn: ActiveTurn }
  | { kind: "stopping"; turn: ActiveTurn; deadline: string }
  | { kind: "backoff"; until: string; attempt: number }
  | { kind: "parked"; reason: ParkReason; until: string };

/** Why a session's queue head waits instead of starting. */
export type Hold = { reason: ParkReason; until: string };

/**
 * The hold on the queue head: a park with work queued. A parked lifecycle never carries a turn, so a held bot has
 * nothing running. session.ts keeps the lifecycle parked exactly while the head is held, for either reason.
 */
export function holdOf(state: Owned<SessionState>): Hold | null {
  const l = state.lifecycle;
  return l.kind === "parked" && state.pending.length > 0 ? { reason: l.reason, until: l.until } : null;
}

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

/**
 * "Allow once": this exact call may run one time before expiresAt (10 minutes). Consumed on use, and only by a turn of
 * the attendance of the card that made it, so an unattended turn cannot ride an approval the user gave in their own
 * turn, and the continuation the grant was made for still finds it. Persisted, so a restart keeps that binding.
 */
export type Grant = { actor: ActorKey; fingerprint: Fingerprint; cardId: MessageId; appliesTo: "attended" | "unattended"; expiresAt: string };

/** What a permission decision applies to. The card message is what the user sees; this is the match key behind it. */
type HeldCall = {
  initiator: Initiator;
  tool: string;
  signature: Signature;
  fingerprint: Fingerprint;
  label: string;
  detail: string;
  always: string;
};

/**
 * An open card's deadlines. The card shows in actor.botId's chat; a question is always the bot's own. A trust card is
 * a permission card on the wire that asks whether the agents in `root` may load the repo's own Claude Code config.
 */
export type OpenCard =
  | { kind: "question"; cardId: MessageId; actor: BotActor; remindAt: string | null; expiresAt: string }
  | { kind: "permission"; cardId: MessageId; actor: Actor; remindAt: string | null; expiresAt: string; call: HeldCall }
  | { kind: "trust"; cardId: MessageId; actor: AgentActor; remindAt: string | null; expiresAt: string; root: string };

/** The kind of message an open card shows as. */
export const cardMessageKind = (card: OpenCard): Card["kind"] => (card.kind === "question" ? "question" : "permission");

/**
 * The user's answer on a trust card. Until an agent's repo is trusted, the agent runs with an empty config folder of
 * the bridge's (projectConfigRoot), so the repo's committed .claude settings and hooks, .mcp.json servers, commands
 * and skills never load. agentId null: every agent in the repo, from Always or Never; else that agent, from Allow
 * once or Deny.
 */
export type RepoTrust = { root: string; agentId: AgentId | null; trusted: boolean; cardId: MessageId; at: string };

/** Whether this agent may load its repo's own config: its own answer, else the repo's; null when nobody answered. */
export function repoTrust(gate: Owned<GateState>, root: string, agentId: AgentId): boolean | null {
  const answer = gate.repos.find((r) => r.root === root && r.agentId === agentId) ?? gate.repos.find((r) => r.root === root && r.agentId === null);
  return answer?.trusted ?? null;
}

/** Allowed calls of a capped tool (create_bot, start_agent) per bot per local day. */
export type DailyCount = { botId: BotId; tool: string; day: string; count: number };

/** Writer: gate.ts. */
export type GateState = { open: OpenCard[]; grants: Grant[]; daily: DailyCount[]; repos: RepoTrust[] };


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

/**
 * Pushes already sent, recorded before sending so a crash never double-pushes. key: `${messageId}|${reason}`, reason
 * card, reminder, message (a turn's first bubble) or result (a long turn's last bubble). Writer: push.ts.
 */
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
  /** The bot turn that started the agent. A report with no turn behind it (a restart cut it off) inherits this lineage. */
  startedBy: Initiator;
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
  gate: { open: [], grants: [], daily: [], repos: [] },
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


function unreadDelta(previous: Message | undefined, next: Message): number {
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
function exchangeFor(
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

/** Messages a bot or agent thread keeps in state.json. Older ones move to the thread's archive. */
const HISTORY_KEEP = 1000;
/** How far past HISTORY_KEEP a thread grows before the move, so the archive takes a batch at a time. */
const HISTORY_SLACK = 100;

/**
 * The move for a thread past HISTORY_KEEP + HISTORY_SLACK: what goes to the archive, oldest first, and what stays,
 * the newest HISTORY_KEEP plus any older message `pinned` holds back. null while the thread is within bounds.
 */
export function splitHistory<M>(messages: readonly M[], pinned: (m: M) => boolean): { archived: M[]; kept: M[] } | null {
  if (messages.length <= HISTORY_KEEP + HISTORY_SLACK) return null;
  const old = messages.slice(0, messages.length - HISTORY_KEEP);
  return { archived: old.filter((m) => !pinned(m)), kept: [...old.filter(pinned), ...messages.slice(-HISTORY_KEEP)] };
}

export type Card = Extract<Message, { kind: "question" | "permission" }>;

/** A card still waiting for its answer. The gate finds it in the bot's messages, so it never leaves state. */
export const isOpenCard = (m: Message): m is Card => (m.kind === "question" || m.kind === "permission") && m.answer === null;

/** The newest card with no answer. Drives Bot.question and the attention badge. */
export function openCard(messages: Message[]): Card | null {
  return messages.findLast(isOpenCard) ?? null;
}

export type CardAnswer = { [K in Card["kind"]]: { kind: K; answer: NonNullable<Extract<Card, { kind: K }>["answer"]> } }[Card["kind"]];

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

/** working wins (a turn runs), then parked (nothing runs and the queue head is held), then awaiting_approval. */
export function botStatus(s: { working: boolean; held: boolean; awaitingApproval: boolean }): BotStatus {
  if (s.working) return "working";
  if (s.held) return "parked";
  return s.awaitingApproval ? "awaiting_approval" : "idle";
}

/** The newest run that actually fired. */
export const lastRunAt = (r: Owned<RoutineRecord>): string | null => r.runs.find((run) => run.status !== "skipped")?.at ?? null;

/** Runs a Bot frame carries per routine, which every broadcast repeats. The details reply carries every kept run. */
export const RUNS_ON_BOT = 5;

/** The wire view of a routine, with its newest `limit` runs. describe and lastRunAt are derived, never stored. */
export function routineView(r: Owned<RoutineRecord>, limit = r.runs.length): Routine {
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
    runs: r.runs.slice(0, limit).map((run) => ({ ...run })),
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
    routines: bot.routines.map((r) => routineView(r, RUNS_ON_BOT)),
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

function extractUrls(text: string): string[] {
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

function sameTrigger(a: Trigger, b: Trigger): boolean {
  switch (a.kind) {
    case "cron":
      return b.kind === "cron" && a.schedule === b.schedule;
  }
}

/**
 * Upsert by name into the scheduler's own (writable) list. An update keeps the id and runs. A new trigger, pausing or
 * re-enabling clears nextRunAt for the scheduler to recompute; re-enabling also clears the fail streak.
 */
export function upsertRoutine(
  routines: RoutineRecord[],
  fields: { name: string; trigger: Trigger; prompt: string; enabled: boolean },
  newId: () => RoutineId,
): { routine: RoutineRecord; created: boolean } {
  const existing = routines.find((r) => r.name === fields.name);
  if (existing) {
    const retimed = !sameTrigger(existing.trigger, fields.trigger) || existing.enabled !== fields.enabled;
    if (fields.enabled && !existing.enabled) existing.failStreak = 0;
    Object.assign(existing, fields);
    if (retimed) existing.nextRunAt = null;
    return { routine: existing, created: false };
  }
  const routine: RoutineRecord = { id: newId(), ...fields, nextRunAt: null, runs: [], failStreak: 0 };
  routines.push(routine);
  return { routine, created: true };
}
