import { describe } from "./cron";
import { maskSecrets } from "./text";
import {
  COLORS,
  SHAPES,
  type Agent,
  type AgentId,
  type AgentMessage,
  type AgentPeer,
  type AgentStatus,
  type Avatar,
  type Bot,
  type BotId,
  type BotSpend,
  type BotStatus,
  type DeviceId,
  type ExchangeMessage,
  type ItemId,
  type Link,
  type Mention,
  type Message,
  type MessageId,
  type MirrorPref,
  type Peer,
  type AskQuestion,
  type PermissionMessage,
  type PermissionMode,
  type PhoneMode,
  type Routine,
  type RoutineId,
  type RoutineRun,
  type RunId,
  type SessionId,
  type SessionItem,
  type SessionOutcome,
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

/** A session the user drives from the phone. Never a gate actor: the gate and the policy keep taking Actor. */
export type OwnActor = { kind: "own"; sessionId: SessionId };
/** Whoever a session.ts Session runs and the ledger meters: a bot, an agent, or the phone's own session. */
export type Driver = Actor | OwnActor;
export type DriverKey = ActorKey | `own:${string}`;
export const driverKey = (d: Driver): DriverKey => (d.kind === "own" ? `own:${d.sessionId}` : actorKey(d));

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

/** A turn at this many hops reaches no other bot: message_bot, create_bot and a group mention all stop here. */
export const HOP_LIMIT = 2;

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
   * command: a /command or skill, text being exactly "/name args". Claude Code runs it from the bare text or from the
   * last text block, so the notices, standing brief and context an envelope carries go in blocks above it.
   */
  kind: "envelope" | "continuation" | "command";
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
  /**
   * The group this turn answers in: its text posts to that group's conversation as the bot. Absent for the bot's own
   * chat, and on every envelope saved before groups existed.
   */
  group?: BotId;
  /** The user's message in the group that began the chain this turn is part of (groups.createChains). Set with group. */
  chain?: MessageId;
  /** The id the phone gave a message it sent to a session, which its queued item carries until the transcript shows it. */
  clientId?: string;
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
export type SessionState = {
  id: string | null;
  pending: Pending[];
  lifecycle: Lifecycle;
  notices: Notice[];
  /**
   * Hashes of the context and standing brief last put on a turn of session `id`, so a restart neither repeats them nor
   * misses a change. Absent until the first; ignored by a query that starts a new session.
   */
  sent?: { context?: string; brief?: string };
  /**
   * The live query's background tasks, absent when it has none. close() leaves them on disk, so the next start can
   * check which a restart stopped.
   */
  background?: BackgroundTask[];
};

/**
 * A background task as a note names it (description) and as the thread shows it (kind, label, stepId, startedAt).
 * group: the process group that runs it, a command's own shell or Claude Code itself, when the bridge found it. A
 * command can outlive Claude Code, so only a check of its group tells whether it still runs.
 */
export type BackgroundTask = {
  id: string;
  description?: string;
  kind?: "agent" | "command" | "other";
  label?: string;
  stepId?: string;
  startedAt?: string;
  group?: number;
};

export const emptySession = (id: string | null = null): SessionState => ({ id, pending: [], lifecycle: { kind: "idle" }, notices: [] });

/** Account-wide pause after a usage-limit rejection (resetsAt + 30 s). No session starts a turn before it. Writer: session.ts. */
export type AccountState = { parkedUntil: string | null };


/**
 * What fires a routine; the scheduler switches over it exhaustively. A webhook routine fires only when a local caller
 * presents its token: tokenHash is the token's sha256, null until the user makes one on the phone. It has no
 * nextRunAt, and the clock never fires it.
 */
export type Trigger = { kind: "cron"; schedule: string } | { kind: "webhook"; tokenHash: string | null };

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
  // initiator: the turn that asked, so the answer continues that turn's chain instead of becoming the user's. Absent on
  // cards saved before it was recorded; the gate answers those as system work.
  | { kind: "question"; cardId: MessageId; actor: BotActor; remindAt: string | null; expiresAt: string; initiator?: Initiator }
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
/** aliveAt: the last minute the bridge ran with a card open, so a restart can give cards back the time it was down. */
export type GateState = { open: OpenCard[]; grants: Grant[]; daily: DailyCount[]; repos: RepoTrust[]; aliveAt?: string };


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


/** What a bot and a group share: one chat in the phone's list. Writer: hub. */
export type ChatRecord = {
  id: BotId;
  name: string;
  title: string | null;
  avatar: Avatar;
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  /** Writer: hub.say → post. Status is not stored: it is derived from the sessions and the gate. */
  messages: Message[];
  unread: number;
  /** No message or result pushes. Writer: hub (update_bot); push.ts reads it. */
  muted: boolean;
};

export type BotRecord = ChatRecord & {
  /** null: the bridge default. Writer: hub (update_bot). */
  dailyCapUsd: number | null;
  /** MCP servers the user turned off for this bot and its agents, by name. Writer: connectors.ts. */
  readonly connectorsOff: Owned<string[]>;
  readonly session: Owned<SessionState>;
  readonly routines: Owned<RoutineRecord[]>;
  readonly rules: Owned<StandingRule[]>;
};

/**
 * A chat of the user and 2 to 8 bots (groups.GROUP_SIZE). It has no session, home, routines, agents, skills,
 * connectors, cards or spend: its members answer in it from their own sessions. So it lives in World.groups, apart
 * from the bots that every session, routine, card and connector path walks. members: in the order the user picked
 * them. Writer: hub.
 */
export type GroupRecord = ChatRecord & { members: BotId[] };

export type AgentRecord = {
  /** Writer: agents.ts. */
  agent: Agent;
  cwd: string;
  /**
   * The project folder's realpath, read when the agent started: repo trust, its config and its worktree's removal go
   * through it, never through files in the worktree the agent can rewrite. Writer: agents.ts. Absent on older records.
   */
  repo?: string;
  /** The commit a worktree agent's branch started from; its evidence counts ahead against it. Writer: agents.ts. */
  base?: string | null;
  messages: AgentMessage[];
  /** Mac agents' SDK session. Writer: session.ts. */
  readonly session: Owned<SessionState>;
  /** Cloud agents' claude.ai session. Writer: agents.ts. */
  cloudSession: string | null;
  /** null: the bridge default. */
  budgetUsd: number | null;
  /** The bot turn that started the agent. A report with no turn behind it (a restart cut it off) inherits this lineage. */
  startedBy: Initiator;
  /**
   * Finished turns' reports not yet delivered to the bot, oldest first. Saved before git is read, so a restart delivers
   * them with fresh evidence. Writer: agents.ts. Absent on older records.
   */
  unreported?: AgentReport[];
  /** The user messaged the agent from its session since its last report, so the next report says so. Writer: agents.ts. */
  directed?: boolean;
};

/** A finished turn's report: the status it leaves, the agent's final message, and the initiator of its turn. */
export type AgentReport = { status: AgentStatus; text: string; by: Initiator };

/**
 * The text of every message_bot message between two bots, oldest first, at most EXCHANGE_KEEP. bots is the pair in
 * sorted order, so either bot finds the same log. Writer: world.ts (logExchange, forgetExchanges).
 */
export type ExchangeLog = { bots: [BotId, BotId]; messages: ExchangeMessage[] };

/**
 * The bridge's own facts about one Claude Code session it has shown or driven: the transcript owns everything else
 * (docs/sessions-design.md §2.1). Writer: sessions.ts.
 */
export type SessionRecord = {
  id: SessionId;
  /** ClaudioBot's own archive. The Claude app's archive is its own store, never written. */
  hidden: boolean;
  /** When the user last left the thread. Unread needs it set (or the bridge driving the session). */
  visitedAt: string | null;
  /**
   * An import into the Claude app is due (docs/sessions-design.md §8.4): since `dueAt`, after the session's first
   * finished turn. failed: one ran and the app did not list the session within 10 s, so automatic tries stopped.
   * Absent when none is due, or once the app lists the session.
   */
  mirror?: { dueAt: string; failed: boolean };
  /** Present once the phone has sent to it or made it; never on an id an agent owns. */
  own?: OwnDrive;
};

/** A session the user drives from the phone. Writer: own.ts, its session slice session.ts. */
export type OwnDrive = {
  /** Where the query opens, fixed at the first send from the transcript (or the new session's folder). */
  cwd: string;
  /** Started from the phone (origin "phone"). */
  created: boolean;
  /** When the phone first sent to it. */
  at: string;
  /** A session the phone started: its first prompt, the row's title until Claude Code names it. */
  prompt?: string;
  /** null: the transcript's last model, else Claude Code's default. */
  model: string | null;
  /** null: the transcript's last mode, else the user's settings.permissions.defaultMode. */
  mode: PhoneMode | null;
  readonly session: Owned<SessionState>;
  /** Open cards and the newest settled ones. Writer: own.ts. */
  cards: OwnCard[];
  // How runs end, kept across bridge restarts. Writer: own.ts.
  /** How the last run ended, until a new run starts: the next send, or a queued turn after the one that ended. */
  outcome?: SessionOutcome;
  /** The envelope whose turn that ending ended; a turn of any other envelope starts a new run. */
  endedTurn?: string;
  /** The steps of tasks the user stopped: they read stopped once the task is gone, before the transcript says so. */
  stoppedSteps?: string[];
  /** The last time work was cut off, kept across sends: steps that started before it never end. */
  cut?: Cut;
  /** The bridge's own lines in the thread (stops, failures, restarts), the newest few. */
  notices?: Extract<SessionItem, { kind: "notice" }>[];
  /** Prompts a stop ended before Claude Code wrote them down, shown until the transcript has their words. */
  kept?: { id: ItemId; at: string; text: string }[];
  /** Background commands that outlived the Claude Code that ran them: they still run, and only the bridge follows them. */
  outlived?: (BackgroundTask & { group: number })[];
};

/**
 * When work on a session was cut off (a stop of everything, Claude Code exiting, a bridge restart) and how it reads:
 * a step that started before then and still reads running will never get its result.
 */
export type Cut = { at: string; state: "stopped" | "error"; cause: string };

/**
 * What Claude Code asked the phone. Live only on the SDK side: the query waiting on it dies with the bridge, so at
 * boot every open one is expired.
 * - permission: a tool call Claude Code's own settings ask about. suggestions: what Always applies, for the session.
 * - ask: AskUserQuestion, answered by question text.
 * - plan: ExitPlanMode. modeBefore: the mode to go back to once the plan is approved.
 */
export const ownCardId = (c: OwnCard): MessageId => (c.kind === "permission" ? c.card.id : c.cardId);
export const ownCardOpen = (c: OwnCard): boolean => (c.kind === "permission" ? c.card.answer === null : c.kind === "ask" ? c.answers === null : c.state === "proposed");

export type OwnCard =
  | {
      kind: "permission";
      card: PermissionMessage;
      toolUseId: string;
      suggestions: unknown[];
      /** The asking subagent: its task id, label and Agent call; absent when the main thread asked. */
      agent?: { id: string; label: string | null; stepId: string | null };
      /** When the user allowed it, so the call's run starts there. */
      allowedAt?: string;
    }
  | {
      kind: "ask";
      cardId: MessageId;
      toolUseId: string;
      at: string;
      expiresAt: string;
      questions: AskQuestion[];
      answers: Record<string, string> | "dismissed" | "expired" | null;
    }
  | {
      kind: "plan";
      cardId: MessageId;
      toolUseId: string;
      at: string;
      expiresAt: string;
      text: string;
      state: "proposed" | "approved" | "rejected" | "expired";
      modeBefore: PermissionMode;
    };

/** Settings, "Show agent sessions in the Claude app". Writer: sessions.ts. */
export type SessionPrefs = { mirror: MirrorPref };

export type World = {
  bots: Map<BotId, BotRecord>;
  /** Group ids share the bot id space, as Bot.id on the wire, and never collide with a bot's. */
  groups: Map<BotId, GroupRecord>;
  agents: Map<AgentId, AgentRecord>;
  readonly gate: Owned<GateState>;
  readonly devices: Owned<DeviceRecord[]>;
  readonly push: Owned<PushState>;
  readonly account: Owned<AccountState>;
  readonly exchanges: Owned<ExchangeLog[]>;
  sessions: Map<SessionId, SessionRecord>;
  readonly sessionPrefs: Owned<SessionPrefs>;
};

export const emptyWorld = (): World => ({
  bots: new Map(),
  groups: new Map(),
  agents: new Map(),
  gate: { open: [], grants: [], daily: [], repos: [] },
  devices: [],
  push: { sent: [] },
  account: { parkedUntil: null },
  exchanges: [],
  sessions: new Map(),
  sessionPrefs: { mirror: "auto" },
});

export const EXCHANGE_KEEP = 200;

const pairOf = (a: BotId, b: BotId): [BotId, BotId] => (a < b ? [a, b] : [b, a]);
const isPair = (log: Owned<ExchangeLog>, [a, b]: [BotId, BotId]) => log.bots[0] === a && log.bots[1] === b;

/** Records one message_bot message, its secrets masked, and drops the pair's oldest past EXCHANGE_KEEP. */
export function logExchange(world: World, message: ExchangeMessage, to: BotId) {
  const pair = pairOf(message.from, to);
  const logs = own<ExchangeLog[]>(world.exchanges);
  let log = logs.find((l) => isPair(l, pair));
  if (!log) logs.push((log = { bots: pair, messages: [] }));
  log.messages.push({ ...message, text: maskSecrets(message.text) });
  log.messages.splice(0, Math.max(0, log.messages.length - EXCHANGE_KEEP));
}

/** Every kept message between the two bots, oldest first; [] for a pair that never exchanged text. */
export const exchangeBetween = (world: World, a: BotId, b: BotId): ExchangeMessage[] =>
  (world.exchanges.find((l) => isPair(l, pairOf(a, b)))?.messages ?? []).map((m) => ({ ...m }));

/** A deleted bot's logs go with it, from both sides. */
export function forgetExchanges(world: World, botId: BotId) {
  const logs = own<ExchangeLog[]>(world.exchanges);
  logs.splice(0, logs.length, ...logs.filter((l) => !l.bots.includes(botId)));
}

/** The bot or the group with this id: the chats the phone lists. */
export const chatOf = (world: World, id: BotId): ChatRecord | undefined => world.bots.get(id) ?? world.groups.get(id);

export const newMessageId = () =>`m_${crypto.randomUUID()}` as MessageId;

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
    muted: false,
    connectorsOff: [],
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
export function post(chat: ChatRecord, message: Message): Message {
  const i = chat.messages.findIndex((m) => m.id === message.id);
  const previous = i === -1 ? undefined : chat.messages[i];
  chat.unread += unreadDelta(previous, message);
  if (i === -1) chat.messages.push(message);
  else chat.messages[i] = message;
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

/**
 * unavailable wins (Claude Code could not start, so the retry is no turn), then working (a turn runs), then parked
 * (nothing runs and the queue head is held), then awaiting_approval.
 */
export function botStatus(s: { unavailable: boolean; working: boolean; held: boolean; awaitingApproval: boolean }): BotStatus {
  if (s.unavailable) return "unavailable";
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
  const schedule = r.trigger.kind === "cron" ? r.trigger.schedule : "";
  return {
    id: r.id,
    name: r.name,
    schedule,
    describe: r.trigger.kind === "cron" ? describe(schedule) : "When its webhook is called",
    prompt: r.prompt,
    enabled: r.enabled,
    lastRunAt: lastRunAt(r),
    trigger: r.trigger.kind,
    nextRunAt: r.nextRunAt,
    runs: r.runs.slice(0, limit).map((run) => ({ ...run })),
  };
}

function chatFrame(chat: ChatRecord, status: BotStatus) {
  const lastBot = chat.messages.findLast((m) => m.kind === "bot");
  return {
    id: chat.id,
    name: chat.name,
    title: chat.title,
    avatar: chat.avatar,
    pinned: chat.pinned,
    hidden: chat.hidden,
    status,
    unread: chat.unread,
    preview: lastBot?.kind === "bot" ? (lastBot.text.trim().split("\n")[0] ?? "") : "",
    lastAt: chat.messages.at(-1)?.at ?? chat.createdAt,
    createdAt: chat.createdAt,
    muted: chat.muted,
  };
}

/** The bot frame without its spend, which the ledger adds. */
export function toBot(bot: BotRecord, status: BotStatus): Omit<Bot, keyof BotSpend> {
  const card = openCard(bot.messages);
  return {
    ...chatFrame(bot, status),
    kind: "bot",
    members: [],
    question: card === null ? null : card.kind === "question" ? card.question : `${card.label}: ${card.detail}`,
    routines: bot.routines.map((r) => routineView(r, RUNS_ON_BOT)),
    dailyCapUsd: bot.dailyCapUsd,
  };
}

/** A group's frame. Its members' cards open in their own chats, so a group never asks anything itself. */
export const toGroup = (group: GroupRecord, status: BotStatus): Omit<Bot, keyof BotSpend> => ({
  ...chatFrame(group, status),
  kind: "group",
  members: [...group.members],
  question: null,
  routines: [],
  dailyCapUsd: null,
});

export const sortBots = <B extends Pick<Bot, "pinned" | "lastAt">>(bots: B[]): B[] =>
  [...bots].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt.localeCompare(a.lastAt));

/**
 * The user's mentions as the bridge keeps them: bots that exist, under their current names, and connectors among
 * `connectors` (the bot's, turned on). Anything else is dropped, and so is a repeat.
 */
export function resolveMentions(world: World, mentions: readonly Mention[], connectors: ReadonlySet<string>): Mention[] {
  const kept = new Map<string, Mention>();
  for (const m of mentions) {
    if (m.kind === "connector") {
      if (connectors.has(m.name)) kept.set(`connector:${m.name}`, m);
      continue;
    }
    const bot = world.bots.get(m.id);
    if (bot) kept.set(`bot:${bot.id}`, { kind: "bot", id: bot.id, name: bot.name });
  }
  return [...kept.values()];
}

/** By id, then by name, then by title, ignoring case: a bot is often called by its role ("the engineer"). */
export function findBot(world: World, ref: string): BotRecord | undefined {
  const byId = world.bots.get(ref as BotId);
  if (byId) return byId;
  const key = ref.trim().toLowerCase();
  const bots = [...world.bots.values()];
  return bots.find((b) => b.name.toLowerCase() === key) ?? bots.find((b) => b.title?.trim().toLowerCase() === key);
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

function extractUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, ""));
}

export function linksOf(bot: ChatRecord, agents: Agent[]): Link[] {
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
    case "webhook":
      return b.kind === "webhook";
  }
}

/** The list_routines tool's answer: each routine's name, when it runs, whether it is on, and its newest run. */
export function routinesText(routines: Owned<RoutineRecord[]>): string {
  if (routines.length === 0) return "No routines.";
  return routines
    .map((r) => {
      const v = routineView(r, 1);
      const last = v.runs[0];
      const state = v.enabled ? (v.nextRunAt ? `next ${v.nextRunAt}` : "on") : "paused";
      return `- ${v.name}: ${v.describe} (${v.trigger === "cron" ? v.schedule : "webhook"}), ${state}; last run: ${last ? `${last.status} at ${last.at}` : "never"}`;
    })
    .join("\n");
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
