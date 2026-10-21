import type { CardReply } from "../gate";
import type { UsageRow } from "../ledger";
import type { Agent, AgentId, AgentMessage, BotId, DeviceId, Message, MessageId } from "../protocol";
import type { Isolate } from "../tools";
import type { Initiator } from "../world";
import type { MachineProfile } from "./profile";

// The one list of what crosses between the home and a machine. Plain JSON, each union discriminated by `kind`, so
// Phase 3's zod schemas mirror it one to one. No Access or mode ever rides an intent: each machine reads its own.

export type IntentId = string & { readonly __brand: "IntentId" };
export type MachineId = string & { readonly __brand: "MachineId" };
/** An event's place in its machine's outbox, from 1. */
export type Seq = number;

export const newIntentId = (): IntentId => `i_${crypto.randomUUID()}` as IntentId;
/** The home mints it, so the bot can name the agent at once and a replayed start is a no-op. */
export const newAgentId = (): AgentId => `a_${crypto.randomUUID()}` as AgentId;

/** What a machine keeps of a bot that has agents there (docs/vps-design.md, "Stand-in fields"). */
export type BotStandIn = { id: BotId; name: string; dailyCapUsd: number | null; connectorsOff: string[] };

/**
 * A project as the bot named it, which the machine resolves in its own roots. name: a folder name or an
 * "owner/repo", never a path on another machine. githubRepo: the "owner/repo" when the bot named one.
 */
export type ProjectRef = { githubRepo: string | null; name: string };

/** A phone's signed tap. Declared now so adding signatures needs no wire change; always null until they land. */
export type SignedAnswer = { deviceId: DeviceId; cardId: MessageId; digest: string; reply: CardReply; at: string; sig: string };

export type Intent =
  | {
      kind: "agent.start";
      intentId: IntentId;
      agentId: AgentId;
      bot: BotStandIn;
      title: string;
      prompt: string;
      project: ProjectRef;
      where: "mac" | "cloud";
      isolate: Isolate;
      budgetUsd: number | null;
      slash: string | null;
      initiator: Initiator;
    }
  | { kind: "agent.message"; intentId: IntentId; agentId: AgentId; text: string; initiator: Initiator }
  /** The user from the phone, in the agent's session. */
  | { kind: "agent.direct"; intentId: IntentId; agentId: AgentId; text: string; clientId: string }
  | { kind: "agent.stop"; intentId: IntentId; agentId: AgentId }
  | { kind: "agent.removeWorktree"; intentId: IntentId; agentId: AgentId }
  | { kind: "card.answer"; intentId: IntentId; botId: BotId; cardId: MessageId; reply: CardReply; signed: SignedAnswer | null }
  | { kind: "snapshot" };

/** reply: what the bot or the phone is told, such as "Sent. Fix tests will report back." */
export type Applied = { ok: true; reply?: string } | { ok: false; reason: string };

/** A machine's profile as the home may see it: no agent socket path. */
export type ProfileView = Omit<MachineProfile, "sshAuthSock">;

export type EventBody =
  /** The record or something its status derives from changed. */
  | { kind: "agent"; agent: Agent; messages: AgentMessage[] }
  /** A turn's report for the bot. by: the initiator of the agent turn that reported. */
  | { kind: "report"; agentId: AgentId; botId: BotId; text: string; by: Initiator }
  /** A line about the agent in its bot's chat. */
  | { kind: "note"; agentId: AgentId; botId: BotId; text: string }
  /** A card the machine's gate posted on its stand-in. */
  | { kind: "card"; botId: BotId; message: Message }
  | { kind: "usage"; row: UsageRow }
  | { kind: "profile"; profile: ProfileView }
  | { kind: "refused"; intentId: IntentId; reason: string }
  | { kind: "snapshot"; agents: { agent: Agent; messages: AgentMessage[] }[]; openCards: { botId: BotId; message: Message }[] };

export type Event = { seq: Seq; at: string } & EventBody;
