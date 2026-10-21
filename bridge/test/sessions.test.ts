import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeApps, DesktopEntry, Live } from "../src/claudeApps";
import type { AgentId, BotId, ServerMessage, SessionId, SessionItem, SessionRow, SessionsChannelFrame, ThreadChannelFrame } from "../src/protocol";
import { createSessions, type Sessions } from "../src/sessions";
import { emptySession, emptyWorld, own, type AgentRecord, type SessionState, type World } from "../src/world";

// The Sessions facade over a temp CLAUDE_CONFIG_DIR holding recorded transcripts, with the Claude app faked and the
// sockets' channels recorded. Driving sessions (send, cards) is tested where the drivers are.

const FIXTURES = join(import.meta.dir, "transcripts", "jsonl");
const ASK = "22222222-2222-4222-8222-222222222222" as SessionId;
const PERMISSION = "11111111-1111-4111-8111-111111111111" as SessionId;

let base: string;
let previous: string | undefined;
let repo: string;
let folder: string;
let world: World;
let sessions: Sessions;
let list: SessionsChannelFrame[];
let thread: { id: SessionId; frame: ThreadChannelFrame }[];
let watchers: Map<SessionId, number>;
let holders: Map<SessionId, Live>;
let changes: (() => void)[];
/** The Claude app as the test sets it: what it lists, whether it is in front, how idle the Mac is, what imports do. */
let app: { listed: Map<SessionId, DesktopEntry>; state: "absent" | "background" | "front"; idle: number | null; lists: boolean; imports: SessionId[]; opened: SessionId[] };

const fakeApps = (): ClaudeApps => ({
  holders: () => holders,
  desktop: () => app.listed,
  desktopState: async () => app.state,
  idleSeconds: async () => app.idle,
  async importToDesktop(id) {
    app.imports.push(id);
    if (app.lists) app.listed.set(id, { localId: `local_${id}`, archived: false, parent: null, title: null });
    return app.lists;
  },
  async openInDesktop(id) {
    app.opened.push(id);
    if (app.lists) app.listed.set(id, { localId: `local_${id}`, archived: false, parent: null, title: null });
    return app.lists;
  },
  refresh() {},
  onChange: (f) => void changes.push(f),
  close() {},
});

const fileOf = (id: SessionId) => join(folder, `${id}.jsonl`);
const install = (name: string, id: SessionId, cwd = repo) => writeFileSync(fileOf(id), readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").replaceAll("<cwd>", cwd));

async function until<T>(get: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function start(over: Partial<Parameters<typeof createSessions>[0]> = {}) {
  sessions = createSessions({
    epoch: "e1",
    projectsDir: join(base, "projects"),
    apps: fakeApps(),
    cacheDir: join(base, "cache"),
    // Copies: bun's toMatchObject writes its matchers into the object it checks, which here is the thread's own state.
    signal: { list: (f) => list.push(structuredClone(f)), thread: (id, frame) => thread.push({ id, frame: structuredClone(frame) }) },
    watchers: (id) => watchers.get(id) ?? 0,
    coalesceMs: 0,
    watch: false,
    world,
    userName: "Alex",
    bridgeHome: join(base, "home"),
    roots: [base],
    agents: { session: () => null, direct: () => "no agents here", stop: async () => false, message: async () => "" },
    decideGate: () => ({ ok: false, error: "Unknown card" }),
    ledger: { add() {}, headroom: () => ({ ok: true, capReached: false }), budgetLeft: () => null, dailyLeft: () => null },
    claude: { query: (() => { throw new Error("no Claude Code in this test"); }) as never, executable: () => "/fake/claude" },
    scope: (cwd) => ({ bridgeHome: join(base, "home"), own: cwd, userMd: null, homedir: base }),
    folders: () => [],
    persist: () => {},
    now: () => new Date(),
    log: () => {},
    ...over,
  });
  return sessions.start().then(() => void list.splice(0));
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sessions-")));
  previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = base;
  repo = join(base, "demo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  folder = join(base, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  install("own-ask", ASK);
  install("own-permission", PERMISSION);
  world = emptyWorld();
  list = [];
  thread = [];
  watchers = new Map();
  holders = new Map();
  changes = [];
  app = { listed: new Map(), state: "absent", idle: null, lists: true, imports: [], opened: [] };
});
afterEach(() => {
  sessions?.stop();
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(base, { recursive: true, force: true });
});

const one = async (m: Parameters<Sessions["handle"]>[0]) => {
  const replies = structuredClone(await sessions.handle(m));
  expect(replies).toHaveLength(1);
  return replies[0]!;
};
const rowsOf = async () => ((await one({ type: "watch_sessions" })) as Extract<ServerMessage, { type: "sessions" }>).rows;
const rowOf = (rows: SessionRow[], id: SessionId) => rows.find((r) => r.id === id)!;

function continueWith(id: SessionId, entry: Record<string, unknown>) {
  const lines = readFileSync(fileOf(id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const leaf = lines.findLast((l) => typeof l.uuid === "string" && ["user", "assistant", "attachment", "system"].includes(String(l.type)))!;
  const uuid = crypto.randomUUID();
  appendFileSync(fileOf(id), `${JSON.stringify({ parentUuid: leaf.uuid, isSidechain: false, cwd: repo, sessionId: id, timestamp: new Date().toISOString(), uuid, ...entry })}\n`);
  return uuid;
}

test("the list groups every transcript under its project, with what each row needs", async () => {
  await start();
  const frame = (await one({ type: "watch_sessions" })) as Extract<ServerMessage, { type: "sessions" }>;
  expect(frame.mirror).toBe("auto");
  expect(frame.projects).toEqual([expect.objectContaining({ name: "demo", path: repo, githubRepo: null, canCloud: false })]);
  expect(frame.rows.map((r) => r.id).sort()).toEqual([PERMISSION, ASK].sort());
  expect(rowOf(frame.rows, ASK)).toMatchObject({ projectId: frame.projects[0]!.id, origin: "sdk", status: "idle", holder: "none", unread: false, worktree: false, mirror: "none", hidden: false, agent: null, parentId: null });
});

test("a session another Claude Code holds busy shows working in the Claude app", async () => {
  await start();
  holders.set(ASK, { pid: 1, sessionId: ASK, entrypoint: "claude-desktop", kind: "interactive", cwd: repo, status: "busy", waitingFor: null });
  for (const f of changes) f();
  const frame = await until(() => list.find((f) => f.rows.some((r) => r.id === ASK)), "a row diff");
  expect(rowOf(frame.rows, ASK)).toMatchObject({ status: "working", holder: "desktop" });
  expect(frame.rows).toHaveLength(1);
});

test("a thread opens on its newest page, then streams what Claude Code appends, and a reconnect replays it", async () => {
  await start();
  watchers.set(ASK, 1);
  const snapshot = (await one({ type: "watch_session", sessionId: ASK, after: null })) as Extract<ServerMessage, { type: "session" }>;
  const epoch = snapshot.epoch;
  expect(epoch).toStartWith("e1.");
  expect(snapshot).toMatchObject({ rev: 0, before: null, live: null, controls: { canSend: true, queued: 0, working: false } });
  expect(snapshot.items.map((i) => i.kind)).toEqual(["user", "work", "assistant", "ask", "work", "assistant"]);

  const prompt = continueWith(ASK, { type: "user", message: { role: "user", content: "One more thing" } });
  await sessions.sync();
  const frame = thread.find((t) => t.id === ASK)?.frame;
  expect(frame).toMatchObject({ type: "session_items", rev: 1, removed: [], controls: null, items: [expect.objectContaining({ kind: "user", id: prompt, text: "One more thing" })] });

  const replayed = structuredClone(await sessions.handle({ type: "watch_session", sessionId: ASK, after: { epoch, rev: 0 } }));
  expect(replayed).toEqual([{ type: "session_items", sessionId: ASK, rev: 1, items: [expect.objectContaining({ id: prompt })], removed: [], controls: expect.objectContaining({ canSend: true }) }]);
  const fresh = (await one({ type: "watch_session", sessionId: ASK, after: { epoch: "e0.1", rev: 1 } })) as Extract<ServerMessage, { type: "session" }>;
  expect(fresh.type).toBe("session");
  expect(fresh.items.at(-1)).toMatchObject({ id: prompt });
});

test("a rewind is a fork: the abandoned branch is removed and the new one upserted", async () => {
  await start();
  watchers.set(ASK, 1);
  const snapshot = (await one({ type: "watch_session", sessionId: ASK, after: null })) as Extract<ServerMessage, { type: "session" }>;
  const first = readFileSync(fileOf(ASK), "utf8").split("\n").map((l) => (l ? JSON.parse(l) : {})).find((l) => l.type === "user")!;
  const uuid = crypto.randomUUID();
  appendFileSync(fileOf(ASK), `${JSON.stringify({ parentUuid: first.parentUuid, isSidechain: false, type: "user", message: { role: "user", content: "Start over" }, cwd: repo, sessionId: ASK, timestamp: new Date().toISOString(), uuid })}\n`);
  await sessions.sync();
  const frame = thread.find((t) => t.frame.type === "session_items")?.frame as Extract<ThreadChannelFrame, { type: "session_items" }>;
  expect(frame.items.map((i) => i.id)).toEqual([uuid as never]);
  expect(frame.removed.sort()).toEqual(snapshot.items.map((i) => i.id).sort());
});

test("leaving a thread marks it visited; a later answer makes it unread until it is opened again", async () => {
  await start();
  watchers.set(ASK, 1);
  await sessions.handle({ type: "watch_session", sessionId: ASK, after: null });
  expect(rowOf(await rowsOf(), ASK).unread).toBe(false);
  watchers.set(ASK, 0);
  await sessions.handle({ type: "unwatch_session", sessionId: ASK });
  expect(world.sessions.get(ASK)?.visitedAt).toEqual(expect.any(String));
  await Bun.sleep(5);
  continueWith(ASK, { type: "assistant", message: { id: "msg_late", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Also done." }] }, apiBlockIndex: 0 });
  await sessions.sync();
  const frame = list.find((f) => f.rows.some((r) => r.id === ASK && r.unread))!;
  expect(rowOf(frame.rows, ASK).unread).toBe(true);
  expect(rowOf(await rowsOf(), PERMISSION).unread).toBe(false);
});

test("Mark as Read on a session never opened records the visit, and watching the list again answers the list as it is now", async () => {
  await start();
  expect(world.sessions.get(PERMISSION)?.visitedAt ?? null).toBeNull();
  expect(await sessions.handle({ type: "unwatch_session", sessionId: PERMISSION })).toEqual([]);
  expect(world.sessions.get(PERMISSION)?.visitedAt).toEqual(expect.any(String));

  expect((await rowsOf()).map((r) => r.id).sort()).toEqual([PERMISSION, ASK].sort());
  const later = "33333333-3333-4333-8333-333333333333" as SessionId;
  install("own-plan", later);
  await sessions.sync();
  expect((await rowsOf()).map((r) => r.id).sort()).toEqual([PERMISSION, ASK, later].sort());
});

test("hide, rename through Claude Code, the mirror setting, and a tool's full output", async () => {
  await start();
  expect(await sessions.handle({ type: "session_set", sessionId: ASK, patch: { hidden: true } })).toEqual([]);
  expect(await sessions.handle({ type: "session_set", sessionId: ASK, patch: { title: "Color picker" } })).toEqual([]);
  expect(readFileSync(fileOf(ASK), "utf8")).toContain('"customTitle":"Color picker"');
  const renamed = await until(() => list.find((f) => f.rows.some((r) => r.id === ASK && r.title === "Color picker")), "the renamed row");
  expect(rowOf(renamed.rows, ASK)).toMatchObject({ hidden: true, title: "Color picker" });
  expect(((await one({ type: "session_prefs", mirror: "tap" })) as Extract<ServerMessage, { type: "sessions" }>).mirror).toBe("tap");
  expect(world.sessionPrefs.mirror).toBe("tap");

  const snapshot = (await one({ type: "watch_session", sessionId: PERMISSION, after: null })) as Extract<ServerMessage, { type: "session" }>;
  const bash = (snapshot.items.find((i) => i.kind === "work") as Extract<SessionItem, { kind: "work" }>).steps.find((s) => s.tool === "Bash")!;
  expect(await one({ type: "session_tool", sessionId: PERMISSION, toolUseId: bash.id })).toEqual({ type: "session_tool_output", sessionId: PERMISSION, toolUseId: bash.id, output: expect.stringContaining("TWO") });
});

test("a transcript that goes away leaves the list and its thread says so", async () => {
  await start();
  watchers.set(ASK, 1);
  await sessions.handle({ type: "watch_session", sessionId: ASK, after: null });
  rmSync(fileOf(ASK));
  await sessions.sync();
  const frame = list.find((f) => f.removed.includes(ASK))!;
  expect(frame.removed).toEqual([ASK]);
  expect(thread.find((t) => t.frame.type === "session_removed")?.frame).toEqual({ type: "session_removed", sessionId: ASK, movedTo: null });
  expect(await sessions.handle({ type: "watch_session", sessionId: ASK, after: null })).toEqual([{ type: "session_removed", sessionId: ASK, movedTo: null }]);
});

test("a bot's own sessions, under the bridge home, are not listed", async () => {
  const home = join(base, "home", "bots", "b_1");
  mkdirSync(home, { recursive: true });
  const botFolder = join(base, "projects", home.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(botFolder, { recursive: true });
  writeFileSync(join(botFolder, "33333333-3333-4333-8333-333333333333.jsonl"), readFileSync(join(FIXTURES, "own-plan.jsonl"), "utf8").replaceAll("<cwd>", home));
  await start();
  expect((await rowsOf()).map((r) => r.id).sort()).toEqual([PERMISSION, ASK].sort());
});


test("sessions left in temp folders outside the project roots are not listed; the roots' own are", async () => {
  const leftover = join(realpathSync(tmpdir()), `leftover-${crypto.randomUUID()}`);
  const leftoverFolder = join(base, "projects", leftover.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(leftoverFolder, { recursive: true });
  writeFileSync(join(leftoverFolder, "33333333-3333-4333-8333-333333333333.jsonl"), readFileSync(join(FIXTURES, "own-plan.jsonl"), "utf8").replaceAll("<cwd>", leftover));
  const tmp = "/private/tmp/scratch";
  const tmpFolder = join(base, "projects", tmp.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(tmpFolder, { recursive: true });
  writeFileSync(join(tmpFolder, "44444444-4444-4444-8444-444444444444.jsonl"), readFileSync(join(FIXTURES, "own-plan.jsonl"), "utf8").replaceAll("<cwd>", tmp));
  await start({ roots: [realpathSync(tmpdir())] });
  expect((await rowsOf()).map((r) => r.id)).toContain("33333333-3333-4333-8333-333333333333" as SessionId);
  sessions.stop();

  await start();
  expect(repo.startsWith(realpathSync(tmpdir()))).toBe(true);
  expect((await rowsOf()).map((r) => r.id).sort(), "a leftover the last start cached is dropped too").toEqual([PERMISSION, ASK].sort());
});

function agentOn(id: SessionId, over: Partial<AgentRecord["agent"]> = {}): AgentRecord {
  const rec: AgentRecord = {
    agent: { id: "a_1" as AgentId, botId: "b_1" as BotId, title: "Pick a color", where: "mac", projectName: "demo", status: "waiting", url: null, createdAt: "2026-10-18T12:00:00.000Z", updatedAt: "2026-10-18T12:00:00.000Z", evidence: null, worktree: null, ...over },
    cwd: repo,
    repo,
    messages: [],
    session: emptySession(id),
    cloudSession: null,
    budgetUsd: null,
    startedBy: { kind: "user" },
  };
  world.agents.set(rec.agent.id, rec);
  return rec;
}

test("an agent's session lists under its project before Claude Code has written a word, and fills in once it does", async () => {
  const id = crypto.randomUUID() as SessionId;
  agentOn(id, { status: "working" });
  await start();
  expect(rowOf(await rowsOf(), id)).toMatchObject({ title: "Pick a color", origin: "agent", agent: { botId: "b_1", agentId: "a_1" }, status: "working" });
  watchers.set(id, 1);
  expect(await one({ type: "watch_session", sessionId: id, after: null })).toMatchObject({ type: "session", items: [] });
  install("own-ask", id);
  await sessions.sync();
  const frame = thread.find((t) => t.id === id)?.frame as Extract<ThreadChannelFrame, { type: "session_items" }>;
  expect(frame.items.map((i) => i.kind)).toEqual(["user", "work", "assistant", "ask", "work", "assistant"]);
  expect(frame.items[0]).toMatchObject({ kind: "user", from: "bot" });
});

test("an agent's session that restarts under a new id moves its watchers there", async () => {
  const rec = agentOn(ASK);
  await start();
  sessions.agentChanged(rec);
  watchers.set(ASK, 1);
  await sessions.handle({ type: "watch_session", sessionId: ASK, after: null });
  own<SessionState>(rec.session).id = PERMISSION;
  sessions.agentChanged(rec);
  expect(thread.find((t) => t.frame.type === "session_removed")?.frame).toEqual({ type: "session_removed", sessionId: ASK, movedTo: PERMISSION });
});

describe("the Claude app mirror", () => {
  const due = async () => {
    const rec = agentOn(ASK);
    await start();
    sessions.agentTurnDone(rec);
    return rec;
  };
  const tickOnce = async () => {
    sessions.tick(new Date(Date.now() + 61_000 * ++ticks));
    await Bun.sleep(20);
  };
  let ticks = 0;

  test("after an agent's first finished turn the session is due, and imports only while the app is in the background and the Mac idle", async () => {
    await due();
    expect(rowOf(await rowsOf(), ASK).mirror).toBe("pending");
    app.state = "front";
    app.idle = 600;
    await tickOnce();
    app.state = "background";
    app.idle = 30;
    await tickOnce();
    expect(app.imports).toEqual([]);
    app.idle = 600;
    await tickOnce();
    expect(app.imports).toEqual([ASK]);
    expect(world.sessions.get(ASK)?.mirror).toBeUndefined();
    expect(rowOf(await rowsOf(), ASK).mirror).toBe("imported");
    await tickOnce();
    expect(app.imports).toEqual([ASK]);
  });

  test("an import the app never lists is failed and not tried again; Open in Claude app still tries", async () => {
    await due();
    app.state = "background";
    app.idle = 600;
    app.lists = false;
    await tickOnce();
    await tickOnce();
    expect(app.imports).toEqual([ASK]);
    expect(rowOf(await rowsOf(), ASK).mirror).toBe("failed");
    expect(await sessions.handle({ type: "session_open_desktop", sessionId: ASK })).toEqual([{ type: "error", message: expect.stringContaining("claude://") }]);
    app.lists = true;
    expect(await sessions.handle({ type: "session_open_desktop", sessionId: ASK })).toEqual([]);
    expect(app.opened).toEqual([ASK, ASK]);
    expect(rowOf(await rowsOf(), ASK).mirror).toBe("imported");
  });

  test("with the setting on When I tap, nothing is imported on its own", async () => {
    await start();
    await sessions.handle({ type: "session_prefs", mirror: "tap" });
    sessions.agentTurnDone(agentOn(ASK));
    app.state = "background";
    app.idle = 600;
    await tickOnce();
    expect([app.imports, world.sessions.get(ASK)?.mirror, rowOf(await rowsOf(), ASK).mirror]).toEqual([[], undefined, "none"]);
  });
});
