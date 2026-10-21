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
export type MachineId = string & { readonly __brand: "MachineId" };
/** One world of bots: the home's, minted once and kept in its machine.json, so it outlives the home's address. */
export type WorldId = string & { readonly __brand: "WorldId" };

/**
 * What a bridge can do beyond protocol 3's base. hello.features lists the ones this bridge serves, which may be fewer
 * than FEATURES names. An app hides the screens a bridge does not list, so a new app on an older bridge never offers a
 * control the bridge would ignore. Additive changes extend this list instead of bumping PROTOCOL.
 */
export const FEATURES = [
  "memory", "activity", "mute", "worktrees", "connectors", "skills", "webhooks", "spend",
  "mentions", "commands", "exchanges", "groups", "usage", "sessions", "presence", "machines",
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
  // The machine this bot starts its agents on unless it names another. null: the bot picks, the home's own machine
  // when it names none. Always null for a group.
  agentsOn: MachineId | null;
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
  // The machine it runs on; for a cloud agent, the machine that started it.
  machine: MachineId;
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

// Sessions (feature "sessions"): the Claude Code sessions on this Mac, grouped by project, and one thread at a time.
// docs/sessions-design.md §3 and §8 describe them. Session frames never go through the replay ring and never carry a
// seq. A frame is a reply to the socket that asked, or goes on a channel: "sessions" reaches the sockets that sent
// watch_sessions, and `s:<sessionId>` the sockets that sent watch_session for that id. A request with no answer named
// below is answered by the change it makes, on those channels, or by an error frame. A protocol 2 socket never gets
// a session frame and may not send a session request. The app treats an unknown origin, status, holder, mirror state
// or mode as `.unknown`, and an unknown item kind as an `.unknown` item it skips.

/** Claude Code's session uuid; a cloud row uses its session_01… id. */
export type SessionId = string & { readonly __brand: "SessionId" };
/** The first 16 hex digits of the sha256 of the project root's realpath. */
export type ProjectId = string & { readonly __brand: "ProjectId" };
/** Stable across history and live: `${message.id}:${block}`, a tool_use id, or a user entry's uuid. */
export type ItemId = string & { readonly __brand: "ItemId" };
/** Opaque to the app: where the next older page starts. The app sends it back as it got it. */
export type Cursor = string & { readonly __brand: "Cursor" };

/** Who started the session: the phone, a bot's agent, the Claude app, a terminal, an SDK script, or claude.ai (cloud). */
export type SessionOrigin = "phone" | "agent" | "desktop" | "terminal" | "sdk" | "cloud";
/**
 * awaiting_approval: a permission or plan card is open. awaiting_input: an ask card is open. parked: queued input
 * waits on a hold (the usage limit, or another process busy on the id). unavailable: Claude Code could not start.
 */
export type SessionStatus = "idle" | "working" | "awaiting_approval" | "awaiting_input" | "failed" | "parked" | "unavailable";
/** Which live process holds the session now: none, this bridge, the Claude app, a terminal, or another program. */
export type Holder = "none" | "claudio" | "desktop" | "terminal" | "other";
/**
 * Whether the Claude app lists the session. imported: its store has the session. pending: an automatic import waits on
 * its gates (docs/sessions-design.md §8.4). failed: an import did not show up within 10 s, so automatic retries
 * stopped; "Open in Claude app" still tries. none: not in the app and nothing queued.
 */
export type SessionMirror = "imported" | "pending" | "failed" | "none";
/** Settings, "Show agent sessions in the Claude app": Automatically, When I tap, Never. */
export const MIRROR_PREFS = ["auto", "tap", "never"] as const;
export type MirrorPref = (typeof MIRROR_PREFS)[number];
/** Claude Code's permission modes, as the SDK names them. test/protocol.test.ts pins this list to the SDK's. */
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** The modes the phone may set. It is never offered bypassPermissions, and the bridge refuses it. */
export const PHONE_MODES = ["default", "acceptEdits", "plan", "dontAsk", "auto"] as const satisfies readonly PermissionMode[];
export type PhoneMode = (typeof PHONE_MODES)[number];

/**
 * A project: a git repository's main checkout, which every worktree of it joins. machine: the machine whose disk holds
 * it, where a session_create for it runs. name: the GitHub repo name when the remote is on GitHub ("solta-o-som" for
 * ~/Dev/projects/br-soundless), else the folder name. lastAt: the newest lastAt of its sessions, null when it has none.
 * canCloud: reserved for phone-started cloud sessions, false in v1.
 */
export type SessionProject = { id: ProjectId; machine: MachineId; name: string; path: string; githubRepo: string | null; lastAt: string | null; canCloud: boolean };

/** state null: the transcript names the PR without its state. */
export type SessionPr = { number: number; url: string; state: "open" | "merged" | "closed" | null };

/**
 * One session in the list. Status, unread, holder and mirror are computed when the row is built. parentId: the
 * session it was spawned from, so the app nests it. agent: set when a bot's agent owns the id. worktree: the cwd is a
 * git worktree, not the main checkout. unread: the bridge drives it or the user opened it before, its lastAt is past
 * that visit, and its last item is the assistant's. url: claude.ai for a cloud row, else null. machine: the machine
 * whose Claude Code transcripts hold the session, since a transcript resumes only where it was written.
 */
export type SessionRow = {
  id: SessionId;
  machine: MachineId;
  projectId: ProjectId;
  parentId: SessionId | null;
  title: string;
  origin: SessionOrigin;
  agent: { botId: BotId; agentId: AgentId } | null;
  status: SessionStatus;
  holder: Holder;
  unread: boolean;
  branch: string | null;
  worktree: boolean;
  pr: SessionPr | null;
  mirror: SessionMirror;
  hidden: boolean;
  url: string | null;
  createdAt: string;
  lastAt: string;
};

/**
 * One tool call in a work item. id: its tool_use id, which session_tool names. label: the call in words ("Edit
 * src/app.ts", "Run bun test"). diff: the line counts of an Edit, Write or MultiEdit, else null. output: the last
 * 2 KB of its result, null while it runs or when it returned nothing.
 */
export type ToolStep = {
  id: string;
  tool: string;
  label: string;
  state: "running" | "ok" | "error" | "denied";
  diff: { path: string; added: number; removed: number } | null;
  output: string | null;
};

/** One AskUserQuestion question. The app offers a free answer besides the options, as Claude Code does. */
export type AskQuestion = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };

/** A permission card, the same shape a bot's chat shows. Its id is the cardId session_decide sends. */
export type PermissionMessage = Extract<Message, { kind: "permission" }>;

/**
 * One row of a thread. The app upserts items by id.
 * - user: from "bot" when a bot sent it to its agent, "system" for a bridge notice turn. queued: not sent yet.
 * - assistant: markdown text.
 * - thinking: at most 400 characters. ms: how long it thought, null when unknown.
 * - work: one run of tool calls, until a text block or a user prompt closes it. id: its first tool_use id.
 * - todo: the turn's TodoWrite list, upserted in place.
 * - plan: an ExitPlanMode plan. cardId: set while the phone may decide it (session_decide: "once" approves, "deny"
 *   keeps planning), null when it was decided or was proposed elsewhere.
 * - permission: a card the gate or the session holds. Open while card.answer is null.
 * - ask: an AskUserQuestion. answers: by question text, a multi-select's labels comma-separated; null while open.
 *   cardId: set while the phone may answer it (session_answer), null otherwise.
 * - notice: a line the bridge adds ("This session's transcript is gone").
 * - compaction: Claude Code compacted the conversation here.
 */
export type SessionItem =
  | { kind: "user"; id: ItemId; at: string; text: string; from: "user" | "bot" | "system"; queued: boolean }
  | { kind: "assistant"; id: ItemId; at: string; text: string }
  | { kind: "thinking"; id: ItemId; at: string; text: string; ms: number | null }
  | { kind: "work"; id: ItemId; at: string; steps: ToolStep[] }
  | { kind: "todo"; id: ItemId; at: string; todos: { text: string; state: "pending" | "in_progress" | "done" }[] }
  | { kind: "plan"; id: ItemId; at: string; text: string; state: "proposed" | "approved" | "rejected" | "expired"; cardId: MessageId | null }
  | { kind: "permission"; id: ItemId; at: string; card: PermissionMessage }
  | { kind: "ask"; id: ItemId; at: string; questions: AskQuestion[]; answers: Record<string, string> | "dismissed" | "expired" | null; cardId: MessageId | null }
  | { kind: "notice"; id: ItemId; at: string; text: string; tone: "info" | "error" }
  | { kind: "compaction"; id: ItemId; at: string };

/**
 * What the composer may do now. canSend false comes with the reason in words ("Working in the Claude app"). queued:
 * the user's messages waiting for their turn. model: null for the transcript's last model, else the user's default.
 * modes: what the mode menu offers.
 */
export type SessionControls = {
  canSend: boolean;
  reason: string | null;
  working: boolean;
  queued: number;
  model: string | null;
  models: { id: string; label: string }[];
  mode: PermissionMode;
  modes: PhoneMode[];
};

/** Where a thread stands. rev counts upserts per session within one bridge epoch (the epoch in hello). */
export type ThreadPosition = { epoch: string; rev: number };

/** Text streaming into an item not yet upserted. Lengths and offsets count UTF-16 code units, as JavaScript strings do. */
export type ThreadLive = { itemId: ItemId; text: string };

export type SessionServerMessage =
  // Reply to watch_sessions: every project and row. It replaces what the app had.
  | { type: "sessions"; projects: SessionProject[]; rows: SessionRow[]; mirror: MirrorPref }
  // Channel "sessions", coalesced every 500 ms. rows and projects upsert by id; removed rows go.
  | { type: "session_rows"; rows: SessionRow[]; removed: SessionId[]; projects: SessionProject[] }
  // Reply to watch_session when it needs a snapshot (after null, another epoch, or a rev the ring no longer holds).
  // items: the newest page, oldest first; it replaces what the app had. before: null at the start of the transcript.
  // live: seeds the streaming text.
  | {
      type: "session";
      sessionId: SessionId;
      epoch: string;
      rev: number;
      items: SessionItem[];
      before: Cursor | null;
      controls: SessionControls;
      live: ThreadLive | null;
    }
  // Channel s:<id>, and the reply to watch_session when the ring still holds after.rev: then it is one frame with every
  // upsert and removal since then, and controls set. Items upsert by id, so a replayed one is a no-op. rev: the
  // thread's rev after this frame. controls: null when they did not change. An upsert of an item drops its live text.
  | { type: "session_items"; sessionId: SessionId; rev: number; items: SessionItem[]; removed: ItemId[]; controls: SessionControls | null }
  // Channel s:<id>, unsequenced, coalesced every 60 ms. Applies only when offset equals the length of the app's live
  // text for itemId (0 when it has none), counted in UTF-16 code units; any other is dropped, and the upsert brings
  // the text. The app clears a thread's live text when it sends watch_session, so a replay reply ends with a delta at
  // offset 0 holding the whole live text when an item is streaming.
  | { type: "session_delta"; sessionId: SessionId; itemId: ItemId; offset: number; text: string }
  // Reply to session_page: the page before the cursor, oldest first, to put above the app's items.
  | { type: "session_page"; sessionId: SessionId; items: SessionItem[]; before: Cursor | null }
  // Reply to session_create with the ref the client sent. The id exists before Claude Code starts.
  | { type: "session_created"; ref: string; sessionId: SessionId }
  // Reply to session_tool: the call's full result, its last 64 KB when longer.
  | { type: "session_tool_output"; sessionId: SessionId; toolUseId: string; output: string }
  // Channel s:<id>, and the reply to watch_session for a session that is gone. movedTo: the id an agent's session
  // restarted under, which the app opens instead; null when the transcript is gone.
  | { type: "session_removed"; sessionId: SessionId; movedTo: SessionId | null };

/** Sent on channel "sessions". */
export type SessionsChannelFrame = Extract<SessionServerMessage, { type: "session_rows" }>;
/** Sent on channel `s:<sessionId>`. */
export type ThreadChannelFrame = Extract<SessionServerMessage, { type: "session_items" | "session_delta" | "session_removed" }>;

/** The fields set are the ones to change. title renames through Claude Code, so the transcript keeps it. */
export type SessionPatch = { title?: string; hidden?: boolean; model?: string | null; mode?: PhoneMode };

export type SessionClientMessage =
  // Subscribes this socket to channel "sessions". Answered with a sessions frame. The app sends it again after each hello.
  | { type: "watch_sessions" }
  | { type: "unwatch_sessions" }
  // Subscribes this socket to s:<sessionId>. after: the position the app holds, null for a fresh snapshot. Answered
  // with session, session_items or session_removed. The app sends it again after each hello.
  | { type: "watch_session"; sessionId: SessionId; after: ThreadPosition | null }
  // Unsubscribes and marks the session visited.
  | { type: "unwatch_session"; sessionId: SessionId }
  | { type: "session_page"; sessionId: SessionId; before: Cursor }
  // clientId: the queued user item's id until the transcript's own entry replaces it. interrupt: "Stop and send": stops the turn in flight, then queues.
  | { type: "session_send"; sessionId: SessionId; text: string; clientId: string; interrupt: boolean }
  // Stops the turn in flight. The user's queued messages still run.
  | { type: "session_stop"; sessionId: SessionId }
  // Answers a permission item (card.id) or a plan item (cardId), whoever holds the card.
  | { type: "session_decide"; sessionId: SessionId; cardId: MessageId; choice: PermissionChoice }
  // Answers an ask item by question text. null dismisses it.
  | { type: "session_answer"; sessionId: SessionId; cardId: MessageId; answers: Record<string, string> | null }
  // Answered by session_created with the same ref. model and mode null: the user's Claude Code defaults. machine:
  // where it runs; absent, the home's own machine.
  | {
      type: "session_create";
      ref: string;
      projectId: ProjectId;
      text: string;
      model: string | null;
      mode: PhoneMode | null;
      isolate: "none" | "worktree";
      machine?: MachineId;
    }
  | { type: "session_set"; sessionId: SessionId; patch: SessionPatch }
  // Imports the session into the Claude app when needed, then brings the app forward.
  | { type: "session_open_desktop"; sessionId: SessionId }
  // Asks for a tool call's full output. Answered with session_tool_output.
  | { type: "session_tool"; sessionId: SessionId; toolUseId: string }
  // Answered with a sessions frame carrying the new mirror.
  | { type: "session_prefs"; mirror: MirrorPref };

/** Every session frame by type, so a session frame can be told apart at runtime. */
const SESSION_FRAMES: Record<SessionServerMessage["type"], true> = {
  sessions: true, session_rows: true, session: true, session_items: true, session_delta: true,
  session_page: true, session_created: true, session_tool_output: true, session_removed: true,
};
const SESSION_REQUESTS: Record<SessionClientMessage["type"], true> = {
  watch_sessions: true, unwatch_sessions: true, watch_session: true, unwatch_session: true, session_page: true,
  session_send: true, session_stop: true, session_decide: true, session_answer: true, session_create: true,
  session_set: true, session_open_desktop: true, session_tool: true, session_prefs: true,
};
export const isSessionFrame = (m: ServerMessage): m is SessionServerMessage => Object.hasOwn(SESSION_FRAMES, m.type);
export const isSessionRequest = (m: ClientMessage): m is SessionClientMessage => Object.hasOwn(SESSION_REQUESTS, m.type);

export type ServerMessage =
  // The app shows "Update the bridge" or "Update the app" when protocol is outside the range it speaks.
  // machines and world: present when the bridge serves feature "machines". world.name is "<userName>'s bots".
  | ({
      type: "hello";
      protocol: number;
      features: Feature[];
      machine: string;
      userName: string;
      bots: Bot[];
      machines?: MachineView[];
      world?: { id: WorldId; name: string };
    } & StreamPosition)
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
  | ({ type: "pair_code" } & PairOffer)
  // Feature "machines": every machine, sent whenever one comes online, goes offline or enrolls.
  | { type: "machines"; machines: MachineView[] }
  // Feature "machines", in answer to machine_code: urls are the home's addresses for `claudiobot machine enroll`.
  | ({ type: "machine_code" } & PairOffer)
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
  | SessionServerMessage
  | { type: "error"; message: string };

/** Sent to live protocol 3 sockets only, without a seq: not kept for replay. */
export type Signal = Extract<ServerMessage, { type: "activity" | "usage" }>;

// A frame published to every socket carries the stream seq. Replies to one client do not.
export type Broadcast = ServerMessage & { seq: number };

export type Upload = { name: string; mime: string; data: string };

// members applies to a group only; agentsOn, to a bot only, and names this home's own machine or one enrolled into it.
export type BotPatch = Partial<Pick<Bot, "name" | "title" | "avatar" | "pinned" | "hidden" | "dailyCapUsd" | "muted" | "members" | "agentsOn">>;

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
  | SessionClientMessage
  // Transport messages: the socket layer answers these, because they need the socket's own device.
  | { type: "devices" }
  | { type: "revoke_device"; deviceId: DeviceId }
  | { type: "pair_code" }
  // Feature "machines": a one-time code another computer enrolls with as a machine of this home.
  | { type: "machine_code" }
  // Feature "presence". attended false: nobody is looking at this app, so its socket does not hold back a push. A
  // socket that never sends one counts as attended.
  | { type: "presence"; attended: boolean };

export type TransportMessage = Extract<ClientMessage, { type: "devices" | "revoke_device" | "pair_code" | "machine_code" | "presence" }>;

/**
 * A computer that runs agents for this home (feature "machines"). role home: the bridge the phone is connected to.
 * since: when it came online, or when it was last heard from while offline; null when never. access: the machine's
 * own mode, which only its own environment sets. connectors: the MCP servers its agents can use, as it last reported
 * them.
 */
export type MachineView = {
  id: MachineId;
  name: string;
  role: "home" | "machine";
  online: boolean;
  since: string | null;
  platform: "darwin" | "linux";
  access: { full: boolean; sandbox: boolean };
  connectors: MachineConnector[];
};

/**
 * An MCP server on a machine, by name only. kind: chrome for a browser server (chrome, chrome-devtools,
 * claude-in-chrome), computer-use for computer-use, other for the rest. The app treats an unknown kind as "other".
 */
export type MachineConnector = { name: string; kind: "chrome" | "computer-use" | "other" };

/**
 * A one-time code another device can pair with, valid until expiresAt, with the bridge's socket URLs best first: what
 * a claudiobot://pair link carries.
 */
export type PairOffer = { code: string; expiresAt: string; urls: string[] };

// HTTP, outside the socket. POST /pair with a one-time code returns this device's own token.
// The socket then authenticates with Authorization: Bearer <token>.
export type PairRequest = { code: string; name: string };
export type PairResponse = { deviceId: DeviceId; token: string };
