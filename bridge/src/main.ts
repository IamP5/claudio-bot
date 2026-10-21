import { mkdirSync, realpathSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import qrcode from "qrcode-terminal";
import { accessLine } from "./access";
import { bridgeUrls, lanAddresses, pairLink, readNames } from "./address";
import { readPlanUsage, strictMcp } from "./claudeCode";
import { createDevices, type PairCode } from "./devices";
import { createHomes } from "./home";
import { createHub } from "./hub";
import { platformOf, profileOf } from "./machine/profile";
import { legacyToken } from "./legacy";
import { lockHome } from "./lock";
import { migrateHome } from "./migrate";
import { scanProjects } from "./projects";
import { createPush, senderFromEnv } from "./push";
import { serve, threadTopic } from "./serve";
import { createClaudeApps, fakeDesktop, realAppsDeps } from "./claudeApps";
import { serveControl } from "./control";
import type { PairOffer } from "./protocol";
import { claudeExecutable, ownPids } from "./session";
import { bridgeHome, createSaver, loadWorld } from "./store";
import { createStream } from "./stream";
import { errorText } from "./text";
import { USAGE_TIMEOUT_MS } from "./usage";

/** A helper command's output, or "" when it is missing, fails or takes over 2 s (it is killed then). */
async function run(argv: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch {
    return "";
  }
  const timer = setTimeout(() => proc.kill(), 2000);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => ["", 1] as const);
  clearTimeout(timer);
  return code === 0 ? out.trim() : "";
}

const machineName = async () => (await run(["scutil", "--get", "ComputerName"])) || hostname().replace(/\.local$/, "");

const firstName = async () =>
  process.env.CLAUDIOBOT_USER_NAME || (await run(["id", "-F"])).split(/\s+/)[0] || process.env.USER || "there";

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

/**
 * The plan's usage, read from a query that loads no settings, so the user's SessionStart hooks do not run every five
 * minutes. The login is not a setting: Claude Code reads it all the same.
 */
function readUsage() {
  const path = claudeExecutable();
  if (!path) return Promise.reject(new Error("claude was not found on PATH, or CLAUDIOBOT_CLAUDE does not name an executable"));
  return readPlanUsage(query, { pathToClaudeCodeExecutable: path, cwd: homedir(), settingSources: [], ...strictMcp(profile.managedMcpPath), mcpServers: {} }, USAGE_TIMEOUT_MS);
}
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
// Only after the migration, which links the home into place when it is absent. Other users may not list it.
mkdirSync(home, { recursive: true, mode: 0o700 });

const port = Number(process.env.CLAUDIOBOT_PORT ?? 7878);
// The names are read before the bridge listens, so no pair_code can arrive before the addresses it carries.
const [machine, names] = await Promise.all([machineName(), readNames(run)]);
const profile = profileOf({
  env: process.env,
  platform: platformOf(process.platform),
  name: machine,
  homedir: realpathSync(homedir()),
  username: userInfo().username,
  bridgeHome: realpathSync(home),
});
const { world, firstRun } = loadWorld(home);
const saver = createSaver(world, home, 250, log);
const devices = createDevices({ world, persist: saver.schedule, now, announce });
const legacy = legacyToken(home);
legacy.reconcile(devices);

const push = createPush({
  world,
  persist: saver.schedule,
  sender: senderFromEnv(process.env.CLAUDIOBOT_PUSH_URL, log),
  liveUntil: () => transport.liveUntil(),
  now,
  log,
});

const stream = createStream();

const hub = createHub({
  profile,
  userName: await firstName(),
  world,
  homes: createHomes(home),
  model: process.env.CLAUDIOBOT_MODEL || undefined,
  scan: () => scanProjects(),
  claude: { query },
  broadcast: (message) => transport.publish(message),
  signal: (message) => transport.signal(message),
  persist: saver.schedule,
  log,
  push,
  webhookPort: Number(process.env.CLAUDIOBOT_WEBHOOK_PORT ?? 7879),
  usage: { read: readUsage, watched: () => transport.live() > 0 },
  sessions: {
    epoch: stream.epoch,
    projectsDir: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
    // CLAUDIOBOT_DESKTOP_FAKE: a verification run's stand-in for the Claude app, which records imports to that file.
    apps: process.env.CLAUDIOBOT_DESKTOP_FAKE
      ? fakeDesktop(createClaudeApps(realAppsDeps(ownPids)), process.env.CLAUDIOBOT_DESKTOP_FAKE)
      : createClaudeApps(realAppsDeps(ownPids)),
    cacheDir: join(home, "cache"),
    signal: { list: (frame) => transport.signal(frame, "sessions"), thread: (id, frame) => transport.signal(frame, threadTopic(id)) },
    watchers: (id) => transport.watchers(id),
  },
});

const transport = serve({ devices, stream, hub, legacy, log, now, port, offer });
const urls = bridgeUrls(names, lanAddresses(), transport.port);
const control = serveControl({ home, offer, log });

function offer(): PairOffer {
  return { ...devices.newCode(), urls };
}

function shutdown() {
  let saved = true;
  control?.stop();
  try {
    hub.close();
  } catch (e) {
    log(`shutdown: closing the bots failed: ${errorText(e)}`);
  }
  try {
    saver.flush();
  } catch (e) {
    saved = false;
    log(`shutdown: state.json was not saved: ${errorText(e)}`);
  }
  process.exit(saved ? 0 : 1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);

console.log(`claudiobot bridge on ${machine}`);
for (const url of urls) console.log(`  ${url}`);
console.log(accessLine(profile.access));
const missing = profile.sandboxNeeds.filter((command) => Bun.which(command) === null);
if (missing.length > 0) {
  console.error(
    `WARNING: the sandbox is on but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not on PATH, so every Bash call of a bot or agent will fail.\n` +
      `  Install ${missing.map((c) => (c === "bwrap" ? "bubblewrap" : c)).join(" and ")}, or set CLAUDIOBOT_SANDBOX=off.`,
  );
}

function announce({ code, expiresAt }: PairCode) {
  const link = pairLink(urls, code);
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
