import { expect, test } from "bun:test";
import type { Agent, AgentId, BotId, Message, MessageId, Peer } from "../src/protocol";
import { envelope } from "../src/prompts";
import {
  findBot,
  linksOf,
  newBot,
  post,
  recordExchange,
  settleQuestion,
  sortBots,
  toBot,
  upsertRoutine,
  type World,
} from "../src/world";

const at = (minute: number) => `2026-10-17T12:${String(minute).padStart(2, "0")}:00.000Z`;
const bot = (name = "engineer") => newBot({ id: `b_${name}` as BotId, name, avatar: { shape: "circle", color: "white" }, at: at(0) });
const id = (s: string) => s as MessageId;
const said = (text: string, minute = 1): Message => ({ kind: "bot", id: id(`m${minute}`), at: at(minute), text });
const agent: Peer = { kind: "agent", id: "a1" as AgentId, title: "Fix login" };

test("consecutive messages with one peer group into one exchange", () => {
  const b = bot();
  recordExchange(b, agent, "sent", at(1));
  recordExchange(b, agent, "received", at(2));
  recordExchange(b, agent, "received", at(3));
  expect(b.messages).toHaveLength(1);
  expect(b.messages[0]).toMatchObject({ kind: "exchange", peer: agent, sent: 1, received: 2, at: at(3) });
});

test("anything said in between starts a new exchange", () => {
  const b = bot();
  recordExchange(b, agent, "sent", at(1));
  post(b, said("Started it.", 2));
  recordExchange(b, agent, "received", at(3));
  expect(b.messages.map((m) => m.kind)).toEqual(["exchange", "bot", "exchange"]);
  expect(b.messages[2]).toMatchObject({ sent: 0, received: 1 });
});

test("a different peer starts a new exchange", () => {
  const b = bot();
  recordExchange(b, agent, "sent", at(1));
  recordExchange(b, { kind: "agent", id: "a2" as AgentId, title: "Other" }, "sent", at(2));
  expect(b.messages).toHaveLength(2);
});

test("unread counts bot bubbles, cards and received exchange messages, not sent ones, notes or the user", () => {
  const b = bot();
  post(b, { kind: "user", id: id("u"), at: at(1), text: "hi", attachments: [] });
  post(b, said("hello", 2));
  post(b, { kind: "question", id: id("q"), at: at(3), question: "Which?", options: ["A", "B"], answer: null });
  post(b, { kind: "note", id: id("n"), at: at(4), text: "Created routine {0}", refs: [] });
  recordExchange(b, agent, "sent", at(5));
  recordExchange(b, agent, "received", at(6));
  recordExchange(b, agent, "received", at(7));
  expect(toBot(b, "idle").unread).toBe(4);
});

test("replaying the same message changes nothing", () => {
  const b = bot();
  const m = said("hello");
  post(b, m);
  post(b, m);
  expect(b.messages).toHaveLength(1);
  expect(b.unread).toBe(1);
});

test("question and preview come from the newest open card and the last bot message", () => {
  const b = bot();
  post(b, said("**Done.** Two PRs\nare open.", 1));
  post(b, { kind: "question", id: id("q1"), at: at(2), question: "Merge #139?", options: ["Yes", "No"], answer: null });
  post(b, { kind: "user", id: id("u"), at: at(3), text: "wait", attachments: [] });
  const view = toBot(b, "working");
  expect(view).toMatchObject({ question: "Merge #139?", preview: "**Done.** Two PRs", lastAt: at(3), status: "working" });

  const settled = settleQuestion(b.messages[1], 0);
  if (!settled.ok) throw new Error(settled.error);
  post(b, settled.message);
  expect(toBot(b, "idle").question).toBeNull();
});

test("a card can be settled once, with a valid option", () => {
  const q: Message = { kind: "question", id: id("q"), at: at(1), question: "Which?", options: ["A", "B"], answer: null };
  expect(settleQuestion(q, 2).ok).toBe(false);
  expect(settleQuestion(said("x"), 0).ok).toBe(false);
  const dismissed = settleQuestion(q, "dismissed");
  expect(dismissed.ok && dismissed.message.answer).toBe("dismissed");
  expect(settleQuestion(dismissed.ok ? dismissed.message : q, 0).ok).toBe(false);
});

test("home order is pinned first, then newest activity", () => {
  const older = toBot({ ...bot("a"), messages: [said("x", 5)] }, "idle");
  const newer = toBot({ ...bot("b"), messages: [said("x", 9)] }, "idle");
  const pinned = toBot({ ...bot("c"), pinned: true }, "idle");
  expect(sortBots([older, newer, pinned]).map((b) => b.name)).toEqual(["c", "b", "a"]);
});

test("links come from bot messages and agent urls, deduped, newest first", () => {
  const b = bot();
  post(b, said("Opened [#142](https://github.com/acme/web/pull/142). See https://example.com/a.", 1));
  post(b, said("Still https://github.com/acme/web/pull/142, and **https://news.ycombinator.com/item?id=1**", 3));
  const cloud = { url: "https://claude.ai/code/session_abc", createdAt: at(2) } as Agent;
  expect(linksOf(b, [cloud])).toEqual([
    { url: "https://github.com/acme/web/pull/142", host: "github.com", at: at(3) },
    { url: "https://news.ycombinator.com/item?id=1", host: "news.ycombinator.com", at: at(3) },
    { url: "https://claude.ai/code/session_abc", host: "claude.ai", at: at(2) },
    { url: "https://example.com/a", host: "example.com", at: at(1) },
  ]);
});

test("routines upsert by name", () => {
  const b = bot();
  let n = 0;
  const newId = () => `r${++n}` as never;
  const fields = { name: "digest", schedule: "0 9 * * *", describe: "Every day at 9:00 AM", prompt: "Post it.", enabled: true };
  expect(upsertRoutine(b, fields, newId).created).toBe(true);
  const again = upsertRoutine(b, { ...fields, schedule: "0 8 * * *" }, newId);
  expect(again.created).toBe(false);
  expect(b.routines).toEqual([{ ...fields, schedule: "0 8 * * *", id: "r1" as never, lastRunAt: null }]);
});

test("bots are found by id or by name, ignoring case", () => {
  const world: World = { bots: new Map([[bot().id, bot()]]), agents: new Map() };
  expect(findBot(world, "b_engineer")?.name).toBe("engineer");
  expect(findBot(world, " Engineer ")?.name).toBe("engineer");
  expect(findBot(world, "nobody")).toBeUndefined();
});

test.each([
  [{ from: "user", text: "Fix it", attachments: [{ name: "a.png", mime: "image/png", path: "inbox/a.png" }] }, "[Alex]\nFix it\nAttached: inbox/a.png"],
  [{ from: "answer", question: "Which?", option: "B" }, '[Alex answered "Which?": B]'],
  [{ from: "dismiss", question: "Which?" }, '[Alex dismissed "Which?" without answering]'],
  [{ from: "routine", name: "digest", prompt: "Post it." }, "[Routine digest fired]\nPost it."],
  [{ from: "agent", title: "Fix login", agentId: "a1", text: "PR #3 is open." }, '[Agent "Fix login" (a1) reports]\nPR #3 is open.'],
  [{ from: "bot", name: "bot maker", text: "Hi" }, "[Message from bot bot maker]\nHi"],
  [{ from: "created", by: "user", brief: null }, "[You were just created by Alex]"],
  [{ from: "created", by: { bot: "bot maker" }, brief: "Write my standup notes." }, "[You were just created by bot bot maker. Brief:]\nWrite my standup notes."],
] as const)("envelope %#", (e, expected) => {
  expect(envelope(e as never, "Alex")).toBe(expected);
});
