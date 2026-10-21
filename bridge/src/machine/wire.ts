import { z } from "zod";
import type { CardReply } from "../gate";
import type { UsageRow } from "../ledger";
import { parseClientMessage } from "../parse";
import {
  COLORS,
  isSessionRequest,
  MIRROR_PREFS,
  PERMISSION_CHOICES,
  SHAPES,
  type Agent,
  type AgentId,
  type AgentMessage,
  type BotId,
  type DeviceId,
  type MachineConnector,
  type MachineId,
  type Message,
  type MessageId,
  type RoutineId,
  type RunId,
  type ServerMessage,
  type SessionClientMessage,
  type SessionId,
  type SessionServerMessage,
  type SessionsChannelFrame,
} from "../protocol";
import type { ThreadSignal } from "../sessions";
import type { Isolate } from "../tools";
import type { Initiator } from "../world";
import type { MachineProfile } from "./profile";

// The one list of what crosses between the home and a machine. Plain JSON, each union discriminated by `kind` (and a
// link frame by `t`). Every type has its zod schema beside it, parsed at both ends of the socket. No Access or mode
// ever rides an intent: each machine reads its own.

export type { MachineId };
export type IntentId = string & { readonly __brand: "IntentId" };
/** An event's place in its machine's outbox, from 1. */
export type Seq = number;

export const newIntentId = (): IntentId => `i_${crypto.randomUUID()}` as IntentId;
/** The home mints it, so the bot can name the agent at once and a replayed start is a no-op. */
export const newAgentId = (): AgentId => `a_${crypto.randomUUID()}` as AgentId;
export const newMachineId = (): MachineId => `m_${crypto.randomUUID()}` as MachineId;

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
  /** Always applied afresh: its intentId only pairs it with its applied frame. */
  | { kind: "snapshot"; intentId: IntentId }
  /** The projects under the machine's roots, as the reply's text. Always applied afresh, as snapshot. */
  | { kind: "projects"; intentId: IntentId };

/** reply: what the bot or the phone is told, such as "Sent. Fix tests will report back." */
export type Applied = { ok: true; reply?: string } | { ok: false; reason: string };

/** A machine's profile as the home may see it: no agent socket path, and the connectors its agents can use. */
export type ProfileView = Omit<MachineProfile, "sshAuthSock"> & { connectors: readonly MachineConnector[] };

/** No machine reads its own connectors yet, so each reports none. */
export function profileView(profile: MachineProfile): ProfileView {
  const { sshAuthSock: _, ...view } = profile;
  return { ...view, connectors: [] };
}

export type EventBody =
  /** The record or something its status derives from changed. */
  | { kind: "agent"; agent: Agent; messages: AgentMessage[] }
  /** A turn's report for the bot. by: the initiator of the agent turn that reported. */
  | { kind: "report"; agentId: AgentId; botId: BotId; text: string; by: Initiator }
  /** A line about the agent in its bot's chat. */
  | { kind: "note"; agentId: AgentId; botId: BotId; text: string }
  /** A message the machine's gate posted on its stand-in, or the same message again once answered or expired. */
  | { kind: "card"; botId: BotId; message: Message }
  /** The gate reminds once at half a card's life; only the home pushes, so the reminder rides here. */
  | { kind: "reminder"; botId: BotId; cardId: MessageId }
  /** A card opened in a session the phone drives on this machine: the home pushes that a session needs the user. */
  | { kind: "sessionCard"; sessionId: SessionId; cardId: MessageId }
  | { kind: "usage"; row: UsageRow }
  | { kind: "profile"; profile: ProfileView }
  | { kind: "refused"; intentId: IntentId; reason: string }
  | { kind: "snapshot"; agents: { agent: Agent; messages: AgentMessage[] }[]; openCards: { botId: BotId; message: Message }[] };

export type Event = { seq: Seq; at: string } & EventBody;

/** What a machine's sessions answer a phone's request with: session frames, or an error frame. */
export type SessionReply = SessionServerMessage | Extract<ServerMessage, { type: "error" }>;
/** A frame a machine's sessions put on a channel: the list's, or one thread's. */
export type SessionSignal = SessionsChannelFrame | ThreadSignal;

/**
 * What the home sends on the link. challenge and welcome are the handshake; the rest flow once it is live. ask: a
 * phone's request for the machine's Sessions tab, answered by reply with the same id. Unlike an intent it is never
 * queued, journaled or applied once: a session is driven live, and session_send carries its own clientId.
 */
export type HomeFrame =
  | { t: "challenge"; nonce: string }
  /** sig: the home's signature over the machine's nonce and the machine's id. ackedSeq: replay events after it. */
  | { t: "welcome"; sig: string; ackedSeq: Seq }
  | { t: "intent"; intent: Intent }
  /** The home handled every event through seq and saved that, so the machine may drop them. */
  | { t: "ack"; seq: Seq }
  | { t: "ask"; id: IntentId; frame: SessionClientMessage };

/**
 * What a machine sends on the link. hello answers the challenge; the rest flow once it is live. signal: a sessions
 * channel frame, never journaled or replayed, as the phone protocol has them; the home asks afresh when it links.
 */
export type MachineFrame =
  /** sig: the machine's signature over the home's nonce and the home's id. lastSeq: the newest seq in its outbox. */
  | { t: "hello"; machineId: MachineId; sig: string; nonce: string; profile: ProfileView; lastSeq: Seq }
  | { t: "event"; event: Event }
  | { t: "applied"; intentId: IntentId; applied: Applied }
  | { t: "reply"; id: IntentId; frames: SessionReply[] }
  | { t: "signal"; frame: SessionSignal };

// Schemas. Each is annotated with its type, so tsc fails when a type and its schema drift apart.

const id = <T extends string>() => z.string().min(1) as unknown as z.ZodType<T>;
const text = z.string();
const iso = z.string().min(1);
const seq = z.number().int().nonnegative();
const usd = z.number().nonnegative();
/** 32 random bytes, hex. */
export const NONCE = /^[0-9a-f]{64}$/;
const nonce = z.string().regex(NONCE);
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

const runRef = z.object({ routineId: id<RoutineId>(), runId: id<RunId>() });
const origin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("routine"), run: runRef, manual: z.boolean() }),
  z.object({ kind: z.literal("system") }),
]);
const initiator: z.ZodType<Initiator> = z.discriminatedUnion("kind", [
  ...origin.options,
  z.object({ kind: z.literal("bot"), botId: id<BotId>(), hops: seq, origin }),
  z.object({ kind: z.literal("agent"), agentId: id<AgentId>(), hops: seq, origin }),
]);

const cardReply: z.ZodType<CardReply> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("option"), index: seq }),
  z.object({ kind: z.literal("dismiss") }),
  z.object({ kind: z.literal("permission"), choice: z.enum(PERMISSION_CHOICES) }),
]);

const signedAnswer: z.ZodType<SignedAnswer> = z.object({ deviceId: id<DeviceId>(), cardId: id<MessageId>(), digest: text, reply: cardReply, at: iso, sig: text });

const botStandIn: z.ZodType<BotStandIn> = z.object({ id: id<BotId>(), name: z.string().min(1), dailyCapUsd: usd.nullable(), connectorsOff: z.array(z.string()) });
const projectRef: z.ZodType<ProjectRef> = z.object({ githubRepo: z.string().min(1).nullable(), name: z.string().min(1) });
const intentId = id<IntentId>();
const agentId = id<AgentId>();

export const intentSchema: z.ZodType<Intent> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent.start"),
    intentId,
    agentId,
    bot: botStandIn,
    title: z.string().min(1),
    prompt: z.string().min(1),
    project: projectRef,
    where: z.enum(["mac", "cloud"]),
    isolate: z.enum(["auto", "none", "worktree"]),
    budgetUsd: usd.nullable(),
    slash: z.string().min(1).nullable(),
    initiator,
  }),
  z.object({ kind: z.literal("agent.message"), intentId, agentId, text: z.string().min(1), initiator }),
  z.object({ kind: z.literal("agent.direct"), intentId, agentId, text: z.string().min(1), clientId: z.string().min(1) }),
  z.object({ kind: z.literal("agent.stop"), intentId, agentId }),
  z.object({ kind: z.literal("agent.removeWorktree"), intentId, agentId }),
  z.object({ kind: z.literal("card.answer"), intentId, botId: id<BotId>(), cardId: id<MessageId>(), reply: cardReply, signed: signedAnswer.nullable() }),
  z.object({ kind: z.literal("snapshot"), intentId }),
  z.object({ kind: z.literal("projects"), intentId }),
]);

export const appliedSchema: z.ZodType<Applied> = z.union([
  z.object({ ok: z.literal(true), reply: z.string().optional() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

const avatar = z.object({ shape: z.enum(SHAPES), color: z.enum(COLORS) });
const peer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: id<BotId>(), name: text, avatar }),
  z.object({ kind: z.literal("agent"), id: agentId, title: text }),
  z.object({ kind: z.literal("routine"), id: id<RoutineId>(), name: text }),
]);
const agentPeer = z.object({ kind: z.literal("agent"), id: agentId, title: text });
const mention = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: id<BotId>(), name: text }),
  z.object({ kind: z.literal("connector"), name: text }),
]);
const messageId = id<MessageId>();
export const messageSchema: z.ZodType<Message> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: messageId,
    at: iso,
    text,
    attachments: z.array(z.object({ name: text, mime: text, path: text })),
    clientId: z.string().optional(),
    mentions: z.array(mention).optional(),
  }),
  z.object({ kind: z.literal("bot"), id: messageId, at: iso, text, from: id<BotId>().optional() }),
  z.object({
    kind: z.literal("question"),
    id: messageId,
    at: iso,
    question: text,
    options: z.array(text),
    answer: z.union([seq, z.literal("dismissed"), z.literal("expired")]).nullable(),
    expiresAt: iso.nullable(),
  }),
  z.object({
    kind: z.literal("permission"),
    id: messageId,
    at: iso,
    from: agentPeer.nullable(),
    tool: text,
    label: text,
    detail: text,
    always: text,
    answer: z.union([z.enum(PERMISSION_CHOICES), z.literal("expired")]).nullable(),
    expiresAt: iso,
  }),
  z.object({ kind: z.literal("exchange"), id: messageId, at: iso, peer, sent: seq, received: seq }),
  z.object({ kind: z.literal("note"), id: messageId, at: iso, text, refs: z.array(peer) }),
]);

export const agentSchema: z.ZodType<Agent> = z.object({
  id: agentId,
  botId: id<BotId>(),
  title: text,
  where: z.enum(["mac", "cloud"]),
  projectName: text,
  status: z.enum(["working", "waiting", "failed", "in_cloud", "awaiting_approval", "parked", "unavailable", "capped"]),
  url: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  evidence: z
    .object({
      at: iso,
      branch: z.string().nullable(),
      head: z.string().nullable(),
      ahead: seq,
      changed: seq,
      insertions: seq,
      deletions: seq,
      dirty: z.boolean(),
      pr: z.string().nullable(),
    })
    .nullable(),
  worktree: z.object({ path: text, branch: text }).nullable(),
});
export const agentMessageSchema: z.ZodType<AgentMessage> = z.object({ id: messageId, at: iso, from: z.enum(["bot", "agent"]), text });
const mirror = z.object({ agent: agentSchema, messages: z.array(agentMessageSchema) });

const usageRow: z.ZodType<UsageRow> = z.object({
  at: iso,
  actor: z.string().regex(/^(bot|agent|own):.+/) as unknown as z.ZodType<UsageRow["actor"]>,
  botId: id<BotId>().nullable(),
  sessionId: text,
  initiator,
  cumulativeUsd: z.number(),
  deltaUsd: z.number(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fresh: z.literal(true).optional(),
});

const paths = z.array(z.string());
export const profileViewSchema: z.ZodType<ProfileView> = z.object({
  name: text,
  platform: z.enum(["darwin", "linux"]),
  homedir: text,
  username: text,
  rootHome: z.enum(["/var/root", "/root"]),
  bridgeHome: text,
  managedMcpPath: text,
  private: z.object({ bridge: paths, keys: paths, browser: paths, creds: paths, personal: paths }),
  caches: paths,
  pushReadable: paths,
  tempDirs: paths,
  sandboxNeeds: paths,
  access: z.object({ full: z.boolean(), sandbox: z.boolean() }),
  // A machine from before connectors sends none.
  connectors: z.array(z.object({ name: text, kind: z.enum(["chrome", "computer-use", "other"]) })).default([]),
});

const stamp = { seq, at: iso };
export const eventSchema: z.ZodType<Event> = z.discriminatedUnion("kind", [
  z.object({ ...stamp, kind: z.literal("agent"), agent: agentSchema, messages: z.array(agentMessageSchema) }),
  z.object({ ...stamp, kind: z.literal("report"), agentId, botId: id<BotId>(), text, by: initiator }),
  z.object({ ...stamp, kind: z.literal("note"), agentId, botId: id<BotId>(), text }),
  z.object({ ...stamp, kind: z.literal("card"), botId: id<BotId>(), message: messageSchema }),
  z.object({ ...stamp, kind: z.literal("reminder"), botId: id<BotId>(), cardId: messageId }),
  z.object({ ...stamp, kind: z.literal("sessionCard"), sessionId: id<SessionId>(), cardId: messageId }),
  z.object({ ...stamp, kind: z.literal("usage"), row: usageRow }),
  z.object({ ...stamp, kind: z.literal("profile"), profile: profileViewSchema }),
  z.object({ ...stamp, kind: z.literal("refused"), intentId, reason: text }),
  z.object({ ...stamp, kind: z.literal("snapshot"), agents: z.array(mirror), openCards: z.array(z.object({ botId: id<BotId>(), message: messageSchema })) }),
]);

/** The phone's own parser, so a machine reads a forwarded request exactly as a phone socket's. */
const sessionRequest: z.ZodType<SessionClientMessage> = z.unknown().transform((v, ctx) => {
  const parsed = parseClientMessage(JSON.stringify(v));
  if (parsed.ok && isSessionRequest(parsed.message)) return parsed.message;
  ctx.addIssue({ code: "custom", message: parsed.ok ? `${parsed.message.type} is not a session request` : parsed.error });
  return z.NEVER;
});

// Shallow on purpose: the home reads only these fields (ids to route by, the rows it caches and re-stamps), and passes
// the rest to the phone, which parses its own frames.
const keyed = z.looseObject({ id: z.string().min(1) });
const sessionId = z.string().min(1);
const rowsFrame = z.looseObject({ type: z.literal("session_rows"), rows: z.array(keyed), removed: z.array(sessionId), projects: z.array(keyed) });
const threadFrame = z.looseObject({ type: z.enum(["session_items", "session_delta"]), sessionId });
const removedFrame = z.looseObject({ type: z.literal("session_removed"), sessionId, movedTo: sessionId.nullable() });
const snapshotFrame = z.looseObject({ type: z.literal("session"), sessionId });
const signalSchema = z.union([rowsFrame, threadFrame, removedFrame, snapshotFrame]) as unknown as z.ZodType<SessionSignal>;
const replySchema = z.union([
  rowsFrame,
  threadFrame,
  removedFrame,
  z.looseObject({ type: z.literal("sessions"), rows: z.array(keyed), projects: z.array(keyed), mirror: z.enum(MIRROR_PREFS) }),
  z.looseObject({ type: z.literal("session_created"), ref: z.string(), sessionId }),
  snapshotFrame,
  z.looseObject({ type: z.enum(["session_page", "session_tool_output"]), sessionId }),
  z.looseObject({ type: z.literal("error"), message: z.string() }),
]) as unknown as z.ZodType<SessionReply>;

export const homeFrameSchema: z.ZodType<HomeFrame> = z.discriminatedUnion("t", [
  z.object({ t: z.literal("challenge"), nonce }),
  z.object({ t: z.literal("welcome"), sig: base64, ackedSeq: seq }),
  z.object({ t: z.literal("intent"), intent: intentSchema }),
  z.object({ t: z.literal("ack"), seq }),
  z.object({ t: z.literal("ask"), id: intentId, frame: sessionRequest }),
]);

export const machineFrameSchema: z.ZodType<MachineFrame> = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), machineId: id<MachineId>(), sig: base64, nonce, profile: profileViewSchema, lastSeq: seq }),
  z.object({ t: z.literal("event"), event: eventSchema }),
  z.object({ t: z.literal("applied"), intentId, applied: appliedSchema }),
  z.object({ t: z.literal("reply"), id: intentId, frames: z.array(replySchema) }),
  z.object({ t: z.literal("signal"), frame: signalSchema }),
]);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  const r = schema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: z.prettifyError(r.error).split("\n")[0] ?? "bad frame" };
}

export const parseHomeFrame = (raw: string) => parseWith(homeFrameSchema, raw);
export const parseMachineFrame = (raw: string) => parseWith(machineFrameSchema, raw);
