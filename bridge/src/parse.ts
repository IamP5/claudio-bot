import type { ClientMessage, Decision, ItemId, PermissionMode, ProjectId, Target, TaskId } from "./protocol";

export type Parsed = { ok: true; message: ClientMessage } | { ok: false; error: string };

class ParseError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ParseError(`${what} must be an object`);
  return v as Obj;
}

function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "") throw new ParseError(`${key} must be a non-empty string`);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  const v = str(o, key);
  if (!(values as readonly string[]).includes(v)) throw new ParseError(`${key} must be one of ${values.join(", ")}`);
  return v as T;
}

function stringRecord(v: unknown, what: string): Record<string, string> {
  const o = obj(v, what);
  for (const [k, val] of Object.entries(o)) if (typeof val !== "string") throw new ParseError(`${what}.${k} must be a string`);
  return o as Record<string, string>;
}

const permissionModes = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const satisfies readonly PermissionMode[];
const decisions = ["allow", "allow_always", "deny"] as const satisfies readonly Decision[];
const targetKinds = ["local", "cloud"] as const satisfies readonly Target["kind"][];

const parsers: Record<ClientMessage["type"], (o: Obj) => ClientMessage> = {
  create: (o) => {
    const t = obj(o.target, "target");
    return {
      type: "create",
      prompt: str(o, "prompt"),
      target: { kind: oneOf(t, "kind", targetKinds), projectId: str(t, "projectId") as ProjectId },
      model: str(o, "model"),
      permissionMode: oneOf(o, "permissionMode", permissionModes),
    };
  },
  subscribe: (o) => ({ type: "subscribe", taskId: str(o, "taskId") as TaskId }),
  send: (o) => ({ type: "send", taskId: str(o, "taskId") as TaskId, text: str(o, "text") }),
  decide: (o) => ({
    type: "decide",
    taskId: str(o, "taskId") as TaskId,
    itemId: str(o, "itemId") as ItemId,
    decision: oneOf(o, "decision", decisions),
  }),
  answer: (o) => ({
    type: "answer",
    taskId: str(o, "taskId") as TaskId,
    itemId: str(o, "itemId") as ItemId,
    answers: stringRecord(o.answers, "answers"),
  }),
  stop: (o) => ({ type: "stop", taskId: str(o, "taskId") as TaskId }),
};

export function parseClientMessage(raw: unknown): Parsed {
  try {
    const o = obj(typeof raw === "string" ? JSON.parse(raw) : raw, "message");
    const parse = typeof o.type === "string" && Object.hasOwn(parsers, o.type) ? parsers[o.type as ClientMessage["type"]] : null;
    if (!parse) return { ok: false, error: `unknown message type ${JSON.stringify(o.type)}` };
    return { ok: true, message: parse(o) };
  } catch (e) {
    if (e instanceof ParseError || e instanceof SyntaxError) return { ok: false, error: e.message };
    throw e;
  }
}
