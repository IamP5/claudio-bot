import { timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";
import { parseClientMessage } from "./parse";
import type { ServerMessage } from "./protocol";
import { loadOrCreateToken } from "./store";

const TOPIC = "all";

async function machineName(): Promise<string> {
  const proc = Bun.spawn(["scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [name, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => ["", 1] as const);
  return code === 0 && name.trim() !== "" ? name.trim() : hostname().replace(/\.local$/, "");
}

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
      send(ws, { type: "hello", machine, userName: "", bots: [] });
      ws.subscribe(TOPIC);
    },
    async message(ws, raw) {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) return send(ws, { type: "error", message: parsed.error });
      send(ws, { type: "error", message: `${parsed.message.type} is not served yet` });
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

const urls = (lanAddresses().length > 0 ? lanAddresses() : ["127.0.0.1"]).map((ip) => `ws://${ip}:${server.port}/ws`);
const pairLink = `claudebot://pair?url=${encodeURIComponent(urls[0]!)}&token=${token}`;

console.log(`claudebot bridge on ${machine}`);
for (const url of urls) console.log(`  ${url}`);
console.log(`token: ${token}`);
console.log(`pair: ${pairLink}`);
qrcode.generate(pairLink, { small: true }, (qr) => console.log(qr));
