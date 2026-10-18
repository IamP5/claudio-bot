import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeApps, type AppsDeps } from "../src/claudeApps";
import type { SessionId } from "../src/protocol";

const START = "Sun Oct 18 16:20:13 2026";
const sid = (s: string) => s as SessionId;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Reply = { code: number; stdout: string };

function harness(opts: { replies?: Record<string, Reply>; alive?: number[]; starts?: Record<number, string | null>; own?: number[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "claude-apps-"));
  dirs.push(root);
  const registryDir = join(root, "sessions");
  const storeDir = join(root, "store");
  const orgDir = join(storeDir, "acct", "org");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(orgDir, { recursive: true });
  const ran: string[][] = [];
  const state = { slept: 0, onSleep: (_ms: number) => {} };
  const alive = new Set(opts.alive ?? []);
  const deps: AppsDeps = {
    registryDir,
    storeDir,
    run: async (argv) => {
      ran.push(argv);
      return opts.replies?.[argv.join(" ")] ?? { code: 0, stdout: "" };
    },
    alive: (pid) => alive.has(pid),
    procStart: (pid) => (opts.starts && pid in opts.starts ? opts.starts[pid]! : START),
    own: () => new Set(opts.own ?? []),
    sleep: async (ms) => {
      state.slept += ms;
      state.onSleep(ms);
    },
  };
  const holder = (pid: number, fields: Record<string, unknown> = {}) =>
    writeFileSync(
      join(registryDir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: "/repo", entrypoint: "cli", kind: "interactive", status: "idle", procStart: START, ...fields }),
    );
  const entry = (localId: string, cli: string, fields: Record<string, unknown> = {}) =>
    writeFileSync(join(orgDir, `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: cli, isArchived: false, title: "T", ...fields }));
  return { deps, ran, state, registryDir, holder, entry, apps: () => createClaudeApps(deps) };
}

test("an alive holder with a matching start is listed, busy or idle", () => {
  const h = harness({ alive: [10, 11] });
  h.holder(10, { status: "busy", entrypoint: "claude-desktop" });
  h.holder(11);
  const holders = h.apps().holders();
  expect(holders.get(sid("s-10"))).toEqual({ pid: 10, sessionId: sid("s-10"), entrypoint: "claude-desktop", kind: "interactive", cwd: "/repo", busy: true });
  expect(holders.get(sid("s-11"))?.busy).toBe(false);
});

test("a dead pid, a reused pid, the bridge's own child and a malformed file are not holders", () => {
  const h = harness({ alive: [20, 21, 22, 24], starts: { 21: "Sat Oct 17 09:00:00 2026" }, own: [22] });
  h.holder(20, { sessionId: "kept" });
  h.holder(21);
  h.holder(22);
  h.holder(23);
  h.holder(24, { procStart: undefined });
  writeFileSync(join(h.registryDir, "25.json"), '{"pid": 25, "sessionId": "s-');
  writeFileSync(join(h.registryDir, "20.aaaa.key"), "{}");
  expect([...h.apps().holders().keys()]).toEqual([sid("kept")]);
});

test("a start padded differently by ps still matches", () => {
  const h = harness({ alive: [30], starts: { 30: "Sun Oct  4 16:20:13 2026" } });
  h.holder(30, { procStart: "Sun Oct 4 16:20:13 2026" });
  expect(h.apps().holders().has(sid("s-30"))).toBe(true);
});

test("an alive holder whose start ps cannot read is kept", () => {
  const h = harness({ alive: [35], starts: { 35: null } });
  h.holder(35);
  expect(h.apps().holders().has(sid("s-35"))).toBe(true);
});

test("two processes on one id: the busy one wins", () => {
  const h = harness({ alive: [40, 41, 42] });
  h.holder(40, { sessionId: "shared" });
  h.holder(41, { sessionId: "shared", status: "busy" });
  h.holder(42, { sessionId: "shared" });
  expect(h.apps().holders().get(sid("shared"))?.pid).toBe(41);
});

test("the desktop store maps by cliSessionId, with archived and the spawning parent's cli id", () => {
  const h = harness();
  h.entry("local_p", "cli-parent");
  h.entry("local_c", "cli-child", { isArchived: true, title: undefined, spawnedFrom: { sessionId: "local_p", taskId: "t" } });
  h.entry("local_o", "cli-orphan", { spawnedFrom: { sessionId: "local_gone" } });
  writeFileSync(join(h.deps.storeDir, "acct", "org", "local_bad.json"), "not json");
  writeFileSync(join(h.deps.storeDir, "acct", "org", "other.json"), JSON.stringify({ sessionId: "local_x", cliSessionId: "cli-x" }));
  const desktop = h.apps().desktop();
  expect(desktop.size).toBe(3);
  expect(desktop.get(sid("cli-parent"))).toEqual({ localId: "local_p", archived: false, parent: null, title: "T" });
  expect(desktop.get(sid("cli-child"))).toEqual({ localId: "local_c", archived: true, parent: sid("cli-parent"), title: null });
  expect(desktop.get(sid("cli-orphan"))?.parent).toBeNull();
});

test("missing directories read as empty", () => {
  const h = harness();
  rmSync(h.deps.storeDir, { recursive: true });
  rmSync(h.registryDir, { recursive: true });
  const apps = h.apps();
  expect(apps.holders().size).toBe(0);
  expect(apps.desktop().size).toBe(0);
});

const FIND = "lsappinfo find bundleid=com.anthropic.claudefordesktop";
const FRONT = "lsappinfo front";
const INFO = 'lsappinfo info -only bundleid ASN:0x0-0x1:';

test("desktopState tells absent, background and front apart", async () => {
  const running = { code: 0, stdout: 'ASN:0x0-0x7a9:"Claude":\n' };
  const front = { code: 0, stdout: "ASN:0x0-0x1:\n" };
  expect(await harness().apps().desktopState()).toBe("absent");
  const bg = harness({ replies: { [FIND]: running, [FRONT]: front, [INFO]: { code: 0, stdout: '"CFBundleIdentifier"="com.apple.Terminal"\n' } } });
  expect(await bg.apps().desktopState()).toBe("background");
  const fg = harness({ replies: { [FIND]: running, [FRONT]: front, [INFO]: { code: 0, stdout: '"CFBundleIdentifier"="com.anthropic.claudefordesktop"\n' } } });
  expect(await fg.apps().desktopState()).toBe("front");
});

test("idleSeconds reads HIDIdleTime, null when it is missing or ioreg fails", async () => {
  const IOREG = "ioreg -c IOHIDSystem -d 4";
  const ok = harness({ replies: { [IOREG]: { code: 0, stdout: '  | |   "HIDIdleTime" = 2453750932958\n' } } });
  expect(await ok.apps().idleSeconds()).toBe(2453);
  expect(await harness({ replies: { [IOREG]: { code: 0, stdout: "nothing here" } } }).apps().idleSeconds()).toBeNull();
  expect(await harness({ replies: { [IOREG]: { code: 1, stdout: '"HIDIdleTime" = 5000000000' } } }).apps().idleSeconds()).toBeNull();
});

test("importToDesktop on an id the store already lists runs nothing", async () => {
  const h = harness();
  h.entry("local_a", "cli-a");
  expect(await h.apps().importToDesktop(sid("cli-a"))).toBe(true);
  expect(h.ran).toEqual([]);
});

test("importToDesktop opens the deep link once and succeeds when the entry appears", async () => {
  const h = harness();
  const apps = h.apps();
  let changes = 0;
  apps.onChange(() => changes++);
  h.state.onSleep = () => {
    if (h.state.slept === 1500) h.entry("local_n", "cli-new");
  };
  expect(await apps.importToDesktop(sid("cli-new"))).toBe(true);
  expect(h.ran).toEqual([["open", "-g", "claude://resume?session=cli-new"]]);
  expect(h.state.slept).toBe(1500);
  expect(apps.desktop().has(sid("cli-new"))).toBe(true);
  expect(changes).toBe(1);
});

test("importToDesktop gives up after 10 s when the entry never appears", async () => {
  const h = harness();
  expect(await h.apps().importToDesktop(sid("cli-never"))).toBe(false);
  expect(h.state.slept).toBe(10_000);
  expect(h.ran).toEqual([["open", "-g", "claude://resume?session=cli-never"]]);
});

test("openInDesktop imports, then brings the app forward", async () => {
  const h = harness();
  h.entry("local_a", "cli-a");
  expect(await h.apps().openInDesktop(sid("cli-a"))).toBe(true);
  expect(h.ran).toEqual([["open", "-b", "com.anthropic.claudefordesktop"]]);
});

test("refresh notifies only when a snapshot changed", () => {
  const h = harness({ alive: [50] });
  const apps = h.apps();
  let changes = 0;
  apps.onChange(() => changes++);
  apps.refresh();
  expect(changes).toBe(0);
  h.holder(50);
  apps.refresh();
  expect(changes).toBe(1);
  expect(apps.holders().has(sid("s-50"))).toBe(true);
  apps.refresh();
  expect(changes).toBe(1);
  h.holder(50, { status: "busy" });
  apps.refresh();
  expect(changes).toBe(2);
  h.entry("local_z", "cli-z");
  apps.refresh();
  expect(changes).toBe(3);
});
