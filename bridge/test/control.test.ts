import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveControl } from "../src/control";
import { createDevices } from "../src/devices";
import { legacyToken } from "../src/legacy";
import type { PairOffer, ServerMessage } from "../src/protocol";
import { serve } from "../src/serve";
import { createSaver, loadWorld } from "../src/store";
import { createStream } from "../src/stream";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});

const URLS = ["ws://Mac.local:7878/ws", "ws://192.168.1.20:7878/ws"];

function tempHome(prefix = "cb-ctl-") {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** The bridge as main.ts wires it: one offer() behind both the WebSocket server and the control socket. */
function boot(home: string) {
  const { world } = loadWorld(home);
  const saver = createSaver(world, home);
  const devices = createDevices({ world, persist: saver.schedule, now: () => new Date(), announce: () => {} });
  const offer = (): PairOffer => ({ ...devices.newCode(), urls: URLS });
  const hub = {
    hello: (): ServerMessage => ({ type: "hello", protocol: 3, features: [], epoch: "e", seq: 0, resumed: false, machine: "Mac", userName: "Alex", bots: [] }),
    greeting: () => [],
    handle: async () => [],
    left: async () => {},
  };
  const transport = serve({ devices, stream: createStream(), hub, legacy: legacyToken(home), log: () => {}, now: () => new Date(), port: 0, hostname: "127.0.0.1", offer });
  const logs: string[] = [];
  const control = serveControl({ home, offer, log: (line) => logs.push(line) });
  cleanups.push(() => {
    control?.stop();
    transport.stop();
    saver.flush();
  });
  return { control, logs, devices, socket: join(home, "run", "control.sock"), http: `http://127.0.0.1:${transport.port}` };
}

const call = (socket: string, path = "/pair-code", init: RequestInit = { method: "POST" }) => fetch(`http://localhost${path}`, { ...init, unix: socket } as RequestInit);

const mode = (path: string) => statSync(path).mode & 0o777;

test("the control socket is 0600 in a 0700 run folder, even when the folder was there at 0755", () => {
  const home = tempHome();
  mkdirSync(join(home, "run"), { mode: 0o755 });
  chmodSync(join(home, "run"), 0o755);
  const b = boot(home);
  expect(b.control).not.toBeNull();
  expect(mode(join(home, "run"))).toBe(0o700);
  expect(mode(b.socket)).toBe(0o600);
});

test("a code minted on the control socket pairs a device at POST /pair, and the log never holds the code", async () => {
  const b = boot(tempHome());
  const res = await call(b.socket);
  expect(res.status).toBe(200);
  const offer = (await res.json()) as PairOffer;
  expect(offer).toEqual({ code: expect.stringMatching(/^\w{4}-\w{4}$/), expiresAt: expect.any(String), urls: URLS });

  const paired = await fetch(`${b.http}/pair`, { method: "POST", body: JSON.stringify({ code: offer.code, name: "ClaudioBot on Mac" }) });
  expect(paired.status).toBe(200);
  expect(b.devices.list(null).map((d) => d.name)).toEqual(["ClaudioBot on Mac"]);
  expect(b.logs).toEqual(["local pair code minted"]);
});

test("a stale socket file left by a crash is replaced", async () => {
  const home = tempHome();
  mkdirSync(join(home, "run"));
  writeFileSync(join(home, "run", "control.sock"), "left over");
  const b = boot(home);
  expect((await call(b.socket)).status).toBe(200);
});

test("a request with an Origin header is refused, and only POST /pair-code exists", async () => {
  const b = boot(tempHome());
  expect((await call(b.socket, "/pair-code", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await call(b.socket, "/pair")).status).toBe(404);
  expect((await call(b.socket, "/pair-code", { method: "GET" })).status).toBe(405);
  expect(b.logs).toEqual([]);
});

test("stopping removes the socket", () => {
  const b = boot(tempHome());
  b.control!.stop();
  expect(existsSync(b.socket)).toBe(false);
});

test("a home whose socket path is too long leaves the door off with one log line, and the bridge still serves", async () => {
  const home = tempHome(`cb-ctl-${"x".repeat(100)}-`);
  const b = boot(home);
  expect(b.control).toBeNull();
  expect(b.logs).toEqual([expect.stringContaining("too long")]);
  expect((await fetch(`${b.http}/health`)).status).toBe(200);
});
