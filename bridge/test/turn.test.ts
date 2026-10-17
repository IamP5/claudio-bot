import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotId } from "../src/protocol";
import { ASK_TOOL, freshTurn, readTurn, splitBubbles, type Turn } from "../src/turn";
import { newBot, post } from "../src/world";

test("paragraphs become separate bubbles", () => {
  expect(splitBubbles("Hey Bruno.\n\nI looked at the PR.\n\n\nIt is ready to merge.")).toEqual([
    "Hey Bruno.",
    "I looked at the PR.",
    "It is ready to merge.",
  ]);
});

test("a single paragraph stays as it is", () => {
  expect(splitBubbles("The build is green.\nTwo tests were flaky.")).toEqual(["The build is green.\nTwo tests were flaky."]);
});

test("a fenced code block with blank lines inside is never split", () => {
  const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
  expect(splitBubbles(`Here is the diff.\n\n${code}\n\nShip it?`)).toEqual(["Here is the diff.", code, "Ship it?"]);
});

test("list items separated by blank lines stay in one bubble", () => {
  expect(splitBubbles("- First PR\n\n- Second PR\n\n1. Third\n\nThat is all.")).toEqual([
    "- First PR\n\n- Second PR\n\n1. Third",
    "That is all.",
  ]);
});

test("a line ending in a colon stays with the list it introduces", () => {
  expect(splitBubbles("Done.\n\nThree things changed:\n\n- login\n- signup\n\n- logout\n\nAnything else?")).toEqual([
    "Done.",
    "Three things changed:\n\n- login\n- signup\n\n- logout",
    "Anything else?",
  ]);
});

let n = 0;
const assistant = (...content: object[]) =>
  ({ type: "assistant", uuid: `u${++n}`, parent_tool_use_id: null, session_id: "s", message: { content } }) as unknown as SDKMessage;
const text = (t: string) => ({ type: "text", text: t });
const askCall = { type: "tool_use", id: "t1", name: ASK_TOOL, input: { question: "Which first?", options: ["A", "B"] } };
const otherTool = { type: "tool_use", id: "t2", name: "Read", input: {} };
const result = { type: "result", subtype: "success", session_id: "s" } as unknown as SDKMessage;

function chat(messages: SDKMessage[]): string[] {
  let turn: Turn = freshTurn;
  const said: string[] = [];
  for (const m of messages) {
    const read = readTurn(turn, m);
    turn = read.turn;
    said.push(...read.bubbles.map((b) => b.text));
  }
  return said;
}

test("text after ask in the same turn never reaches the chat, and the next turn speaks again", () => {
  expect(
    chat([
      assistant(text("Hey Bruno.\n\nI can help with code or research.")),
      assistant(otherTool),
      assistant(text("One more thing."), askCall, text("I've posted the question card.")),
      assistant(text("Let me know what you pick.")),
      result,
      assistant(text("Great, coding it is.")),
    ]),
  ).toEqual(["Hey Bruno.", "I can help with code or research.", "One more thing.", "Great, coding it is."]);
});

test("replaying an assistant message rewrites the same bubbles", () => {
  const bot = newBot({ id: "b_1" as BotId, name: "New Bot", avatar: { shape: "circle", color: "white" }, at: "2026-10-17T12:00:00.000Z" });
  const m = assistant(text("One.\n\nTwo."));
  for (let i = 0; i < 2; i++) {
    for (const b of readTurn(freshTurn, m).bubbles) post(bot, { kind: "bot", id: b.id, at: "2026-10-17T12:01:00.000Z", text: b.text });
  }
  expect(bot.messages.map((x) => x.kind === "bot" && x.text)).toEqual(["One.", "Two."]);
  expect(bot.unread).toBe(2);
});
