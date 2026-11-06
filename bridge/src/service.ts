import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Platform } from "./machine/profile";

// The bridge as a service in the user's login session: a launchd LaunchAgent in gui/<uid> on macOS, a systemd user
// unit on Linux. A system daemon would run outside the session and could not reach the keychain or keyring item
// that holds the claude login.

export type Ran = { code: number; stdout: string; stderr: string };
export type Exec = (argv: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<Ran>;

/** Where one service lives. The label and log dir can be overridden, so a throwaway install never meets the real one. */
export type ServiceTarget = {
  platform: Platform;
  label: string;
  uid: number;
  /** The file the supervisor loads: a plist on macOS, a .service unit on Linux. */
  unit: string;
  log: string;
  /** Absolute; holds src/main.ts. */
  bridgeDir: string;
};

export const DEFAULT_LABEL: Readonly<Record<Platform, string>> = { darwin: "com.claudiobot.bridge", linux: "claudiobot" };

const UNIT_PATH: Readonly<Record<Platform, (home: string, label: string) => string>> = {
  darwin: (home, label) => join(home, "Library", "LaunchAgents", `${label}.plist`),
  linux: (home, label) => join(home, ".config", "systemd", "user", `${label}.service`),
};

export function serviceTarget(opts: { platform: Platform; label: string; uid: number; logDir: string; bridgeDir: string; home?: string }): ServiceTarget {
  return {
    platform: opts.platform,
    label: opts.label,
    uid: opts.uid,
    unit: UNIT_PATH[opts.platform](opts.home ?? homedir(), opts.label),
    log: join(opts.logDir, "bridge.log"),
    bridgeDir: opts.bridgeDir,
  };
}

const LOG_DIR: Readonly<Record<Platform, (home: string) => string>> = {
  darwin: (home) => join(home, "Library", "Logs", "ClaudioBot"),
  linux: (home) => join(home, ".local", "state", "claudiobot"),
};

export const defaultLogDir = (platform: Platform, home = homedir()) => LOG_DIR[platform](home);

/** Names that steer this CLI, not the bridge, so they stay out of the service's environment. */
const CONTROL_VARS = ["CLAUDIOBOT_SERVICE_LABEL", "CLAUDIOBOT_LOG_DIR"] as const;

/**
 * Claude Code's own variables the bridge's queries inherit. CLAUDE_CONFIG_DIR picks the config (and login) the bots
 * use; HOME is never pinned. ENABLE_CLAUDEAI_MCP_SERVERS=false leaves claude.ai connectors out.
 */
const CLAUDE_VARS = ["CLAUDE_CONFIG_DIR", "ENABLE_CLAUDEAI_MCP_SERVERS"] as const;

/** launchd and systemd start services with a bare PATH and none of the shell's variables, so the install-time ones are pinned. */
export function capturedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const bridge = key.startsWith("CLAUDIOBOT_") && !(CONTROL_VARS as readonly string[]).includes(key);
    if (key === "PATH" || bridge || (CLAUDE_VARS as readonly string[]).includes(key)) out[key] = value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export type ServiceSpec = { target: ServiceTarget; bun: string; env: Record<string, string> };

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function plistDict(spec: ServiceSpec): { [key: string]: PlistValue } {
  const { target } = spec;
  return {
    Label: target.label,
    ProgramArguments: [spec.bun, join(target.bridgeDir, "src", "main.ts")],
    WorkingDirectory: target.bridgeDir,
    RunAtLoad: true,
    // Restart after a crash but not after a clean exit: the bridge exits 0 only when told to stop.
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    EnvironmentVariables: spec.env,
    StandardOutPath: target.log,
    StandardErrorPath: target.log,
  };
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function plistValue(value: PlistValue, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number") return `${indent}<integer>${Math.trunc(value)}</integer>`;
  const inner = indent + "\t";
  if (Array.isArray(value)) return [`${indent}<array>`, ...value.map((v) => plistValue(v, inner)), `${indent}</array>`].join("\n");
  const entries = Object.entries(value).flatMap(([k, v]) => [`${inner}<key>${escapeXml(k)}</key>`, plistValue(v, inner)]);
  return [`${indent}<dict>`, ...entries, `${indent}</dict>`].join("\n");
}

export function plistXml(spec: ServiceSpec): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    plistValue(plistDict(spec), ""),
    `</plist>`,
    ``,
  ].join("\n");
}

// systemd expands %specifiers in every value and $VARIABLES in ExecStart, and takes C escapes inside double quotes.
function unitQuote(s: string, exec: boolean): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/%/g, "%%");
  return '"' + (exec ? escaped.replace(/\$/g, "$$$$") : escaped) + '"';
}
const unitPath = (s: string) => s.replace(/%/g, "%%");

export function systemdUnit(spec: ServiceSpec): string {
  const { target } = spec;
  return [
    `[Unit]`,
    `Description=ClaudioBot bridge`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${unitPath(target.bridgeDir)}`,
    `ExecStart=${[spec.bun, join(target.bridgeDir, "src", "main.ts")].map((a) => unitQuote(a, true)).join(" ")}`,
    ...Object.entries(spec.env).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`, false)}`),
    // Restart after a crash but not after a clean exit: the bridge exits 0 only when told to stop.
    `Restart=on-failure`,
    `RestartSec=10`,
    `StandardOutput=append:${unitPath(target.log)}`,
    `StandardError=append:${unitPath(target.log)}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

/** The double-quoted words of a unit value, unescaped. Only reads what systemdUnit writes. */
function unitWords(value: string, exec: boolean): string[] {
  const words: string[] = [];
  for (const m of value.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const unescaped = m[1]!.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)).replace(/%%/g, "%");
    words.push(exec ? unescaped.replace(/\$\$/g, "$") : unescaped);
  }
  return words;
}

/** What an installed plist or unit says. */
export type InstalledUnit = { bun: string | null; main: string | null; env: Record<string, string> };

export type ServiceState = { state: string; pid: number | null; lastExit: string | null };

/** Only the service's own top-level keys: nested blocks (endpoints, sockets) repeat "state" one tab deeper. */
export function parseLaunchdPrint(text: string): ServiceState {
  const top = (key: string) => text.match(new RegExp(`^\\t${key} = (.+)$`, "m"))?.[1]?.trim() ?? null;
  const pid = top("pid");
  return { state: top("state") ?? "unknown", pid: pid && /^\d+$/.test(pid) ? Number(pid) : null, lastExit: top("last exit code") };
}

/** `systemctl show` output; null when systemd has no such unit. A running unit reads "running", as launchd says it. */
export function parseSystemctlShow(text: string): ServiceState | null {
  const prop = (key: string) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? null;
  if (prop("LoadState") !== "loaded") return null;
  const active = prop("ActiveState") ?? "unknown";
  const pid = Number(prop("MainPID") ?? 0);
  return { state: active === "active" && prop("SubState") === "running" ? "running" : active, pid: pid > 0 ? pid : null, lastExit: prop("ExecMainStatus") };
}

export type ServiceDeps = {
  exec: Exec;
  out: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
};

const POLL_MS = 250;

/** One way of running the bridge as a login-session service. */
export type Supervisor = {
  name: "launchd" | "systemd";
  /** Where the service runs, for messages. */
  where: (t: ServiceTarget) => string;
  unitText: (spec: ServiceSpec) => string;
  readInstalled: (exec: Exec, t: ServiceTarget) => Promise<InstalledUnit | null>;
  /** null: the supervisor has not loaded the service. */
  state: (exec: Exec, t: ServiceTarget) => Promise<ServiceState | null>;
  /** Whether it was running; returns once it is gone. */
  stop: (deps: ServiceDeps, t: ServiceTarget) => Promise<boolean>;
  start: (exec: Exec, t: ServiceTarget) => Promise<Ran>;
  restart: (exec: Exec, t: ServiceTarget) => Promise<Ran>;
  /** Removes the unit file and whatever the supervisor keeps of it. */
  remove: (exec: Exec, t: ServiceTarget) => Promise<void>;
  /** Printed after a start: what the user may still need to do. */
  note: string;
};

const launchd: Supervisor = {
  name: "launchd",
  where: (t) => `gui/${t.uid}`,
  unitText: plistXml,
  async readInstalled(exec, t) {
    if (!existsSync(t.unit)) return null;
    // Through plutil, so any valid plist parses.
    const ran = await exec(["plutil", "-convert", "json", "-o", "-", t.unit]);
    if (ran.code !== 0) return { bun: null, main: null, env: {} };
    const parsed = JSON.parse(ran.stdout) as { ProgramArguments?: unknown; EnvironmentVariables?: unknown };
    const args = Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments.filter((a): a is string => typeof a === "string") : [];
    const env = typeof parsed.EnvironmentVariables === "object" && parsed.EnvironmentVariables !== null ? parsed.EnvironmentVariables : {};
    return {
      bun: args[0] ?? null,
      main: args[1] ?? null,
      env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")),
    };
  },
  async state(exec, t) {
    const ran = await exec(["launchctl", "print", `gui/${t.uid}/${t.label}`]);
    return ran.code === 0 ? parseLaunchdPrint(ran.stdout) : null;
  },
  // bootout returns before the job is gone, and a bootstrap that races it fails with an I/O error.
  async stop(deps, t) {
    if ((await launchd.state(deps.exec, t)) === null) return false;
    await deps.exec(["launchctl", "bootout", `gui/${t.uid}/${t.label}`]);
    for (let i = 0; i < 40 && (await launchd.state(deps.exec, t)) !== null; i++) await deps.sleep(POLL_MS);
    return true;
  },
  start: (exec, t) => exec(["launchctl", "bootstrap", `gui/${t.uid}`, t.unit]),
  restart: (exec, t) => exec(["launchctl", "kickstart", "-k", `gui/${t.uid}/${t.label}`]),
  async remove(_exec, t) {
    rmSync(t.unit, { force: true });
  },
  note: "",
};

const unitName = (t: ServiceTarget) => `${t.label}.service`;

const systemd: Supervisor = {
  name: "systemd",
  where: () => "the systemd user manager",
  unitText: systemdUnit,
  async readInstalled(_exec, t) {
    if (!existsSync(t.unit)) return null;
    const text = readFileSync(t.unit, "utf8");
    const exec = text.match(/^ExecStart=(.*)$/m)?.[1];
    const args = exec ? unitWords(exec, true) : [];
    const env = [...text.matchAll(/^Environment=(.*)$/gm)].flatMap((m) => unitWords(m[1]!, false));
    return {
      bun: args[0] ?? null,
      main: args[1] ?? null,
      env: Object.fromEntries(env.flatMap((kv) => (kv.includes("=") ? [[kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]] : []))),
    };
  },
  async state(exec, t) {
    const ran = await exec(["systemctl", "--user", "show", unitName(t), "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus"]);
    return ran.code === 0 ? parseSystemctlShow(ran.stdout) : null;
  },
  // systemctl stop waits for the unit to stop.
  async stop(deps, t) {
    const state = (await systemd.state(deps.exec, t))?.state;
    if (state === undefined || state === "inactive" || state === "failed") return false;
    await deps.exec(["systemctl", "--user", "stop", unitName(t)]);
    return true;
  },
  async start(exec, t) {
    const reloaded = await exec(["systemctl", "--user", "daemon-reload"]);
    return reloaded.code === 0 ? exec(["systemctl", "--user", "enable", "--now", unitName(t)]) : reloaded;
  },
  restart: (exec, t) => exec(["systemctl", "--user", "restart", unitName(t)]),
  async remove(exec, t) {
    await exec(["systemctl", "--user", "disable", unitName(t)]);
    rmSync(t.unit, { force: true });
    await exec(["systemctl", "--user", "daemon-reload"]);
  },
  note: "systemd stops user services when you log out and starts them only at login. To keep the bridge running: loginctl enable-linger\n",
};

export const SUPERVISOR: Readonly<Record<Platform, Supervisor>> = { darwin: launchd, linux: systemd };

const supervisorOf = (t: ServiceTarget) => SUPERVISOR[t.platform];

export const readInstalled = (exec: Exec, t: ServiceTarget) => supervisorOf(t).readInstalled(exec, t);
export const serviceState = (exec: Exec, t: ServiceTarget) => supervisorOf(t).state(exec, t);

async function start(deps: ServiceDeps, target: ServiceTarget): Promise<boolean> {
  const sup = supervisorOf(target);
  const ran = await sup.start(deps.exec, target);
  if (ran.code === 0) return true;
  deps.out(`${sup.name} could not start ${target.label} (${ran.code}): ${(ran.stderr || ran.stdout).trim()}\n`);
  return false;
}

/** The log is 0600 before the supervisor opens it: the first pairing code lands there. */
function prepareLog(log: string): number {
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  closeSync(openSync(log, "a", 0o600));
  chmodSync(log, 0o600);
  return statSync(log).size;
}

function writeAtomic(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const readFrom = (path: string, offset: number) => readFileSync(path).subarray(offset).toString("utf8");

const STARTED = /^(pair: |\d+ paired devices?\.)/m;
const REFUSED = /^(Another ClaudioBot bridge|Could not take the lock|ClaudioBot will not start)/m;

/** Echoes what the bridge printed at start: its URLs and, while no phone is paired, the code and QR. */
async function showStart(deps: ServiceDeps, target: ServiceTarget, offset: number, waitMs: number): Promise<"started" | "refused" | "down"> {
  for (let waited = 0; waited < waitMs; waited += POLL_MS) {
    const text = readFrom(target.log, offset);
    if (REFUSED.test(text)) {
      deps.out(text);
      return "refused";
    }
    if (STARTED.test(text)) {
      // The QR code follows the link line.
      await deps.sleep(500);
      deps.out(readFrom(target.log, offset));
      return "started";
    }
    await deps.sleep(POLL_MS);
  }
  const state = await supervisorOf(target).state(deps.exec, target);
  deps.out(readFrom(target.log, offset));
  if (state?.state === "running") {
    deps.out(`The service is running but printed no pairing line yet. Watch it with: claudiobot logs\n`);
    return "started";
  }
  deps.out(`The service is not running (last exit code ${state?.lastExit ?? "unknown"}). See ${target.log}\n`);
  return "down";
}

/** Converges from any prior state: a loaded job is stopped first, so a rerun replaces it cleanly. */
export async function install(deps: ServiceDeps, spec: ServiceSpec, waitMs = 15_000): Promise<number> {
  const { target } = spec;
  const sup = supervisorOf(target);
  const offset = prepareLog(target.log);
  if (await sup.stop(deps, target)) deps.out(`stopped the running ${target.label}\n`);
  writeAtomic(target.unit, sup.unitText(spec));
  deps.out(`wrote ${target.unit}\n`);
  if (!(await start(deps, target))) return 1;
  deps.out(`started ${target.label} in ${sup.where(target)}. Log: ${target.log}\n${sup.note}\n`);
  const outcome = await showStart(deps, target, offset, waitMs);
  if (outcome === "refused") {
    // The supervisor would restart a refused bridge every few seconds for as long as the cause stays.
    await sup.stop(deps, target);
    deps.out(`\nStopped ${target.label} again. Fix the above, then run claudiobot install again.\n`);
  }
  return outcome === "started" ? 0 : 1;
}

/** Leaves the bridge home and the log alone. */
export async function uninstall(deps: ServiceDeps, target: ServiceTarget, dataHome: string): Promise<number> {
  const sup = supervisorOf(target);
  const stopped = await sup.stop(deps, target);
  const present = existsSync(target.unit);
  if (present) await sup.remove(deps.exec, target);
  if (!stopped && !present) {
    deps.out(`${target.label} is not installed.\n`);
    return 0;
  }
  deps.out(`${stopped ? "stopped and " : ""}removed ${target.label}. Your bots in ${dataHome} and the log ${target.log} are kept.\n`);
  return 0;
}

export type Foreground = (argv: string[], opts: { cwd: string; env: Record<string, string | undefined>; onLine: (line: string, stop: () => void) => void }) => Promise<number>;

/** One process per home: the service steps aside while the bridge runs here with --pair, then comes back. */
export async function pair(
  deps: ServiceDeps & { foreground: Foreground },
  target: ServiceTarget,
  run: { bun: string; env: Record<string, string | undefined> },
): Promise<number> {
  const wasRunning = await supervisorOf(target).stop(deps, target);
  if (wasRunning) deps.out(`stopped ${target.label} while pairing\n`);
  deps.out(`Scan the code with the ClaudioBot app. This stops by itself once a phone pairs, or press Ctrl-C.\n\n`);
  let paired = false;
  try {
    await deps.foreground([run.bun, join(target.bridgeDir, "src", "main.ts"), "--pair"], {
      cwd: target.bridgeDir,
      env: run.env,
      onLine: (line, stopBridge) => {
        if (/^paired /.test(line)) {
          paired = true;
          stopBridge();
        }
      },
    });
  } finally {
    if (wasRunning && (await start(deps, target))) deps.out(`started ${target.label} again\n`);
  }
  deps.out(paired ? `Paired.\n` : `No phone paired.\n`);
  return paired ? 0 : 1;
}

export type UpdateDeps = ServiceDeps & { ask: (question: string) => Promise<boolean> };

/** Never automatic: shows what would arrive and changes nothing without a yes. */
export async function update(deps: UpdateDeps, target: ServiceTarget): Promise<number> {
  const git = (args: string[]) => deps.exec(["git", ...args], { cwd: target.bridgeDir });
  const fail = (what: string, ran: Ran) => {
    deps.out(`${what} failed: ${(ran.stderr || ran.stdout).trim()}\n`);
    return 1;
  };
  const fetched = await git(["fetch", "--quiet"]);
  if (fetched.code !== 0) return fail("git fetch", fetched);
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.code !== 0) return fail("finding the upstream branch", upstream);
  const incoming = await git(["log", "--oneline", "--no-decorate", "HEAD..@{u}"]);
  if (incoming.code !== 0) return fail("git log", incoming);
  const commits = incoming.stdout.trim();
  if (commits === "") {
    deps.out(`Already up to date with ${upstream.stdout.trim()}.\n`);
    return 0;
  }
  deps.out(`Incoming from ${upstream.stdout.trim()}:\n${commits}\n\n`);
  if (!(await deps.ask("Update to these commits and restart the bridge? [y/N] "))) {
    deps.out(`Not updated.\n`);
    return 0;
  }
  const pulled = await git(["pull", "--ff-only"]);
  if (pulled.code !== 0) return fail("git pull --ff-only", pulled);
  const installed = await deps.exec(["bun", "install", "--frozen-lockfile"], { cwd: target.bridgeDir });
  if (installed.code !== 0) return fail("bun install --frozen-lockfile", installed);
  const sup = supervisorOf(target);
  if ((await sup.state(deps.exec, target)) === null) {
    deps.out(`Updated. ${target.label} is not running, so nothing was restarted.\n`);
    return 0;
  }
  const kicked = await sup.restart(deps.exec, target);
  if (kicked.code !== 0) return fail("restarting the service", kicked);
  deps.out(`Updated and restarted ${target.label}.\n`);
  return 0;
}
