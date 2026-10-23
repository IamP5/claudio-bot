import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices, type Devices, type PairCode } from "../src/devices";
import { legacyToken } from "../src/legacy";
import type { BotId, ClientMessage, DeviceId, Message, MessageId, PairResponse, ServerMessage, SessionId, SessionsChannelFrame, StreamPosition, ThreadChannelFrame } from "../src/protocol";
import { MAX_FRAME_BYTES, PAIR_FAILURE_WINDOW_MS, PAIR_FAILURES_PER_ADDRESS, serve, threadTopic } from "../src/serve";
import { createPush } from "../src/push";
import { createSaver, loadWorld } from "../src/store";
import { createStream } from "../src/stream";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

function tempHome(legacy?: string) {
  const home = mkdtempSync(join(tmpdir(), "claudiobot-serve-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  if (legacy !== undefined) writeFileSync(join(home, "token"), `${legacy}\n`);
  return home;
}

const URLS = ["ws://mac.tail1234.ts.net:7878/ws", "ws://192.168.1.20:7878/ws"];

/** What main.ts does at start, against a temp home, with a fake hub and a clock the test moves. */
function boot(home: string, opts: { wrap?: (d: Devices) => Devices; replies?: (m: ClientMessage) => ServerMessage[] | Promise<ServerMessage[]>; greeting?: ServerMessage[] } = {}) {
  let now = new Date("2026-10-17T09:00:00.000Z");
  let saving = true;
  const { world } = loadWorld(home);
  const saver = createSaver(world, home);
  const persist = (urgency?: "now") => {
    if (urgency === "now" && !saving) throw new Error("disk full");
    saver.schedule(urgency);
  };
  const announced: PairCode[] = [];
  const devices = createDevices({ world, persist, now: () => now, announce: (code) => announced.push(code) });
  const legacy = legacyToken(home);
  legacy.reconcile(devices);
  const handled: ClientMessage[] = [];
  const left: { id: SessionId; at: string }[] = [];
  let presences = 0;
  const hub = {
    hello: (position: StreamPosition): ServerMessage => ({ type: "hello", protocol: 3, features: [], ...position, machine: "Mac", userName: "Alex", bots: [] }),
    greeting: () => opts.greeting ?? [],
    handle: async (message: ClientMessage): Promise<ServerMessage[]> => {
      handled.push(message);
      return (await opts.replies?.(message)) ?? [];
    },
    left: async (id: SessionId, at: Date) => void left.push({ id, at: at.toISOString() }),
  };
  const transport = serve({
    devices: opts.wrap ? opts.wrap(devices) : devices,
    stream: createStream(),
    hub,
    legacy,
    log: () => {},
    now: () => now,
    port: 0,
    hostname: "127.0.0.1",
    offer: () => ({ ...devices.newCode(), urls: URLS }),
    presence: () => presences++,
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    transport.stop();
    saver.flush();
  };
  cleanups.push(stop);
  return {
    transport,
    devices,
    announced,
    handled,
    left,
    presences: () => presences,
    http: `http://127.0.0.1:${transport.port}`,
    savesFail: (fail = true) => (saving = !fail),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    now: () => now,
    stop,
  };
}

type Booted = ReturnType<typeof boot>;

const postPair = (b: Booted, code: string, name = "phone") =>
  fetch(`${b.http}/pair`, { method: "POST", body: JSON.stringify({ code, name }) });

async function pairPhone(b: Booted, name = "phone"): Promise<PairResponse> {
  const res = await postPair(b, b.devices.newCode().code, name);
  expect(res.status).toBe(200);
  return (await res.json()) as PairResponse;
}

async function until<T>(get: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function connect(b: Booted, auth: { bearer: string; query?: string } | { query: string }) {
  const url = `ws://127.0.0.1:${b.transport.port}/ws${auth.query ?? ""}`;
  const ws = "bearer" in auth ? new WebSocket(url, { headers: { Authorization: `Bearer ${auth.bearer}` } } as never) : new WebSocket(url);
  const inbox: ServerMessage[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  cleanups.push(() => ws.close());
  return {
    inbox,
    raw: ws,
    send: (message: object) => ws.send(JSON.stringify(message)),
    next: <K extends ServerMessage["type"]>(type: K) =>
      until(() => {
        const i = inbox.findIndex((m) => m.type === type);
        return i === -1 ? undefined : (inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: K }>);
      }, `a ${type} frame`),
    closed: () => until(() => closed ?? undefined, "the socket to close"),
  };
}

const legacyId = (b: Booted) => b.devices.list(null).find((d) => d.legacy)!.id;

test("a revoked legacy phone stays revoked after a restart, even when its token file comes back", async () => {
  const home = tempHome("shared");
  let b = boot(home);
  expect((await fetch(`${b.http}/ws?token=shared`)).status).toBe(426);
  const phone = await pairPhone(b);
  const owner = connect(b, { bearer: phone.token, query: "?protocol=3" });
  const old = connect(b, { query: "?token=shared" });
  await owner.next("hello");
  await old.next("hello");

  owner.send({ type: "revoke_device", deviceId: legacyId(b) });
  expect((await owner.next("devices")).devices.map((d) => d.id)).toEqual([phone.deviceId]);
  expect(await old.closed()).toEqual({ code: 4001, reason: "revoked" });
  expect(existsSync(join(home, "token"))).toBe(false);

  writeFileSync(join(home, "token"), "shared\n");
  b.stop();
  b = boot(home);
  expect((await fetch(`${b.http}/ws?token=shared`)).status).toBe(401);
  expect(b.devices.list(null).map((d) => d.id)).toEqual([phone.deviceId]);
});

test("a legacy revoke that cannot be saved still closes the phone, and a restart does not bring it back", async () => {
  const home = tempHome("shared");
  let b = boot(home);
  const phone = await pairPhone(b);
  const owner = connect(b, { bearer: phone.token, query: "?protocol=3" });
  const old = connect(b, { query: "?token=shared" });
  await owner.next("hello");
  await old.next("hello");

  b.savesFail();
  owner.send({ type: "revoke_device", deviceId: legacyId(b) });
  expect(await owner.next("error")).toEqual({ type: "error", message: expect.any(String) });
  expect(await old.closed()).toEqual({ code: 4001, reason: "revoked" });

  b.savesFail(false);
  b.stop();
  b = boot(home);
  expect((await fetch(`${b.http}/ws?token=shared`)).status).toBe(401);
});

test("revoking a phone closes its sockets and its token opens no new one", async () => {
  const b = boot(tempHome());
  const keep = await pairPhone(b, "keep");
  const drop = await pairPhone(b, "drop");
  const owner = connect(b, { bearer: keep.token, query: "?protocol=3" });
  const doomed = connect(b, { bearer: drop.token });
  await owner.next("hello");
  await doomed.next("hello");
  expect(b.transport.live()).toBe(2);

  owner.send({ type: "revoke_device", deviceId: drop.deviceId });
  expect(await doomed.closed()).toEqual({ code: 4001, reason: "revoked" });
  await until(() => b.transport.live() === 1, "one live socket");
  const retry = await fetch(`${b.http}/ws`, { headers: { authorization: `Bearer ${drop.token}` } });
  expect(retry.status).toBe(401);
});

test("a socket is live only while the app was heard from within the window; its pings and messages renew it", async () => {
  const b = boot(tempHome());
  const phone = await pairPhone(b);
  const client = connect(b, { bearer: phone.token, query: "?protocol=3" });
  await client.next("hello");
  expect(b.transport.live()).toBe(1);
  expect(b.transport.liveUntil()).toEqual(new Date(b.now().getTime() + 45_000));

  b.advance(45_000);
  expect(b.transport.live()).toBe(0);
  expect(b.transport.liveUntil()).toBeNull();

  client.raw.ping();
  await until(() => b.transport.live() === 1, "a ping to renew the socket");
  expect(b.transport.liveUntil()).toEqual(new Date(b.now().getTime() + 45_000));

  b.advance(45_000);
  client.send({ type: "open", botId: "b_1" });
  await until(() => b.transport.live() === 1, "a message to renew the socket");
});

test("a socket whose device is gone by the time it opens is closed before any hello", async () => {
  const b = boot(tempHome(), { wrap: (d) => ({ ...d, authenticate: () => "d_gone" as DeviceId }) });
  const ghost = connect(b, { bearer: "anything" });
  expect(await ghost.closed()).toEqual({ code: 4001, reason: "revoked" });
  expect(ghost.inbox).toEqual([]);
  expect(b.transport.live()).toBe(0);
});

test("a message from a device revoked behind its socket's back is not handled", async () => {
  const b = boot(tempHome());
  const phone = await pairPhone(b);
  const client = connect(b, { bearer: phone.token });
  await client.next("hello");
  b.devices.revoke(phone.deviceId);

  client.send({ type: "open", botId: "b_1" });
  expect(await client.closed()).toEqual({ code: 4001, reason: "revoked" });
  expect(b.handled).toEqual([]);
});

test("an unexpected failure answers a bare 500 with no stack or path", async () => {
  const home = tempHome();
  const b = boot(home, {
    wrap: (d) => ({
      ...d,
      authenticate: () => {
        throw new Error(`boom in ${home}/secret.ts`);
      },
    }),
  });
  const res = await fetch(`${b.http}/ws`);
  const body = await res.text();
  expect(res.status).toBe(500);
  expect(body).not.toContain("boom");
  expect(body).not.toContain(home);
  expect(body).not.toContain("secret");
});

test("a pairing that cannot be saved answers 500, and the same code works on retry", async () => {
  const b = boot(tempHome());
  const { code } = b.devices.newCode();
  b.savesFail();
  const failed = await postPair(b, code);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: expect.any(String) });
  expect(b.devices.list(null)).toEqual([]);

  b.savesFail(false);
  expect((await postPair(b, code)).status).toBe(200);
});

test("one address gets a limited number of failed pairings, then waits out the window", async () => {
  const b = boot(tempHome());
  b.devices.newCode();
  for (let i = 0; i < PAIR_FAILURES_PER_ADDRESS; i++) expect((await postPair(b, "2222-2222")).status).toBe(401);
  const limited = await postPair(b, b.devices.newCode().code);
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: expect.any(String) });

  b.advance(PAIR_FAILURE_WINDOW_MS);
  expect((await postPair(b, b.devices.newCode().code)).status).toBe(200);
});

test("the legacy phone cannot hand out pairing codes; a paired phone can, with every address of the bridge", async () => {
  const b = boot(tempHome("shared"));
  const old = connect(b, { query: "?token=shared" });
  await old.next("hello");
  old.send({ type: "pair_code" });
  expect(await old.next("error")).toEqual({ type: "error", message: expect.stringContaining("pair") });
  expect(old.inbox.some((m) => m.type === "pair_code")).toBe(false);

  const phone = await pairPhone(b);
  const owner = connect(b, { bearer: phone.token });
  await owner.next("hello");
  owner.send({ type: "pair_code" });
  const offered = await owner.next("pair_code");
  expect(offered).toEqual({ type: "pair_code", code: expect.stringMatching(/^\w{4}-\w{4}$/), expiresAt: expect.any(String), urls: URLS });
  expect((await postPair(b, offered.code, "second")).status).toBe(200);
});

test("an unattended socket does not hold back a push; an attended one, or one that never said, does", async () => {
  const b = boot(tempHome());
  const sent: unknown[] = [];
  const push = createPush({
    world: loadWorld(tempHome()).world,
    persist: () => {},
    sender: async (n) => void sent.push(n),
    liveUntil: () => b.transport.liveUntil(),
    now: b.now,
    log: () => {},
  });
  const bot = { id: "b_1" as BotId, name: "Claudio" };
  const mac = connect(b, { bearer: (await pairPhone(b, "mac")).token, query: "?protocol=3" });
  await mac.next("hello");
  expect(push.notify(bot, "card", "m_1" as MessageId)).toBe(false);

  mac.send({ type: "presence", attended: false });
  await until(() => b.transport.live() === 0, "the unattended socket to stop counting");
  expect(push.notify(bot, "card", "m_2" as MessageId)).toBe(true);

  const phone = connect(b, { bearer: (await pairPhone(b, "phone")).token, query: "?protocol=3" });
  await phone.next("hello");
  expect(push.notify(bot, "card", "m_3" as MessageId)).toBe(false);

  mac.send({ type: "presence", attended: true });
  phone.raw.close();
  await until(() => b.transport.live() === 1, "only the attended mac");
  expect(push.notify(bot, "card", "m_4" as MessageId)).toBe(false);
  expect(sent).toHaveLength(1);
  expect(mac.inbox.some((m) => m.type === "error")).toBe(false);
});

test("the legacy phone may revoke only itself", async () => {
  const b = boot(tempHome("shared"));
  const phone = await pairPhone(b);
  const old = connect(b, { query: "?token=shared" });
  await old.next("hello");

  old.send({ type: "revoke_device", deviceId: phone.deviceId });
  expect(await old.next("error")).toEqual({ type: "error", message: expect.stringContaining("only revoke itself") });
  expect(b.devices.list(null).map((d) => d.id)).toContain(phone.deviceId);

  old.send({ type: "revoke_device", deviceId: legacyId(b) });
  expect(await old.closed()).toEqual({ code: 4001, reason: "revoked" });
  expect(b.devices.list(null).map((d) => d.id)).toEqual([phone.deviceId]);
});

test("a legacy or protocol 2 socket may decide only Allow once or Deny; a paired protocol 3 app may decide anything", async () => {
  const b = boot(tempHome("shared"));
  const { token } = await pairPhone(b);
  const legacy = connect(b, { query: "?token=shared&protocol=3" });
  const today = connect(b, { bearer: token });
  const current = connect(b, { bearer: token, query: "?protocol=3" });
  for (const c of [legacy, today, current]) await c.next("hello");
  const decide = (choice: string) => ({ type: "decide", botId: "b_eng", messageId: "m_card", choice });

  legacy.send(decide("always"));
  today.send(decide("never"));
  expect(await legacy.next("error")).toEqual({ type: "error", message: expect.stringContaining("Allow once or Deny") });
  expect(await today.next("error")).toEqual({ type: "error", message: expect.stringContaining("Allow once or Deny") });
  legacy.send(decide("once"));
  today.send(decide("deny"));
  current.send(decide("always"));
  await until(() => b.handled.length === 3, "the allowed decisions to reach the hub");

  expect(b.handled.map((m) => (m.type === "decide" ? m.choice : m.type)).sort()).toEqual(["always", "deny", "once"]);
});

test("a protocol 2 app may not watch sessions or send any session request; a protocol 3 app may", async () => {
  const b = boot(tempHome("shared"));
  const { token } = await pairPhone(b);
  const old = connect(b, { query: "?token=shared" });
  const today = connect(b, { bearer: token });
  const legacy = connect(b, { query: "?token=shared&protocol=3" });
  const current = connect(b, { bearer: token, query: "?protocol=3" });
  for (const c of [old, today, legacy, current]) await c.next("hello");

  for (const c of [old, today]) {
    c.send({ type: "watch_sessions" });
    c.send({ type: "session_send", sessionId: "s1", text: "hi", clientId: "c1", interrupt: false });
    expect(await c.next("error")).toEqual({ type: "error", message: expect.stringContaining("no Sessions view") });
    expect(await c.next("error")).toEqual({ type: "error", message: expect.stringContaining("no Sessions view") });
  }
  legacy.send({ type: "watch_sessions" });
  current.send({ type: "watch_session", sessionId: "s1", after: null });
  await until(() => b.handled.length === 2, "the protocol 3 requests to reach the hub");

  expect(b.handled.map((m) => m.type).sort()).toEqual(["watch_session", "watch_sessions"]);
});

test("only an attended socket heard from recently reads a thread it watches, and a silent one left when last heard", async () => {
  const b = boot(tempHome());
  const { token } = await pairPhone(b);
  const phone = connect(b, { bearer: token, query: "?protocol=3" });
  await phone.next("hello");
  const id = "s1" as SessionId;
  phone.send({ type: "watch_session", sessionId: id, after: null });
  await until(() => b.transport.watchers(id) === 1, "the watch");
  expect(b.transport.readers(id)).toBe(1);

  b.advance(1_000);
  phone.send({ type: "presence", attended: false });
  await until(() => b.presences() === 1, "the presence change");
  expect([b.transport.watchers(id), b.transport.readers(id)]).toEqual([1, 0]);
  expect(b.left).toEqual([{ id, at: "2026-10-17T09:00:01.000Z" }]);
  b.advance(1_000);
  phone.send({ type: "presence", attended: false });
  phone.send({ type: "devices" });
  await phone.next("devices");
  phone.send({ type: "presence", attended: true });
  await until(() => b.presences() === 2, "the second change");
  expect(b.transport.readers(id)).toBe(1);

  b.advance(45_000);
  expect(b.transport.readers(id)).toBe(0);
  phone.raw.close();
  await until(() => b.presences() === 3, "the close");
  expect(b.left).toEqual([
    { id, at: "2026-10-17T09:00:01.000Z" },
    { id, at: "2026-10-17T09:00:02.000Z" },
  ]);
});

test("an alert counts as seen once a socket it went to is heard from attended, including the presence(false) it leaves with, and after it closes", async () => {
  const b = boot(tempHome());
  const { token } = await pairPhone(b);
  const phone = connect(b, { bearer: token, query: "?protocol=3" });
  await phone.next("hello");
  const old = connect(b, { bearer: token });
  await old.next("hello");
  const alert = { type: "session_alert", sessionId: "s1" as SessionId, reason: "finished", count: 1, title: "Fix the fade", cardId: null, cardKind: null } as const;
  const to = b.transport.sockets.alert(alert);
  const sent = Date.parse("2026-10-17T09:00:00.000Z");
  expect([to, b.transport.sockets.open(), await phone.next("session_alert"), b.transport.sockets.heard(to, sent)]).toEqual([[1], [1], alert, false]);
  b.advance(1_000);
  phone.send({ type: "devices" });
  await phone.next("devices");
  expect([b.transport.sockets.heard(to, sent), b.transport.sockets.heard(to, sent + 1_000)]).toEqual([true, false]);
  b.advance(1_000);
  phone.send({ type: "presence", attended: false });
  await until(() => b.presences() === 1, "the presence change");
  b.advance(1_000);
  phone.send({ type: "devices" });
  await phone.next("devices");
  expect([b.transport.sockets.heard(to, sent + 1_500), b.transport.sockets.heard(to, sent + 2_000)]).toEqual([true, false]);
  phone.raw.close();
  await until(() => b.transport.sockets.open().length === 0, "the close");
  expect([b.transport.sockets.heard(to, sent + 1_500), b.transport.sockets.heard(to, sent + 2_000), old.inbox.some((m) => m.type === "session_alert")]).toEqual([true, false, false]);
});

test("session channels reach only the sockets watching them, until they unwatch or close", async () => {
  const b = boot(tempHome());
  const { token } = await pairPhone(b);
  const list = connect(b, { bearer: token, query: "?protocol=3" });
  const thread = connect(b, { bearer: token, query: "?protocol=3" });
  const other = connect(b, { bearer: token, query: "?protocol=3" });
  for (const c of [list, thread, other]) await c.next("hello");
  const id = "s1" as SessionId;
  list.send({ type: "watch_sessions" });
  thread.send({ type: "watch_session", sessionId: id, after: null });
  await until(() => b.handled.length === 2 && b.transport.watchers(id) === 1, "both watches");

  const rows: SessionsChannelFrame = { type: "session_rows", rows: [], removed: [id], projects: [] };
  const items: ThreadChannelFrame = { type: "session_items", sessionId: id, rev: 1, items: [], removed: [], controls: null };
  b.transport.signal(rows, "sessions");
  b.transport.signal(items, threadTopic(id));
  expect(await list.next("session_rows")).toEqual(rows);
  expect(await thread.next("session_items")).toEqual(items);
  await Bun.sleep(50);
  expect(other.inbox).toEqual([]);
  expect(list.inbox).toEqual([]);

  thread.raw.close();
  await until(() => b.left.length === 1, "the close to unwatch the thread");
  expect(b.left).toEqual([{ id, at: "2026-10-17T09:00:00.000Z" }]);
  expect(b.transport.watchers(id)).toBe(0);
  list.send({ type: "unwatch_sessions" });
  await until(() => b.handled.length === 3, "the unwatch");
  b.transport.signal(rows, "sessions");
  await Bun.sleep(50);
  expect(list.inbox).toEqual([]);
});

test("no frame carries half a character: a lone surrogate goes out as U+FFFD, on replies, broadcasts and channels alike", async () => {
  const half = "Refactor the screen \ud83d";
  const b = boot(tempHome(), { replies: (m) => (m.type === "watch_sessions" ? [{ type: "error", message: half }] : []) });
  const { token } = await pairPhone(b);
  const c = connect(b, { bearer: token, query: "?protocol=3" });
  await c.next("hello");
  const texts: string[] = [];
  c.raw.addEventListener("message", (e) => texts.push(String(e.data)));
  c.send({ type: "watch_sessions" });
  await until(() => texts.length === 1, "the reply");
  b.transport.signal({ type: "session_rows", rows: [], removed: [half as SessionId], projects: [] }, "sessions");
  b.transport.publish({ type: "bot_removed", botId: half as BotId });
  await until(() => texts.length === 3, "the channel frame and the broadcast");
  expect(texts.map((t) => [t.isWellFormed(), t.includes("\\ud83d"), t.includes("Refactor the screen �")])).toEqual(Array(3).fill([true, false, true]));
});

test("a socket's requests are handled and answered in the order it sent them, even when an earlier one is slow", async () => {
  const b = boot(tempHome(), {
    replies: async (m) => {
      if (m.type === "watch_sessions") await Bun.sleep(40);
      return [{ type: "error", message: m.type }];
    },
  });
  const { token } = await pairPhone(b);
  const app = connect(b, { bearer: token, query: "?protocol=3" });
  await app.next("hello");
  app.send({ type: "watch_sessions" });
  app.send({ type: "watch_session", sessionId: "s1", after: null });
  app.send({ type: "unwatch_session", sessionId: "s1" });
  await until(() => app.inbox.length === 3, "three answers");

  expect(app.inbox).toEqual(["watch_sessions", "watch_session", "unwatch_session"].map((message) => ({ type: "error", message })));
  expect(b.handled.map((m) => m.type)).toEqual(["watch_sessions", "watch_session", "unwatch_session"]);
  expect(b.transport.watchers("s1" as SessionId)).toBe(0);
});

test("uploads up to the frame limit reach the hub; a frame over it closes the socket", async () => {
  expect(MAX_FRAME_BYTES).toBeGreaterThan(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1024);
  const b = boot(tempHome());
  const phone = await pairPhone(b);
  const client = connect(b, { bearer: phone.token });
  await client.next("hello");

  const frame = (data: string) => JSON.stringify({ type: "send", botId: "b_1", text: "", uploads: [{ name: "big.png", mime: "image/png", data }] });
  client.raw.send(frame("A".repeat(MAX_FRAME_BYTES - frame("").length)));
  await until(() => b.handled.length === 1, "the upload to reach the hub");

  client.raw.send("x".repeat(MAX_FRAME_BYTES + 1));
  await client.closed();
  expect(b.handled).toHaveLength(1);
});

test("an app that did not announce protocol 3 gets permission cards as Allow once / Deny questions; a protocol 3 app gets them as they are", async () => {
  const botId = "b_eng" as BotId;
  const card: Message = { kind: "permission", id: "m_card" as MessageId, at: "2026-10-17T09:00:00.000Z", from: null, tool: "Bash", label: "Push to the default branch", detail: "git push origin main", always: "git push to main", answer: null, expiresAt: "2026-10-17T11:00:00.000Z" };
  const b = boot(tempHome(), { replies: (m) => (m.type === "open" ? [{ type: "conversation", botId, messages: [card] }] : []) });
  const { token } = await pairPhone(b);
  const today = connect(b, { bearer: token });
  const next = connect(b, { bearer: token, query: "?protocol=3" });
  await today.next("hello");
  await next.next("hello");

  b.transport.publish({ type: "message", botId, message: card });
  const shown = await today.next("message");
  const asIs = await next.next("message");
  today.send({ type: "open", botId });
  const conversation = await today.next("conversation");

  expect(shown.message).toMatchObject({ kind: "question", id: card.id, options: ["Allow once", "Deny"], answer: null });
  expect((shown as unknown as { seq: number }).seq).toBe((asIs as unknown as { seq: number }).seq);
  expect(asIs.message).toEqual(card);
  expect(conversation.messages.map((m) => m.kind)).toEqual(["question"]);
});

test("a protocol 3 app resumes from the replay ring; an app that did not announce protocol 3 gets a fresh hello only", async () => {
  const b = boot(tempHome());
  const { token } = await pairPhone(b);
  const first = connect(b, { bearer: token, query: "?protocol=3" });
  const { epoch } = await first.next("hello");
  b.transport.publish({ type: "bot_removed", botId: "b_gone" as BotId });
  await first.next("bot_removed");

  const resumed = connect(b, { bearer: token, query: `?protocol=3&epoch=${epoch}&after=0` });
  const today = connect(b, { bearer: token, query: `?epoch=${epoch}&after=0` });

  expect(await resumed.next("hello")).toMatchObject({ epoch, seq: 1, resumed: true });
  expect(await resumed.next("bot_removed")).toMatchObject({ botId: "b_gone", seq: 1 });
  expect(await today.next("hello")).toMatchObject({ epoch, seq: 1, resumed: false });
  await Bun.sleep(50);
  expect(today.inbox).toEqual([]);
});

test("a protocol 3 app gets the latest plan usage right after its hello and each change after; a protocol 2 app never does", async () => {
  const usage = (utilization: number): Extract<ServerMessage, { type: "usage" }> => ({
    type: "usage",
    usage: { state: "ok", plan: "max", fetchedAt: "2026-10-17T09:00:00.000Z", stale: false, windows: [{ id: "session", kind: "session", label: "Current session", utilization, resetsAt: null, severity: "normal" }] },
  });
  const b = boot(tempHome(), { greeting: [usage(0.1)] });
  const { token } = await pairPhone(b);
  const next = connect(b, { bearer: token, query: "?protocol=3" });
  const today = connect(b, { bearer: token });
  await until(() => next.inbox.length >= 2, "hello and usage");
  expect(next.inbox.splice(0).map((m) => (m.type === "usage" ? m : m.type))).toEqual(["hello", usage(0.1)]);
  await today.next("hello");

  b.transport.signal(usage(0.2));
  expect(await next.next("usage")).toEqual(usage(0.2));
  await Bun.sleep(50);
  expect(today.inbox).toEqual([]);
});

test("/health proves to a paired phone that it is the same bridge, without the phone sending its token", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const b = boot(tempHome());
  const phone = await pairPhone(b);
  const nonce = "9f".repeat(16);
  const key = createHash("sha256").update(phone.token).digest();
  const expected = createHmac("sha256", key).update(nonce).digest("hex");

  const proved = (await (await fetch(`${b.http}/health?device=${phone.deviceId}&nonce=${nonce}`)).json()) as { ok: boolean; proof?: string };
  expect(proved).toEqual({ ok: true, proof: expected });

  expect(await (await fetch(`${b.http}/health`)).json()).toEqual({ ok: true });
  expect(await (await fetch(`${b.http}/health?device=d_unknown&nonce=${nonce}`)).json()).toEqual({ ok: true });
  expect(await (await fetch(`${b.http}/health?device=${phone.deviceId}&nonce=short`)).json()).toEqual({ ok: true });
});
