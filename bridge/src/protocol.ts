// Wire protocol between the iOS app and the Mac bridge. JSON over one WebSocket.
// ios/ClaudeBot/Model/Protocol.swift mirrors this file; fixtures/protocol.json pins both.
// docs/grok-bot-reference.md describes the product these types model.

export type BotId = string & { readonly __brand: "BotId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type RoutineId = string & { readonly __brand: "RoutineId" };

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

export type Routine = {
  id: RoutineId;
  name: string;
  // Five-field cron in the Mac's local time zone.
  schedule: string;
  // "Weekdays at 7:57 AM", computed by the bridge.
  describe: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
};

export type Bot = {
  id: BotId;
  name: string;
  // The optional label under the name.
  title: string | null;
  avatar: Avatar;
  pinned: boolean;
  hidden: boolean;
  // working: a turn is in progress, so the app shows "Typing…".
  status: "idle" | "working";
  unread: number;
  // Text of the newest unanswered question card. Drives the attention badge and the list preview.
  question: string | null;
  preview: string;
  lastAt: string;
  createdAt: string;
  routines: Routine[];
};

export type Peer =
  | { kind: "bot"; id: BotId; name: string; avatar: Avatar }
  | { kind: "agent"; id: AgentId; title: string }
  | { kind: "routine"; id: RoutineId; name: string };

export type Attachment = { name: string; mime: string; path: string };

export type Message =
  | { kind: "user"; id: MessageId; at: string; text: string; attachments: Attachment[] }
  | { kind: "bot"; id: MessageId; at: string; text: string }
  | {
      kind: "question";
      id: MessageId;
      at: string;
      question: string;
      options: string[];
      // Index into options, "dismissed", or null while open.
      answer: number | "dismissed" | null;
    }
  // A run of messages between this bot and one peer, grouped while nothing else is said.
  // The app labels it: sent 1 → "Messaged X", received 1 → "Message from X", else "N messages with X".
  | { kind: "exchange"; id: MessageId; at: string; peer: Peer; sent: number; received: number }
  // A system line such as "Created routines {0} and {1}". Each {n} is replaced by a tappable chip for refs[n].
  | { kind: "note"; id: MessageId; at: string; text: string; refs: Peer[] };

export type AgentStatus = "working" | "waiting" | "failed" | "in_cloud";

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
};

export type AgentMessage = { id: MessageId; at: string; from: "bot" | "agent"; text: string };

export type LibraryFile = { path: string; size: number; modifiedAt: string };
export type Link = { url: string; host: string; at: string };

export type ServerMessage =
  | { type: "hello"; machine: string; userName: string; bots: Bot[] }
  | { type: "bot"; bot: Bot }
  | { type: "bot_removed"; botId: BotId }
  // Answers create_bot with the ref the client sent, so the app can open the new bot.
  | { type: "created"; ref: string; botId: BotId }
  // Full history, sent in answer to open.
  | { type: "conversation"; botId: BotId; messages: Message[] }
  // Insert or replace by message.id. Replaying the same message is a no-op.
  | { type: "message"; botId: BotId; message: Message }
  | { type: "details"; botId: BotId; library: LibraryFile[]; links: Link[]; agents: Agent[] }
  | { type: "agent"; agent: Agent; messages: AgentMessage[] }
  // content is null when the file is not text or is over 1 MB. data is base64 for images up to 10 MB.
  | { type: "file"; botId: BotId; path: string; mime: string; content: string | null; data: string | null }
  | { type: "error"; message: string };

export type Upload = { name: string; mime: string; data: string };

export type BotPatch = Partial<Pick<Bot, "name" | "title" | "avatar" | "pinned" | "hidden">>;

export type ClientMessage =
  | { type: "create_bot"; ref: string }
  // Sends the conversation and marks the bot read.
  | { type: "open"; botId: BotId }
  | { type: "send"; botId: BotId; text: string; uploads: Upload[] }
  | { type: "answer"; botId: BotId; messageId: MessageId; option: number }
  | { type: "dismiss"; botId: BotId; messageId: MessageId }
  | { type: "update_bot"; botId: BotId; patch: BotPatch }
  | { type: "mark_unread"; botId: BotId }
  | { type: "delete_bot"; botId: BotId }
  | { type: "set_routine"; botId: BotId; routineId: RoutineId; enabled: boolean }
  | { type: "details"; botId: BotId }
  | { type: "agent"; agentId: AgentId }
  | { type: "file"; botId: BotId; path: string };
