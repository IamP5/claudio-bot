import {
  COLORS,
  SHAPES,
  type AgentId,
  type Avatar,
  type BotId,
  type BotPatch,
  type ClientMessage,
  type MessageId,
  type RoutineId,
  type Upload,
} from "./protocol";

export type Parsed = { ok: true; message: ClientMessage } | { ok: false; error: string };

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

function avatar(v: unknown): Avatar {
  const o = obj(v, "avatar");
  return { shape: oneOf(o, "shape", SHAPES), color: oneOf(o, "color", COLORS) };
}

function patch(v: unknown): BotPatch {
  const o = obj(v, "patch");
  const p: BotPatch = {};
  if (o.name !== undefined) p.name = str(o, "name");
  if (o.title !== undefined) p.title = o.title === null ? null : str(o, "title", { empty: true });
  if (o.avatar !== undefined) p.avatar = avatar(o.avatar);
  if (o.pinned !== undefined) p.pinned = bool(o, "pinned");
  if (o.hidden !== undefined) p.hidden = bool(o, "hidden");
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

const botId = (o: Obj) => str(o, "botId") as BotId;

const parsers: Record<ClientMessage["type"], (o: Obj) => ClientMessage> = {
  create_bot: (o) => ({ type: "create_bot", ref: str(o, "ref") }),
  open: (o) => ({ type: "open", botId: botId(o) }),
  send: (o) => {
    const message = { type: "send", botId: botId(o), text: str(o, "text", { empty: true }), uploads: uploads(o.uploads) } as const;
    if (message.text.trim() === "" && message.uploads.length === 0) throw new ParseError("send needs text or uploads");
    return message;
  },
  answer: (o) => ({ type: "answer", botId: botId(o), messageId: str(o, "messageId") as MessageId, option: index(o, "option") }),
  dismiss: (o) => ({ type: "dismiss", botId: botId(o), messageId: str(o, "messageId") as MessageId }),
  update_bot: (o) => ({ type: "update_bot", botId: botId(o), patch: patch(o.patch) }),
  mark_unread: (o) => ({ type: "mark_unread", botId: botId(o) }),
  delete_bot: (o) => ({ type: "delete_bot", botId: botId(o) }),
  set_routine: (o) => ({ type: "set_routine", botId: botId(o), routineId: str(o, "routineId") as RoutineId, enabled: bool(o, "enabled") }),
  details: (o) => ({ type: "details", botId: botId(o) }),
  agent: (o) => ({ type: "agent", agentId: str(o, "agentId") as AgentId }),
  file: (o) => ({ type: "file", botId: botId(o), path: str(o, "path") }),
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
