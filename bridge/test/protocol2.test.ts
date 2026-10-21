import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import type { AgentId, BotId, Message, MessageId, ServerMessage } from "../src/protocol";
import { cardReply, forProtocol2 } from "../src/protocol2";

const at = "2026-10-17T12:00:00.000Z";
const expiresAt = "2026-10-17T14:00:00.000Z";
const botId = "b_eng" as BotId;
type Permission = Extract<Message, { kind: "permission" }>;

const permission = (answer: Permission["answer"], from: Permission["from"] = null): Permission => ({
  kind: "permission",
  id: "m_card" as MessageId,
  at,
  from,
  tool: "Bash",
  label: "Push to the default branch",
  detail: "git push origin main",
  always: "git push to main",
  answer,
  expiresAt,
});

test.each([
  [null, null],
  ["once", 0],
  ["always", 0],
  ["deny", 1],
  ["never", 1],
  ["expired", "expired"],
  ["stopped", "dismissed"],
] as const)("a protocol 2 app sees a permission card answered %p as a question answered %p", (answer, shown) => {
  expect(forProtocol2({ type: "message", botId, message: permission(answer) })).toEqual({
    type: "message",
    botId,
    message: { kind: "question", id: "m_card" as MessageId, at, question: "Push to the default branch: git push origin main", options: ["Allow once", "Deny"], answer: shown, expiresAt },
  });
});

test("an agent's card names the agent, and a conversation downgrades only its permission cards", () => {
  const note: Message = { kind: "note", id: "m_note" as MessageId, at, text: "Created routine {0}", refs: [] };
  const fromAgent = permission(null, { kind: "agent", id: "a_1" as AgentId, title: "Fix login" });

  const shown = forProtocol2({ type: "conversation", botId, messages: [note, fromAgent] });

  expect(shown?.type === "conversation" && shown.messages.map((m) => (m.kind === "question" ? m.question : m.kind))).toEqual([
    "note",
    "Fix login: Push to the default branch: git push origin main",
  ]);
});

test("frames without a permission card are passed through as the same object", () => {
  const frames: ServerMessage[] = [
    { type: "message", botId, message: { kind: "bot", id: "m_1" as MessageId, at, text: "hi" } },
    { type: "bot_removed", botId },
  ];
  for (const frame of frames) expect(forProtocol2(frame)).toBe(frame);
});

test.each([
  ["Allow once on a permission card", permission(null), { type: "answer", option: 0 }, { kind: "permission", choice: "once" }],
  ["Deny on a permission card", permission(null), { type: "answer", option: 1 }, { kind: "permission", choice: "deny" }],
  ["dismissing a permission card", permission(null), { type: "dismiss" }, { kind: "permission", choice: "deny" }],
  ["an option a protocol 2 app never showed", permission(null), { type: "answer", option: 2 }, null],
  ["an answer to a question", undefined, { type: "answer", option: 2 }, { kind: "option", index: 2 }],
  ["a dismissed question", undefined, { type: "dismiss" }, { kind: "dismiss" }],
] as const)("card reply: %s", (_, card, tap, reply) => {
  expect(cardReply(card, tap)).toEqual(reply);
});

test.each(fixtures.server.map((m) => [m.type, m as ServerMessage] as const))("a protocol 2 app gets fixture %s only if it is not a session frame", (type, frame) => {
  expect(forProtocol2(frame) === null).toBe(type.startsWith("session"));
});
