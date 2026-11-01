import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotId, MessageId, SessionId, Signal } from "../src/protocol";
import { createPush, MESSAGE_THROTTLE_MS, ntfySender, OWED_RETRY_MS, PollForbidden, PROBE_MS, PushFailure, senderFromEnv, START_GRACE_MS, type PushReason, type Sender } from "../src/push";
import { createSaver, loadWorld } from "../src/store";
import { botActor, emptySession, newBot, own, post, type GateState, type OwnCard, type PushState, type World } from "../src/world";

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

/**
 * liveFor: a socket was heard from just now and stays live this many ms; 0: none is live. respond: the server's answer
 * to a push; takes: whether it published one it failed to answer (it did not answer in time). The server's poll of its
 * cache answers from what it published, or with poll's answer.
 */
function harness(opts: { home?: string; start?: number; liveFor?: number; off?: boolean; respond?: () => Promise<Response>; takes?: () => boolean; hang?: boolean; poll?: () => Promise<Response>; noSid?: boolean } = {}) {
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
  const polls: string[] = [];
  const onDisk: string[][] = [];
  const clock = { t: opts.start ?? T0 };
  const published: { time: number; message: string; click: string; sequence_id?: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    if (init.method !== "POST") {
      polls.push(url);
      if (opts.poll) return opts.poll();
      const since = Number(new URL(url).searchParams.get("since"));
      const lines = published.filter((m) => m.time >= since).map((m) => JSON.stringify({ event: "message", ...m }));
      return new Response(lines.join("\n"));
    }
    calls.push({ url, init });
    onDisk.push(diskKeys(home));
    const headers = init.headers as Record<string, string>;
    const publish = () => published.push({ time: Math.floor(clock.t / 1000), message: String(init.body), click: headers.Click!, ...(!opts.noSid && { sequence_id: headers["X-Sequence-ID"] }) });
    if (opts.hang) return publish(), new Promise<Response>(() => {});
    try {
      const res = await (opts.respond ? opts.respond() : Promise.resolve(new Response("ok")));
      if (res.ok) publish();
      return res;
    } catch (e) {
      if (opts.takes?.()) publish();
      throw e;
    }
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const signals: Signal[] = [];
  /** until: when the live sockets go quiet. open: the open sockets' ids. readAt: when each was last heard from, attended. */
  const sockets: { until: Date | null; open: number[]; readAt: Map<number, number>; hear(t: number): void } = {
    until: opts.liveFor ? new Date(T0 + opts.liveFor) : null,
    open: [1],
    readAt: new Map(),
    /** Every open socket was heard from, attended, at t. */
    hear(t) {
      for (const id of sockets.open) sockets.readAt.set(id, t);
    },
  };
  const waits: number[] = [];
  const pokes = { n: 0 };
  const push = createPush({
    world,
    persist: saver.schedule,
    sender: opts.off ? null : ntfySender(URL_, fakeFetch),
    liveUntil: () => sockets.until,
    sockets: {
      alert: (m, only) => (signals.push(m), sockets.open.filter((id) => only === undefined || only.includes(id))),
      heard: (ids, since) => ids.some((id) => (sockets.readAt.get(id) ?? 0) > since),
      open: () => [...sockets.open],
      lookedAt: () => Math.max(0, ...sockets.readAt.values()),
    },
    signal: (m) => signals.push(m),
    title: () => "Fix the fade",
    now: () => new Date(clock.t),
    log: (l) => logs.push(l),
    wait: async (ms) => void waits.push(ms),
    poke: () => void pokes.n++,
  });
  const bubble = (id: string) => {
    post(world.bots.get(BOT.id)!, { kind: "bot", id: id as MessageId, at: new Date(clock.t).toISOString(), text: SECRET_CHAT });
    return id as MessageId;
  };
  return { home, world, push, calls, polls, published, onDisk, logs, clock, sockets, bubble, signals, waits, pokes };
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
  const unsaved = createPush({ world, persist: () => { throw new Error("disk full"); }, sender: { send: async () => {}, taken: async () => [] }, liveUntil: () => null, now: () => new Date(T0), log: () => {} });
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
  expect(init.headers).toEqual({ Title: "ClaudioBot", Click: "claudiobot://bot/b_claudio?message=m_card", Priority: "high", "X-Sequence-ID": expect.stringMatching(/^cb[0-9a-f]{32}$/) });
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

const drain = async () => {
  for (let i = 0; i < 20; i++) await settle();
};

test.each([
  ["a refused connection", () => Promise.reject(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" })), "Could not reach the push server"],
  ["a non-2xx response", () => Promise.resolve(new Response("nope", { status: 500 })), "The push server answered 500"],
  ["a 503 from a proxy that did not reach the server", () => Promise.resolve(new Response("nope", { status: 503 })), "The push server answered 503"],
] as [string, () => Promise<Response>, string][])("%s is tried three times, then the push state reads failing, without the URL", async (_, respond, error) => {
  const h = harness({ respond });
  openCard(h.world);
  expect(h.push.state!()).toEqual({ state: "on" });
  h.push.notify(BOT, "card", CARD);
  await drain();
  h.push.notify(BOT, "card", CARD);
  await drain();
  expect(h.calls).toHaveLength(3);
  expect(h.waits).toEqual([2_000, 8_000]);
  expect(keys(h.world)).toEqual(["m_card|card"]);
  expect(h.push.state!()).toEqual({ state: "failing", error, at: new Date(T0).toISOString() });
  expect(h.signals).toEqual([{ type: "push_state", push: { state: "failing", error, at: new Date(T0).toISOString() } }]);
  expect(h.logs).toEqual([`push: card for b_claudio failed after 3 tries: ${error}`]);
});

test("a send that gets through on its second try, or after a failing one, puts the state back to on", async () => {
  let fails = 1;
  const h = harness({ respond: async () => (fails-- > 0 ? new Response("", { status: 500 }) : new Response("ok")) });
  openCard(h.world);
  h.push.notify(BOT, "card", CARD);
  await drain();
  expect([h.calls.length, h.push.state!()]).toEqual([2, { state: "on" }]);
  expect(h.signals).toEqual([]);

  fails = 3;
  h.push.notify(BOT, "reminder", CARD);
  await drain();
  expect(h.push.state!().state).toBe("failing");
  h.push.notify(BOT, "message", h.bubble("m_b"));
  await drain();
  expect(h.signals.map((s) => (s.type === "push_state" ? s.push.state : s.type))).toEqual(["failing", "on"]);
});

test("push with no URL reads off", () => {
  const { world } = harness();
  expect(createPush({ world, persist: () => {}, sender: null, liveUntil: () => null, now: () => new Date(T0), log: () => {} }).state!()).toEqual({ state: "off" });
});

test("a sender that throws synchronously never reaches the caller", async () => {
  const h = harness();
  const logs: string[] = [];
  const throwing: Sender = {
    send: () => {
      throw new Error("boom");
    },
    taken: async () => [],
  };
  const push = createPush({ world: h.world, persist: () => {}, sender: throwing, liveUntil: () => null, now: () => new Date(T0), log: (l) => logs.push(l), wait: async () => {} });
  expect(() => push.notify(BOT, "card", CARD)).not.toThrow();
  await drain();
  expect(logs).toEqual(["push: card for b_claudio may not have gone out: boom"]);
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
  await sender!.send({ botId: BOT.id, text: "Claudio Bot needs you", link: "claudiobot://bot/b_claudio?message=m_card", high: true, sid: "cb0" });
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
  const push = createPush({ world: h.world, persist, sender: { send: async (n) => void sent.push(n), taken: async () => [] }, liveUntil: () => null, now: () => new Date(T0), log: (l) => logs.push(l) });
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

const SID = "6b1f3c2a-8d4e-4f7a-9c1b-2e5d7a9f0c31" as SessionId;
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

function permission(id: string, at: number): OwnCard {
  const card = { kind: "permission" as const, id: id as MessageId, at: iso(at), from: null, tool: "Bash", label: SECRET_COMMAND, detail: SECRET_COMMAND, always: "", answer: null, expiresAt: iso(at + 2 * HOUR) };
  return { kind: "permission", card, toolUseId: `toolu_${id}`, suggestions: [] };
}
const question = (id: string, at: number): OwnCard => ({ kind: "ask", cardId: id as MessageId, toolUseId: `toolu_${id}`, at: iso(at), expiresAt: iso(at + 2 * HOUR), questions: [], answers: null });

function drive(h: ReturnType<typeof harness>, cards: OwnCard[]) {
  h.world.sessions.set(SID, { id: SID, hidden: false, visitedAt: null, own: { cwd: "/x", created: true, at: iso(T0), model: null, mode: null, session: emptySession(SID), cards } });
  return cards;
}
const answer = (c: OwnCard) => {
  if (c.kind === "permission") c.card = { ...c.card, answer: "once" };
};
const sent = (h: ReturnType<typeof harness>) => h.calls.map((c) => [c.init.body, (c.init.headers as Record<string, string>).Click, (c.init.headers as Record<string, string>).Priority ?? "default"]);
const at = (h: ReturnType<typeof harness>, t: number) => {
  h.clock.t = t;
  h.push.tick(new Date(t));
};

test("a session's cards that open within 2 s of the one before share one high-priority push that counts them and names nothing", async () => {
  const h = harness();
  drive(h, [permission("m_a", T0), permission("m_b", T0 + 3), permission("m_c", T0 + 1_500)]);
  expect(h.push.nextDeadline()).toBe(iso(T0 + 3_500));
  at(h, T0 + 3_499);
  at(h, T0 + 3_500);
  at(h, T0 + 3_501);
  await settle();
  expect(sent(h)).toEqual([["A Claude Code session needs 3 approvals", `claudiobot://session/${SID}?card=m_a`, "high"]]);
  expect(keys(h.world)).toEqual(["m_a|card", "m_b|card", "m_c|card"]);
  expect(JSON.stringify(h.calls)).not.toContain("git push");
});

test("a burst of cards that keeps growing still pushes 6 s after its first card", async () => {
  const h = harness();
  const cards = drive(h, [permission("m_0", T0)]);
  for (let i = 1; i <= 4; i++) cards.push(permission(`m_${i}`, T0 + i * 1_500));
  expect(h.push.nextDeadline()).toBe(iso(T0 + 6_000));
  at(h, T0 + 6_000);
  await settle();
  expect(sent(h).map((s) => s[0])).toEqual(["A Claude Code session needs 5 approvals"]);
});

test("a retry is dropped once its card was answered, or once a phone came back", async () => {
  const h = harness();
  const [card] = drive(h, [permission("m_a", T0)]);
  const tries: string[] = [];
  const logs: string[] = [];
  const failing: Sender = {
    send: async (n) => {
      tries.push(n.text);
      throw new PushFailure("The push server answered 503", false);
    },
    taken: async () => [],
  };
  const phone = { until: null as Date | null };
  const push = (wait: () => void) =>
    createPush({ world: h.world, persist: () => {}, sender: failing, liveUntil: () => phone.until, now: () => new Date(T0 + 2_000), log: (l) => logs.push(l), wait: async () => wait() });

  const answered = push(() => answer(card!));
  answered.tick(new Date(T0 + 2_000));
  await drain();
  const back = push(() => void (phone.until = new Date(T0 + 60_000)));
  back.sessionEnded!(SID, "finished", iso(T0));
  await drain();
  expect(tries).toEqual(["A Claude Code session needs your approval", "A Claude Code session finished"]);
  expect([answered.state!(), back.state!(), logs]).toEqual([{ state: "on" }, { state: "on" }, []]);
});

test("a later card waits while the last push's cards are open, and goes in 2 s once they are answered", async () => {
  const h = harness();
  const [first] = drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  h.world.sessions.get(SID)!.own!.cards.push(permission("m_b", T0 + 60_000));
  at(h, T0 + 62_000);
  expect(h.push.nextDeadline()).toBe(iso(T0 + 2_000 + MESSAGE_THROTTLE_MS));
  answer(first!);
  at(h, T0 + 62_001);
  await settle();
  expect(sent(h).map((s) => s[0])).toEqual(["A Claude Code session needs your approval", "A Claude Code session needs your approval"]);
  expect(sent(h)[1]![1]).toBe(`claudiobot://session/${SID}?card=m_b`);
});

test("a question reads as one, and mixed cards read as requests", async () => {
  const h = harness();
  drive(h, [question("m_q", T0)]);
  at(h, T0 + 2_000);
  const other = harness();
  drive(other, [question("m_q", T0), permission("m_p", T0)]);
  at(other, T0 + 2_000);
  await settle();
  expect([sent(h)[0]![0], sent(other)[0]![0]]).toEqual(["A Claude Code session has a question for you", "A Claude Code session needs you: 2 requests"]);
});

test("while a phone is live, cards become one session alert; still open when it goes quiet, they push", async () => {
  const h = harness({ liveFor: 45_000 });
  drive(h, [permission("m_a", T0), permission("m_b", T0 + 10)]);
  at(h, T0 + 2_010);
  at(h, T0 + 3_000);
  expect(h.signals).toEqual([{ type: "session_alert", sessionId: SID, reason: "card", count: 2, title: "Fix the fade", cardId: "m_a" as MessageId, cardKind: "permission" }]);
  expect(h.push.nextDeadline()).toBe(iso(T0 + 45_000));
  h.sockets.until = null;
  h.sockets.hear(T0 + 20_000);
  at(h, T0 + 46_000);
  await settle();
  expect(sent(h).map((s) => s[0])).toEqual(["A Claude Code session needs 2 approvals"]);
});

test("cards answered while the phone was live never push", async () => {
  const h = harness({ liveFor: 45_000 });
  const cards = drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  cards.forEach(answer);
  h.sockets.until = null;
  at(h, T0 + 46_000);
  await settle();
  expect([h.calls.length, h.signals.length]).toEqual([0, 1]);
  expect(h.push.nextDeadline()).toBeNull();
});

test("a card's reminder pushes once at half its time", async () => {
  const h = harness();
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  expect(h.push.nextDeadline()).toBe(iso(T0 + HOUR));
  at(h, T0 + HOUR - 1);
  at(h, T0 + HOUR);
  at(h, T0 + HOUR + 1);
  await settle();
  expect(sent(h)).toEqual([
    ["A Claude Code session needs your approval", `claudiobot://session/${SID}?card=m_a`, "high"],
    ["A Claude Code session is still waiting for your approval", `claudiobot://session/${SID}?card=m_a`, "high"],
  ]);
  expect(h.push.nextDeadline()).toBeNull();
});

test("a reminder the app showed is not pushed when the phone goes quiet after it was seen", async () => {
  const h = harness({ liveFor: 2 * HOUR });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + HOUR);
  expect(h.signals.map((s) => s.type === "session_alert" && s.reason)).toEqual(["card", "reminder"]);
  h.sockets.hear(T0 + HOUR + 5_000);
  h.sockets.until = null;
  at(h, T0 + HOUR + 60_000);
  await settle();
  expect(sent(h).map((s) => s[0])).toEqual(["A Claude Code session needs your approval"]);
  expect(keys(h.world)).toContain("m_a|reminder");
});

test("a session's run that ended pushes once per ending, at default priority, to the session", async () => {
  const h = harness();
  h.push.sessionEnded!(SID, "finished", iso(T0));
  h.push.sessionEnded!(SID, "finished", iso(T0));
  h.push.sessionEnded!(SID, "failed", iso(T0 + 60_000));
  await settle();
  expect(sent(h)).toEqual([
    ["A Claude Code session finished", `claudiobot://session/${SID}`, "default"],
    ["A Claude Code session stopped with an error", `claudiobot://session/${SID}`, "default"],
  ]);
  expect(keys(h.world)).toEqual([`${SID}|${iso(T0)}|done`, `${SID}|${iso(T0 + 60_000)}|done`]);
});

test("an ending held for a live phone is an alert; it pushes when the phone goes quiet only if nobody was heard since", async () => {
  const seen = harness({ liveFor: 45_000 });
  seen.push.sessionEnded!(SID, "finished", iso(T0));
  expect(seen.signals).toEqual([{ type: "session_alert", sessionId: SID, reason: "finished", count: 1, title: "Fix the fade", cardId: null, cardKind: null }]);
  seen.sockets.hear(T0 + 1_000);
  seen.sockets.until = null;
  at(seen, T0 + 46_000);

  const gone = harness({ liveFor: 45_000 });
  gone.push.sessionEnded!(SID, "finished", iso(T0));
  gone.sockets.hear(T0 - 1_000);
  gone.sockets.until = null;
  at(gone, T0 + 46_000);
  at(gone, T0 + 47_000);
  await settle();
  expect([sent(seen), sent(gone)]).toEqual([[], [["A Claude Code session finished", `claudiobot://session/${SID}`, "default"]]]);
});

test("with push off a session's events are alerts only, each once", async () => {
  const h = harness();
  const signals: Signal[] = [];
  const sockets = { alert: (m: Signal) => (signals.push(m), [1]), heard: () => false, open: () => [1] };
  const off = createPush({ world: h.world, persist: () => {}, sender: null, liveUntil: () => null, sockets, now: () => new Date(h.clock.t), log: () => {} });
  drive(h, [permission("m_a", T0)]);
  off.tick(new Date(T0 + 2_000));
  off.tick(new Date(T0 + 3_000));
  off.sessionEnded!(SID, "failed", iso(T0));
  off.sessionEnded!(SID, "failed", iso(T0));
  expect(signals.map((s) => s.type === "session_alert" && [s.reason, s.title])).toEqual([
    ["card", "Claude Code session"],
    ["failed", "Claude Code session"],
  ]);
  h.clock.t = T0 + 3_000;
  expect(off.nextDeadline()).toBe(iso(T0 + HOUR));
});

test("a run a restart cut off waits out the start grace, then pushes once in plain words; another restart never repeats it", async () => {
  const h = harness();
  h.push.sessionEnded!(SID, "lost", iso(T0));
  await settle();
  expect([h.calls.length, h.push.nextDeadline()]).toEqual([0, iso(T0 + START_GRACE_MS)]);
  at(h, T0 + START_GRACE_MS);
  await settle();
  expect(sent(h)).toEqual([["A Claude Code session was interrupted by a bridge restart", `claudiobot://session/${SID}`, "default"]]);
  const again = harness({ home: h.home });
  again.push.sessionEnded!(SID, "lost", iso(T0));
  at(again, T0 + START_GRACE_MS);
  await settle();
  expect(again.calls).toEqual([]);
});

/** The session's Claude Code died at T0 and left these commands running, which only the bridge follows now. */
function survived(h: ReturnType<typeof harness>, end: "failed" | "lost", commands: string[], over: string[] = [], at = T0) {
  drive(h, []);
  const own = h.world.sessions.get(SID)!.own!;
  own.outcome = { kind: end, text: "Claude Code stopped unexpectedly (terminated by signal SIGKILL)", at: iso(at) };
  own.outlived = [...commands.map((id) => ({ id, group: 4242, foreground: true as const })), ...over.map((id) => ({ id, group: 4243, over: "ended" as const }))];
}

test("a death that left commands running is pushed with how many still run, and nothing of what they are", async () => {
  const h = harness();
  survived(h, "failed", ["perl-a", "perl-b"], ["gone"]);
  h.push.sessionEnded!(SID, "failed", iso(T0));
  await settle();
  expect(sent(h)).toEqual([["A Claude Code session stopped with an error. 2 commands still run on your Mac.", `claudiobot://session/${SID}`, "default"]]);
});

test("the alert for a death or a restart counts the work that still runs; a finished one never does", async () => {
  const h = harness();
  survived(h, "lost", ["perl-a"]);
  h.sockets.until = new Date(T0 + 120_000);
  h.push.sessionEnded!(SID, "lost", iso(T0));
  at(h, T0 + 1_000);
  survived(h, "failed", ["perl-a", "perl-b"], [], T0 + 1_000);
  h.push.sessionEnded!(SID, "failed", iso(T0 + 1_000));
  expect(h.signals.map((f) => f.type === "session_alert" && [f.reason, f.running ?? null])).toEqual([
    ["lost", { agents: 0, commands: 1 }],
    ["failed", { agents: 0, commands: 2 }],
  ]);
  const done = harness();
  survived(done, "failed", ["perl-a"]);
  done.sockets.until = new Date(T0 + 120_000);
  done.push.sessionEnded!(SID, "finished", iso(T0 + 5_000));
  expect(done.signals.map((f) => f.type === "session_alert" && [f.reason, f.running ?? null])).toEqual([["finished", null]]);
});

test("a run a restart cut off keeps the grace it started with: a second restart does not start it over", async () => {
  const h = harness();
  h.push.sessionEnded!(SID, "lost", iso(T0));
  at(h, T0 + 50_000);
  const again = harness({ home: h.home, start: T0 + 50_000 });
  expect(again.push.nextDeadline()).toBe(iso(T0 + START_GRACE_MS));
  at(again, T0 + START_GRACE_MS);
  await settle();
  expect(sent(again).map((c) => c[0])).toEqual(["A Claude Code session was interrupted by a bridge restart"]);
});

test("a phone back within the start grace hears of a run a restart cut off as an alert, and no push follows once it was seen", async () => {
  const h = harness();
  h.push.sessionEnded!(SID, "lost", iso(T0));
  h.sockets.until = new Date(T0 + 120_000);
  at(h, T0 + START_GRACE_MS);
  expect(h.signals).toEqual([{ type: "session_alert", sessionId: SID, reason: "lost", count: 1, title: "Fix the fade", cardId: null, cardKind: null }]);
  h.sockets.hear(T0 + START_GRACE_MS + 1_000);
  h.sockets.until = null;
  at(h, T0 + 130_000);
  await settle();
  expect(h.calls).toEqual([]);
});

test("an ending the app was told of and a phone was heard from after is never pushed, also after a restart", async () => {
  const h = harness({ liveFor: 45_000 });
  h.push.sessionEnded!(SID, "finished", iso(T0));
  h.sockets.hear(T0 + 20_000);
  at(h, T0 + 20_000);
  const after = harness({ home: h.home });
  at(after, T0 + START_GRACE_MS + 1);
  await settle();
  expect([h.calls, after.calls, after.world.push.held]).toEqual([[], [], []]);
});

test("unreadable endings on disk are dropped, and a readable one is still owed", async () => {
  const h = harness();
  own<PushState>(h.world.push).held = [{ key: "x" } as never, { key: `${SID}|${iso(T0)}|done`, id: SID, end: "failed", at: iso(T0), alerted: false }];
  const bodies: unknown[] = [];
  const sender = ntfySender(URL_, (async (_: string, init: RequestInit) => (bodies.push(init.body), new Response("ok"))) as unknown as typeof fetch);
  const restarted = createPush({ world: h.world, persist: () => {}, sender, liveUntil: () => null, now: () => new Date(T0), log: () => {} });
  expect(h.world.push.held?.map((x) => x.end)).toEqual(["failed"]);
  restarted.tick(new Date(T0 + START_GRACE_MS));
  await settle();
  expect(bodies).toEqual(["A Claude Code session stopped with an error"]);
});

test("an ending held for a live phone outlives a restart, and pushes once the phone stays away past the start grace", async () => {
  const h = harness({ liveFor: 45_000 });
  h.push.sessionEnded!(SID, "finished", iso(T0));
  expect(h.signals.length).toBe(1);
  const after = harness({ home: h.home });
  after.clock.t = T0 + 10_000;
  expect(after.push.nextDeadline()).toBe(iso(T0 + START_GRACE_MS));
  at(after, T0 + 20_000);
  at(after, T0 + START_GRACE_MS);
  at(after, T0 + START_GRACE_MS + 1);
  await settle();
  expect([sent(h), sent(after)]).toEqual([[], [["A Claude Code session finished", `claudiobot://session/${SID}`, "default"]]]);
});

test("an alert names its cards' kind when every card is that kind, and none when they are mixed", () => {
  const asks = harness({ liveFor: 45_000 });
  drive(asks, [question("m_q", T0), question("m_r", T0)]);
  at(asks, T0 + 2_000);
  const mixed = harness({ liveFor: 45_000 });
  drive(mixed, [question("m_q", T0), permission("m_p", T0)]);
  at(mixed, T0 + 2_000);
  expect([...asks.signals, ...mixed.signals]).toEqual([
    { type: "session_alert", sessionId: SID, reason: "card", count: 2, title: "Fix the fade", cardId: "m_q" as MessageId, cardKind: "ask" },
    { type: "session_alert", sessionId: SID, reason: "card", count: 2, title: "Fix the fade", cardId: "m_q" as MessageId, cardKind: null },
  ]);
});

test("an alert that went to a socket that died unseen goes again to the socket open now, and is seen only once that one is heard from", async () => {
  const unheard = harness({ liveFor: 45_000 });
  unheard.push.sessionEnded!(SID, "finished", iso(T0));
  unheard.sockets.open = [2];
  unheard.clock.t = T0 + 5_000;
  expect(unheard.push.nextDeadline()).toBe(iso(T0 + 5_000));
  at(unheard, T0 + 5_000);
  at(unheard, T0 + 6_000);
  const alert: Signal = { type: "session_alert", sessionId: SID, reason: "finished", count: 1, title: "Fix the fade", cardId: null, cardKind: null };
  expect(unheard.signals).toEqual([alert, alert]);
  unheard.sockets.until = null;
  at(unheard, T0 + 46_000);

  const heard = harness({ liveFor: 45_000 });
  heard.push.sessionEnded!(SID, "finished", iso(T0));
  heard.sockets.open = [2];
  at(heard, T0 + 5_000);
  heard.sockets.hear(T0 + 6_000);
  heard.sockets.until = null;
  at(heard, T0 + 46_000);
  await settle();
  expect([sent(unheard), sent(heard), heard.world.push.held]).toEqual([[["A Claude Code session finished", `claudiobot://session/${SID}`, "default"]], [], []]);
});

test("an alert the socket that got it was heard from after is not sent again to a socket that opens later", () => {
  const h = harness({ liveFor: 45_000 });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  h.sockets.hear(T0 + 3_000);
  h.sockets.open = [2];
  at(h, T0 + 4_000);
  expect(h.signals.map((s) => s.type === "session_alert" && [s.reason, s.cardId as string])).toEqual([["card", "m_a"]]);
});

test("an alert goes at once to a socket that opens while the one it went to is still open but unheard, and only once", () => {
  const h = harness({ liveFor: 45_000 });
  h.push.sessionEnded!(SID, "finished", iso(T0));
  h.sockets.open = [1, 2];
  at(h, T0 + 1_000);
  at(h, T0 + 2_000);
  expect(h.signals.map((s) => s.type)).toEqual(["session_alert", "session_alert"]);
});

test("a card alert to a socket that died unseen goes again while the card is open, and not once it is answered", () => {
  const open = harness({ liveFor: 45_000 });
  drive(open, [permission("m_a", T0)]);
  at(open, T0 + 2_000);
  open.sockets.open = [2];
  at(open, T0 + 3_000);
  const answered = harness({ liveFor: 45_000 });
  const [card] = drive(answered, [permission("m_a", T0)]);
  at(answered, T0 + 2_000);
  answer(card!);
  answered.sockets.open = [2];
  at(answered, T0 + 3_000);
  expect([open.signals.length, answered.signals.length]).toEqual([2, 1]);
});

/** A push server that answers 500 while down, and publishes and answers 200 once back. */
function flaky(opts: Omit<Parameters<typeof harness>[0] & {}, "respond"> = {}) {
  const server = { down: true };
  const h = harness({ ...opts, respond: async () => (server.down ? new Response("", { status: 500 }) : new Response("ok")) });
  return Object.assign(h, { server });
}
const states = (h: ReturnType<typeof harness>) => h.signals.flatMap((s) => (s.type === "push_state" ? [s.push.state] : []));
const TIMEOUT = () => Promise.reject(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));

test("a card push whose tries all failed goes again once the server is back, before its reminder, and the state reads on", async () => {
  const h = flaky();
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  expect([h.calls.length, h.push.state!()]).toEqual([3, { state: "failing", error: "The push server answered 500", at: iso(T0 + 2_000) }]);
  expect([h.push.nextDeadline(), h.pokes.n]).toEqual([iso(T0 + 2_000 + OWED_RETRY_MS[0]), 1]);
  h.server.down = false;
  at(h, T0 + 17_000);
  await drain();
  at(h, T0 + 18_000);
  await drain();
  expect(sent(h).slice(3)).toEqual([["A Claude Code session needs your approval", `claudiobot://session/${SID}?card=m_a`, "high"]]);
  expect([h.push.state!(), states(h), h.world.push.owed]).toEqual([{ state: "on" }, ["failing", "on"], undefined]);
  at(h, T0 + HOUR);
  await drain();
  expect(sent(h).slice(4).map((c) => c[0])).toEqual(["A Claude Code session is still waiting for your approval"]);
});

test("an owed push goes again 15 s after the failure, then 30 s, 1, 2 and 5 minutes apart, as one try each", async () => {
  const h = flaky();
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  const tries: number[] = [];
  for (let i = 0; i < 6; i++) {
    const due = Date.parse(h.push.nextDeadline()!);
    tries.push(due - h.clock.t);
    at(h, due);
    await drain();
  }
  expect(tries).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
  expect(h.calls).toHaveLength(9);
  expect(h.push.state!()).toEqual({ state: "failing", error: "The push server answered 500", at: iso(h.clock.t) });
});

test("an owed push is dropped once its card is answered or someone looks, and is never sent then", async () => {
  for (const back of ["answered", "looked"] as const) {
    const h = flaky();
    const [card] = drive(h, [permission("m_a", T0)]);
    at(h, T0 + 2_000);
    await drain();
    h.server.down = false;
    if (back === "answered") answer(card!);
    else h.sockets.hear(T0 + 5_000);
    at(h, T0 + 17_000);
    await drain();
    expect([back, h.calls.length, h.world.push.owed]).toEqual([back, 3, undefined]);
  }
});

test("a live app nobody looks at delays an owed push until it is quiet, and never drops it", async () => {
  const h = flaky();
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  h.server.down = false;
  h.sockets.until = new Date(T0 + 60_000);
  at(h, T0 + 17_000);
  await drain();
  expect([h.calls.length, h.world.push.owed?.length, h.push.nextDeadline()]).toEqual([3, 1, iso(T0 + 60_000)]);
  h.sockets.until = null;
  at(h, T0 + 60_000);
  await drain();
  expect([h.calls.length, h.world.push.owed]).toEqual([4, undefined]);
});

test("a reminder speaks for its card, so a card push still owed is not sent as well", async () => {
  const h = flaky();
  const card = permission("m_a", T0);
  drive(h, [card.kind === "permission" ? { ...card, card: { ...card.card, expiresAt: iso(T0 + 60_000) } } : card]);
  at(h, T0 + 2_000);
  await drain();
  at(h, T0 + 30_000);
  await drain();
  h.server.down = false;
  at(h, T0 + 47_000);
  await drain();
  at(h, T0 + 48_000);
  await drain();
  const good = h.calls.slice(-1).map((c) => c.init.body);
  expect([h.calls.length, good, h.world.push.owed]).toEqual([7, ["A Claude Code session is still waiting for your approval"], undefined]);
});

test("with nothing owed, a failing state asks the server for its recent pushes, every minute, and reads on once it answers", async () => {
  let pollOk = false;
  const h = flaky({ poll: async () => (pollOk ? new Response("") : new Response("", { status: 502 })) });
  const [card] = drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  answer(card!);
  at(h, T0 + 17_000);
  await drain();
  expect([h.polls.length, h.push.state!(), h.push.nextDeadline()]).toEqual([1, { state: "failing", error: "The push server answered 502", at: iso(T0 + 17_000) }, iso(T0 + 17_000 + PROBE_MS)]);
  pollOk = true;
  at(h, T0 + 17_000 + PROBE_MS);
  await drain();
  expect([h.calls.length, h.polls.length, h.push.state!(), states(h)]).toEqual([3, 2, { state: "on" }, ["failing", "failing", "on"]]);
  expect(h.polls[1]).toBe(`${URL_}/json?poll=1&since=${Math.floor((T0 + 17_000 + PROBE_MS) / 1000)}`);
  expect(h.push.nextDeadline()).not.toBe(iso(T0 + 17_000 + 2 * PROBE_MS));
});

test("a restart keeps the failing state and the pushes owed: hello says failing, the first tick checks the server, and the owed push waits out the start grace", async () => {
  const a = flaky();
  a.push.notify(BOT, "message", a.bubble("m_b"));
  await drain();
  expect(a.push.state!().state).toBe("failing");
  const b = harness({ home: a.home });
  expect(b.push.state!()).toEqual({ state: "failing", error: "The push server answered 500", at: iso(T0) });
  expect(b.push.nextDeadline()).toBe(iso(T0));
  at(b, T0);
  await drain();
  expect([b.calls.length, b.polls.length, b.push.state!(), b.push.nextDeadline()]).toEqual([0, 1, { state: "on" }, iso(T0 + START_GRACE_MS)]);
  at(b, T0 + START_GRACE_MS);
  await drain();
  expect([b.calls.map((c) => c.init.body), b.world.push.owed, b.world.push.failing]).toEqual([["Claudio Bot has an update for you"], undefined, undefined]);
});

test("a push the server took but did not answer in time rings once: the bridge asks the server before it sends again", async () => {
  const h = harness({ respond: TIMEOUT, takes: () => true });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  expect([h.calls.length, h.push.state!()]).toEqual([1, { state: "failing", error: "The push server did not answer within 10 s", at: iso(T0 + 2_000) }]);
  at(h, T0 + 17_000);
  await drain();
  at(h, T0 + 18_000);
  await drain();
  expect([h.calls.length, h.polls, h.push.state!(), h.world.push.owed]).toEqual([1, [`${URL_}/json?poll=1&since=${Math.floor((T0 + 2_000 - 60_000) / 1000)}`], { state: "on" }, undefined]);
  expect(h.logs).toEqual([`push: card for session ${SID} may not have gone out: The push server did not answer within 10 s`, "push: m_a|card had gone out"]);
});

test("a push that timed out goes again once the server says it does not hold it, and not while it cannot say", async () => {
  let respond: () => Promise<Response> = TIMEOUT;
  let pollOk = false;
  const h = harness({ respond: () => respond(), poll: async () => (pollOk ? new Response(JSON.stringify({ event: "message", time: 0, message: "other", click: "x" })) : new Response("", { status: 503 })) });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  at(h, T0 + 17_000);
  await drain();
  expect([h.calls.length, h.polls.length, h.push.state!().state]).toEqual([1, 1, "failing"]);
  pollOk = true;
  respond = async () => new Response("ok");
  at(h, Date.parse(h.push.nextDeadline()!));
  await drain();
  expect([h.calls.length, h.polls.length, h.push.state!(), h.world.push.owed]).toEqual([2, 2, { state: "on" }, undefined]);
});

test("ntfy's transport: a refused connection is safe to send again, a timeout or a broken connection is not, and the poll reads the topic's cache", async () => {
  const fail = (e: object) => ntfySender(URL_, (async () => Promise.reject(Object.assign(new Error("x"), e))) as unknown as typeof fetch).send({ botId: null, text: "t", link: "l", high: false, sid: "cb0" });
  const outcome = async (e: object) => fail(e).catch((x: PushFailure) => [x.message, x.maybe]);
  expect(await outcome({ code: "ConnectionRefused" })).toEqual(["Could not reach the push server", false]);
  expect(await outcome({ name: "TimeoutError" })).toEqual(["The push server did not answer within 10 s", true]);
  expect(await outcome({ code: "ECONNRESET" })).toEqual(["The connection to the push server broke before it answered", true]);
  const answered = (status: number) =>
    ntfySender(URL_, (async () => new Response("", { status })) as unknown as typeof fetch)
      .send({ botId: null, text: "t", link: "l", high: false, sid: "cb0" })
      .catch((x: PushFailure) => x.maybe);
  expect(await Promise.all([500, 503, 429, 502, 504, 524].map(answered))).toEqual([false, false, false, true, true, true]);
  const forbidden = ntfySender(URL_, (async () => new Response("", { status: 403 })) as unknown as typeof fetch).taken(T0);
  expect(await forbidden.catch((x: Error) => x instanceof PollForbidden)).toBe(true);
  const urls: string[] = [];
  const body = [{ event: "open" }, { event: "message", time: 1, message: "A Claude Code session finished", click: "claudiobot://session/s", sequence_id: "cb1" }].map((m) => JSON.stringify(m)).join("\n");
  const poll = ntfySender(`${URL_}?auth=tok`, (async (url: string) => (urls.push(url), new Response(body))) as unknown as typeof fetch);
  expect(await poll.taken(T0 + 999)).toEqual([{ text: "A Claude Code session finished", link: "claudiobot://session/s", at: 1_000, sid: "cb1" }]);
  expect(urls).toEqual([`https://ntfy.example/claudio-topic/json?auth=tok&poll=1&since=${Math.floor(T0 / 1000)}`]);
});

const outcomeAt = (h: ReturnType<typeof harness>, t: number) => (h.world.sessions.get(SID)!.own!.outcome = { kind: "finished", text: "Finished", at: iso(t) });

test("an ending's alert stops going to newly opened sockets, and never pushes, once a newer run of the session began", async () => {
  const h = harness({ liveFor: 45_000 });
  drive(h, []);
  outcomeAt(h, T0);
  h.push.sessionEnded!(SID, "finished", iso(T0));
  h.sockets.open = [2];
  at(h, T0 + 1_000);
  delete h.world.sessions.get(SID)!.own!.outcome;
  h.sockets.open = [3];
  at(h, T0 + 2_000);
  h.sockets.until = null;
  at(h, T0 + 46_000);
  await drain();
  expect([h.signals.filter((s) => s.type === "session_alert").length, h.calls, h.world.push.held]).toEqual([2, [], []]);
});

test("with push off, an ending told while no socket was open goes to the next socket that opens, once, until it is seen", async () => {
  const h = harness({ off: true });
  drive(h, []);
  outcomeAt(h, T0);
  h.sockets.open = [];
  h.push.sessionEnded!(SID, "failed", iso(T0));
  at(h, T0 + 1_000);
  h.sockets.open = [4];
  at(h, T0 + 2_000);
  at(h, T0 + 3_000);
  h.sockets.hear(T0 + 3_500);
  at(h, T0 + 4_000);
  h.sockets.open = [5];
  at(h, T0 + 5_000);
  expect(h.signals.map((s) => s.type === "session_alert" && s.reason)).toEqual(["failed", "failed"]);
  expect([keys(h.world), h.world.push.held]).toEqual([[`${SID}|${iso(T0)}|done`], []]);
});

test("a bridge that dies while a try is out asks the server after the restart: one ring if it took the push, and the push if not", async () => {
  for (const took of [true, false]) {
    const a = harness({ hang: true });
    a.push.notify(BOT, "message", a.bubble("m_b"));
    await drain();
    if (!took) a.published.length = 0;
    expect(a.world.push.owed?.map((o) => [o.keys, o.unsure])).toEqual([[["m_b|message"], iso(T0)]]);
    const b = harness({ home: a.home });
    b.published.push(...a.published);
    at(b, T0 + START_GRACE_MS);
    await drain();
    expect([took, b.calls.map((c) => c.init.body), b.polls.length, b.world.push.owed]).toEqual([took, took ? [] : ["Claudio Bot has an update for you"], 1, undefined]);
  }
});

test("a failed probe does not stretch the backoff: a new push that fails is tried again 15 s later", async () => {
  const h = flaky({ poll: async () => new Response("", { status: 502 }) });
  const [card] = drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  answer(card!);
  for (const t of [17_000, 77_000, 137_000]) {
    at(h, T0 + t);
    await drain();
  }
  expect([h.polls.length, h.world.push.failing?.retries]).toEqual([3, 0]);
  h.world.sessions.get(SID)!.own!.cards.push(permission("m_b", T0 + 140_000));
  at(h, T0 + 142_000);
  await drain();
  expect([h.calls.length, h.push.nextDeadline()]).toEqual([6, iso(T0 + 142_000 + OWED_RETRY_MS[0])]);
});

test("a card answered while the server was asked about its timed-out push is not sent again", async () => {
  let card: OwnCard | undefined;
  const h = harness({ respond: TIMEOUT, poll: async () => (answer(card!), new Response("")) });
  [card] = drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  at(h, T0 + 17_000);
  await drain();
  expect([h.calls.length, h.polls.length, h.world.push.owed]).toEqual([1, 1, undefined]);
});

test("a bot card's reminder speaks for it, so its card push still owed is not sent as well", async () => {
  const h = flaky();
  openCard(h.world);
  h.push.notify(BOT, "card", CARD);
  await drain();
  h.server.down = false;
  h.push.notify(BOT, "reminder", CARD);
  await drain();
  at(h, T0 + 20_000);
  await drain();
  expect([h.calls.map((c) => c.init.body), h.world.push.owed]).toEqual([["Claudio Bot needs you", "Claudio Bot needs you", "Claudio Bot needs you", "Claudio Bot is still waiting for you"], undefined]);
});

test("unreadable owed pushes and push state on disk are dropped at start, and the bridge still starts", () => {
  const h = harness();
  const state = own<PushState>(h.world.push);
  const good = { keys: ["m_b|message"], botId: BOT.id, text: "Claudio Bot has an update for you", link: "claudiobot://bot/b_claudio?message=m_b", high: false, for: { kind: "bot" as const } };
  Object.assign(state, { failing: { error: 3 }, owed: [null, { ...good, keys: ["x|card"], for: { kind: "cards", session: SID } }, { ...good, keys: ["y|card"], for: { kind: "elsewhere" } }, good] });
  const push = createPush({ world: h.world, persist: () => {}, sender: { send: async () => {}, taken: async () => [] }, liveUntil: () => null, now: () => new Date(T0), log: () => {} });
  expect([push.state!(), h.world.push.failing, h.world.push.owed]).toEqual([{ state: "on" }, undefined, [good]]);
  createPush({ world: h.world, persist: () => {}, sender: null, liveUntil: () => null, now: () => new Date(T0), log: () => {} });
  expect(h.world.push.owed).toBeUndefined();
});

const REFUSED = () => Promise.reject(Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" }));
/** Ticks at `from`, then at each deadline the push module names, as the clock would, until `to`. */
const ticks = async (h: ReturnType<typeof harness>, from: number, to: number) => {
  for (let t = from; t < to; ) {
    at(h, t);
    await drain();
    const next = h.push.nextDeadline();
    t = next === null ? to : Math.max(Date.parse(next), t + 1_000);
  }
};

test("a bot's updates through a 6 h outage leave one owed push, sent once the server is back (REPRO-1)", async () => {
  const h = flaky();
  for (let t = T0, n = 0; t < T0 + 6 * HOUR; t += 11 * 60_000, n++) {
    at(h, t);
    h.push.notify(BOT, "message", h.bubble(`m_b${n}`));
    await drain();
  }
  expect(h.world.push.owed?.map((o) => o.keys)).toEqual([["m_b32|message"]]);
  const before = h.calls.length;
  h.server.down = false;
  await ticks(h, T0 + 6 * HOUR, T0 + 6 * HOUR + 10 * 60_000);
  expect(h.calls.slice(before).map((c) => c.init.body)).toEqual(["Claudio Bot has an update for you"]);
});

test("a phone that looked and left before the retry drops what was owed; one live but never looking only delays it (REPRO-2)", async () => {
  const live = flaky();
  live.push.notify(BOT, "message", live.bubble("m_b0"));
  await drain();
  live.sockets.until = new Date(T0 + 50_000);
  at(live, T0 + 5_000);
  live.sockets.until = null;
  live.server.down = false;
  await ticks(live, T0 + 51_000, T0 + 10 * 60_000);
  expect([live.calls.map((c) => c.init.body).slice(3), live.world.push.owed]).toEqual([["Claudio Bot has an update for you"], undefined]);

  const h = flaky();
  openCard(h.world);
  h.push.notify(BOT, "card", CARD);
  await drain();
  h.sockets.hear(T0 + 1_000);
  h.server.down = false;
  const before = h.calls.length;
  await ticks(h, T0 + 51_000, T0 + 10 * 60_000);
  expect([h.calls.length - before, h.world.push.owed]).toEqual([0, undefined]);
});

test("a write-only topic: a timed-out card push goes again after the backoff, and a probe keeps the real error (REPRO-3)", async () => {
  let respond: () => Promise<Response> = TIMEOUT;
  const h = harness({ respond: () => respond(), poll: async () => new Response("forbidden", { status: 403 }) });
  const [card] = drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  respond = async () => new Response("ok");
  await ticks(h, T0 + 3_000, T0 + 60_000);
  expect([h.calls.map((c) => c.init.body), h.push.state!(), h.world.push.owed]).toEqual([["A Claude Code session needs your approval", "A Claude Code session needs your approval"], { state: "on" }, undefined]);

  respond = REFUSED;
  answer(card!);
  h.world.sessions.get(SID)!.own!.cards.push(permission("m_b", T0 + 70_000));
  at(h, T0 + 72_000);
  await drain();
  h.world.sessions.get(SID)!.own!.cards.forEach(answer);
  const polled = h.polls.length;
  await ticks(h, T0 + 73_000, T0 + 300_000);
  expect([h.polls.length - polled, h.push.state!()]).toEqual([4, { state: "failing", error: "Could not reach the push server", at: iso(T0 + 72_000) }]);
});

test("a gateway timeout after the server published is not sent again at 2 s; the poll finds it (REPRO-4)", async () => {
  const h = harness({ respond: async () => new Response("gateway timeout", { status: 504 }), takes: () => true });
  h.published.length = 0;
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  h.published.push({ time: Math.floor((T0 + 2_000) / 1000), message: "A Claude Code session needs your approval", click: `claudiobot://session/${SID}?card=m_a`, sequence_id: String((h.calls[0]!.init.headers as Record<string, string>)["X-Sequence-ID"]) });
  await ticks(h, T0 + 3_000, T0 + 60_000);
  expect([h.calls.length, h.push.state!(), h.world.push.owed]).toEqual([1, { state: "on" }, undefined]);
});

test("a session's second ending whose try timed out is told apart from the first ending's push and sent (REPRO-5)", async () => {
  let respond: () => Promise<Response> = async () => new Response("ok");
  const h = harness({ respond: () => respond() });
  h.push.sessionEnded!(SID, "finished", iso(T0));
  await drain();
  respond = TIMEOUT;
  at(h, T0 + 40_000);
  h.push.sessionEnded!(SID, "finished", iso(T0 + 40_000));
  await drain();
  respond = async () => new Response("ok");
  await ticks(h, T0 + 41_000, T0 + 10 * 60_000);
  expect([h.calls.length, h.published.length]).toEqual([3, 2]);
});

test("on a server that keeps no sequence id, a session's second ending is told from its first by time, and sent (REPRO-5)", async () => {
  let respond: () => Promise<Response> = async () => new Response("ok");
  const h = harness({ respond: () => respond(), noSid: true });
  h.push.sessionEnded!(SID, "finished", iso(T0));
  await drain();
  respond = TIMEOUT;
  at(h, T0 + 40_000);
  h.push.sessionEnded!(SID, "finished", iso(T0 + 40_000));
  await drain();
  respond = async () => new Response("ok");
  await ticks(h, T0 + 41_000, T0 + 10 * 60_000);
  expect([h.calls.length, h.published.length]).toEqual([3, 2]);
});

test("a server that keeps no sequence id is matched by text and link", async () => {
  const h = harness({ respond: TIMEOUT, takes: () => true, noSid: true });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  await ticks(h, T0 + 3_000, T0 + 30_000);
  expect([h.calls.length, h.push.state!()]).toEqual([1, { state: "on" }]);
});

test("bot updates owed through an outage never push an owed card push out of the queue (REPRO-6)", async () => {
  const h = flaky();
  const card = permission("m_a", T0);
  drive(h, [card.kind === "permission" ? { ...card, card: { ...card.card, expiresAt: iso(T0 + 24 * HOUR) } } : card]);
  at(h, T0 + 2_000);
  await drain();
  for (let i = 0; i < 50; i++) {
    at(h, T0 + 3_000 + i * 11 * 60_000);
    await drain();
    h.push.notify(BOT, "message", h.bubble(`m_b${i}`));
    await drain();
  }
  expect((h.world.push.owed ?? []).map((o) => o.keys[0])).toEqual(expect.arrayContaining(["m_a|card"]));
});

test("over the cap, owed updates go before owed cards", () => {
  const h = harness();
  const update = (i: number) => ({ keys: [`m_${i}|message`], botId: BOT.id, text: "u", link: "l", high: false, for: { kind: "bot" as const } });
  const cardPush = { keys: ["m_a|card"], botId: null, text: "c", link: "l", high: true, for: { kind: "cards" as const, session: SID, cards: ["m_a" as MessageId] } };
  own<PushState>(h.world.push).owed = [cardPush, ...Array.from({ length: 51 }, (_, i) => update(i))];
  const logs: string[] = [];
  createPush({ world: h.world, persist: () => {}, sender: { send: async () => {}, taken: async () => [] }, liveUntil: () => null, now: () => new Date(T0), log: (l) => logs.push(l) }).notify(BOT, "card", CARD);
  expect([h.world.push.owed?.[0]?.keys, h.world.push.owed?.length]).toEqual([["m_a|card"], 50]);
});

test("a reminder that goes while a retry of its card's push is out is not followed by that card push (REPRO-7)", async () => {
  let next: () => Promise<Response> = REFUSED;
  let release = () => {};
  const h = harness({ respond: () => next() });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  next = () => new Promise<Response>((_, rej) => (release = () => rej(Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" }))));
  at(h, T0 + 17_000);
  await drain();
  next = async () => new Response("ok");
  at(h, T0 + HOUR);
  await drain();
  release();
  await drain();
  await ticks(h, T0 + HOUR + 1_000, T0 + HOUR + 10 * 60_000);
  expect(h.calls.slice(4).map((c) => c.init.body)).toEqual(["A Claude Code session is still waiting for your approval"]);
});

test("a write-only topic whose server takes each push but never answers rings at most twice: one blind resend, then the push ends", async () => {
  const h = harness({ respond: TIMEOUT, takes: () => true, poll: async () => new Response("forbidden", { status: 403 }) });
  drive(h, [permission("m_a", T0)]);
  at(h, T0 + 2_000);
  await drain();
  await ticks(h, T0 + 3_000, T0 + 30 * 60_000);
  expect([h.published.length, h.world.push.owed, h.push.state!().state]).toEqual([2, undefined, "failing"]);
  expect(h.logs.at(-1)).toBe("push: m_a|card not sent again: the push server did not answer twice and will not say whether it took it");
});
