import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collect } from "./output";

// The real CLI in a child process, with a temp HOME and stand-ins for launchctl, git and the bun the plist names, so
// nothing reaches the real LaunchAgents, the real repo's remote or a real bridge.
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "../src/cli.ts");
const uid = process.getuid!();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function machine({ incoming = "" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-cli-")));
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const logs = join(root, "logs");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(state, "incoming"), incoming);
  const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >> "${state}/${name}.calls"\n${body}`, { mode: 0o755 });
  script(
    "launchctl",
    `case "$1" in
  print) [ -f "${state}/loaded" ] || exit 113; printf '\\tstate = running\\n\\tpid = 4242\\n\\tlast exit code = (never exited)\\n' ;;
  bootstrap) touch "${state}/loaded"; echo "1 paired device. To pair another, use Settings on a paired phone or restart with --pair." >> "$(plutil -extract StandardOutPath raw -o - "$3")" ;;
  bootout) rm -f "${state}/loaded" ;;
  kickstart) ;;
  *) exit 1 ;;
esac
`,
  );
  script(
    "git",
    `case "$1" in
  fetch) ;;
  rev-parse) echo origin/main ;;
  log) cat "${state}/incoming" ;;
  *) echo "unexpected git $*" >&2; exit 1 ;;
esac
`,
  );
  // What the plist runs. --pair prints what the bridge prints when a phone pairs, then waits to be stopped.
  script("bun", `echo "pair: claudiobot://pair?code=TEST"\necho "paired Alex's iPhone"\nsleep 20\n`);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    CLAUDIOBOT_HOME: join(root, "home"),
    CLAUDIOBOT_LOG_DIR: logs,
    CLAUDIOBOT_PORT: "1",
  };
  const plist = (label = "com.claudiobot.bridge") => join(root, "Library", "LaunchAgents", `${label}.plist`);
  return {
    root,
    env,
    plist,
    log: join(logs, "bridge.log"),
    calls: (name: string) => (existsSync(join(state, `${name}.calls`)) ? readFileSync(join(state, `${name}.calls`), "utf8").trim().split("\n") : []),
    loaded: () => existsSync(join(state, "loaded")),
    async run(args: string[], extra: Record<string, string> = {}) {
      const proc = Bun.spawn([process.execPath, CLI, ...args], { env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    },
  };
}

test.each([
  ["no command", [], 0],
  ["help", ["help"], 0],
  ["--help", ["--help"], 0],
  ["an unknown command", ["restart"], 2],
])("%s prints the usage", async (_, args, expected) => {
  const m = machine();
  const r = await m.run(args);
  expect(r.code).toBe(expected);
  expect(r.stderr).toContain("usage: claudiobot <install|uninstall|status|doctor|logs|pair|update>");
  expect(m.calls("launchctl")).toEqual([]);
});

test.each([
  ["--label", ["--label"]],
  ["--log-dir", ["--log-dir"]],
  ["--label followed by another flag", ["--label", "--log-dir", "/tmp/x"]],
])("%s exits 2 and says the flag needs a value", async (_, args) => {
  const m = machine();
  const r = await m.run(["install", ...args]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(`${args[0]} needs a value\n`);
  expect(existsSync(m.plist())).toBe(false);
});

test("install writes the LaunchAgent under HOME, bootstraps it in the user's gui domain and echoes the start", async () => {
  const m = machine();
  const r = await m.run(["install"]);

  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`wrote ${m.plist()}`);
  expect(r.stdout).toContain("1 paired device.");
  expect(m.calls("launchctl")).toContain(`bootstrap gui/${uid} ${m.plist()}`);
  const plist = readFileSync(m.plist(), "utf8");
  expect(plist).toContain(`<string>${join(m.root, "bin", "bun")}</string>`);
  expect(plist).toContain(`<string>${join(dirname(import.meta.dir), "src", "main.ts")}</string>`);
  expect(plist).toContain(`<key>CLAUDIOBOT_HOME</key>`);
  expect(plist).not.toContain("CLAUDIOBOT_LOG_DIR");
});

test("--label and --log-dir install a separate service, and the label also comes from CLAUDIOBOT_SERVICE_LABEL", async () => {
  const m = machine();
  const logs = join(m.root, "other-logs");
  const flagged = await m.run(["install", "--label", "com.test.one", "--log-dir", logs]);
  expect(flagged.code).toBe(0);
  expect(flagged.stdout).toContain(`wrote ${m.plist("com.test.one")}`);
  expect(m.calls("launchctl")).toContain(`bootstrap gui/${uid} ${m.plist("com.test.one")}`);
  expect(readFileSync(m.plist("com.test.one"), "utf8")).toContain(`<string>${join(logs, "bridge.log")}</string>`);

  const viaEnv = await m.run(["uninstall"], { CLAUDIOBOT_SERVICE_LABEL: "com.test.one" });
  expect(viaEnv.stdout).toContain("removed com.test.one");
  expect(existsSync(m.plist("com.test.one"))).toBe(false);
});

test("status reports launchd, /health and the lock, and exits 0 only when the service runs and answers", async () => {
  const m = machine();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
  try {
    expect(await m.run(["install"], { CLAUDIOBOT_PORT: String(server.port) })).toMatchObject({ code: 0 });
    const up = await m.run(["status"]);
    expect(up.code).toBe(0);
    expect(up.stdout).toContain("service  com.claudiobot.bridge: running, pid 4242");
    expect(up.stdout).toContain(`health   http://127.0.0.1:${server.port}/health: ok`);
    expect(up.stdout).toContain(`home     ${join(m.root, "home")}`);
  } finally {
    server.stop(true);
  }
  const down = await m.run(["status"]);
  expect(down.code).toBe(1);
  expect(down.stdout).not.toContain("/health: ok");
});

test("uninstall boots the service out and removes the plist, keeps the data, and is quiet when nothing is installed", async () => {
  const m = machine();
  await m.run(["install"]);
  const r = await m.run(["uninstall"]);

  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`stopped and removed com.claudiobot.bridge. Your bots in ${join(m.root, "home")}`);
  expect(m.calls("launchctl")).toContain(`bootout gui/${uid}/com.claudiobot.bridge`);
  expect([existsSync(m.plist()), m.loaded()]).toEqual([false, false]);

  expect((await m.run(["uninstall"])).stdout).toBe("com.claudiobot.bridge is not installed.\n");
});

test("pair stops the service, runs the plist's bun with --pair until a phone pairs, then starts the service again", async () => {
  const m = machine();
  await m.run(["install"]);
  const r = await m.run(["pair"]);

  expect(r.code).toBe(0);
  expect(r.stdout).toContain("stopped com.claudiobot.bridge while pairing");
  expect(r.stdout).toContain("paired Alex's iPhone");
  expect(r.stdout).toContain("started com.claudiobot.bridge again\nPaired.\n");
  expect(m.calls("bun")).toEqual([`${join(dirname(import.meta.dir), "src", "main.ts")} --pair`]);
  expect(m.loaded()).toBe(true);
});

test("update shows nothing to do when up to date, and without a terminal never pulls", async () => {
  const current = machine();
  const none = await current.run(["update"]);
  expect(none).toMatchObject({ code: 0, stdout: "Already up to date with origin/main.\n" });

  const behind = machine({ incoming: "c3 Fix the gate\n" });
  const r = await behind.run(["update"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("Incoming from origin/main:\nc3 Fix the gate");
  expect(r.stdout).toContain("Not updated.");
  expect(behind.calls("git")).not.toContain("pull --ff-only");
});

test("logs says how to start when there is no log yet, and otherwise follows it", async () => {
  const m = machine();
  const missing = await m.run(["logs"]);
  expect(missing).toMatchObject({ code: 1, stdout: `No log at ${m.log} yet. Run: claudiobot install\n` });

  mkdirSync(dirname(m.log), { recursive: true });
  writeFileSync(m.log, "first line\n");
  const proc = Bun.spawn([process.execPath, CLI, "logs"], { env: m.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = collect(proc.stdout);
  await out.until(/first line/);
  writeFileSync(m.log, "first line\nsecond line\n");
  await out.until(/second line/);
  proc.kill("SIGTERM");
  await proc.exited;
});
