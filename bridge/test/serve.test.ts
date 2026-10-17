import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices, type Devices, type PairCode } from "../src/devices";
import { legacyToken } from "../src/legacy";
import type { ClientMessage, DeviceId, PairResponse, ServerMessage } from "../src/protocol";
import { MAX_FRAME_BYTES, PAIR_FAILURE_WINDOW_MS, PAIR_FAILURES_PER_ADDRESS, serve } from "../src/serve";
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

/** What main.ts does at start, against a temp home, with a fake hub and a clock the test moves. */
function boot(home: string, opts: { wrap?: (d: Devices) => Devices } = {}) {
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
  const hub = {
    hello: (): ServerMessage => ({ type: "hello", protocol: 3, epoch: "", seq: 0, resumed: false, machine: "Mac", userName: "Alex", bots: [] }),
    handle: async (message: ClientMessage): Promise<ServerMessage[]> => {
      handled.push(message);
      return [];
    },
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
    http: `http://127.0.0.1:${transport.port}`,
    savesFail: (fail = true) => (saving = !fail),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
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

function connect(b: Booted, auth: { bearer: string } | { query: string }) {
  const url = `ws://127.0.0.1:${b.transport.port}/ws${"query" in auth ? auth.query : ""}`;
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
  const owner = connect(b, { bearer: phone.token });
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
  const owner = connect(b, { bearer: phone.token });
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
  const owner = connect(b, { bearer: keep.token });
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

test("the legacy phone cannot hand out pairing codes; a paired phone can", async () => {
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
  expect(await owner.next("pair_code")).toEqual({ type: "pair_code", code: expect.stringMatching(/^\w{4}-\w{4}$/), expiresAt: expect.any(String) });
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
