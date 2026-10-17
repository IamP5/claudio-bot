import type { ServerWebSocket } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import qrcode from "qrcode-terminal";
import { createDevices, rejectsOrigin } from "./devices";
import { createHomes } from "./home";
import { createHub } from "./hub";
import { migrateHome } from "./migrate";
import { parseClientMessage } from "./parse";
import { scanProjects } from "./projects";
import type { ClientMessage, DeviceId, ServerMessage, TransportMessage } from "./protocol";
import { createPush } from "./push";
import { bridgeHome, createSaver, loadWorld } from "./store";
import { createStream } from "./stream";

const TOPIC = "all";

type SocketData = { deviceId: DeviceId; resume: { epoch: string; after: number } | null };
type Socket = ServerWebSocket<SocketData>;

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => ["", 1] as const);
  return code === 0 ? out.trim() : "";
}

const machineName = async () => (await run(["scutil", "--get", "ComputerName"])) || hostname().replace(/\.local$/, "");

const firstName = async () =>
  process.env.CLAUDIOBOT_USER_NAME || (await run(["id", "-F"])).split(/\s+/)[0] || process.env.USER || "there";

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

/** Boots with a module that is still a scaffold stub; any other failure stops the bridge. */
function unlessStub<T>(what: string, build: () => T): T | undefined {
  try {
    return build();
  } catch (e) {
    if ((e as Error).message !== "not implemented") throw e;
    console.log(`${what}: not in this build yet`);
    return undefined;
  }
}

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One bridge per home. The lock sits beside the home rather than in it, so the migration can move or link the home
 * while the lock is held. A lock whose pid is gone was left by a crash and is taken over.
 */
function lockHome(home: string) {
  const path = `${home}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      process.on("exit", () => {
        if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
      });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : NaN;
    if (alive(holder)) {
      console.error(`Another ClaudioBot bridge (pid ${holder}) is using ${home}. Stop it first; if none is running, delete ${path}.`);
      process.exit(1);
    }
    rmSync(path, { force: true });
  }
  throw new Error(`Could not take the lock ${path}`);
}

const isTransport = (m: ClientMessage): m is TransportMessage => m.type === "devices" || m.type === "revoke_device" || m.type === "pair_code";

const now = () => new Date();
const log = (line: string) => console.log(line);

if (process.env.CLAUDEBOT_HOME && !process.env.CLAUDIOBOT_HOME) {
  console.warn(`WARNING: CLAUDEBOT_HOME is set but this bridge reads CLAUDIOBOT_HOME. Rename the variable; until then it is ignored.`);
}

const home = bridgeHome();
lockHome(home);

const migration = unlessStub("home migration", () => migrateHome({ env: process.env, home: homedir(), now }));
if (migration?.kind === "conflict") {
  console.warn(`WARNING: both ${migration.from} and ${migration.to} hold bots. Using ${migration.to}; ${migration.from} was not touched.`);
} else if (migration?.kind === "linked") {
  log(`linked ${migration.to} to ${migration.from}`);
} else if (migration?.kind === "moved_aside") {
  console.error(
    `NOTE: ${migration.to} held no bots of yours, so it was moved to ${migration.aside} and ${migration.to} now links to ${migration.from}.\n` +
      `  ${migration.aside} is only a backup of that near-empty home. Check it, then delete it when you like.`,
  );
}

const port = Number(process.env.CLAUDIOBOT_PORT ?? 7878);
const machine = await machineName();
const { world, firstRun } = loadWorld(home);
const saver = createSaver(world, home);
const devices = createDevices({ world, persist: saver.schedule, now });
const stream = createStream();
const sockets = new Map<DeviceId, Set<Socket>>();

// Protocol 2's shared token keeps today's phone connected for one release. Revoking that phone deletes the file, so a
// restart cannot import it again.
const legacyTokenFile = join(home, "token");
const legacyToken = existsSync(legacyTokenFile) ? readFileSync(legacyTokenFile, "utf8").trim() : "";
if (legacyToken !== "") devices.importLegacy(legacyToken);

const push = unlessStub("push", () =>
  createPush({
    world,
    persist: saver.schedule,
    url: process.env.CLAUDIOBOT_PUSH_URL || null,
    live: () => [...sockets.values()].reduce((n, set) => n + set.size, 0),
    now,
    log,
  }),
);

const hub = createHub({
  machine,
  userName: await firstName(),
  world,
  homes: createHomes(home),
  model: process.env.CLAUDIOBOT_MODEL || undefined,
  scan: () => scanProjects(),
  broadcast: (message) => server.publish(TOPIC, stream.append(message)),
  persist: saver.schedule,
  log,
  push,
});

const send = (ws: Socket, message: ServerMessage) => {
  ws.send(JSON.stringify(message));
};

function transport(ws: Socket, message: TransportMessage): ServerMessage[] {
  const self = ws.data.deviceId;
  switch (message.type) {
    case "devices":
      return [{ type: "devices", devices: devices.list(self) }];
    case "pair_code":
      return [{ type: "pair_code", ...devices.newCode() }];
    case "revoke_device": {
      const target = devices.list(null).find((d) => d.id === message.deviceId);
      if (!target || !devices.revoke(target.id)) return [{ type: "error", message: "That device is not paired." }];
      if (target.legacy) rmSync(legacyTokenFile, { force: true });
      log(`revoked ${target.name}`);
      for (const socket of sockets.get(target.id) ?? []) socket.close(4001, "revoked");
      return [{ type: "devices", devices: devices.list(self) }];
    }
  }
}

async function pair(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const body: unknown = await req.json().catch(() => null);
  const { code, name } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof code !== "string" || typeof name !== "string") return Response.json({ error: "Send {code, name} as JSON." }, { status: 400 });
  const result = devices.pair(code, name);
  if ("error" in result) return Response.json(result, { status: 401 });
  log(`paired ${devices.list(null).find((d) => d.id === result.deviceId)?.name}`);
  return Response.json(result);
}

const server = Bun.serve<SocketData>({
  hostname: "0.0.0.0",
  port,
  maxRequestBodySize: 64 * 1024,
  async fetch(req, server) {
    if (rejectsOrigin(req)) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/pair") return pair(req);
    if (url.pathname === "/ws") {
      const deviceId = devices.authenticate(req);
      if (deviceId === null) return new Response("Unauthorized", { status: 401 });
      const epoch = url.searchParams.get("epoch");
      const resume = epoch ? { epoch, after: Number(url.searchParams.get("after") ?? NaN) } : null;
      if (server.upgrade(req, { data: { deviceId, resume } })) return;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { deviceId, resume } = ws.data;
      const missed = resume ? stream.since(resume.epoch, resume.after) : null;
      // Hello, replay and subscribe in one tick, so no broadcast falls between them.
      send(ws, hub.hello(stream.position(missed !== null)));
      for (const frame of missed ?? []) ws.send(frame);
      ws.subscribe(TOPIC);
      sockets.set(deviceId, (sockets.get(deviceId) ?? new Set()).add(ws));
      devices.seen(deviceId);
    },
    close(ws) {
      sockets.get(ws.data.deviceId)?.delete(ws);
    },
    async message(ws, raw) {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) return send(ws, { type: "error", message: parsed.error });
      try {
        const replies = isTransport(parsed.message) ? transport(ws, parsed.message) : await hub.handle(parsed.message);
        for (const reply of replies) send(ws, reply);
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

console.log(`claudiobot bridge on ${machine}`);
for (const url of urls) console.log(`  ${url}`);

// The legacy phone alone still gets a code: it should re-pair with its own token before the legacy path goes away.
const paired = devices.list(null).filter((d) => !d.legacy).length;
if (paired === 0 || process.argv.includes("--pair")) {
  const { code, expiresAt } = devices.newCode();
  const link = `claudiobot://pair?url=${encodeURIComponent(urls[0]!)}&code=${code}`;
  console.log(`pair code: ${code} (single use, until ${new Date(expiresAt).toLocaleTimeString()})`);
  console.log(`pair: ${link}`);
  qrcode.generate(link, { small: true }, (qr) => console.log(qr));
} else {
  console.log(`${paired} paired device${paired === 1 ? "" : "s"}. To pair another, use Settings on a paired phone or restart with --pair.`);
}

hub.boot(firstRun);
hub.startTicker();
