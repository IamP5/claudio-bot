import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import type * as nodeFs from "node:fs";
import { join } from "node:path";
import { accessLine, accessOf, type Access } from "./access";
import { bridgeUrls, tailnetName } from "./address";
import { claudeConfigDir, loginOf, MIN_CLAUDE, olderThan, type Login } from "./claudeCode";
import { lockPathOf, pidIn } from "./lock";
import { projectRoots } from "./projects";
import { profileOf, type Platform } from "./machine/profile";
import { readInstalled, serviceState, SUPERVISOR, type Exec, type InstalledUnit, type ServiceState, type ServiceTarget } from "./service";
import { checkStateFile, type StateCheck } from "./store";
import { errorText } from "./text";

// Read-only diagnostics. Never loads the store: loadWorld would upgrade a v2 state.json on the spot, so the doctor reads
// the file through the fs it was handed, which has no write methods, and asks checkStateFile what a start would do.

export type DoctorFs = Pick<typeof nodeFs, "existsSync" | "lstatSync" | "statSync" | "readFileSync" | "readdirSync" | "realpathSync" | "readlinkSync">;

export type DoctorDeps = {
  fs: DoctorFs;
  exec: Exec;
  fetch: (url: string) => Promise<{ ok: boolean; status: number }>;
  which: (command: string, path: string) => string | null;
  alive: (pid: number) => boolean;
  lan: () => string[];
  platform: Platform;
  /** The CLI's own environment, used where no service is installed. */
  env: Record<string, string | undefined>;
  homeDir: string;
  /** The account a query of `claude` under `env` reports, read without running a turn. */
  login: (claude: string, env: Record<string, string | undefined>) => Promise<AccountInfo>;
};

export type Level = "PASS" | "WARN" | "FAIL";
export type Finding = { level: Level; check: string; detail: string };

type Entry = { kind: "absent" } | { kind: "dir" } | { kind: "link"; target: string; resolves: boolean } | { kind: "other" };

type StateFacts = { kind: "absent" } | { kind: "unreadable"; why: string } | StateCheck;

type LockFacts = { path: string } & ({ kind: "free" } | { kind: "pid"; pid: number; alive: boolean } | { kind: "garbled" });

export type Facts = {
  platform: Platform;
  /** "macOS 26.5", "Linux 6.17.2-arch1-1"; null when the OS gave no version. */
  os: string | null;
  supervisor: "launchd" | "systemd";
  label: string;
  unit: string;
  installed: InstalledUnit | null;
  /** null: the supervisor has not loaded the service. */
  loaded: ServiceState | null;
  mainExists: boolean | null;
  /** The environment the service runs with: the unit's when installed, else this shell's. */
  envFrom: "unit" | "shell";
  /** CLAUDIOBOT_ACCESS and CLAUDIOBOT_SANDBOX as the service reads them. */
  access: Access;
  /** What the OS sandbox needs on the service's PATH (none when it is off), and which of those are missing. */
  sandbox: { needs: readonly string[]; missing: readonly string[] };
  bun: { path: string | null; version: string | null };
  claude: { asked: string; path: string | null; version: string | null };
  /** Claude Code's config dir as the service resolves it (set: from CLAUDE_CONFIG_DIR), and as this shell does. */
  config: { dir: string; set: boolean; shellDir: string };
  /** null: no claude to ask. */
  login: Login | { kind: "unknown"; why: string } | null;
  home: { path: string; mode: number | null };
  secrets: { path: string; mode: number }[];
  state: StateFacts;
  health: { url: string; ok: boolean; error: string | null };
  lock: LockFacts;
  roots: { explicit: boolean; list: { path: string; exists: boolean; repos: number }[] };
  /** url: the socket address on the tailnet name, which the app can reach from anywhere it runs Tailscale. */
  tailscale: { path: string | null; ip: string | null; url: string | null };
  lan: string[];
  legacy: { homeSet: boolean; oldEnvSet: boolean; oldHome: string; newHome: string; old: Entry; new: Entry };
};

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

function entryAt(fs: DoctorFs, path: string): Entry {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: "link", target: String(fs.readlinkSync(path)), resolves: fs.existsSync(path) };
    return stat.isDirectory() ? { kind: "dir" } : { kind: "other" };
  } catch (e) {
    if (errno(e) === "ENOENT") return { kind: "absent" };
    throw e;
  }
}

const modeOf = (fs: DoctorFs, path: string) => {
  try {
    return fs.statSync(path).mode & 0o777;
  } catch {
    return null;
  }
};

function readLock(fs: DoctorFs, alive: (pid: number) => boolean, home: string): LockFacts {
  let path: string;
  try {
    path = lockPathOf(home, (p) => fs.realpathSync(p));
  } catch {
    path = `${home}.lock`;
  }
  let body: string;
  try {
    body = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return { path, kind: "free" };
    return { path, kind: "garbled" };
  }
  const pid = pidIn(body);
  return pid === null ? { path, kind: "garbled" } : { path, kind: "pid", pid, alive: alive(pid) };
}

function readState(fs: DoctorFs, home: string): StateFacts {
  const path = join(home, "state.json");
  if (!fs.existsSync(path)) return { kind: "absent" };
  try {
    return checkStateFile(JSON.parse(fs.readFileSync(path, "utf8")));
  } catch (e) {
    return { kind: "unreadable", why: errorText(e) };
  }
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

async function version(exec: Exec, argv: string[], env?: Record<string, string | undefined>): Promise<string | null> {
  const ran = await exec(argv, env ? { env } : undefined).catch(() => null);
  return ran && ran.code === 0 ? firstLine(ran.stdout) : null;
}

type ServiceView = { installed: InstalledUnit | null; env: Record<string, string | undefined>; envFrom: "unit" | "shell"; home: string; port: number };

/** What the service sees: launchd and systemd hand it the unit's variables and no others from the shell. */
export async function serviceView(deps: Pick<DoctorDeps, "exec" | "env" | "homeDir">, target: ServiceTarget): Promise<ServiceView> {
  const installed = await readInstalled(deps.exec, target);
  const env = installed ? installed.env : deps.env;
  return {
    installed,
    env,
    envFrom: installed ? "unit" : "shell",
    home: env.CLAUDIOBOT_HOME ?? join(deps.homeDir, ".claudiobot"),
    port: Number(env.CLAUDIOBOT_PORT ?? 7878),
  };
}

async function health(deps: Pick<DoctorDeps, "fetch">, port: number): Promise<Facts["health"]> {
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const res = await deps.fetch(url);
    return { url, ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { url, ok: false, error: errorText(e) };
  }
}

const OS_VERSION: Readonly<Record<Platform, (exec: Exec) => Promise<string | null>>> = {
  darwin: async (exec) => {
    const v = await version(exec, ["sw_vers", "-productVersion"]);
    return v && `macOS ${v}`;
  },
  linux: (exec) => version(exec, ["uname", "-sr"]),
};

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

async function tailscaleOf(exec: Exec, path: string | null, port: number): Promise<Facts["tailscale"]> {
  if (path === null) return { path, ip: null, url: null };
  const ip = await version(exec, [path, "ip", "-4"]);
  const status = await exec([path, "status", "--json"]).catch(() => null);
  const name = status && status.code === 0 ? tailnetName(status.stdout) : null;
  return { path, ip, url: name === null ? null : bridgeUrls({ tailnet: name, localHost: null }, [], port)[0]! };
}

export async function gather(deps: DoctorDeps, target: ServiceTarget): Promise<Facts> {
  const { fs, exec } = deps;
  const view = await serviceView(deps, target);
  const servicePath = view.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";

  const bunPath = view.installed?.bun ?? deps.which("bun", deps.env.PATH ?? "");
  const askedClaude = view.env.CLAUDIOBOT_CLAUDE ?? "claude";
  const claudePath = deps.which(askedClaude, servicePath);
  const tailscalePath = deps.which("tailscale", servicePath) ?? deps.which("tailscale", deps.env.PATH ?? "") ?? (fs.existsSync(TAILSCALE_APP) ? TAILSCALE_APP : null);

  const claudeEnv: Record<string, string | undefined> = { ...deps.env, PATH: servicePath, CLAUDE_CONFIG_DIR: view.env.CLAUDE_CONFIG_DIR };
  if (!claudeEnv.CLAUDE_CONFIG_DIR) delete claudeEnv.CLAUDE_CONFIG_DIR;

  const explicitRoots = Boolean(view.env.CLAUDIOBOT_ROOTS);
  const roots = projectRoots(explicitRoots ? view.env : {}).map((path) => {
    const exists = fs.existsSync(path) && fs.statSync(path).isDirectory();
    const repos = exists ? fs.readdirSync(path).filter((name) => fs.existsSync(join(path, name, ".git"))).length : 0;
    return { path, exists, repos };
  });

  const oldHome = join(deps.homeDir, ".claudebot");
  const newHome = join(deps.homeDir, ".claudiobot");

  const needs = profileOf({ env: view.env, platform: deps.platform, name: "", homedir: deps.homeDir, username: "" }).sandboxNeeds;

  return {
    platform: deps.platform,
    os: await OS_VERSION[deps.platform](exec),
    supervisor: SUPERVISOR[deps.platform].name,
    label: target.label,
    unit: target.unit,
    installed: view.installed,
    loaded: await serviceState(exec, target),
    mainExists: view.installed?.main ? fs.existsSync(view.installed.main) : null,
    envFrom: view.envFrom,
    bun: { path: bunPath, version: bunPath ? await version(exec, [bunPath, "--version"]) : null },
    claude: {
      asked: askedClaude,
      path: claudePath,
      version: claudePath ? await version(exec, [claudePath, "--version"], claudeEnv) : null,
    },
    config: { dir: claudeConfigDir(view.env, deps.homeDir), set: Boolean(view.env.CLAUDE_CONFIG_DIR), shellDir: claudeConfigDir(deps.env, deps.homeDir) },
    login: claudePath ? await deps.login(claudePath, claudeEnv).then(loginOf, (e) => ({ kind: "unknown" as const, why: errorText(e) })) : null,
    home: { path: view.home, mode: modeOf(fs, view.home) },
    secrets: ["token", "state.json"].flatMap((name) => {
      const path = join(view.home, name);
      const mode = modeOf(fs, path);
      return mode === null ? [] : [{ path, mode }];
    }),
    state: readState(fs, view.home),
    health: await health(deps, view.port),
    lock: readLock(fs, deps.alive, view.home),
    roots: { explicit: explicitRoots, list: roots },
    tailscale: await tailscaleOf(exec, tailscalePath, view.port),
    lan: deps.lan(),
    access: accessOf(view.env),
    sandbox: { needs, missing: needs.filter((command) => deps.which(command, servicePath) === null) },
    legacy: {
      homeSet: view.env.CLAUDIOBOT_HOME !== undefined,
      oldEnvSet: view.env.CLAUDEBOT_HOME !== undefined,
      oldHome,
      newHome,
      old: entryAt(fs, oldHome),
      new: entryAt(fs, newHome),
    },
  };
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const octal = (mode: number) => `0${mode.toString(8).padStart(3, "0")}`;
const pass = (check: string, detail: string): Finding => ({ level: "PASS", check, detail });
const warn = (check: string, detail: string): Finding => ({ level: "WARN", check, detail });
const fail = (check: string, detail: string): Finding => ({ level: "FAIL", check, detail });

type Check = (f: Facts) => Finding | Finding[];

const CHECKS: Check[] = [
  (f) => (f.os ? pass("os", f.os) : warn("os", `${f.platform} gave no version`)),

  (f) => {
    if (!f.installed) return warn("service", `${f.label} is not installed. Run: claudiobot install`);
    if (f.installed.bun === null || f.installed.main === null) return fail("service", `${f.unit} is not a service file this CLI wrote. Run: claudiobot install`);
    if (!f.mainExists) return fail("service", `${f.installed.main} is gone (was the checkout moved?). Run claudiobot install from the new place`);
    if (!f.loaded) return fail("service", `${f.unit} exists but ${f.supervisor} has not loaded it. Run: claudiobot install`);
    if (f.loaded.state !== "running") return fail("service", `${f.label} is ${f.loaded.state} (last exit code ${f.loaded.lastExit ?? "unknown"})`);
    return pass("service", `${f.label} running, pid ${f.loaded.pid ?? "unknown"}`);
  },

  (f) => (f.bun.version ? pass("bun", `bun ${f.bun.version} (${f.bun.path})`) : fail("bun", f.bun.path ? `${f.bun.path} --version failed` : "bun is not on PATH")),

  (f) => {
    const where = f.envFrom === "unit" ? "the service PATH" : "this shell's PATH (no service installed)";
    if (!f.claude.path) return fail("claude", `${f.claude.asked} does not resolve under ${where}. Set CLAUDIOBOT_CLAUDE to its full path and run claudiobot install`);
    if (!f.claude.version) return fail("claude", `${f.claude.path} --version failed`);
    if (olderThan(f.claude.version, MIN_CLAUDE))
      return warn("claude", `${f.claude.version} at ${f.claude.path} is older than ${MIN_CLAUDE}, the oldest Claude Code ClaudioBot is tested with. Run: claude update`);
    return pass("claude", `${f.claude.version} at ${f.claude.path}, found under ${where}`);
  },

  (f) =>
    f.envFrom === "unit" && f.config.dir !== f.config.shellDir
      ? warn("config", `the service reads Claude Code's config from ${f.config.dir} but this shell from ${f.config.shellDir}. Run claudiobot install from the shell whose config the bots should use`)
      : pass("config", `Claude Code's config is ${f.config.dir}`),

  (f) => {
    const l = f.login;
    if (l === null) return [];
    if (l.kind === "in") return pass("login", `logged in: ${l.how}`);
    if (l.kind === "unknown") return warn("login", `could not read the login: ${l.why}`);
    return fail("login", `claude is not logged in for ${f.config.dir}. Run: ${f.config.set ? `CLAUDE_CONFIG_DIR=${f.config.dir} ` : ""}claude auth login`);
  },

  (f) => {
    if (f.home.mode === null) return warn("home", `${f.home.path} does not exist yet; the bridge creates it on first start`);
    if ((f.home.mode & 0o077) !== 0) return warn("home", `${f.home.path} is ${octal(f.home.mode)}; other users can list it. Run: chmod 700 ${f.home.path}`);
    return pass("home", `${f.home.path} is ${octal(f.home.mode)}`);
  },

  (f) =>
    f.secrets.map((s) =>
      (s.mode & 0o077) !== 0 ? fail("secrets", `${s.path} is ${octal(s.mode)}. Run: chmod 600 ${s.path}`) : pass("secrets", `${s.path} is ${octal(s.mode)}`),
    ),

  (f) => {
    const s = f.state;
    if (s.kind === "absent") return pass("state", "no state.json yet: the next start is a first run");
    if (s.kind === "unreadable") return fail("state", `state.json cannot be read (${s.why}); the bridge will refuse to start`);
    switch (s.kind) {
      case "v3":
        return pass("state", `state.json v3, ${plural(s.bots, "bot")}, ${plural(s.devices, "paired device")}`);
      case "v2":
        return warn("state", "state.json is v2: the next start upgrades it to v3 and keeps state.v2.json.bak");
      case "v1":
        return warn("state", "state.json is v1: the next start backs it up and starts fresh");
      case "refused":
        return fail("state", `state.json ${s.why}; the bridge will refuse to start`);
    }
  },

  (f) => {
    if (f.health.ok) return pass("health", `${f.health.url} answers`);
    const detail = `${f.health.url} does not answer (${f.health.error})`;
    return f.installed ? fail("health", detail) : warn("health", `${detail}; no service is installed`);
  },

  (f) => {
    const l = f.lock;
    if (l.kind === "free") return f.health.ok ? warn("lock", `${l.path} is missing but something answers on the port`) : warn("lock", `no bridge holds ${l.path}`);
    if (l.kind === "garbled") return fail("lock", `${l.path} holds no pid, so no bridge will start. If none is running, delete it`);
    if (!l.alive) return warn("lock", `${l.path} names pid ${l.pid}, which is gone; the next bridge takes it over`);
    if (f.loaded?.pid && f.loaded.pid !== l.pid) return warn("lock", `${l.path} is held by pid ${l.pid}, not by the service (pid ${f.loaded.pid})`);
    return pass("lock", `${l.path} held by live pid ${l.pid}`);
  },

  (f) => {
    const { explicit, list } = f.roots;
    if (explicit) {
      return list.map((r) =>
        !r.exists ? fail("roots", `${r.path} (CLAUDIOBOT_ROOTS) does not exist`) : r.repos === 0 ? warn("roots", `${r.path} holds no git repos`) : pass("roots", `${r.path}: ${plural(r.repos, "git repo")}`),
      );
    }
    const found = list.filter((r) => r.exists);
    const repos = found.reduce((n, r) => n + r.repos, 0);
    if (repos === 0) return warn("roots", `no git repos in the default folders; set CLAUDIOBOT_ROOTS and run claudiobot install`);
    return pass("roots", `${plural(repos, "git repo")} in ${found.map((r) => r.path).join(", ")}`);
  },

  (f) => {
    if (!f.tailscale.path) return warn("tailscale", "not installed (optional: it lets the phone reach the bridge away from this network)");
    if (!f.tailscale.ip) return warn("tailscale", `installed at ${f.tailscale.path} but has no address; is it signed in and up?`);
    if (!f.tailscale.url) return pass("tailscale", `${f.tailscale.ip}; turn on MagicDNS for a *.ts.net name the app can use`);
    return pass("tailscale", `${f.tailscale.url} (${f.tailscale.ip}): use it in Edit address to reach the bridge away from home`);
  },

  (f) =>
    f.access.full
      ? warn("access", `${accessLine(f.access)}: bots and agents reach your keys, credentials, ~/.claude and every repo's config, as you do`)
      : f.access.sandbox
        ? pass("access", accessLine(f.access))
        : warn("access", `${accessLine(f.access)}: commands run unsandboxed under the gate's rules`),

  (f) => {
    const { needs, missing } = f.sandbox;
    if (needs.length === 0) return [];
    if (missing.length === 0) return pass("sandbox", `${needs.join(" and ")} found for the sandbox`);
    const packages = missing.map((c) => (c === "bwrap" ? "bubblewrap" : c)).join(" ");
    return fail("sandbox", `the sandbox is on but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not on the service PATH, so every Bash call fails. Install ${packages}, or set CLAUDIOBOT_SANDBOX=off and run claudiobot install`);
  },

  (f) => (f.lan.length === 0 ? warn("lan", "no LAN address: a phone on the same Wi-Fi cannot reach the bridge") : pass("lan", f.lan.join(", "))),

  (f) => {
    const l = f.legacy;
    const out: Finding[] = [];
    if (l.oldEnvSet) out.push(warn("home link", "CLAUDEBOT_HOME is set for the service and ignored. Rename it to CLAUDIOBOT_HOME"));
    if (l.homeSet) return [...out, pass("home link", "CLAUDIOBOT_HOME is set, so ~/.claudebot is not linked")];
    const { old, new: now } = l;
    if (now.kind === "link") {
      if (!now.resolves) out.push(fail("home link", `${l.newHome} links to ${now.target}, which does not exist`));
      else if (now.target === ".claudebot" || now.target === l.oldHome) out.push(pass("home link", `${l.newHome} links to ${l.oldHome}`));
      else out.push(warn("home link", `${l.newHome} links to ${now.target}, not to ${l.oldHome}`));
    } else if (now.kind === "other") out.push(fail("home link", `${l.newHome} is not a directory`));
    else if (old.kind === "absent") out.push(pass("home link", now.kind === "dir" ? `${l.newHome} is the home` : "no home yet"));
    else if (now.kind === "absent") out.push(warn("home link", `the next start links ${l.newHome} to ${l.oldHome}`));
    else out.push(warn("home link", `${l.oldHome} and ${l.newHome} are separate folders; the bridge uses ${l.newHome} only`));
    return out;
  },

  (f) =>
    f.installed
      ? warn("mcp env", `${f.supervisor} does not read .zshrc or .bashrc: an MCP server that needs a variable from it will not see it. Put the value in the server's env (claude mcp add -e KEY=value)`)
      : [],
];

export const check = (facts: Facts): Finding[] => CHECKS.flatMap((c) => c(facts));

const formatFinding = (f: Finding) => `${f.level}  ${f.check.padEnd(10)} ${f.detail}`;

export async function doctor(deps: DoctorDeps, target: ServiceTarget, out: (text: string) => void): Promise<number> {
  const findings = check(await gather(deps, target));
  for (const f of findings) out(formatFinding(f) + "\n");
  const failed = findings.filter((f) => f.level === "FAIL").length;
  out(failed === 0 ? `\nNo failures.\n` : `\n${failed} failure${failed === 1 ? "" : "s"}.\n`);
  return failed === 0 ? 0 : 1;
}

/** Exit 0 only when the supervisor runs the service and it answers /health. */
export async function status(deps: DoctorDeps, target: ServiceTarget, out: (text: string) => void): Promise<number> {
  const view = await serviceView(deps, target);
  const loaded = await serviceState(deps.exec, target);
  const h = await health(deps, view.port);
  const lock = readLock(deps.fs, deps.alive, view.home);
  const service = !view.installed
    ? "not installed"
    : !loaded
      ? `installed but not loaded (${target.unit})`
      : `${loaded.state}, pid ${loaded.pid ?? "none"}, last exit code ${loaded.lastExit ?? "none"}`;
  const holder = lock.kind === "free" ? "free" : lock.kind === "garbled" ? "holds no pid" : `pid ${lock.pid}${lock.alive ? "" : " (gone)"}`;
  out(
    [
      `service  ${target.label}: ${service}`,
      `health   ${h.url}: ${h.ok ? "ok" : h.error}`,
      `lock     ${lock.path}: ${holder}`,
      `home     ${view.home}`,
      `log      ${target.log}`,
      ``,
    ].join("\n"),
  );
  return loaded?.state === "running" && h.ok ? 0 : 1;
}
