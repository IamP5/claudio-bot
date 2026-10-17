import { homedir, hostname, networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";
import { createDevices, type PairCode } from "./devices";
import { createHomes } from "./home";
import { createHub } from "./hub";
import { legacyToken } from "./legacy";
import { lockHome } from "./lock";
import { migrateHome } from "./migrate";
import { scanProjects } from "./projects";
import { createPush, senderFromEnv } from "./push";
import { serve } from "./serve";
import { bridgeHome, createSaver, loadWorld } from "./store";
import { createStream } from "./stream";

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

function holdLock(home: string) {
  const lock = lockHome(home);
  if (lock.kind === "held") {
    process.on("exit", lock.release);
    return;
  }
  console.error(
    lock.kind === "busy"
      ? `Another ClaudioBot bridge (pid ${lock.pid}) is using ${home}. Stop it first; if none is running, delete ${lock.path}.`
      : `Could not take the lock ${lock.path}. If no ClaudioBot bridge is running, delete it and start again.`,
  );
  process.exit(1);
}

const now = () => new Date();
const log = (line: string) => console.log(line);

const home = bridgeHome();
holdLock(home);

const migration = migrateHome({ env: process.env, home: homedir(), now });
if (migration.legacyEnv !== null && !process.env.CLAUDIOBOT_HOME) {
  console.warn(`WARNING: CLAUDEBOT_HOME is set but this bridge reads CLAUDIOBOT_HOME. Rename the variable; until then it is ignored.`);
}
if (migration.kind === "conflict") {
  console.error(migration.message);
} else if (migration.kind === "linked") {
  log(`linked ${migration.to} to ${migration.from}`);
} else if (migration.kind === "moved_aside") {
  console.error(
    `NOTE: ${migration.to} held no bots of yours, so it was moved to ${migration.aside} and ${migration.to} now links to ${migration.from}.\n` +
      `  ${migration.aside} is only a backup of that near-empty home. Check it, then delete it when you like.`,
  );
}
// The home now resolves to ~/.claudebot, a different lock name. Hold that one too, or a bridge started with
// CLAUDIOBOT_HOME=~/.claudebot could share the home.
if (migration.kind === "linked" || migration.kind === "moved_aside") holdLock(home);

const port = Number(process.env.CLAUDIOBOT_PORT ?? 7878);
const machine = await machineName();
const { world, firstRun } = loadWorld(home);
const saver = createSaver(world, home);
const devices = createDevices({ world, persist: saver.schedule, now, announce });
const legacy = legacyToken(home);
legacy.reconcile(devices);

const push = createPush({
  world,
  persist: saver.schedule,
  sender: senderFromEnv(process.env.CLAUDIOBOT_PUSH_URL, log),
  live: () => transport.live(),
  now,
  log,
});

const hub = createHub({
  machine,
  userName: await firstName(),
  world,
  homes: createHomes(home),
  model: process.env.CLAUDIOBOT_MODEL || undefined,
  scan: () => scanProjects(),
  broadcast: (message) => transport.publish(message),
  persist: saver.schedule,
  log,
  push,
});

const transport = serve({ devices, stream: createStream(), hub, legacy, log, now, port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    hub.close();
    saver.flush();
    process.exit(0);
  });
}

const urls = (lanAddresses().length > 0 ? lanAddresses() : ["127.0.0.1"]).map((ip) => `ws://${ip}:${transport.port}/ws`);

console.log(`claudiobot bridge on ${machine}`);
for (const url of urls) console.log(`  ${url}`);

function announce({ code, expiresAt }: PairCode) {
  const link = `claudiobot://pair?url=${encodeURIComponent(urls[0]!)}&code=${code}`;
  console.log(`pair code: ${code} (single use, until ${new Date(expiresAt).toLocaleTimeString()})`);
  console.log(`pair: ${link}`);
  qrcode.generate(link, { small: true }, (qr) => console.log(qr));
}

// The legacy phone alone still gets a code: it should re-pair with its own token before the legacy path goes away.
const paired = devices.list(null).filter((d) => !d.legacy).length;
if (paired === 0 || process.argv.includes("--pair")) {
  announce(devices.newCode());
} else {
  console.log(`${paired} paired device${paired === 1 ? "" : "s"}. To pair another, use Settings on a paired phone or restart with --pair.`);
}

hub.boot(firstRun);
hub.startTicker();
