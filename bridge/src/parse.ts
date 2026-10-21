import { GROUP_SIZE } from "./groups";
import { BOT_NAME_MAX } from "./text";
import {
  COLORS,
  MIRROR_PREFS,
  PERMISSION_CHOICES,
  PHONE_MODES,
  SHAPES,
  type AgentId,
  type Avatar,
  type BotId,
  type BotPatch,
  type ClientMessage,
  type Cursor,
  type DeviceId,
  type FactId,
  type MachineId,
  type Mention,
  type MessageId,
  type ProjectId,
  type RoutineId,
  type SessionClientMessage,
  type SessionId,
  type SessionPatch,
  type ThreadPosition,
  type Upload,
} from "./protocol";

type Parsed = { ok: true; message: ClientMessage } | { ok: false; error: string };

class ParseError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ParseError(`${what} must be an object`);
  return v as Obj;
}

function str(o: Obj, key: string, { empty = false } = {}): string {
  const v = o[key];
  if (typeof v !== "string" || (!empty && v === "")) throw new ParseError(`${key} must be a ${empty ? "" : "non-empty "}string`);
  return v;
}

function bool(o: Obj, key: string): boolean {
  if (typeof o[key] !== "boolean") throw new ParseError(`${key} must be a boolean`);
  return o[key] as boolean;
}

function index(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ParseError(`${key} must be a non-negative integer`);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const v = str(o, key);
  if (!(values as readonly string[]).includes(v)) throw new ParseError(`${key} must be one of ${values.join(", ")}`);
  return v as T;
}

function usd(o: Obj, key: string): number | null {
  const v = o[key];
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ParseError(`${key} must be null or a non-negative number`);
  return v;
}

function avatar(v: unknown): Avatar {
  const o = obj(v, "avatar");
  return { shape: oneOf(o, "shape", SHAPES), color: oneOf(o, "color", COLORS) };
}

function boundedStr(o: Obj, key: string, max: number): string {
  const v = str(o, key).trim();
  if (v === "" || Array.from(v).length > max) throw new ParseError(`${key} must be 1 to ${max} characters`);
  return v;
}

const MENTIONS_MAX = 10;
const MENTION_NAME_MAX = 64;

function mentions(v: unknown): Mention[] {
  if (!Array.isArray(v)) throw new ParseError("mentions must be an array");
  if (v.length > MENTIONS_MAX) throw new ParseError(`mentions holds at most ${MENTIONS_MAX}`);
  return v.map((m): Mention => {
    const o = obj(m, "mention");
    const kind = oneOf(o, "kind", ["bot", "connector"] as const);
    const name = str(o, "name");
    if (Array.from(name).length > MENTION_NAME_MAX) throw new ParseError(`name must be at most ${MENTION_NAME_MAX} characters`);
    return kind === "bot" ? { kind, id: str(o, "id") as BotId, name } : { kind, name };
  });
}

function members(v: unknown): BotId[] {
  if (!Array.isArray(v) || v.some((id) => typeof id !== "string" || id === "")) throw new ParseError("members must be an array of bot ids");
  if (v.length < GROUP_SIZE.min || v.length > GROUP_SIZE.max || new Set(v).size !== v.length)
    throw new ParseError(`members must be ${GROUP_SIZE.min} to ${GROUP_SIZE.max} different bots`);
  return v as BotId[];
}

function patch(v: unknown): BotPatch {
  const o = obj(v, "patch");
  const p: BotPatch = {};
  if (o.name !== undefined) p.name = str(o, "name");
  if (o.title !== undefined) p.title = o.title === null ? null : str(o, "title", { empty: true });
  if (o.avatar !== undefined) p.avatar = avatar(o.avatar);
  if (o.pinned !== undefined) p.pinned = bool(o, "pinned");
  if (o.hidden !== undefined) p.hidden = bool(o, "hidden");
  if (o.dailyCapUsd !== undefined) p.dailyCapUsd = usd(o, "dailyCapUsd");
  if (o.muted !== undefined) p.muted = bool(o, "muted");
  if (o.members !== undefined) p.members = members(o.members);
  if (o.agentsOn !== undefined) p.agentsOn = o.agentsOn === null ? null : (str(o, "agentsOn") as MachineId);
  return p;
}

function uploads(v: unknown): Upload[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ParseError("uploads must be an array");
  return v.map((u) => {
    const o = obj(u, "upload");
    return { name: str(o, "name"), mime: str(o, "mime"), data: str(o, "data") };
  });
}

function nullable<T>(o: Obj, key: string, parse: (o: Obj, key: string) => T): T | null {
  return o[key] === null ? null : parse(o, key);
}

/** Text the user typed: kept as sent, but not blank. */
function prompt(o: Obj, key: string): string {
  const v = str(o, key);
  if (v.trim() === "") throw new ParseError(`${key} must not be blank`);
  return v;
}

function position(v: unknown): ThreadPosition | null {
  if (v === null) return null;
  const o = obj(v, "after");
  return { epoch: str(o, "epoch"), rev: index(o, "rev") };
}

const ASK_ANSWERS_MAX = 4;

function answers(v: unknown): Record<string, string> | null {
  if (v === null) return null;
  const o = obj(v, "answers");
  const entries = Object.entries(o);
  if (entries.length === 0 || entries.length > ASK_ANSWERS_MAX) throw new ParseError(`answers must hold 1 to ${ASK_ANSWERS_MAX} questions`);
  if (entries.some(([q, a]) => q === "" || typeof a !== "string")) throw new ParseError("answers must map each question to a string");
  return o as Record<string, string>;
}

function sessionPatch(v: unknown): SessionPatch {
  const o = obj(v, "patch");
  const p: SessionPatch = {};
  if (o.title !== undefined) p.title = prompt(o, "title");
  if (o.hidden !== undefined) p.hidden = bool(o, "hidden");
  if (o.model !== undefined) p.model = nullable(o, "model", str);
  if (o.mode !== undefined) p.mode = oneOf(o, "mode", PHONE_MODES);
  return p;
}

const botId = (o: Obj) => str(o, "botId") as BotId;
const messageId = (o: Obj) => str(o, "messageId") as MessageId;
const agentId = (o: Obj) => str(o, "agentId") as AgentId;
const routineId = (o: Obj) => str(o, "routineId") as RoutineId;
const factId = (o: Obj) => str(o, "factId") as FactId;
const sessionId = (o: Obj) => str(o, "sessionId") as SessionId;
const cardId = (o: Obj) => str(o, "cardId") as MessageId;

const sessionParsers: Record<SessionClientMessage["type"], (o: Obj) => SessionClientMessage> = {
  watch_sessions: () => ({ type: "watch_sessions" }),
  unwatch_sessions: () => ({ type: "unwatch_sessions" }),
  watch_session: (o) => ({ type: "watch_session", sessionId: sessionId(o), after: position(o.after) }),
  unwatch_session: (o) => ({ type: "unwatch_session", sessionId: sessionId(o) }),
  session_page: (o) => ({ type: "session_page", sessionId: sessionId(o), before: str(o, "before") as Cursor }),
  session_send: (o) => ({ type: "session_send", sessionId: sessionId(o), text: prompt(o, "text"), clientId: str(o, "clientId"), interrupt: bool(o, "interrupt") }),
  session_stop: (o) => ({ type: "session_stop", sessionId: sessionId(o) }),
  session_decide: (o) => ({ type: "session_decide", sessionId: sessionId(o), cardId: cardId(o), choice: oneOf(o, "choice", PERMISSION_CHOICES) }),
  session_answer: (o) => ({ type: "session_answer", sessionId: sessionId(o), cardId: cardId(o), answers: answers(o.answers) }),
  session_create: (o) => ({
    type: "session_create",
    ref: str(o, "ref"),
    projectId: str(o, "projectId") as ProjectId,
    text: prompt(o, "text"),
    model: nullable(o, "model", str),
    mode: nullable(o, "mode", (o, key) => oneOf(o, key, PHONE_MODES)),
    isolate: oneOf(o, "isolate", ["none", "worktree"] as const),
    ...(o.machine !== undefined && { machine: str(o, "machine") as MachineId }),
  }),
  session_set: (o) => ({ type: "session_set", sessionId: sessionId(o), patch: sessionPatch(o.patch) }),
  session_open_desktop: (o) => ({ type: "session_open_desktop", sessionId: sessionId(o) }),
  session_tool: (o) => ({ type: "session_tool", sessionId: sessionId(o), toolUseId: str(o, "toolUseId") }),
  session_prefs: (o) => ({ type: "session_prefs", mirror: oneOf(o, "mirror", MIRROR_PREFS) }),
};

const parsers: Record<ClientMessage["type"], (o: Obj) => ClientMessage> = {
  create_bot: (o) => ({ type: "create_bot", ref: str(o, "ref") }),
  open: (o) => ({ type: "open", botId: botId(o) }),
  send: (o) => {
    const message = { type: "send", botId: botId(o), text: str(o, "text", { empty: true }), uploads: uploads(o.uploads) } as const;
    if (message.text.trim() === "" && message.uploads.length === 0) throw new ParseError("send needs text or uploads");
    return {
      ...message,
      ...(o.clientId !== undefined && { clientId: str(o, "clientId") }),
      ...(o.mentions !== undefined && { mentions: mentions(o.mentions) }),
    };
  },
  answer: (o) => ({ type: "answer", botId: botId(o), messageId: messageId(o), option: index(o, "option") }),
  dismiss: (o) => ({ type: "dismiss", botId: botId(o), messageId: messageId(o) }),
  decide: (o) => ({ type: "decide", botId: botId(o), messageId: messageId(o), choice: oneOf(o, "choice", PERMISSION_CHOICES) }),
  stop: (o) => ({ type: "stop", botId: botId(o) }),
  stop_agent: (o) => ({ type: "stop_agent", agentId: agentId(o) }),
  update_bot: (o) => ({ type: "update_bot", botId: botId(o), patch: patch(o.patch) }),
  mark_unread: (o) => ({ type: "mark_unread", botId: botId(o) }),
  delete_bot: (o) => (o.force === undefined ? { type: "delete_bot", botId: botId(o) } : { type: "delete_bot", botId: botId(o), force: bool(o, "force") }),
  set_routine: (o) => ({ type: "set_routine", botId: botId(o), routineId: routineId(o), enabled: bool(o, "enabled") }),
  run_routine: (o) => ({ type: "run_routine", botId: botId(o), routineId: routineId(o) }),
  details: (o) => ({ type: "details", botId: botId(o) }),
  agent: (o) => ({ type: "agent", agentId: agentId(o) }),
  file: (o) => ({ type: "file", botId: botId(o), path: str(o, "path") }),
  memory: () => ({ type: "memory" }),
  set_fact: (o) => ({ type: "set_fact", factId: o.factId === null ? null : factId(o), text: str(o, "text") }),
  forget_fact: (o) => ({ type: "forget_fact", factId: factId(o) }),
  confirm_fact: (o) => ({ type: "confirm_fact", factId: factId(o) }),
  connectors: (o) => ({ type: "connectors", botId: botId(o) }),
  set_connector: (o) => ({ type: "set_connector", botId: botId(o), name: str(o, "name"), enabled: bool(o, "enabled") }),
  skills: (o) => ({ type: "skills", botId: botId(o) }),
  delete_skill: (o) => ({ type: "delete_skill", botId: botId(o), name: str(o, "name") }),
  commands: (o) => ({ type: "commands", botId: botId(o) }),
  exchange: (o) => ({ type: "exchange", botId: botId(o), peer: str(o, "peer") as BotId }),
  create_group: (o) => ({ type: "create_group", ref: str(o, "ref"), name: boundedStr(o, "name", BOT_NAME_MAX), members: members(o.members) }),
  webhook_token: (o) => ({ type: "webhook_token", botId: botId(o), routineId: routineId(o) }),
  remove_worktree: (o) => ({ type: "remove_worktree", agentId: agentId(o) }),
  refresh_usage: () => ({ type: "refresh_usage" }),
  devices: () => ({ type: "devices" }),
  revoke_device: (o) => ({ type: "revoke_device", deviceId: str(o, "deviceId") as DeviceId }),
  pair_code: () => ({ type: "pair_code" }),
  machine_code: () => ({ type: "machine_code" }),
  presence: (o) => ({ type: "presence", attended: bool(o, "attended") }),
  ...sessionParsers,
};

export function parseClientMessage(raw: string): Parsed {
  try {
    const o = obj(JSON.parse(raw), "message");
    const parse = typeof o.type === "string" && Object.hasOwn(parsers, o.type) ? parsers[o.type as ClientMessage["type"]] : null;
    if (!parse) return { ok: false, error: `unknown message type ${JSON.stringify(o.type)}` };
    return { ok: true, message: parse(o) };
  } catch (e) {
    if (e instanceof ParseError || e instanceof SyntaxError) return { ok: false, error: e.message };
    throw e;
  }
}
