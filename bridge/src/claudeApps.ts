import { appendFileSync, watch as fsWatch, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionId } from "./protocol";

// What the Claude Code CLI and the Claude app say about sessions, read from their own files and never written.

/** status: the registry's word ("busy", "idle", "waiting"); waitingFor: what a waiting one waits on ("permission prompt"). */
export type Live = { pid: number; sessionId: SessionId; entrypoint: string; kind: string; cwd: string; status: string; waitingFor: string | null };
export type DesktopEntry = { localId: string; archived: boolean; parent: SessionId | null; title: string | null };
export type DesktopState = "absent" | "background" | "front";

export type ClaudeApps = {
  /** Live Claude Code processes by the session they hold, the bridge's own children excluded. Several on one id: a busy one wins. */
  holders(): ReadonlyMap<SessionId, Live>;
  /** The Claude app's sessions by cliSessionId. */
  desktop(): ReadonlyMap<SessionId, DesktopEntry>;
  desktopState(): Promise<DesktopState>;
  /** Seconds since the last keyboard or mouse input, null when unreadable. */
  idleSeconds(): Promise<number | null>;
  /** True once the store lists the id (at once when it already does), false after 10 s. */
  importToDesktop(id: SessionId): Promise<boolean>;
  /** Imports when needed, then brings the app forward (`open -b com.anthropic.claudefordesktop`). Resolves the import's result. */
  openInDesktop(id: SessionId): Promise<boolean>;
  /** Re-reads both stores now; listeners run when either snapshot changed. */
  refresh(): void;
  onChange(listener: () => void): void;
  close(): void;
};

export type AppsDeps = {
  registryDir: string;
  storeDir: string;
  run(argv: string[]): Promise<{ code: number; stdout: string }>;
  alive(pid: number): boolean;
  /** `ps -o lstart=` under TZ=UTC, null when unknown. */
  procStart(pid: number): string | null;
  /** Pids of Claude Code processes this bridge spawned. */
  own(): ReadonlySet<number>;
  sleep(ms: number): Promise<void>;
  /** Absent: no watching, callers refresh(). */
  watch?(dir: string, onEvent: () => void): { close(): void };
};

export const DESKTOP_BUNDLE = "com.anthropic.claudefordesktop";
const IMPORT_WAIT_MS = 10_000;
const IMPORT_POLL_MS = 500;
const WATCH_DEBOUNCE_MS = 300;

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

/** ps pads a one-digit day with a second space; the registry may not. */
const sameStart = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

/** A registry file's pid checked against ps within this long is not checked again: each check spawns ps. */
const START_CHECK_TTL_MS = 60_000;

function readHolders(deps: AppsDeps, checked: Map<string, { ok: boolean; at: number }>): Map<SessionId, Live> {
  let names: string[];
  try {
    names = readdirSync(deps.registryDir).filter((n) => n.endsWith(".json"));
  } catch {
    return new Map();
  }
  const own = deps.own();
  const out = new Map<SessionId, Live>();
  for (const name of names) {
    const o = readJson(join(deps.registryDir, name));
    if (o === null) continue;
    const { pid, status } = o;
    const sessionId = str(o.sessionId), cwd = str(o.cwd), entrypoint = str(o.entrypoint), kind = str(o.kind), recorded = str(o.procStart);
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof status !== "string") continue;
    if (sessionId === null || cwd === null || entrypoint === null || kind === null || recorded === null) continue;
    if (own.has(pid) || !deps.alive(pid)) continue;
    // As in lock.ts: an alive pid whose start ps cannot read is kept, since nothing proves it is another process.
    const key = `${pid}|${recorded}`;
    const now = Date.now();
    let check = checked.get(key);
    if (check === undefined || now - check.at > START_CHECK_TTL_MS) {
      const start = deps.procStart(pid);
      check = { ok: start === null || sameStart(start, recorded), at: now };
      checked.set(key, check);
    }
    if (!check.ok) continue;
    const live: Live = { pid, sessionId: sessionId as SessionId, entrypoint, kind, cwd, status, waitingFor: str(o.waitingFor) };
    const prior = out.get(live.sessionId);
    const busy = live.status === "busy", priorBusy = prior?.status === "busy";
    if (prior === undefined || (busy && !priorBusy) || (busy === priorBusy && live.pid < prior.pid)) out.set(live.sessionId, live);
  }
  return out;
}

function readDesktop(storeDir: string): Map<SessionId, DesktopEntry> {
  let names: string[];
  try {
    names = readdirSync(storeDir, { recursive: true, encoding: "utf8" }).filter((n) => /^local_.+\.json$/.test(basename(n)));
  } catch {
    return new Map();
  }
  const rows: { localId: string; cli: SessionId; archived: boolean; parentLocal: string | null; title: string | null }[] = [];
  for (const name of names) {
    const o = readJson(join(storeDir, name));
    if (o === null) continue;
    const localId = str(o.sessionId), cli = str(o.cliSessionId);
    if (localId === null || cli === null) continue;
    const from = o.spawnedFrom;
    const parentLocal = typeof from === "object" && from !== null ? str((from as Record<string, unknown>).sessionId) : null;
    rows.push({ localId, cli: cli as SessionId, archived: o.isArchived === true, parentLocal, title: str(o.title) });
  }
  const cliOf = new Map(rows.map((r) => [r.localId, r.cli]));
  return new Map(
    rows.map((r) => [r.cli, { localId: r.localId, archived: r.archived, parent: r.parentLocal === null ? null : (cliOf.get(r.parentLocal) ?? null), title: r.title }]),
  );
}

const signature = (m: ReadonlyMap<string, unknown>) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function createClaudeApps(deps: AppsDeps): ClaudeApps {
  const checked = new Map<string, { ok: boolean; at: number }>();
  let holders = readHolders(deps, checked);
  let desktop = readDesktop(deps.storeDir);
  let seen = { holders: signature(holders), desktop: signature(desktop) };
  const listeners: (() => void)[] = [];

  const refresh = () => {
    for (const [key, c] of checked) if (Date.now() - c.at > START_CHECK_TTL_MS) checked.delete(key);
    holders = readHolders(deps, checked);
    desktop = readDesktop(deps.storeDir);
    const next = { holders: signature(holders), desktop: signature(desktop) };
    const changed = next.holders !== seen.holders || next.desktop !== seen.desktop;
    seen = next;
    if (changed) for (const f of listeners) f();
  };

  const watchers = deps.watch ? [deps.watch(deps.registryDir, refresh), deps.watch(deps.storeDir, refresh)] : [];

  const output = async (argv: string[]) => {
    const r = await deps.run(argv);
    return r.code === 0 ? r.stdout.trim() : "";
  };

  const listed = (id: SessionId) => {
    refresh();
    return desktop.has(id);
  };

  const importToDesktop = async (id: SessionId) => {
    if (listed(id)) return true;
    const opened = await deps.run(["open", "-g", `claude://resume?session=${id}`]);
    if (opened.code !== 0) return false;
    for (let waited = 0; waited < IMPORT_WAIT_MS; waited += IMPORT_POLL_MS) {
      await deps.sleep(IMPORT_POLL_MS);
      if (listed(id)) return true;
    }
    return false;
  };

  return {
    holders: () => holders,
    desktop: () => desktop,
    async desktopState() {
      if ((await output(["lsappinfo", "find", `bundleid=${DESKTOP_BUNDLE}`])) === "") return "absent";
      const front = await output(["lsappinfo", "front"]);
      if (front === "") return "background";
      const info = await output(["lsappinfo", "info", "-only", "bundleid", front]);
      return /"CFBundleIdentifier"\s*=\s*"([^"]*)"/.exec(info)?.[1] === DESKTOP_BUNDLE ? "front" : "background";
    },
    async idleSeconds() {
      const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(await output(["ioreg", "-c", "IOHIDSystem", "-d", "4"]));
      return m ? Math.floor(Number(m[1]) / 1e9) : null;
    },
    importToDesktop,
    async openInDesktop(id) {
      const ok = await importToDesktop(id);
      await deps.run(["open", "-b", DESKTOP_BUNDLE]);
      return ok;
    },
    refresh,
    onChange: (f) => void listeners.push(f),
    close() {
      for (const w of watchers) w.close();
      listeners.length = 0;
    },
  };
}

/**
 * The Claude app as a verification run sees it: imports are written to `file` and listed at once, nothing is opened,
 * the app reads as running in the background and the Mac as idle, so the mirror policy's gates pass.
 */
export function fakeDesktop(real: ClaudeApps, file: string): ClaudeApps {
  const imported = new Map<SessionId, DesktopEntry>();
  const listeners: (() => void)[] = [];
  const note = (what: string, id: SessionId) => appendFileSync(file, `${new Date().toISOString()} ${what} ${id}\n`);
  const importToDesktop = async (id: SessionId) => {
    if (real.desktop().has(id) || imported.has(id)) return true;
    note("import", id);
    imported.set(id, { localId: `local_fake_${id}`, archived: false, parent: null, title: null });
    for (const f of listeners) f();
    return true;
  };
  return {
    ...real,
    desktop: () => new Map([...real.desktop(), ...imported]),
    desktopState: async () => "background",
    idleSeconds: async () => 3600,
    importToDesktop,
    async openInDesktop(id) {
      const ok = await importToDesktop(id);
      note("open", id);
      return ok;
    },
    onChange(f) {
      listeners.push(f);
      real.onChange(f);
    },
  };
}

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  } catch {
    return { code: 1, stdout: "" };
  }
  const timer = setTimeout(() => proc.kill(), 2000);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => ["", 1] as const);
  clearTimeout(timer);
  return { code, stdout };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

function procStart(pid: number): string | null {
  const ran = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stderr: "ignore", env: { ...process.env, TZ: "UTC" } });
  const start = ran.exitCode === 0 ? ran.stdout.toString().trim() : "";
  return start === "" ? null : start;
}

function watch(dir: string, onEvent: () => void): { close(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onEvent();
    }, WATCH_DEBOUNCE_MS);
  };
  let w: ReturnType<typeof fsWatch> | null = null;
  try {
    w = fsWatch(dir, { recursive: true }, fire);
    w.on("error", () => {});
  } catch {
    w = null;
  }
  return {
    close() {
      if (timer !== null) clearTimeout(timer);
      w?.close();
    },
  };
}

export function realAppsDeps(own: () => ReadonlySet<number>): AppsDeps {
  return {
    registryDir: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions"),
    storeDir: join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
    run,
    alive,
    procStart,
    own,
    sleep: (ms) => Bun.sleep(ms),
    watch,
  };
}
