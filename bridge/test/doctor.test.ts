import { describe, expect, test } from "bun:test";
import * as realFs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, doctor, gather, status, type DoctorDeps, type DoctorFs, type Facts, type Finding } from "../src/doctor";
import { serviceTarget, type Exec, type Ran } from "../src/service";

const healthy: Facts = {
  platform: "darwin",
  macos: "26.5.2",
  label: "com.claudiobot.bridge",
  plist: "/Users/me/Library/LaunchAgents/com.claudiobot.bridge.plist",
  installed: { bun: "/opt/homebrew/bin/bun", main: "/Users/me/bridge/src/main.ts", env: { PATH: "/opt/homebrew/bin:/usr/bin" } },
  launchd: { state: "running", pid: 4242, lastExit: "(never exited)" },
  mainExists: true,
  envFrom: "plist",
  bun: { path: "/opt/homebrew/bin/bun", version: "1.3.14" },
  claude: { asked: "claude", path: "/Users/me/.local/bin/claude", version: "2.1.301 (Claude Code)" },
  config: { dir: "/Users/me/.claude", set: false, shellDir: "/Users/me/.claude" },
  login: { kind: "in", how: "me@example.com (Claude Max)" },
  home: { path: "/Users/me/.claudiobot", mode: 0o700 },
  secrets: [{ path: "/Users/me/.claudiobot/state.json", mode: 0o600 }],
  state: { kind: "v3", bots: 2, devices: 1 },
  health: { url: "http://127.0.0.1:7878/health", ok: true, error: null },
  lock: { path: "/Users/me/.claudiobot.lock", kind: "pid", pid: 4242, alive: true },
  roots: { explicit: true, list: [{ path: "/Users/me/code", exists: true, repos: 3 }] },
  tailscale: { path: "/usr/local/bin/tailscale", ip: "100.64.0.7", url: "ws://mac.tail-1234.ts.net:7878/ws" },
  lan: ["192.168.1.20"],
  access: { full: false, sandbox: true },
  legacy: { homeSet: false, oldEnvSet: false, oldHome: "/Users/me/.claudebot", newHome: "/Users/me/.claudiobot", old: { kind: "absent" }, new: { kind: "dir" } },
};

const findingsFor = (name: string, over: Partial<Facts>) => check({ ...healthy, ...over }).filter((f) => f.check === name);
const levels = (fs: Finding[]) => fs.map((f) => f.level);

describe("checks", () => {
  test("a healthy install passes everything except the standing MCP env reminder", () => {
    const findings = check(healthy);
    expect(findings.filter((f) => f.level !== "PASS")).toEqual([
      { level: "WARN", check: "mcp env", detail: expect.stringContaining("launchd does not read .zshrc") },
    ]);
    expect(findings.map((f) => f.check)).toEqual(["macos", "service", "bun", "claude", "config", "login", "home", "secrets", "state", "health", "lock", "roots", "tailscale", "access", "lan", "home link", "mcp env"]);
  });

  const table: [string, string, Partial<Facts>, string, string][] = [
    ["macos", "not macOS", { platform: "linux" }, "FAIL", "this is linux; the service needs macOS"],
    ["service", "not installed", { installed: null, envFrom: "shell" }, "WARN", "com.claudiobot.bridge is not installed. Run: claudiobot install"],
    ["service", "checkout moved", { mainExists: false }, "FAIL", "/Users/me/bridge/src/main.ts is gone (was the checkout moved?). Run claudiobot install from the new place"],
    ["service", "plist not loaded", { launchd: null }, "FAIL", "/Users/me/Library/LaunchAgents/com.claudiobot.bridge.plist exists but launchd has not loaded it. Run: claudiobot install"],
    ["service", "crashed", { launchd: { state: "not running", pid: null, lastExit: "1" } }, "FAIL", "com.claudiobot.bridge is not running (last exit code 1)"],
    ["bun", "missing", { bun: { path: null, version: null } }, "FAIL", "bun is not on PATH"],
    ["claude", "not on the service PATH", { claude: { asked: "claude", path: null, version: null } }, "FAIL", "claude does not resolve under the service PATH. Set CLAUDIOBOT_CLAUDE to its full path and run claudiobot install"],
    ["claude", "found but broken", { claude: { asked: "claude", path: "/x/claude", version: null } }, "FAIL", "/x/claude --version failed"],
    ["claude", "older than the floor", { claude: { asked: "claude", path: "/x/claude", version: "2.1.299 (Claude Code)" } }, "WARN", "2.1.299 (Claude Code) at /x/claude is older than 2.1.301, the oldest Claude Code ClaudioBot is tested with. Run: claude update"],
    ["config", "default", {}, "PASS", "Claude Code's config is /Users/me/.claude"],
    ["config", "set for the service only", { config: { dir: "/c/svc", set: true, shellDir: "/Users/me/.claude" } }, "WARN", "the service reads Claude Code's config from /c/svc but this shell from /Users/me/.claude. Run claudiobot install from the shell whose config the bots should use"],
    ["config", "the shell's, no service", { envFrom: "shell", installed: null, config: { dir: "/c/work", set: true, shellDir: "/c/work" } }, "PASS", "Claude Code's config is /c/work"],
    ["login", "logged in", {}, "PASS", "logged in: me@example.com (Claude Max)"],
    ["login", "logged out", { login: { kind: "out" } }, "FAIL", "claude is not logged in for /Users/me/.claude. Run: claude auth login"],
    ["login", "logged out, own config dir", { login: { kind: "out" }, config: { dir: "/c/work", set: true, shellDir: "/c/work" } }, "FAIL", "claude is not logged in for /c/work. Run: CLAUDE_CONFIG_DIR=/c/work claude auth login"],
    ["login", "unreadable", { login: { kind: "unknown", why: "Reading the Claude login took over 30 s" } }, "WARN", "could not read the login: Reading the Claude login took over 30 s"],
    ["home", "readable by others", { home: { path: "/h", mode: 0o755 } }, "WARN", "/h is 0755; other users can list it. Run: chmod 700 /h"],
    ["home", "not created yet", { home: { path: "/h", mode: null } }, "WARN", "/h does not exist yet; the bridge creates it on first start"],
    ["secrets", "token readable by others", { secrets: [{ path: "/h/token", mode: 0o644 }] }, "FAIL", "/h/token is 0644. Run: chmod 600 /h/token"],
    ["state", "first run", { state: { kind: "absent" } }, "PASS", "no state.json yet: the next start is a first run"],
    ["state", "v2 awaiting upgrade", { state: { kind: "v2", bots: 1 } }, "WARN", "state.json is v2: the next start upgrades it to v3 and keeps state.v2.json.bak"],
    ["state", "refused", { state: { kind: "refused", why: "has version 9, which this bridge (version 3) does not know" } }, "FAIL", "state.json has version 9, which this bridge (version 3) does not know; the bridge will refuse to start"],
    ["state", "broken JSON", { state: { kind: "unreadable", why: "Unexpected end" } }, "FAIL", "state.json cannot be read (Unexpected end); the bridge will refuse to start"],
    ["health", "down while installed", { health: { url: "http://127.0.0.1:7878/health", ok: false, error: "Unable to connect" } }, "FAIL", "http://127.0.0.1:7878/health does not answer (Unable to connect)"],
    ["health", "down, nothing installed", { installed: null, health: { url: "u", ok: false, error: "refused" } }, "WARN", "u does not answer (refused); no service is installed"],
    ["lock", "stale pid", { lock: { path: "/h.lock", kind: "pid", pid: 77, alive: false } }, "WARN", "/h.lock names pid 77, which is gone; the next bridge takes it over"],
    ["lock", "garbled", { lock: { path: "/h.lock", kind: "garbled" } }, "FAIL", "/h.lock holds no pid, so no bridge will start. If none is running, delete it"],
    ["lock", "held by a foreign bridge", { lock: { path: "/h.lock", kind: "pid", pid: 9, alive: true } }, "WARN", "/h.lock is held by pid 9, not by the service (pid 4242)"],
    ["roots", "explicit root missing", { roots: { explicit: true, list: [{ path: "/nope", exists: false, repos: 0 }] } }, "FAIL", "/nope (CLAUDIOBOT_ROOTS) does not exist"],
    ["roots", "explicit root empty", { roots: { explicit: true, list: [{ path: "/empty", exists: true, repos: 0 }] } }, "WARN", "/empty holds no git repos"],
    ["roots", "no repos in defaults", { roots: { explicit: false, list: [{ path: "/d", exists: true, repos: 0 }] } }, "WARN", "no git repos in the default folders; set CLAUDIOBOT_ROOTS and run claudiobot install"],
    ["roots", "repos in defaults", { roots: { explicit: false, list: [{ path: "/a", exists: true, repos: 2 }, { path: "/b", exists: false, repos: 0 }] } }, "PASS", "2 git repos in /a"],
    ["tailscale", "absent", { tailscale: { path: null, ip: null, url: null } }, "WARN", "not installed (optional: it lets the phone reach the bridge away from this network)"],
    ["tailscale", "down", { tailscale: { path: "/t", ip: null, url: null } }, "WARN", "installed at /t but has no address; is it signed in and up?"],
    ["tailscale", "up", {}, "PASS", "ws://mac.tail-1234.ts.net:7878/ws (100.64.0.7): use it in Edit address to reach the bridge away from home"],
    ["tailscale", "up without MagicDNS", { tailscale: { path: "/t", ip: "100.64.0.7", url: null } }, "PASS", "100.64.0.7; turn on MagicDNS for a *.ts.net name the app can use"],
    ["lan", "no address", { lan: [] }, "WARN", "no LAN address: a phone on the same Wi-Fi cannot reach the bridge"],
    ["access", "guarded", {}, "PASS", "access: guarded, sandbox on"],
    ["access", "sandbox off", { access: { full: false, sandbox: false } }, "WARN", "access: guarded, sandbox off: commands run unsandboxed under the gate's rules"],
    [
      "access",
      "full",
      { access: { full: true, sandbox: false } },
      "WARN",
      "access: full, sandbox off: bots and agents reach your keys, credentials, ~/.claude and every repo's config, as you do",
    ],
  ];

  test.each(table)("%s: %s", (name, _case, over, level, detail) => {
    expect(findingsFor(name, over)).toEqual([{ level: level as Finding["level"], check: name, detail }]);
  });

  const link = (over: Partial<Facts["legacy"]>) => findingsFor("home link", { legacy: { ...healthy.legacy, ...over } });
  test("home link states", () => {
    expect(levels(link({ old: { kind: "dir" }, new: { kind: "link", target: ".claudebot", resolves: true } }))).toEqual(["PASS"]);
    expect(link({ old: { kind: "dir" }, new: { kind: "absent" } })[0]!.detail).toBe("the next start links /Users/me/.claudiobot to /Users/me/.claudebot");
    expect(link({ old: { kind: "dir" }, new: { kind: "dir" } })[0]!.level).toBe("WARN");
    expect(link({ old: { kind: "absent" }, new: { kind: "link", target: ".claudebot", resolves: false } })).toEqual([
      { level: "FAIL", check: "home link", detail: "/Users/me/.claudiobot links to .claudebot, which does not exist" },
    ]);
    expect(link({ new: { kind: "other" } })[0]!.level).toBe("FAIL");
    expect(levels(link({ homeSet: true, oldEnvSet: true }))).toEqual(["WARN", "PASS"]);
  });

  test("no login row when there is no claude to ask", () => {
    expect(findingsFor("login", { login: null })).toEqual([]);
  });

  test("no MCP reminder when nothing runs under launchd", () => {
    expect(findingsFor("mcp env", { installed: null })).toEqual([]);
  });
});

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

/** The real fs for reads; every write throws, and the token's contents cannot be read at all. */
function readOnlyFs(tokenPath: string): DoctorFs & Record<string, unknown> {
  const deny = (name: string) => () => {
    throw new Error(`doctor called ${name}`);
  };
  return {
    ...realFs,
    readFileSync: ((path: realFs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(path) === tokenPath) throw new Error("doctor read the token");
      return (realFs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as DoctorFs["readFileSync"],
    writeFileSync: deny("writeFileSync"),
    renameSync: deny("renameSync"),
    mkdirSync: deny("mkdirSync"),
    rmSync: deny("rmSync"),
    openSync: deny("openSync"),
    symlinkSync: deny("symlinkSync"),
    linkSync: deny("linkSync"),
    chmodSync: deny("chmodSync"),
  };
}

function world(opts: { plistEnv?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  const bot = { id: "bot_1", name: "Digest", title: null, avatar: { shape: "circle", color: "white" }, pinned: false, hidden: false, createdAt: "2026-10-01T00:00:00.000Z", messages: [], unread: 0, routines: [], sessionId: null };
  const v2 = JSON.stringify({ version: 2, bots: [bot], agents: [] });
  writeFileSync(join(home, "state.json"), v2, { mode: 0o600 });
  writeFileSync(join(home, "token"), "shared-secret\n", { mode: 0o644 });
  chmodSync(join(home, "token"), 0o644);
  writeFileSync(`${home}.lock`, `${process.pid}\n`);
  const roots = join(root, "code");
  mkdirSync(join(roots, "app", ".git"), { recursive: true });
  mkdirSync(join(roots, "notes"));
  const target = serviceTarget({ label: "com.claudiobot.bridge.test", uid: 501, logDir: join(root, "logs"), bridgeDir: join(root, "bridge"), home: root });
  if (opts.plistEnv) {
    mkdirSync(join(root, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(target.plist, "plist");
  }
  const env = { PATH: "/shell/bin", CLAUDIOBOT_HOME: home, CLAUDIOBOT_ROOTS: roots };
  const exec: Exec = async (argv) => {
    const cmd = argv.join(" ");
    if (cmd === "sw_vers -productVersion") return ok("26.5.2\n");
    if (cmd.endsWith("bun --version")) return ok("1.3.14\n");
    if (cmd.endsWith("claude --version")) return ok("2.1.0 (Claude Code)\n");
    if (cmd.startsWith("plutil")) return ok(JSON.stringify({ ProgramArguments: ["/svc/bin/bun", join(root, "bridge", "src", "main.ts")], EnvironmentVariables: { ...env, ...opts.plistEnv } }));
    if (cmd.startsWith("launchctl print")) return { code: 113, stdout: "", stderr: "Could not find service" };
    return { code: 127, stdout: "", stderr: `no ${argv[0]}` };
  };
  const deps: DoctorDeps = {
    fs: readOnlyFs(join(home, "token")),
    exec,
    fetch: async () => ({ ok: true, status: 200 }),
    which: (command, path) => (path.split(":").includes("/svc/bin") || command === "bun" ? `/svc/bin/${command}` : null),
    alive: (pid) => pid === process.pid,
    lan: () => ["10.0.0.2"],
    platform: "darwin",
    env,
    homeDir: root,
    login: async () => ({ email: "me@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" }),
  };
  return { root, home, v2, target, deps };
}

describe("gather", () => {
  test("reads a v2 home without upgrading it, never reads the token, and reports what it found", async () => {
    const { home, v2, target, deps } = world();
    let printed = "";
    const code = await doctor(deps, target, (t) => void (printed += t));
    expect(readFileSync(join(home, "state.json"), "utf8")).toBe(v2);
    expect(readdirSync(home).sort()).toEqual(["state.json", "token"]);
    expect(code).toBe(1);
    const lines = printed.split("\n");
    expect(lines).toContain("WARN  state      state.json is v2: the next start upgrades it to v3 and keeps state.v2.json.bak");
    expect(lines).toContain(`FAIL  secrets    ${home}/token is 0644. Run: chmod 600 ${home}/token`);
    expect(lines).toContain(`PASS  secrets    ${home}/state.json is 0600`);
    expect(lines).toContain(`PASS  home       ${home} is 0700`);
    expect(lines).toContain(`PASS  lock       ${realFs.realpathSync(home)}.lock held by live pid ${process.pid}`);
    expect(lines).toContain(`PASS  roots      ${join(home, "..", "code")}: 1 git repo`);
    expect(lines).toContain("FAIL  claude     claude does not resolve under this shell's PATH (no service installed). Set CLAUDIOBOT_CLAUDE to its full path and run claudiobot install");
    expect(lines).toContain("PASS  home link  CLAUDIOBOT_HOME is set, so ~/.claudebot is not linked");
    expect(printed).toEndWith("\n2 failures.\n");
  });

  test("resolves claude under the PATH the plist gives the service, not the shell's", async () => {
    const found = world({ plistEnv: { PATH: "/svc/bin:/usr/bin" } });
    const facts = await gather(found.deps, found.target);
    expect(facts.envFrom).toBe("plist");
    expect(facts.claude).toEqual({ asked: "claude", path: "/svc/bin/claude", version: "2.1.0 (Claude Code)" });

    const missing = world({ plistEnv: { PATH: "/usr/bin" } });
    missing.deps.env = { ...missing.deps.env, PATH: "/svc/bin" };
    expect((await gather(missing.deps, missing.target)).claude.path).toBeNull();
  });

  test("asks claude for the login with the config dir the service sees, never the shell's", async () => {
    const asked: Record<string, string | undefined>[] = [];
    const set = world({ plistEnv: { PATH: "/svc/bin:/usr/bin", CLAUDE_CONFIG_DIR: "/c/svc" } });
    set.deps.env = { ...set.deps.env, CLAUDE_CONFIG_DIR: "/c/shell" };
    set.deps.login = async (path, env) => (asked.push({ path, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, PATH: env.PATH }), { tokenSource: "none", apiProvider: "firstParty" });
    const facts = await gather(set.deps, set.target);
    expect(facts.config).toEqual({ dir: "/c/svc", set: true, shellDir: "/c/shell" });
    expect(facts.login).toEqual({ kind: "out" });

    const unset = world({ plistEnv: { PATH: "/svc/bin:/usr/bin" } });
    unset.deps.env = { ...unset.deps.env, CLAUDE_CONFIG_DIR: "/c/shell" };
    unset.deps.login = set.deps.login;
    expect((await gather(unset.deps, unset.target)).config.dir).toBe(join(unset.root, ".claude"));
    expect(asked).toEqual([
      { path: "/svc/bin/claude", CLAUDE_CONFIG_DIR: "/c/svc", PATH: "/svc/bin:/usr/bin" },
      { path: "/svc/bin/claude", CLAUDE_CONFIG_DIR: undefined, PATH: "/svc/bin:/usr/bin" },
    ]);
  });

  test("a login read that fails is a WARN, not a crash", async () => {
    const found = world({ plistEnv: { PATH: "/svc/bin:/usr/bin" } });
    found.deps.login = async () => Promise.reject(new Error("Reading the Claude login took over 30 s"));
    expect(check(await gather(found.deps, found.target)).find((f) => f.check === "login")).toEqual({
      level: "WARN",
      check: "login",
      detail: "could not read the login: Reading the Claude login took over 30 s",
    });
  });

  test("an unreadable state.json is a FAIL, not a crash", async () => {
    const { home, target, deps } = world();
    writeFileSync(join(home, "state.json"), "{not json");
    const facts = await gather(deps, target);
    expect(facts.state.kind).toBe("unreadable");
    expect(check(facts).find((f) => f.check === "state")?.level).toBe("FAIL");
  });

  test("a v3 state.json the bridge would refuse is a FAIL that names the bad field", async () => {
    const { home, target, deps } = world();
    writeFileSync(join(home, "state.json"), JSON.stringify({ version: 3, bots: [{ id: "b_1" }], agents: [], gate: { open: [], grants: [], daily: [] }, devices: [], push: { sent: [] }, account: { parkedUntil: null } }));
    const finding = check(await gather(deps, target)).find((f) => f.check === "state");
    expect(finding).toEqual({ level: "FAIL", check: "state", detail: "state.json has an invalid bots[0].name (Invalid input: expected string, received undefined); the bridge will refuse to start" });
  });

  test("sees the ~/.claudiobot link when no CLAUDIOBOT_HOME is set", async () => {
    const { root, target, deps } = world();
    mkdirSync(join(root, ".claudebot"));
    symlinkSync(".claudebot", join(root, ".claudiobot"));
    deps.env = { PATH: "/shell/bin" };
    const facts = await gather(deps, target);
    expect(facts.legacy.new).toEqual({ kind: "link", target: ".claudebot", resolves: true });
    expect(check(facts).find((f) => f.check === "home link")).toEqual({ level: "PASS", check: "home link", detail: `${join(root, ".claudiobot")} links to ${join(root, ".claudebot")}` });
  });
});

test("status exits 1 and says so when the service is not installed", async () => {
  const { target, deps, home } = world();
  deps.fetch = async () => Promise.reject(new Error("Unable to connect"));
  let printed = "";
  expect(await status(deps, target, (t) => void (printed += t))).toBe(1);
  expect(printed.split("\n").slice(0, 3)).toEqual([
    "service  com.claudiobot.bridge.test: not installed",
    "health   http://127.0.0.1:7878/health: Unable to connect",
    `lock     ${realFs.realpathSync(home)}.lock: pid ${process.pid}`,
  ]);
});
