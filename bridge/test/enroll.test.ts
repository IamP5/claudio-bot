import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveControl } from "../src/control";
import { createDevices } from "../src/devices";
import { legacyToken } from "../src/legacy";
import { dialHub } from "../src/machine/dial";
import { enroll, type EnrollResponse } from "../src/machine/enroll";
import { homeBase, machineCommand } from "../src/machine/command";
import { newIdentity, readIdentity, type Identity } from "../src/machine/identity";
import { createJoinCodes } from "../src/machine/joinCodes";
import { createLinks } from "../src/machine/links";
import { profileOf } from "../src/machine/profile";
import { createRegistry } from "../src/machine/registry";
import type { PairOffer, PairResponse, ServerMessage, StreamPosition } from "../src/protocol";
import { serve } from "../src/serve";
import { createSaver, loadWorld } from "../src/store";
import { createStream } from "../src/stream";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "claudiobot-enroll-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const ENROLL_URLS = ["http://omarchy.tail1234.ts.net:7878"];

/** A home as main.ts wires one: devices for phones, and the registry, join codes and links for machines. */
function home(opts: { machines?: boolean } = {}) {
  const dir = tmp();
  const { world } = loadWorld(dir);
  const saver = createSaver(world, dir);
  const devices = createDevices({ world, persist: saver.schedule, now: () => new Date(), announce: () => {} });
  const identity = newIdentity("omarchy");
  const registry = createRegistry({ bridgeHome: dir, now: () => new Date() });
  const codes = createJoinCodes({ now: () => new Date() });
  const log: string[] = [];
  const links = createLinks({ identity, registry, log: (l) => log.push(l), now: () => new Date() });
  const machineOffer = (): PairOffer => ({ ...codes.newCode(), urls: ENROLL_URLS });
  const hub = {
    hello: (p: StreamPosition): ServerMessage => ({ type: "hello", protocol: 3, features: [], ...p, machine: "omarchy", userName: "Alex", bots: [] }),
    greeting: () => [],
    handle: async () => [],
  };
  const transport = serve({
    devices,
    stream: createStream(),
    hub,
    legacy: legacyToken(dir),
    log: (l) => log.push(l),
    now: () => new Date(),
    port: 0,
    hostname: "127.0.0.1",
    offer: () => ({ ...devices.newCode(), urls: [] }),
    ...(opts.machines !== false && { machines: { links, enroll: (body: unknown) => enroll({ identity, registry, codes }, body), offer: machineOffer } }),
  });
  const control = serveControl({ home: dir, offer: () => ({ ...devices.newCode(), urls: [] }), machineOffer, log: (l) => log.push(l) });
  cleanups.push(() => {
    control?.stop();
    transport.stop();
    saver.flush();
  });
  return { dir, devices, identity, registry, links, log, http: `http://127.0.0.1:${transport.port}`, port: transport.port };
}

async function phone(h: ReturnType<typeof home>) {
  const res = await fetch(`${h.http}/pair`, { method: "POST", body: JSON.stringify({ code: h.devices.newCode().code, name: "iPhone" }) });
  const { token } = (await res.json()) as PairResponse;
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?protocol=3`, { headers: { Authorization: `Bearer ${token}` } } as never);
  const inbox: ServerMessage[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  cleanups.push(() => ws.close());
  await until("hello", () => inbox.some((m) => m.type === "hello"));
  return { send: (m: object) => ws.send(JSON.stringify(m)), inbox };
}

const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (ok()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const enrollAs = (h: { http: string }, me: Identity, code: string) =>
  fetch(`${h.http}/enroll`, { method: "POST", body: JSON.stringify({ code, machineId: me.machineId, name: me.name, publicKey: me.publicKey }) });

const profile = (() => {
  const { sshAuthSock: _, ...view } = profileOf({ env: {}, platform: "darwin", name: "MacBook", homedir: "/Users/alex", username: "alex" });
  return view;
})();

test("a paired phone mints a machine code, a computer enrolls with it, dials /link and comes online", async () => {
  const h = home();
  const p = await phone(h);
  p.send({ type: "machine_code" });
  await until("machine_code", () => p.inbox.some((m) => m.type === "machine_code"));
  const offer = p.inbox.find((m): m is Extract<ServerMessage, { type: "machine_code" }> => m.type === "machine_code")!;
  expect(offer).toEqual({ type: "machine_code", code: expect.stringMatching(/^\w{4}-\w{4}$/), expiresAt: expect.any(String), urls: ENROLL_URLS });

  const mac = newIdentity("MacBook");
  const res = await enrollAs(h, mac, offer.code);
  expect(res.status).toBe(200);
  const answer = (await res.json()) as EnrollResponse;
  expect(answer).toEqual({ homeMachineId: h.identity.machineId, homePublicKey: h.identity.publicKey, homeName: "omarchy" });
  expect(h.log).toContain("enrolled machine MacBook");

  const dialer = dialHub({
    identity: { ...mac, home: { url: h.http, machineId: answer.homeMachineId, publicKey: answer.homePublicKey, name: answer.homeName } },
    runtime: { apply: async () => ({ ok: true }), events: () => [], lastSeq: () => 0, ack: () => {}, subscribe: () => () => {} },
    profile,
    log: () => {},
    backoff: { firstMs: 20, maxMs: 40 },
  });
  cleanups.push(() => dialer.stop());
  await until("online", () => h.links.machines()[0]?.status().online === true);
  expect(dialer.state()).toEqual({ kind: "live", peer: h.identity.machineId });
});

test("a code enrolls once; the same machine and key again are answered without one, and a wrong code is refused", async () => {
  const h = home();
  const res = await fetch(`http://localhost/machine-code`, { method: "POST", unix: join(h.dir, "run", "control.sock") } as RequestInit);
  const { code } = (await res.json()) as PairOffer;
  const mac = newIdentity("MacBook");
  expect((await enrollAs(h, mac, code)).status).toBe(200);
  expect((await enrollAs(h, mac, "spent")).status).toBe(200);
  expect(h.registry.list()).toHaveLength(1);

  const other = newIdentity("thief");
  const refused = await enrollAs(h, other, code);
  expect([refused.status, await refused.json()]).toEqual([401, { error: expect.stringContaining("No machine code is active") }]);
  const forged = await enrollAs(h, { ...other, machineId: mac.machineId }, code);
  expect([forged.status, await forged.json()]).toEqual([409, { error: "MacBook is already enrolled with another key." }]);
  expect(h.log).toContain("local machine code minted");
});

test("an enrollment that is not {code, machineId, name, publicKey} is refused without spending the code", async () => {
  const h = home();
  const p = await phone(h);
  p.send({ type: "machine_code" });
  await until("machine_code", () => p.inbox.some((m) => m.type === "machine_code"));
  const { code } = p.inbox.find((m): m is Extract<ServerMessage, { type: "machine_code" }> => m.type === "machine_code")!;
  const bad = await fetch(`${h.http}/enroll`, { method: "POST", body: JSON.stringify({ code, machineId: "../../etc", name: "x", publicKey: "k" }) });
  expect(bad.status).toBe(400);
  expect((await enrollAs(h, newIdentity("MacBook"), code)).status).toBe(200);
});

test("a bridge that takes no machines answers no machine_code, /enroll or /link", async () => {
  const h = home({ machines: false });
  const p = await phone(h);
  p.send({ type: "machine_code" });
  await until("an error", () => p.inbox.some((m) => m.type === "error"));
  expect(p.inbox.find((m) => m.type === "error")).toEqual({ type: "error", message: "This bridge does not take machines." });
  expect((await enrollAs(h, newIdentity("MacBook"), "x")).status).toBe(404);
  expect((await fetch(`${h.http}/link`)).status).toBe(404);
});

test.each([
  ["http://omarchy.tail1234.ts.net:7878", "http://omarchy.tail1234.ts.net:7878"],
  ["ws://omarchy.tail1234.ts.net:7878/ws", "http://omarchy.tail1234.ts.net:7878"],
  ["omarchy.local:7878", "http://omarchy.local:7878"],
  ["https://home.example.com/anything?x=1", "https://home.example.com"],
  ["ftp://omarchy:21", null],
  ["", null],
])("the home URL %p enrolls at %p", (raw, base) => {
  expect(homeBase(raw)).toBe(base);
});

function commandOn(bridgeHome: string, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const deps = { bridgeHome, env, run: async () => "MacBook", fetch: (url: string, init?: RequestInit) => fetch(url, init), out: (t: string) => lines.push(t) };
  return { run: (...argv: string[]) => machineCommand(argv, deps), text: () => lines.join("") };
}

test("claudiobot machine invite on the home and enroll on another computer pin both keys and say the machine's own mode", async () => {
  const h = home();
  const onHome = commandOn(h.dir);
  expect(await onHome.run("invite")).toBe(0);
  const code = /machine code: (\S+)/.exec(onHome.text())![1]!;
  expect(onHome.text()).toContain(`claudiobot machine enroll ${ENROLL_URLS[0]} ${code}`);

  const mac = tmp();
  const onMac = commandOn(mac, { CLAUDIOBOT_ACCESS: "full" });
  expect(await onMac.run("enroll", h.http, code)).toBe(0);
  expect(onMac.text()).toContain('Enrolled "MacBook" into "omarchy".');
  expect(onMac.text()).toContain("Agents here run with full access, sandbox off");
  const me = readIdentity(mac)!;
  expect(me.home).toEqual({ url: h.http, machineId: h.identity.machineId, publicKey: h.identity.publicKey, name: "omarchy" });
  expect(h.registry.get(me.machineId)?.publicKey).toBe(me.publicKey);

  expect(await onMac.run("enroll", h.http, "SPENT-CODE")).toBe(0);
  expect(h.registry.list()).toHaveLength(1);

  const elsewhere = home();
  const again = commandOn(mac);
  expect(await again.run("enroll", elsewhere.http, "ANY")).toBe(1);
  expect(again.text()).toContain('already a machine of "omarchy"');
  expect(elsewhere.registry.list()).toEqual([]);
});

test("claudiobot machine invite with no bridge running says so", async () => {
  const c = commandOn(tmp());
  expect(await c.run("invite")).toBe(1);
  expect(c.text()).toContain("No running bridge answered");
});
