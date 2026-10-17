import { timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";
import { createHomes } from "./home";
import { createHub } from "./hub";
import { parseClientMessage } from "./parse";
import { scanProjects } from "./projects";
import type { ServerMessage } from "./protocol";
import { bridgeHome, createSaver, loadOrCreateToken, loadWorld } from "./store";

const TOPIC = "all";

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => ["", 1] as const);
  return code === 0 ? out.trim() : "";
}

const machineName = async () => (await run(["scutil", "--get", "ComputerName"])) || hostname().replace(/\.local$/, "");

const firstName = async () =>
  process.env.CLAUDEBOT_USER_NAME || (await run(["id", "-F"])).split(/\s+/)[0] || process.env.USER || "there";

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

const port = Number(process.env.CLAUDEBOT_PORT ?? 7878);
const token = await loadOrCreateToken();
const tokenBytes = Buffer.from(token);
const tokenMatches = (candidate: string | null) => {
  const bytes = Buffer.from(candidate ?? "");
  return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
};

const machine = await machineName();
const { world, firstRun } = loadWorld();
const saver = createSaver(world);
const hub = createHub({
  machine,
  userName: await firstName(),
  world,
  homes: createHomes(bridgeHome()),
  model: process.env.CLAUDEBOT_MODEL || undefined,
  scan: () => scanProjects(),
  broadcast: (message) => server.publish(TOPIC, JSON.stringify(message)),
  persist: saver.schedule,
  log: (line) => console.log(line),
});

const send = (ws: { send(data: string): unknown }, message: ServerMessage) => {
  ws.send(JSON.stringify(message));
};

const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, machine });
    if (url.pathname === "/ws") {
      if (!tokenMatches(url.searchParams.get("token"))) return new Response("Unauthorized", { status: 401 });
      if (server.upgrade(req, { data: undefined })) return;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      // Subscribe in the same tick as the snapshot so no broadcast falls between them.
      send(ws, hub.hello());
      ws.subscribe(TOPIC);
    },
    async message(ws, raw) {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) return send(ws, { type: "error", message: parsed.error });
      try {
        for (const reply of await hub.handle(parsed.message)) send(ws, reply);
      } catch (e) {
        send(ws, { type: "error", message: (e as Error).message });
      }
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    hub.close();
    saver.flush();
    process.exit(0);
  });
}

const urls = (lanAddresses().length > 0 ? lanAddresses() : ["127.0.0.1"]).map((ip) => `ws://${ip}:${server.port}/ws`);
const pairLink = `claudebot://pair?url=${encodeURIComponent(urls[0]!)}&token=${token}`;

console.log(`claudebot bridge on ${machine}`);
for (const url of urls) console.log(`  ${url}`);
console.log(`token: ${token}`);
console.log(`pair: ${pairLink}`);
qrcode.generate(pairLink, { small: true }, (qr) => console.log(qr));

hub.boot(firstRun);
hub.startTicker();
