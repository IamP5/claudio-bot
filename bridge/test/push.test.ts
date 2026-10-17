import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotId, MessageId } from "../src/protocol";
import { createPush, MESSAGE_THROTTLE_MS, ntfySender, senderFromEnv, START_GRACE_MS, type PushReason, type Sender } from "../src/push";
import { createSaver, loadWorld } from "../src/store";
import { botActor, newBot, post, type GateState, type PushState, type World } from "../src/world";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const URL_ = "https://ntfy.example/claudio-topic";
const T0 = Date.parse("2026-10-17T09:00:00.000Z");
const BOT = { id: "b_claudio" as BotId, name: "Claudio Bot" };
const CARD = "m_card" as MessageId;
const SECRET_COMMAND = "git push origin main --force";
const SECRET_CHAT = "the merger closes on Friday, see plan-final.pdf";

type Call = { url: string; init: RequestInit };

/** liveFor: a socket was heard from just now and stays live this many ms; 0: none is live. */
function harness(opts: { home?: string; liveFor?: number; respond?: () => Promise<Response> } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "claudiobot-push-"));
  if (!opts.home) homes.push(home);
  const { world } = loadWorld(home);
  if (!world.bots.has(BOT.id)) {
    const bot = newBot({ id: BOT.id, name: BOT.name, avatar: { shape: "circle", color: "white" }, at: new Date(T0).toISOString() });
    world.bots.set(bot.id, bot);
    post(bot, { kind: "user", id: "m_user" as MessageId, at: bot.createdAt, text: SECRET_CHAT, attachments: [{ name: "plan-final.pdf", mime: "application/pdf", path: "inbox/plan-final.pdf" }] });
    post(bot, { kind: "permission", id: CARD, at: bot.createdAt, from: null, tool: "Bash", label: "Push to the default branch", detail: SECRET_COMMAND, always: "Bash git push", answer: null, expiresAt: new Date(T0 + 3_600_000).toISOString() });
  }
  const saver = createSaver(world, home);
  const calls: Call[] = [];
  const onDisk: string[][] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    onDisk.push(diskKeys(home));
    return opts.respond ? opts.respond() : new Response("ok");
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const clock = { t: T0 };
  const sockets = { until: opts.liveFor ? new Date(T0 + opts.liveFor) : null };
  const push = createPush({
    world,
    persist: saver.schedule,
    sender: ntfySender(URL_, fakeFetch),
    liveUntil: () => sockets.until,
    now: () => new Date(clock.t),
    log: (l) => logs.push(l),
  });
  const bubble = (id: string) => {
    post(world.bots.get(BOT.id)!, { kind: "bot", id: id as MessageId, at: new Date(clock.t).toISOString(), text: SECRET_CHAT });
    return id as MessageId;
  };
  return { home, world, push, calls, onDisk, logs, clock, sockets, bubble };
}

const diskKeys = (home: string): string[] =>
  JSON.parse(readFileSync(join(home, "state.json"), "utf8")).push.sent.map((s: { key: string }) => s.key);
const keys = (world: World) => world.push.sent.map((s) => s.key);
const settle = () => new Promise((r) => setTimeout(r, 0));

test.each(["card", "reminder", "message"] as PushReason[])("a live socket suppresses a %s push and records nothing", async (reason) => {
  const h = harness({ liveFor: 45_000 });
  h.push.notify(BOT, reason, reason === "message" ? h.bubble("m_bubble") : CARD);
  await settle();
  expect(h.calls).toEqual([]);
  expect(keys(h.world)).toEqual([]);
});

test("a socket last heard from before now is not live, so its stale deadline does not hold a push back", async () => {
  const h = harness({ liveFor: 45_000 });
  h.clock.t = T0 + 45_000;
  expect(h.push.notify(BOT, "card", CARD)).toBe(true);
});

test.each([
  ["it went out", {}, () => {}, true],
  ["a socket is live", { liveFor: 45_000 }, () => {}, false],
  ["it already went out once", {}, (h: ReturnType<typeof harness>) => h.push.notify(BOT, "card", CARD), false],
] as [string, Parameters<typeof harness>[0], (h: ReturnType<typeof harness>) => void, boolean][])("notify returns whether the push went out: %s", (_, opts, before, sent) => {
  const h = harness(opts);
  before(h);
  expect(h.push.notify(BOT, "card", CARD)).toBe(sent);
});

test("notify returns false when push is off, when the push cannot be recorded, and when messages are throttled", () => {
  const h = harness();
  const { world } = harness();
  const off = createPush({ world, persist: () => {}, sender: null, liveUntil: () => null, now: () => new Date(T0), log: () => {} });
  const unsaved = createPush({ world, persist: () => { throw new Error("disk full"); }, sender: async () => {}, liveUntil: () => null, now: () => new Date(T0), log: () => {} });
  expect(off.notify(BOT, "card", CARD)).toBe(false);
  expect(unsaved.notify(BOT, "card", CARD)).toBe(false);
  expect(h.push.notify(BOT, "message", h.bubble("m_b1"))).toBe(true);
  expect(h.push.notify(BOT, "message", h.bubble("m_b2"))).toBe(false);
});

function openCard(world: World, cardId = CARD) {
  (world.gate as GateState).open.push({ kind: "question", cardId, actor: botActor(BOT.id), remindAt: null, expiresAt: new Date(T0 + 3_600_000).toISOString() });
}

test("a card push held back by a live socket goes out once, at the first tick after the socket lapses", async () => {
  const h = harness({ liveFor: 45_000 });
  openCard(h.world);
  expect(h.push.notify(BOT, "card", CARD)).toBe(false);
  expect(h.push.nextDeadline()).toBe(new Date(T0 + 45_000).toISOString());

  h.push.tick(new Date(T0 + 30_000));
  await settle();
  expect(h.calls).toEqual([]);

  h.clock.t = T0 + 46_000;
  h.push.tick(new Date(h.clock.t));
  h.push.tick(new Date(h.clock.t));
  await settle();
  expect(h.calls.map((c) => c.init.body)).toEqual(["Claudio Bot needs you"]);
  expect(h.push.nextDeadline()).toBeNull();
});

test("a card answered while the socket was live is never pushed", async () => {
  const h = harness({ liveFor: 45_000 });
  openCard(h.world);
  h.push.notify(BOT, "card", CARD);
  (h.world.gate as GateState).open.splice(0);

  h.clock.t = T0 + 46_000;
  h.push.tick(new Date(h.clock.t));
  await settle();
  expect(h.calls).toEqual([]);
  expect(h.push.nextDeadline()).toBeNull();
});

test("the payload is the bot's name, a fixed phrase and the deep link, never content", async () => {
  const h = harness();
  h.push.notify(BOT, "card", CARD);
  await settle();
  expect(h.calls).toHaveLength(1);
  const { url, init } = h.calls[0]!;
  expect(url).toBe(URL_);
  expect(init.method).toBe("POST");
  expect(init.body).toBe("Claudio Bot needs you");
  expect(init.headers).toEqual({ Title: "ClaudioBot", Click: "claudiobot://bot/b_claudio?message=m_card" });
  const wire = JSON.stringify({ url, body: init.body, headers: init.headers });
  for (const secret of [SECRET_COMMAND, "git push", "Push to the default branch", SECRET_CHAT, "plan-final.pdf", "Bash"]) {
    expect(wire).not.toContain(secret);
  }
});

test.each([
  ["card", "Claudio Bot needs you"],
  ["reminder", "Claudio Bot is still waiting for you"],
  ["message", "Claudio Bot has an update for you"],
  ["result", "Claudio Bot has an update for you"],
] as [PushReason, string][])("reason %s reads %p", async (reason, text) => {
  const h = harness();
  const id = reason === "message" || reason === "result" ? h.bubble("m_bubble") : CARD;
  h.push.notify(BOT, reason, id);
  await settle();
  expect(h.calls.map((c) => c.init.body)).toEqual([text]);
});

test("the key is on disk before the request leaves", async () => {
  const h = harness();
  h.push.notify(BOT, "card", CARD);
  h.push.notify(BOT, "reminder", CARD);
  await settle();
  expect(h.onDisk[0]).toContain("m_card|card");
  expect(h.onDisk[1]).toEqual(["m_card|card", "m_card|reminder"]);
});

test("a card and its reminder each push once, across a restart", async () => {
  const first = harness();
  first.push.notify(BOT, "card", CARD);
  first.push.notify(BOT, "card", CARD);
  await settle();
  expect(first.calls).toHaveLength(1);

  const restarted = harness({ home: first.home });
  restarted.push.notify(BOT, "card", CARD);
  await settle();
  expect(restarted.calls).toEqual([]);

  restarted.push.notify(BOT, "reminder", CARD);
  restarted.push.notify(BOT, "reminder", CARD);
  await settle();
  expect(restarted.calls.map((c) => c.init.body)).toEqual(["Claudio Bot is still waiting for you"]);
});

test("only message pushes throttle message pushes; cards and reminders are never throttled and throttle nothing", async () => {
  const h = harness();
  const pushedAt = (minutes: number, reason: PushReason, id: MessageId) => {
    h.clock.t = T0 + minutes * 60_000;
    const before = h.calls.length;
    h.push.notify(BOT, reason, id);
    return settle().then(() => h.calls.length > before);
  };
  expect(await pushedAt(0, "message", h.bubble("m_b1"))).toBe(true);
  expect(await pushedAt(5, "message", h.bubble("m_b2"))).toBe(false);
  expect(await pushedAt(6, "card", CARD)).toBe(true);
  expect(await pushedAt(7, "reminder", CARD)).toBe(true);
  expect(await pushedAt(12, "message", h.bubble("m_b3"))).toBe(true);
  expect(await pushedAt(12 + MESSAGE_THROTTLE_MS / 60_000 - 1, "message", h.bubble("m_b4"))).toBe(false);
  expect(keys(h.world)).toEqual(["m_b1|message", "m_card|card", "m_card|reminder", "m_b3|message"]);
});

test("a turn's result push is never throttled and throttles no message push", async () => {
  const h = harness();
  const pushedAt = (minutes: number, reason: PushReason, id: MessageId) => {
    h.clock.t = T0 + minutes * 60_000;
    const before = h.calls.length;
    h.push.notify(BOT, reason, id);
    return settle().then(() => h.calls.length > before);
  };
  expect(await pushedAt(0, "message", h.bubble("m_b1"))).toBe(true);
  expect(await pushedAt(1, "result", h.bubble("m_b2"))).toBe(true);
  expect(await pushedAt(2, "result", h.bubble("m_b3"))).toBe(true);
  expect(await pushedAt(10, "message", h.bubble("m_b4"))).toBe(true);
  expect(h.calls.map((c) => c.init.body)).toEqual(Array(4).fill("Claudio Bot has an update for you"));
});

test("the throttle survives a restart", async () => {
  const first = harness();
  first.push.notify(BOT, "message", first.bubble("m_b1"));
  await settle();

  const restarted = harness({ home: first.home });
  restarted.clock.t = T0 + 60_000;
  restarted.push.notify(BOT, "message", restarted.bubble("m_b2"));
  await settle();
  expect(restarted.calls).toEqual([]);
});

test("the throttle is per bot", async () => {
  const h = harness();
  h.push.notify(BOT, "message", h.bubble("m_b1"));
  const other = newBot({ id: "b_other" as BotId, name: "Other", avatar: { shape: "circle", color: "white" }, at: new Date(T0).toISOString() });
  h.world.bots.set(other.id, other);
  post(other, { kind: "bot", id: "m_o1" as MessageId, at: other.createdAt, text: "hi" });
  h.push.notify(other, "message", "m_o1" as MessageId);
  await settle();
  expect(h.calls.map((c) => c.init.body)).toEqual(["Claudio Bot has an update for you", "Other has an update for you"]);
});

test.each([
  ["a rejected request", () => Promise.reject(new Error("connection refused")), "connection refused"],
  ["a non-2xx response", () => Promise.resolve(new Response("nope", { status: 503 })), "HTTP 503"],
] as [string, () => Promise<Response>, string][])("%s is logged, recorded and never retried", async (_, respond, reason) => {
  const h = harness({ respond });
  h.push.notify(BOT, "card", CARD);
  await settle();
  h.push.notify(BOT, "card", CARD);
  await settle();
  expect(h.calls).toHaveLength(1);
  expect(keys(h.world)).toEqual(["m_card|card"]);
  expect(h.logs).toEqual([`push: card for b_claudio failed: ${reason}`]);
});

test("a sender that throws synchronously never reaches the caller", async () => {
  const h = harness();
  const logs: string[] = [];
  const throwing: Sender = () => {
    throw new Error("boom");
  };
  const push = createPush({ world: h.world, persist: () => {}, sender: throwing, liveUntil: () => null, now: () => new Date(T0), log: (l) => logs.push(l) });
  expect(() => push.notify(BOT, "card", CARD)).not.toThrow();
  await settle();
  expect(logs).toEqual(["push: card for b_claudio failed: boom"]);
});

test("push is off when the URL is unset, blank or not http(s)", async () => {
  const logs: string[] = [];
  const fetchCalls: unknown[] = [];
  const fakeFetch = (async (...a: unknown[]) => (fetchCalls.push(a), new Response("ok"))) as unknown as typeof fetch;
  expect(senderFromEnv(undefined, (l) => logs.push(l), fakeFetch)).toBeNull();
  expect(senderFromEnv("  ", (l) => logs.push(l), fakeFetch)).toBeNull();
  expect(logs).toEqual([]);
  expect(senderFromEnv("ntfy.sh/topic", (l) => logs.push(l), fakeFetch)).toBeNull();
  expect(senderFromEnv("file:///etc/passwd", (l) => logs.push(l), fakeFetch)).toBeNull();
  expect(logs).toHaveLength(2);

  const h = harness();
  const persisted: unknown[] = [];
  const off = createPush({ world: h.world, persist: (u) => persisted.push(u), sender: null, liveUntil: () => null, now: () => new Date(T0), log: (l) => logs.push(l) });
  expect(() => off.notify(BOT, "card", CARD)).not.toThrow();
  await settle();
  expect(fetchCalls).toEqual([]);
  expect(persisted).toEqual([]);
  expect(keys(h.world)).toEqual([]);
});

test("a set URL sends to that URL", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => (urls.push(url), new Response("ok"))) as unknown as typeof fetch;
  const sender = senderFromEnv(` ${URL_} `, () => {}, fakeFetch);
  await sender!({ botId: BOT.id, messageId: CARD, text: "Claudio Bot needs you", link: "claudiobot://bot/b_claudio?message=m_card" });
  expect(urls).toEqual([URL_]);
});

test("records older than the retention window are pruned on the next push", async () => {
  const h = harness();
  h.push.notify(BOT, "card", CARD);
  h.clock.t = T0 + 8 * 24 * 3_600_000;
  h.push.notify(BOT, "message", h.bubble("m_late"));
  await settle();
  expect(keys(h.world)).toEqual(["m_late|message"]);
});

test.each([
  ["a 5 KB name with newlines and control characters", "Evil\n\n  Bot\u0000\u001b[31m\r\n" + "x".repeat(5_000), "Evil Bot[31m " + "x".repeat(26) + "\u2026"],
  ["a 40-character name", "y".repeat(40), "y".repeat(40)],
  ["a 41-character name", "y".repeat(41), "y".repeat(39) + "\u2026"],
])("%s is cleaned and capped at 40 characters before it leaves", async (_, name, shown) => {
  const h = harness();
  h.push.notify({ id: BOT.id, name }, "card", CARD);
  await settle();
  expect(h.calls.map((c) => c.init.body)).toEqual([`${shown} needs you`]);
});

test("a failed flush skips the send and never reaches the caller", async () => {
  const h = harness();
  const logs: string[] = [];
  const sent: unknown[] = [];
  const persist = () => {
    throw new Error("ENOSPC: no space left on device");
  };
  const push = createPush({ world: h.world, persist, sender: async (n) => void sent.push(n), liveUntil: () => null, now: () => new Date(T0), log: (l) => logs.push(l) });
  expect(() => push.notify(BOT, "card", CARD)).not.toThrow();
  await settle();
  expect(sent).toEqual([]);
  expect(logs).toEqual(["push: card for b_claudio skipped, could not record it: ENOSPC: no space left on device"]);
});

test("a record stamped after now does not throttle, so a clock set back still pushes", async () => {
  const h = harness();
  const pushedAt = (minutes: number, id: MessageId) => {
    h.clock.t = T0 + minutes * 60_000;
    const before = h.calls.length;
    h.push.notify(BOT, "message", id);
    return settle().then(() => h.calls.length > before);
  };
  expect(await pushedAt(0, h.bubble("m_b1"))).toBe(true);
  expect(await pushedAt(-60, h.bubble("m_b2"))).toBe(true);
  expect(await pushedAt(-55, h.bubble("m_b3"))).toBe(false);
});

test("an unparseable record does not hide a recent push from the throttle", async () => {
  const h = harness();
  const b0 = h.bubble("m_b0");
  const b1 = h.bubble("m_b1");
  (h.world.push as PushState).sent.push({ key: `${b0}|message`, at: "not a date" }, { key: `${b1}|message`, at: new Date(T0).toISOString() });
  h.clock.t = T0 + 60_000;
  h.push.notify(BOT, "message", h.bubble("m_b2"));
  await settle();
  expect(h.calls).toEqual([]);
});

test("a muted bot pushes no message or result, and still pushes its card and reminder", async () => {
  const h = harness();
  h.world.bots.get(BOT.id)!.muted = true;
  expect(h.push.notify(BOT, "message", h.bubble("m_first"))).toBe(false);
  expect(h.push.notify(BOT, "result", h.bubble("m_last"))).toBe(false);
  expect(h.push.notify(BOT, "card", CARD)).toBe(true);
  expect(h.push.notify(BOT, "reminder", CARD)).toBe(true);
  await settle();
  expect(h.calls.map((c) => c.init.body)).toEqual(["Claudio Bot needs you", "Claudio Bot is still waiting for you"]);
  expect(keys(h.world)).toEqual(["m_card|card", "m_card|reminder"]);
});

test("a muted message records nothing, so the first message after unmuting still pushes", async () => {
  const h = harness();
  h.world.bots.get(BOT.id)!.muted = true;
  h.push.notify(BOT, "message", h.bubble("m_first"));
  h.world.bots.get(BOT.id)!.muted = false;
  expect(h.push.notify(BOT, "message", h.bubble("m_second"))).toBe(true);
});

/** A bridge restarted with CARD open in state.json, its card push never sent: a live phone held it back before. */
function restartWithOpenCard() {
  const before = harness();
  openCard(before.world);
  createSaver(before.world, before.home).flush();
  return harness({ home: before.home });
}

test("a card open at start waits out the grace window, then pushes when no phone came back", async () => {
  const restarted = restartWithOpenCard();
  restarted.push.tick(new Date(T0));
  restarted.push.notify(BOT, "reminder", CARD);
  await settle();
  expect(restarted.calls).toEqual([]);
  expect(restarted.push.nextDeadline()).toBe(new Date(T0 + START_GRACE_MS).toISOString());

  restarted.clock.t = T0 + START_GRACE_MS;
  restarted.push.tick(new Date(restarted.clock.t));
  restarted.push.tick(new Date(restarted.clock.t));
  await settle();
  expect(restarted.calls.map((c) => c.init.body).sort()).toEqual(["Claudio Bot is still waiting for you", "Claudio Bot needs you"]);
  expect(restarted.push.nextDeadline()).toBeNull();
});

test("a phone that reconnects within the grace window gets no push for the cards open at start", async () => {
  const restarted = restartWithOpenCard();
  restarted.push.tick(new Date(T0));
  restarted.push.notify(BOT, "reminder", CARD);

  // Reconnected at 5 s and pinging every 20 s, so last heard from at 45 s.
  restarted.sockets.until = new Date(T0 + 45_000 + 45_000);
  restarted.clock.t = T0 + START_GRACE_MS;
  restarted.push.tick(new Date(restarted.clock.t));
  await settle();
  expect(restarted.calls).toEqual([]);
  expect(keys(restarted.world)).toEqual([]);
});

test("a reminder deferred at start is dropped when its card closes inside the grace window", async () => {
  const restarted = restartWithOpenCard();
  restarted.push.notify(BOT, "reminder", CARD);
  (restarted.world.gate as GateState).open.splice(0);
  restarted.clock.t = T0 + START_GRACE_MS;
  restarted.push.tick(new Date(restarted.clock.t));
  await settle();
  expect(restarted.calls).toEqual([]);
});

test("the grace window never delays a card opened after start", async () => {
  const h = harness();
  openCard(h.world, "m_new" as MessageId);
  expect(h.push.notify(BOT, "card", "m_new" as MessageId)).toBe(true);
  await settle();
  expect(h.calls.map((c) => c.init.body)).toEqual(["Claudio Bot needs you"]);
});
