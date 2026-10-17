import { expect, test } from "bun:test";
import type { Agent, AgentId, BotId, Message, MessageId, Peer, RoutineId, RunId } from "../src/protocol";
import { envelope, initiatorOf, notices, runsAhead, withNotices, type Envelope } from "../src/prompts";
import {
  attended,
  botStatus,
  emptyWorld,
  findBot,
  hopsAfter,
  linksOf,
  newBot,
  post,
  recordExchange,
  routineView,
  settleCard,
  sortBots,
  toBot,
  upsertRoutine,
  type Initiator,
  type RoutineRecord,
} from "../src/world";

const at = (minute: number) => `2026-10-17T12:${String(minute).padStart(2, "0")}:00.000Z`;
const bot = (name = "engineer") => newBot({ id: `b_${name}` as BotId, name, avatar: { shape: "circle", color: "white" }, at: at(0) });
const id = (s: string) => s as MessageId;
const said = (text: string, minute = 1): Message => ({ kind: "bot", id: id(`m${minute}`), at: at(minute), text });
const agent: Peer = { kind: "agent", id: "a1" as AgentId, title: "Fix login" };
const question = (q: string, answer: number | "dismissed" | null = null): Message => ({ kind: "question", id: id("q"), at: at(3), question: q, options: ["A", "B"], answer, expiresAt: null });
const permission = (answer: "once" | "expired" | null = null): Message => ({
  kind: "permission", id: id("p"), at: at(4), from: null, tool: "Bash", label: "Push to the default branch",
  detail: "git push origin main", always: "git push to main from engineer", answer, expiresAt: at(59),
});

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
  post(b, question("Which?"));
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
  post(b, { kind: "question", id: id("q1"), at: at(2), question: "Merge #139?", options: ["Yes", "No"], answer: null, expiresAt: null });
  post(b, { kind: "user", id: id("u"), at: at(3), text: "wait", attachments: [] });
  const view = toBot(b, "working");
  expect(view).toMatchObject({ question: "Merge #139?", preview: "**Done.** Two PRs", lastAt: at(3), status: "working" });

  const settled = settleCard(b.messages[1], { kind: "question", answer: 0 });
  if (!settled.ok) throw new Error(settled.error);
  post(b, settled.card);
  expect(toBot(b, "idle").question).toBeNull();
});

test("a card can be settled once, with a valid option", () => {
  const q = question("Which?");
  expect(settleCard(q, { kind: "question", answer: 2 }).ok).toBe(false);
  expect(settleCard(said("x"), { kind: "question", answer: 0 }).ok).toBe(false);
  const dismissed = settleCard(q, { kind: "question", answer: "dismissed" });
  expect(dismissed.ok && dismissed.card.answer).toBe("dismissed");
  expect(settleCard(dismissed.ok ? dismissed.card : q, { kind: "question", answer: 0 }).ok).toBe(false);
});

test("an open permission card counts as unread and shows as the bot's question until it is settled", () => {
  const b = bot();
  post(b, permission());
  expect(toBot(b, "awaiting_approval")).toMatchObject({ unread: 1, question: "Push to the default branch: git push origin main" });
  const settled = settleCard(b.messages[0], { kind: "permission", answer: "once" });
  if (!settled.ok) throw new Error(settled.error);
  post(b, settled.card);
  expect(toBot(b, "idle")).toMatchObject({ unread: 1, question: null });
});

test("a permission card settles first-wins, and an expired one refuses every answer", () => {
  expect(settleCard(permission("once"), { kind: "permission", answer: "deny" })).toEqual({ ok: false, error: "That request was already answered" });
  expect(settleCard(permission("expired"), { kind: "permission", answer: "once" })).toEqual({ ok: false, error: "That request expired" });
  expect(settleCard(question("Which?"), { kind: "permission", answer: "once" }).ok).toBe(false);
  expect(settleCard(permission(), { kind: "question", answer: 0 }).ok).toBe(false);
  const expired = settleCard(permission(), { kind: "permission", answer: "expired" });
  expect(expired.ok && expired.card.answer).toBe("expired");
});

test("status: parked wins, then working, then awaiting approval", () => {
  expect(botStatus({ parked: true, working: true, awaitingApproval: true })).toBe("parked");
  expect(botStatus({ parked: false, working: true, awaitingApproval: true })).toBe("working");
  expect(botStatus({ parked: false, working: false, awaitingApproval: true })).toBe("awaiting_approval");
  expect(botStatus({ parked: false, working: false, awaitingApproval: false })).toBe("idle");
});

test("the wire routine derives describe and lastRunAt; a skipped run is not a run", () => {
  const run = (n: number, status: "ok" | "skipped") => ({ id: `run${n}` as RunId, at: at(n), status, late: false, manual: false, note: null });
  const r: RoutineRecord = {
    id: "r1" as RoutineId, name: "digest", trigger: { kind: "cron", schedule: "57 7 * * 1-5" }, prompt: "Post it.",
    enabled: true, nextRunAt: at(30), runs: [run(9, "skipped"), run(5, "ok")], failStreak: 0,
  };
  expect(routineView(r)).toEqual({
    id: r.id, name: "digest", schedule: "57 7 * * 1-5", describe: "Weekdays at 7:57 AM", prompt: "Post it.",
    enabled: true, lastRunAt: at(5), trigger: "cron", nextRunAt: at(30), runs: r.runs,
  });
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
  const routines: RoutineRecord[] = [];
  let n = 0;
  const newId = () => `r${++n}` as never;
  const fields = { name: "digest", trigger: { kind: "cron" as const, schedule: "0 9 * * *" }, prompt: "Post it.", enabled: true };
  expect(upsertRoutine(routines, fields, newId).created).toBe(true);
  const again = upsertRoutine(routines, { ...fields, trigger: { kind: "cron", schedule: "0 8 * * *" } }, newId);
  expect(again.created).toBe(false);
  expect(routines).toEqual([{ ...fields, trigger: { kind: "cron", schedule: "0 8 * * *" }, id: "r1" as never, nextRunAt: null, runs: [], failStreak: 0 }]);
});

test("bots are found by id or by name, ignoring case", () => {
  const world = emptyWorld();
  world.bots.set(bot().id, bot());
  expect(findBot(world, "b_engineer")?.name).toBe("engineer");
  expect(findBot(world, " Engineer ")?.name).toBe("engineer");
  expect(findBot(world, "nobody")).toBeUndefined();
});

test.each([
  [{ from: "user", text: "Fix it", attachments: [{ name: "a.png", mime: "image/png", path: "inbox/a.png" }] }, "[Alex]\nFix it\nAttached: inbox/a.png"],
  [{ from: "answer", question: "Which?", option: "B" }, '[Alex answered "Which?": B]'],
  [{ from: "dismiss", question: "Which?" }, '[Alex dismissed "Which?" without answering]'],
  [{ from: "routine", name: "digest", prompt: "Post it.", manual: false, late: false }, "[Routine digest fired]\nPost it.\nIf there is nothing worth telling Alex, call routine_no_update and end your turn."],
  [{ from: "routine", name: "digest", prompt: "Post it.", manual: true, late: true }, "[Routine digest fired]\nPost it.\n(It ran late: the Mac was asleep at its time.)\n(Alex ran this now from the phone: reply even if nothing changed.)"],
  [{ from: "decision", choice: "once", tool: "Bash", detail: "git push origin main" }, "[Alex allowed once: Bash `git push origin main`. Run exactly that call again now.]"],
  [{ from: "decision", choice: "always", tool: "Bash", detail: "git push origin main" }, "[Alex allowed Bash `git push origin main` from now on. Run exactly that call again now.]"],
  [{ from: "decision", choice: "deny", tool: "Bash", detail: "git push origin main" }, "[Alex denied: Bash `git push origin main`. Do not try it or anything equivalent.]"],
  [{ from: "decision", choice: "never", tool: "Bash", detail: "git push origin main" }, "[Alex said never: Bash `git push origin main`. Do not try it or anything equivalent, now or later.]"],
  [{ from: "agent", title: "Fix login", agentId: "a1", text: "PR #3 is open." }, '[Agent "Fix login" (a1) reports]\nPR #3 is open.'],
  [{ from: "bot", name: "bot maker", text: "Hi" }, "[Message from bot bot maker]\nHi"],
  [{ from: "created", by: "user", brief: null }, "[You were just created by Alex]"],
  [{ from: "created", by: { bot: "bot maker" }, brief: "Write my standup notes." }, "[You were just created by bot bot maker. Brief:]\nWrite my standup notes."],
] as const)("envelope %#", (e, expected) => {
  expect(envelope(e as never, "Alex")).toBe(expected);
});

const run = { routineId: "r1" as RoutineId, runId: "run1" as RunId };
const b2 = "b_2" as BotId;

test.each<[string, Envelope, Initiator, boolean]>([
  ["user", { from: "user", text: "hi", attachments: [] }, { kind: "user" }, true],
  ["answer", { from: "answer", question: "Which?", option: "A" }, { kind: "user" }, true],
  ["dismiss", { from: "dismiss", question: "Which?" }, { kind: "user" }, true],
  ["scheduled routine", { from: "routine", name: "d", prompt: "p", run, manual: false, late: false }, { kind: "routine", run, manual: false }, false],
  ["Run now", { from: "routine", name: "d", prompt: "p", run, manual: true, late: false }, { kind: "routine", run, manual: true }, true],
  ["agent report", { from: "agent", title: "Fix", agentId: "a1" as AgentId, text: "done" }, { kind: "agent", agentId: "a1" as AgentId }, false],
  ["bot message", { from: "bot", name: "b", botId: b2, hops: 2, text: "hi" }, { kind: "bot", botId: b2, hops: 2 }, false],
  ["created by the user", { from: "created", by: "user", brief: null }, { kind: "user" }, true],
  ["created by a bot", { from: "created", by: { bot: "b", botId: b2, hops: 1 }, brief: "job" }, { kind: "bot", botId: b2, hops: 1 }, false],
  ["a decision on a routine's call", { from: "decision", choice: "once", tool: "Bash", detail: "x", initiator: { kind: "routine", run, manual: false } }, { kind: "routine", run, manual: false }, false],
])("the initiator of %s is derived from the envelope", (_, e, initiator, isAttended) => {
  expect(initiatorOf(e)).toEqual(initiator);
  expect(attended(initiatorOf(e))).toBe(isAttended);
});

test("bot hops count up only along bot-to-bot chains", () => {
  expect(hopsAfter(null)).toBe(1);
  expect(hopsAfter({ kind: "user" })).toBe(1);
  expect(hopsAfter({ kind: "agent", agentId: "a1" as AgentId })).toBe(1);
  expect(hopsAfter({ kind: "bot", botId: b2, hops: 1 })).toBe(2);
});

test("only an approval continuation runs ahead of queued work", () => {
  expect(runsAhead({ from: "decision", choice: "once", tool: "Bash", detail: "x", initiator: { kind: "user" } })).toBe(true);
  expect(runsAhead({ from: "user", text: "hi", attachments: [] })).toBe(false);
});

test("notices go on top of the next envelope, and an expiry is never a no", () => {
  const expired = notices.expiredPermission("Alex", "Bash", "git push origin main");
  expect(expired).toContain("It did not run.");
  expect(expired).toContain("Alex did not say no");
  expect(withNotices("[Alex]\nhi", [{ at: at(1), text: expired }])).toBe(`${expired}\n[Alex]\nhi`);
  expect(withNotices("[Alex]\nhi", [])).toBe("[Alex]\nhi");
});
