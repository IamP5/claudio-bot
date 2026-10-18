// Wire protocol between the iOS app and the Mac bridge. JSON over one WebSocket.
// ios/ClaudioBot/Model/Protocol.swift mirrors this file; fixtures/protocol.json pins both.
// docs/grok-bot-reference.md describes the product these types model.
//
// Protocol 3 is additive over 2: no field changes meaning, so an app that only knows 2 still decodes every frame
// (unknown kinds, statuses and types decode to `.unknown`; unknown keys are ignored; an unknown answer string is closed).

export const PROTOCOL = 3;

export type BotId = string & { readonly __brand: "BotId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RoutineId = string & { readonly __brand: "RoutineId" };
export type RunId = string & { readonly __brand: "RunId" };
export type DeviceId = string & { readonly __brand: "DeviceId" };
export type FactId = string & { readonly __brand: "FactId" };

/**
 * What a bridge can do beyond protocol 3's base. hello.features lists the ones this bridge serves, which may be fewer
 * than FEATURES names. An app hides the screens a bridge does not list, so a new app on an older bridge never offers a
 * control the bridge would ignore. Additive changes extend this list instead of bumping PROTOCOL.
 */
export const FEATURES = [
  "memory", "activity", "mute", "worktrees", "connectors", "skills", "webhooks", "spend",
  "mentions", "commands", "exchanges", "groups", "usage",
] as const;
export type Feature = (typeof FEATURES)[number];

export const SHAPES = [
  "circle", "cloud", "diamond", "star4", "flower", "blob", "scallop",
  "drop", "pill", "triangle", "pentagon", "star6", "hexagon",
] as const;
export const COLORS = [
  "white", "brown", "red", "orange", "amber", "green",
  "teal", "blue", "purple", "pink", "gray",
] as const;
export type Shape = (typeof SHAPES)[number];
export type Color = (typeof COLORS)[number];
export type Avatar = { shape: Shape; color: Color };

// What starts a routine: its cron schedule, or a call to its local webhook. The app treats an unknown kind as "other".
export type TriggerKind = "cron" | "webhook";

// running: fired, turn not finished. quiet: ran and had nothing to say, so nothing was posted.
// skipped: not run (missed while the Mac slept, paused by a limit, or dropped by Stop).
export type RunStatus = "running" | "ok" | "quiet" | "failed" | "skipped";

export type RoutineRun = {
  id: RunId;
  at: string;
  status: RunStatus;
  // Fired after its time because the Mac was asleep, inside the grace window.
  late: boolean;
  // Run now from the phone.
  manual: boolean;
  note: string | null;
};

export type Routine = {
  id: RoutineId;
  name: string;
  // Five-field cron in the Mac's local time zone. "" for a webhook routine.
  schedule: string;
  // "Weekdays at 7:57 AM", computed by the bridge.
  describe: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  trigger: TriggerKind;
  nextRunAt: string | null;
  // Newest first. A Bot frame carries the newest 5; details carries every kept run, at most 20.
  runs: RoutineRun[];
};

// working: a turn is in progress, so the app shows "Typing…".
// awaiting_approval: resting with a permission card open. parked: paused by the usage limit or the daily cap.
// unavailable: Claude Code could not start (it is missing, or its sandbox could not start); queued work waits and the
// bridge keeps trying.
export type BotStatus = "idle" | "working" | "awaiting_approval" | "parked" | "unavailable";

// A group is a chat of the user and several bots. It has no Claude Code session of its own: its members answer in it.
// The app treats an unknown kind as a plain bot.
export type BotKind = "bot" | "group";

export type Bot = {
  id: BotId;
  kind: BotKind;
  // The bots in a group, in the order the user picked them. [] for a plain bot.
  members: BotId[];
  name: string;
  // The optional label under the name.
  title: string | null;
  avatar: Avatar;
  pinned: boolean;
  hidden: boolean;
  status: BotStatus;
  unread: number;
  // The newest open card: a question's text, or "<label>: <detail>" for a permission card.
  // Drives the attention badge and the list preview.
  question: string | null;
  preview: string;
  lastAt: string;
  createdAt: string;
  routines: Routine[];
  // Spend cap per local day for this bot and its agents. null: the bridge default, which is no cap unless the Mac sets one.
  dailyCapUsd: number | null;
  // No message or result pushes for this bot. Cards still push: a held call waits on the user.
  muted: boolean;
} & BotSpend;

/**
 * Spend as the ledger counts it: Claude Code's own cost estimates, summed per turn. Refreshed on every bot frame; the
 * hub sends every bot again at local midnight, so today's figure starts over then.
 */
export type BotSpend = {
  // The bot and its agents, on the Mac's current local day.
  spentTodayUsd: number;
  // The cap in force: dailyCapUsd, or the bridge default when that is null. null: no cap, so nothing waits on spend.
  capUsd: number | null;
};

export type Peer =
  | { kind: "bot"; id: BotId; name: string; avatar: Avatar }
  | { kind: "agent"; id: AgentId; title: string }
  | { kind: "routine"; id: RoutineId; name: string };

export type AgentPeer = Extract<Peer, { kind: "agent" }>;

export type Attachment = { name: string; mime: string; path: string };

/** What one "@name" token in a user message points to. The text keeps the token; the app renders it from this. */
export type Mention = { kind: "bot"; id: BotId; name: string } | { kind: "connector"; name: string };

// Allow once, Always for this bot, Deny, Never. The app renders the labels and sends only these strings.
export const PERMISSION_CHOICES = ["once", "always", "deny", "never"] as const;
export type PermissionChoice = (typeof PERMISSION_CHOICES)[number];

export type Message =
  // clientId: the id the app gave its send, echoed so the app can replace its optimistic bubble. Absent on messages
  // from before it existed and on sends that carried none.
  // mentions: absent when the message mentions nothing.
  | { kind: "user"; id: MessageId; at: string; text: string; attachments: Attachment[]; clientId?: string; mentions?: Mention[] }
  // from: in a group conversation, the member who posted it. Absent in a bot's own chat.
  | { kind: "bot"; id: MessageId; at: string; text: string; from?: BotId }
  | {
      kind: "question";
      id: MessageId;
      at: string;
      question: string;
      options: string[];
      // Index into options, "dismissed", "expired" (nobody answered in time), or null while open.
      answer: number | "dismissed" | "expired" | null;
      // null for cards from before protocol 3, which never expire.
      expiresAt: string | null;
    }
  // A tool call held for approval. It has not run, and runs only if the user allows it.
  | {
      kind: "permission";
      id: MessageId;
      at: string;
      // null when the bot itself asked; the agent when one of the bot's agents did.
      from: AgentPeer | null;
      // "Bash", "Write", "mcp__github__merge_pull_request".
      tool: string;
      // The rule that asked, in words: "Push to the default branch".
      label: string;
      // The exact call the user approves, secrets masked: the command line, or "Write <path> (N lines)".
      detail: string;
      // What "Always" would allow from now on, in words, so that button never surprises.
      always: string;
      answer: PermissionChoice | "expired" | null;
      expiresAt: string;
    }
  // A run of messages between this bot and one peer, grouped while nothing else is said.
  // The app labels it: sent 1 → "Messaged X", received 1 → "Message from X", else "N messages with X".
  | { kind: "exchange"; id: MessageId; at: string; peer: Peer; sent: number; received: number }
  // A system line such as "Created routines {0} and {1}". Each {n} is replaced by a tappable chip for refs[n].
  | { kind: "note"; id: MessageId; at: string; text: string; refs: Peer[] };

// capped: the bot's daily cap stopped the agent's turn. Not a failure: a message tomorrow, or a raised cap, resumes it.
export type AgentStatus = "working" | "waiting" | "failed" | "in_cloud" | "awaiting_approval" | "parked" | "unavailable" | "capped";

/**
 * What the bridge itself read from git after a mac agent's turn, so the bot checks the agent's claim against facts
 * rather than the agent's own words. Read with git only (hooks and fsmonitor off); the bridge never runs the repo's
 * own commands.
 */
export type AgentEvidence = {
  at: string;
  branch: string | null;
  /** Short sha of HEAD. */
  head: string | null;
  /** Commits on the branch that its base (the default branch) does not have. */
  ahead: number;
  /** Diffstat of the branch against its base, committed work only. */
  changed: number;
  insertions: number;
  deletions: number;
  /** Uncommitted changes in the checkout. */
  dirty: boolean;
  /** A pull request URL the agent's final message named. */
  pr: string | null;
};

/** A git worktree the bridge made for one mac agent, outside every bot home. Removed only when the user asks. */
export type Worktree = { path: string; branch: string };

export type Agent = {
  id: AgentId;
  botId: BotId;
  title: string;
  where: "mac" | "cloud";
  projectName: string;
  status: AgentStatus;
  // claude.ai/code URL for cloud agents.
  url: string | null;
  createdAt: string;
  updatedAt: string;
  // null until a mac agent's first turn ends, and always for cloud agents.
  evidence: AgentEvidence | null;
  // The isolated checkout the agent works in; null when it works in the project folder itself.
  worktree: Worktree | null;
};

/** An agent as the phone sees it: its spend from the ledger, null for cloud agents, which the bridge does not meter. */
export type AgentView = Agent & {
  // Lifetime, every turn of every session.
  spentUsd: number | null;
  // The lifetime budget in force; null for a cloud agent or when there is none.
  budgetUsd: number | null;
};

export type AgentMessage = { id: MessageId; at: string; from: "bot" | "agent"; text: string };

export type LibraryFile = { path: string; size: number; modifiedAt: string };
export type Link = { url: string; host: string; at: string };

export type Device = {
  id: DeviceId;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  // The phone paired with the shared token from before protocol 3. It keeps working for one release.
  legacy: boolean;
  // The device that asked for this list.
  current: boolean;
};

// Where the broadcast stream stands. The app reconnects with /ws?epoch=<epoch>&after=<last seq seen>;
// if the bridge still holds every frame since then it replays them after a hello with resumed true.
// epoch "" means the bridge keeps no replay ring, so the app never asks to resume.
export type StreamPosition = { epoch: string; seq: number; resumed: boolean };

/**
 * One line of USER.md's ## Facts. by: the name of the bot that remembered it when it did, null for the user. confirmed:
 * the user added or confirmed it, so every bot reads it; false is a bot's proposal, read only by that bot until the user
 * confirms it. proposerBotId: the bot whose proposal it is, null once confirmed; the app matches proposals to a chat by
 * it, since a bot's name can change.
 */
export type Fact = { id: FactId; text: string; at: string; by: string | null; confirmed: boolean; proposerBotId: BotId | null };

/**
 * An MCP server the bot's queries load, by name only: its configuration (commands, URLs, headers) never leaves the
 * Mac. status: as the live query last reported it; unchecked while no query is open to ask.
 */
export type ConnectorStatus = "connected" | "pending" | "failed" | "needs_auth" | "unchecked";
export type Connector = { name: string; status: ConnectorStatus; enabled: boolean };

/** A skill in the bot's own .claude/skills, saved with save_skill. */
export type Skill = { name: string; description: string; updatedAt: string };

/**
 * One entry of the "/" menu, as the bot's Claude Code session reports it: an installed or plugin skill, or a built-in
 * command the bridge allows from the phone. argumentHint is "" when the command takes none. The app treats an unknown
 * source as "skill".
 */
export type CommandSource = "skill" | "builtin";
export type Command = { name: string; description: string; argumentHint: string; source: CommandSource };

/** One message between two bots, the text behind an exchange line. from: the bot that sent it. */
export type ExchangeMessage = { id: MessageId; at: string; from: BotId; text: string };

/**
 * One limit window of the user's Claude plan, as Claude Code's /usage reads it. kind: the 5-hour session, the weekly
 * window over all models, or a weekly window for one model. The app treats an unknown kind as "weekly".
 */
export type UsageWindowKind = "session" | "weekly" | "weekly_model";
/** How close a window is to its limit, as the server rates it. The app treats an unknown severity as "normal". */
export type UsageSeverity = "normal" | "warning" | "critical";
export type UsageWindow = {
  /** The same window keeps its id across reads: "session", "weekly", "weekly:fable". */
  id: string;
  kind: UsageWindowKind;
  /** "Current session", "Weekly · all models", "Weekly · Fable". */
  label: string;
  /** The share of the window used, from 0; at or past 1 the limit is reached. */
  utilization: number;
  resetsAt: string | null;
  severity: UsageSeverity;
};

/**
 * Why the bridge shows no plan limits. api_key: Claude Code runs on an API key; third_party: on Bedrock, Vertex or
 * another provider; logged_out: not logged in; no_scope: logged in with a token that may not read usage; failed: no
 * read has worked since the bridge started. The app treats an unknown reason as "failed".
 */
export type UsageUnavailable = "api_key" | "third_party" | "logged_out" | "no_scope" | "failed";

/**
 * The plan's usage limits. fetchedAt: when these numbers were read. stale: the last reads failed, so these are the last
 * good ones. plan: the subscription Claude Code reports ("max", "pro"), null when it names none.
 */
export type PlanUsage =
  | { state: "ok"; plan: string | null; fetchedAt: string; stale: boolean; windows: UsageWindow[] }
  | { state: "unavailable"; reason: UsageUnavailable; fetchedAt: string };

export type ServerMessage =
  // The app shows "Update the bridge" or "Update the app" when protocol is outside the range it speaks.
  | ({ type: "hello"; protocol: number; features: Feature[]; machine: string; userName: string; bots: Bot[] } & StreamPosition)
  | { type: "bot"; bot: Bot }
  | { type: "bot_removed"; botId: BotId }
  // Answers create_bot with the ref the client sent, so the app can open the new bot.
  | { type: "created"; ref: string; botId: BotId }
  // Full history, sent in answer to open.
  | { type: "conversation"; botId: BotId; messages: Message[] }
  // Insert or replace by message.id. Replaying the same message is a no-op.
  | { type: "message"; botId: BotId; message: Message }
  // routines: the bot's routines with their full run history.
  | { type: "details"; botId: BotId; library: LibraryFile[]; links: Link[]; agents: AgentView[]; routines: Routine[] }
  | { type: "agent"; agent: AgentView; messages: AgentMessage[] }
  // content is null when the file is not text or is over 1 MB. data is base64 for images up to 10 MB.
  | { type: "file"; botId: BotId; path: string; mime: string; content: string | null; data: string | null }
  | { type: "devices"; devices: Device[] }
  // A one-time code another phone can pair with, valid until expiresAt.
  | { type: "pair_code"; code: string; expiresAt: string }
  // What a bot or one of its agents is doing right now ("Reading hub.ts"). text null: it stopped. Live sockets only:
  // never sequenced, never replayed, never pushed.
  | { type: "activity"; botId: BotId; agentId: AgentId | null; text: string | null; at: string }
  // USER.md's facts, in answer to memory and broadcast after each change.
  | { type: "memory"; facts: Fact[] }
  | { type: "connectors"; botId: BotId; connectors: Connector[] }
  | { type: "skills"; botId: BotId; skills: Skill[] }
  | { type: "commands"; botId: BotId; commands: Command[] }
  // Every message between botId and peer, oldest first, in answer to exchange.
  | { type: "exchange"; botId: BotId; peer: BotId; messages: ExchangeMessage[] }
  // A new token for a webhook routine, shown once. The bridge keeps only its hash. url answers on this Mac only.
  | { type: "webhook_token"; botId: BotId; routineId: RoutineId; url: string; token: string }
  // The plan's usage limits (feature "usage"). Live sockets only, like activity: sent after the hello to each socket
  // that connects, and to every live socket when they change. Never sequenced or replayed.
  | { type: "usage"; usage: PlanUsage }
  | { type: "error"; message: string };

/** Sent to live protocol 3 sockets only, without a seq: not kept for replay. */
export type Signal = Extract<ServerMessage, { type: "activity" | "usage" }>;

// A frame published to every socket carries the stream seq. Replies to one client do not.
export type Broadcast = ServerMessage & { seq: number };

export type Upload = { name: string; mime: string; data: string };

// members applies to a group only.
export type BotPatch = Partial<Pick<Bot, "name" | "title" | "avatar" | "pinned" | "hidden" | "dailyCapUsd" | "muted" | "members">>;

export type ClientMessage =
  | { type: "create_bot"; ref: string }
  // Sends the conversation and marks the bot read.
  | { type: "open"; botId: BotId }
  | { type: "send"; botId: BotId; text: string; uploads: Upload[]; clientId?: string; mentions?: Mention[] }
  | { type: "answer"; botId: BotId; messageId: MessageId; option: number }
  | { type: "dismiss"; botId: BotId; messageId: MessageId }
  // Answers a permission card. The only way a held call can run: chat text never approves.
  | { type: "decide"; botId: BotId; messageId: MessageId; choice: PermissionChoice }
  // Stops the bot's turn in flight and drops its queued unattended work. Its user's queued messages still run.
  | { type: "stop"; botId: BotId }
  | { type: "stop_agent"; agentId: AgentId }
  | { type: "update_bot"; botId: BotId; patch: BotPatch }
  | { type: "mark_unread"; botId: BotId }
  // Refused while the bot's agents hold worktrees, unless force: the phone shows them first, then deletes anyway.
  | { type: "delete_bot"; botId: BotId; force?: boolean }
  | { type: "set_routine"; botId: BotId; routineId: RoutineId; enabled: boolean }
  | { type: "run_routine"; botId: BotId; routineId: RoutineId }
  | { type: "details"; botId: BotId }
  | { type: "agent"; agentId: AgentId }
  | { type: "file"; botId: BotId; path: string }
  | { type: "memory" }
  // factId null adds a fact.
  | { type: "set_fact"; factId: FactId | null; text: string }
  | { type: "forget_fact"; factId: FactId }
  // The user confirms a bot's proposed fact, so every bot reads it.
  | { type: "confirm_fact"; factId: FactId }
  | { type: "connectors"; botId: BotId }
  // Persisted per bot, covering its agents, so the choice survives a restart and a resume.
  | { type: "set_connector"; botId: BotId; name: string; enabled: boolean }
  | { type: "skills"; botId: BotId }
  | { type: "delete_skill"; botId: BotId; name: string }
  | { type: "commands"; botId: BotId }
  // The messages behind the exchange lines between botId and peer.
  | { type: "exchange"; botId: BotId; peer: BotId }
  // Answered by created with the same ref, like create_bot.
  | { type: "create_group"; ref: string; name: string; members: BotId[] }
  // Makes a new token for a webhook routine and invalidates the old one.
  | { type: "webhook_token"; botId: BotId; routineId: RoutineId }
  // Removes the agent's worktree. Refused while the agent works, or while the worktree holds uncommitted work or ignored files other than build folders.
  | { type: "remove_worktree"; agentId: AgentId }
  // Reads the plan's usage now, as pull-to-refresh does. Answered with a usage frame once the read ends.
  | { type: "refresh_usage" }
  // Transport messages: the socket layer answers these, because they need the socket's own device.
  | { type: "devices" }
  | { type: "revoke_device"; deviceId: DeviceId }
  | { type: "pair_code" };

export type TransportMessage = Extract<ClientMessage, { type: "devices" | "revoke_device" | "pair_code" }>;

// HTTP, outside the socket. POST /pair with a one-time code returns this device's own token.
// The socket then authenticates with Authorization: Bearer <token>.
export type PairRequest = { code: string; name: string };
export type PairResponse = { deviceId: DeviceId; token: string };
