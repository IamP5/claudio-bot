import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotId } from "../src/protocol";
import { ASK_TOOL, QUIET_TOOL, freshTurn, readTurn, type Turn } from "../src/turn";
import { newBot, post } from "../src/world";

let n = 0;
const assistant = (...content: object[]) =>
  ({ type: "assistant", uuid: `u${++n}`, parent_tool_use_id: null, session_id: "s", message: { content } }) as unknown as SDKMessage;
const apiError = (t: string) =>
  ({ type: "assistant", uuid: `u${++n}`, parent_tool_use_id: null, session_id: "s", error: "overloaded", message: { content: [text(t)] } }) as unknown as SDKMessage;
const text = (t: string) => ({ type: "text", text: t });
const askCall = { type: "tool_use", id: "t1", name: ASK_TOOL, input: { question: "Which first?", options: ["A", "B"] } };
const quietCall = { type: "tool_use", id: "t3", name: QUIET_TOOL, input: {} };
const otherTool = { type: "tool_use", id: "t2", name: "Read", input: {} };
const result = { type: "result", subtype: "success", session_id: "s" } as unknown as SDKMessage;
const turnEnd = "turn end" as const;

// Drives readTurn the way the hub does: the owner resets to freshTurn when the session reports the turn's end.
function chat(script: (SDKMessage | typeof turnEnd)[]): { said: string[]; ends: Turn[] } {
  let turn: Turn = freshTurn;
  const said: string[] = [];
  const ends: Turn[] = [];
  for (const m of script) {
    if (m === turnEnd) {
      ends.push(turn);
      turn = freshTurn;
      continue;
    }
    const read = readTurn(turn, m);
    turn = read.turn;
    said.push(...read.bubbles.map((b) => b.text));
  }
  return { said, ends };
}

test("a text block with several paragraphs, a list and code is one bubble", () => {
  const body = "Done.\n\nThree things changed:\n\n- login\n\n- signup\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAnything else?";
  expect(chat([assistant(text(`\n${body}\n\n`))]).said).toEqual([body]);
});

test("each text block is its own bubble, and a block with only whitespace is none", () => {
  expect(chat([assistant(text("First."), otherTool, text(" \n\t\n"), text("Second.\n\nStill second."))]).said).toEqual([
    "First.",
    "Second.\n\nStill second.",
  ]);
});

test("text after ask in the same turn never reaches the chat, and the next turn speaks again", () => {
  expect(
    chat([
      assistant(text("Hey Alex.\n\nI can help with code or research.")),
      assistant(otherTool),
      assistant(text("One more thing."), askCall, text("I've posted the question card.")),
      assistant(text("Let me know what you pick.")),
      result,
      turnEnd,
      assistant(text("Great, coding it is.")),
    ]).said,
  ).toEqual(["Hey Alex.\n\nI can help with code or research.", "One more thing.", "Great, coding it is."]);
});

test("a turn that called routine_no_update ends quiet, and the flags are still set after its result", () => {
  const { said, ends } = chat([assistant(text("Checked the inbox."), quietCall), result, turnEnd, assistant(text("Morning!")), result, turnEnd]);
  expect(said).toEqual(["Checked the inbox.", "Morning!"]);
  expect(ends).toEqual([
    { asked: false, quiet: true },
    { asked: false, quiet: false },
  ]);
});

test("a quiet turn that also asked ends with both flags, so its card still shows", () => {
  expect(chat([assistant(quietCall), assistant(askCall), result, turnEnd]).ends).toEqual([{ asked: true, quiet: true }]);
});

test("the SDK's synthetic API-error message never becomes a bubble", () => {
  expect(chat([apiError("API Error: 529 overloaded"), assistant(text("Back again."))]).said).toEqual(["Back again."]);
});

test("replaying an assistant message rewrites the same bubbles", () => {
  const bot = newBot({ id: "b_1" as BotId, name: "New Bot", avatar: { shape: "circle", color: "white" }, at: "2026-10-17T12:00:00.000Z" });
  const m = assistant(text("One.\n\nTwo."));
  for (let i = 0; i < 2; i++) {
    for (const b of readTurn(freshTurn, m).bubbles) post(bot, { kind: "bot", id: b.id, at: "2026-10-17T12:01:00.000Z", text: b.text });
  }
  expect(bot.messages.map((x) => x.kind === "bot" && x.text)).toEqual(["One.\n\nTwo."]);
  expect(bot.unread).toBe(1);
});
