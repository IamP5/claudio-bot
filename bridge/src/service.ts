import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The bridge as a launchd LaunchAgent in the gui/<uid> domain: a daemon would run outside the login session and
// could not reach the Keychain item that holds the claude login.

export const DEFAULT_LABEL = "com.claudiobot.bridge";

export type Ran = { code: number; stdout: string; stderr: string };
export type Exec = (argv: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<Ran>;

/** Where one service lives. The label and log dir can be overridden, so a throwaway install never meets the real one. */
export type ServiceTarget = {
  label: string;
  uid: number;
  plist: string;
  log: string;
  /** Absolute; holds src/main.ts. */
  bridgeDir: string;
};

export function serviceTarget(opts: { label: string; uid: number; logDir: string; bridgeDir: string; home?: string }): ServiceTarget {
  return {
    label: opts.label,
    uid: opts.uid,
    plist: join(opts.home ?? homedir(), "Library", "LaunchAgents", `${opts.label}.plist`),
    log: join(opts.logDir, "bridge.log"),
    bridgeDir: opts.bridgeDir,
  };
}

export const defaultLogDir = (home = homedir()) => join(home, "Library", "Logs", "ClaudioBot");

/** Names that steer this CLI, not the bridge, so they stay out of the service's environment. */
const CONTROL_VARS = ["CLAUDIOBOT_SERVICE_LABEL", "CLAUDIOBOT_LOG_DIR"] as const;

/** launchd starts agents with a bare PATH and none of the shell's variables, so the install-time ones are pinned. */
export function capturedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "PATH" || (key.startsWith("CLAUDIOBOT_") && !(CONTROL_VARS as readonly string[]).includes(key))) out[key] = value;
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

/** What an installed plist says, read back through plutil so any valid plist parses. */
export type InstalledPlist = { bun: string | null; main: string | null; env: Record<string, string> };

export async function readInstalled(exec: Exec, plist: string): Promise<InstalledPlist | null> {
  if (!existsSync(plist)) return null;
  const ran = await exec(["plutil", "-convert", "json", "-o", "-", plist]);
  if (ran.code !== 0) return { bun: null, main: null, env: {} };
  const parsed = JSON.parse(ran.stdout) as { ProgramArguments?: unknown; EnvironmentVariables?: unknown };
  const args = Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments.filter((a): a is string => typeof a === "string") : [];
  const env = typeof parsed.EnvironmentVariables === "object" && parsed.EnvironmentVariables !== null ? parsed.EnvironmentVariables : {};
  return {
    bun: args[0] ?? null,
    main: args[1] ?? null,
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")),
  };
}

export type LaunchdState = { state: string; pid: number | null; lastExit: string | null };

/** Only the service's own top-level keys: nested blocks (endpoints, sockets) repeat "state" one tab deeper. */
export function parseLaunchdPrint(text: string): LaunchdState {
  const top = (key: string) => text.match(new RegExp(`^\\t${key} = (.+)$`, "m"))?.[1]?.trim() ?? null;
  const pid = top("pid");
  return { state: top("state") ?? "unknown", pid: pid && /^\d+$/.test(pid) ? Number(pid) : null, lastExit: top("last exit code") };
}

export function launchctl(exec: Exec, uid: number) {
  const domain = `gui/${uid}`;
  return {
    async print(label: string): Promise<LaunchdState | null> {
      const ran = await exec(["launchctl", "print", `${domain}/${label}`]);
      return ran.code === 0 ? parseLaunchdPrint(ran.stdout) : null;
    },
    bootout: (label: string) => exec(["launchctl", "bootout", `${domain}/${label}`]),
    bootstrap: (plist: string) => exec(["launchctl", "bootstrap", domain, plist]),
    kickstart: (label: string) => exec(["launchctl", "kickstart", "-k", `${domain}/${label}`]),
  };
}

export type ServiceDeps = {
  exec: Exec;
  out: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
};

const POLL_MS = 250;

/** bootout returns before the job is gone, and a bootstrap that races it fails with an I/O error. */
async function stop(deps: ServiceDeps, target: ServiceTarget): Promise<boolean> {
  const lc = launchctl(deps.exec, target.uid);
  if ((await lc.print(target.label)) === null) return false;
  await lc.bootout(target.label);
  for (let i = 0; i < 40 && (await lc.print(target.label)) !== null; i++) await deps.sleep(POLL_MS);
  return true;
}

async function start(deps: ServiceDeps, target: ServiceTarget): Promise<boolean> {
  const ran = await launchctl(deps.exec, target.uid).bootstrap(target.plist);
  if (ran.code === 0) return true;
  deps.out(`launchctl bootstrap failed (${ran.code}): ${(ran.stderr || ran.stdout).trim()}\n`);
  return false;
}

/** The log is 0600 before launchd opens it: the first pairing code lands there. */
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
  const state = await launchctl(deps.exec, target.uid).print(target.label);
  deps.out(readFrom(target.log, offset));
  if (state?.state === "running") {
    deps.out(`The service is running but printed no pairing line yet. Watch it with: claudiobot logs\n`);
    return "started";
  }
  deps.out(`The service is not running (last exit code ${state?.lastExit ?? "unknown"}). See ${target.log}\n`);
  return "down";
}

/** Converges from any prior state: a loaded job is booted out first, so a rerun replaces it cleanly. */
export async function install(deps: ServiceDeps, spec: ServiceSpec, waitMs = 15_000): Promise<number> {
  const { target } = spec;
  const offset = prepareLog(target.log);
  if (await stop(deps, target)) deps.out(`stopped the running ${target.label}\n`);
  writeAtomic(target.plist, plistXml(spec));
  deps.out(`wrote ${target.plist}\n`);
  if (!(await start(deps, target))) return 1;
  deps.out(`started ${target.label} in gui/${target.uid}. Log: ${target.log}\n\n`);
  const outcome = await showStart(deps, target, offset, waitMs);
  if (outcome === "refused") {
    // KeepAlive would restart a refused bridge every ThrottleInterval for as long as the cause stays.
    await stop(deps, target);
    deps.out(`\nStopped ${target.label} again. Fix the above, then run claudiobot install again.\n`);
  }
  return outcome === "started" ? 0 : 1;
}

/** Leaves the bridge home and the log alone. */
export async function uninstall(deps: ServiceDeps, target: ServiceTarget, dataHome: string): Promise<number> {
  const stopped = await stop(deps, target);
  const present = existsSync(target.plist);
  rmSync(target.plist, { force: true });
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
  const wasRunning = await stop(deps, target);
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
  const lc = launchctl(deps.exec, target.uid);
  if ((await lc.print(target.label)) === null) {
    deps.out(`Updated. ${target.label} is not running, so nothing was restarted.\n`);
    return 0;
  }
  const kicked = await lc.kickstart(target.label);
  if (kicked.code !== 0) return fail("restarting the service", kicked);
  deps.out(`Updated and restarted ${target.label}.\n`);
  return 0;
}
