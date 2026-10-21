import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import { parseHomeFrame, parseMachineFrame } from "../src/machine/wire";

type Frame = { t: string; intent?: { kind: string } & Record<string, unknown>; event?: { kind: string } };
const link = fixtures.link as Frame[];

const HOME = new Set(["challenge", "welcome", "intent", "ack", "ask"]);
const parse = (frame: { t: string }) => (HOME.has(frame.t) ? parseHomeFrame : parseMachineFrame)(JSON.stringify(frame));

test.each(link.map((f) => [[f.t, f.intent?.kind ?? f.event?.kind].filter(Boolean).join(" "), f] as const))(
  "link fixture %s parses to itself",
  (_, frame) => {
    expect(parse(frame)).toEqual({ ok: true, value: frame } as never);
  },
);

test("a profile from a machine before connectors reads as none", () => {
  const event = link.find((f) => f.event?.kind === "profile")! as Frame & { event: { profile: Record<string, unknown> } };
  const { connectors: _, ...old } = event.event.profile;
  const parsed = parseMachineFrame(JSON.stringify({ ...event, event: { ...event.event, profile: old } }));
  expect(parsed).toEqual({ ok: true, value: { ...event, event: { ...event.event, profile: { ...old, connectors: [] } } } } as never);
});

test("a home frame is not a machine frame, nor the other way round", () => {
  const challenge = link.find((f) => f.t === "challenge")!;
  const event = link.find((f) => f.t === "event")!;
  expect(parseMachineFrame(JSON.stringify(challenge)).ok).toBe(false);
  expect(parseHomeFrame(JSON.stringify(event)).ok).toBe(false);
});

const start = link.find((f) => f.intent?.kind === "agent.start")!;

test.each([
  ["not json", "{nope"],
  ["an unknown frame", { t: "shell", cmd: "id" }],
  ["a short nonce", { t: "challenge", nonce: "ab" }],
  ["a negative ack", { t: "ack", seq: -1 }],
  ["a fractional ack", { t: "ack", seq: 1.5 }],
  ["an unknown intent", { t: "intent", intent: { kind: "agent.exec", intentId: "i_1" } }],
  ["an intent without an id", { t: "intent", intent: { kind: "agent.stop", agentId: "a1" } }],
  ["a start with a path for a project and no name", { t: "intent", intent: { ...start.intent, project: { githubRepo: null } } }],
  ["a start whose isolate the machine does not know", { t: "intent", intent: { ...start.intent, isolate: "clone" } }],
  ["a card answer with a choice the gate does not know", { t: "intent", intent: { kind: "card.answer", intentId: "i_6", botId: "b1", cardId: "m1", reply: { kind: "permission", choice: "maybe" }, signed: null } }],
  ["a card answer that leaves signed out", { t: "intent", intent: { kind: "card.answer", intentId: "i_6", botId: "b1", cardId: "m1", reply: { kind: "dismiss" } } }],
  ["an ask that is not a session request", { t: "ask", id: "i_9", frame: { type: "delete_bot", botId: "b1" } }],
  ["an ask whose session_send has no clientId", { t: "ask", id: "i_9", frame: { type: "session_send", sessionId: "s1", text: "hi", interrupt: false } }],
  ["an ask whose session_set asks for bypassPermissions", { t: "ask", id: "i_9", frame: { type: "session_set", sessionId: "s1", patch: { mode: "bypassPermissions" } } }],
])("a home frame with %s is refused", (_, raw) => {
  expect(parseHomeFrame(typeof raw === "string" ? raw : JSON.stringify(raw)).ok).toBe(false);
});

test("an intent never carries an access mode: unknown keys are dropped, so a machine cannot adopt one from the wire", () => {
  const parsed = parseHomeFrame(JSON.stringify({ ...start, intent: { ...start.intent, access: { full: true, sandbox: false } } }));
  expect(parsed.ok && parsed.value.t === "intent" && "access" in parsed.value.intent).toBe(false);
});

test.each([
  ["a hello without a profile", { t: "hello", machineId: "m_1", sig: "c2ln", nonce: "4e".repeat(32), lastSeq: 0 }],
  ["an event of an unknown kind", { t: "event", event: { seq: 1, at: "2026-10-16T12:00:00.000Z", kind: "shell" } }],
  ["an event without a seq", { t: "event", event: { at: "2026-10-16T12:00:00.000Z", kind: "note", agentId: "a1", botId: "b1", text: "x" } }],
  ["an applied that is neither ok nor refused", { t: "applied", intentId: "i_1", applied: { ok: "yes" } }],
  ["a reply whose row has no id", { t: "reply", id: "i_9", frames: [{ type: "session_rows", rows: [{ title: "x" }], removed: [], projects: [] }] }],
  ["a reply with a frame that is not a session frame", { t: "reply", id: "i_9", frames: [{ type: "bot_removed", botId: "b1" }] }],
  ["a signal that is a whole list, which only answers a request", { t: "signal", frame: { type: "sessions", rows: [], projects: [], mirror: "auto" } }],
])("a machine frame with %s is refused", (_, raw) => {
  expect(parseMachineFrame(JSON.stringify(raw)).ok).toBe(false);
});
