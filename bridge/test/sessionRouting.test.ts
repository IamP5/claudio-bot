import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubDeps } from "../src/hub";
import type { Machine } from "../src/machine/machines";
import { profileOf } from "../src/machine/profile";
import { createRemoteSessions } from "../src/machine/remoteSessions";
import { profileView, type EventBody, type Intent, type MachineId, type SessionReply, type SessionSignal } from "../src/machine/wire";
import type { AgentId, BotId, MessageId, ProjectId, ServerMessage, SessionClientMessage, SessionId, SessionProject, SessionRow, SessionsChannelFrame } from "../src/protocol";
import { newDrive } from "../src/own";
import type { ThreadSignal } from "../src/sessions";
import { emptyWorld, type World } from "../src/world";
import { bot, cleanup, flush, hubOver, roots } from "./hub-kit";

afterEach(cleanup);

const MAC = "m_mac" as MachineId;
const HOME = "m_test" as MachineId;
const at = "2026-10-21T12:00:00.000Z";
const S1 = "11111111-1111-4111-8111-000000000001" as SessionId;
const S2 = "11111111-1111-4111-8111-000000000002" as SessionId;
const NEW = "11111111-1111-4111-8111-00000000000a" as SessionId;
const P = "p_shop" as ProjectId;

const row = (id: SessionId, machine: MachineId = MAC): SessionRow => ({
  id,
  machine,
  projectId: P,
  parentId: null,
  title: `title of ${id.slice(-1)}`,
  origin: "phone",
  agent: null,
  status: "idle",
  holder: "none",
  unread: false,
  branch: "main",
  worktree: false,
  pr: null,
  mirror: "none",
  hidden: false,
  url: null,
  createdAt: at,
  lastAt: at,
});
const project: SessionProject = { id: P, name: "shop", path: "/Users/alex/code/shop", githubRepo: null, lastAt: at, canCloud: false };
const listOf = (...rows: SessionRow[]): Extract<SessionReply, { type: "sessions" }> => ({ type: "sessions", rows, projects: [project], mirror: "auto" });

test("a machine's rows are re-stamped with the machine their link names, removed when its next list drops them, and the home wins an id both list", () => {
  const home = new Set<SessionId>();
  const r = createRemoteSessions({ home: (id) => home.has(id) });
  expect(r.replace(MAC, listOf(row(S1, "m_lies" as MachineId), row(S2)))).toEqual({ type: "session_rows", rows: [row(S1), row(S2)], removed: [], projects: [project] });
  expect(r.ownerOf(S1)).toBe(MAC);
  expect(r.replace(MAC, listOf(row(S2)))).toMatchObject({ rows: [row(S2)], removed: [S1] });
  expect(r.ownerOf(S1)).toBeNull();

  home.add(S2);
  expect(r.ownerOf(S2)).toBeNull();
  expect(r.list().rows).toEqual([]);
  expect(r.apply(MAC, { type: "session_rows", rows: [row(S2)], removed: [], projects: [] }).rows).toEqual([]);
});

test("a session the machine answered for routes to it before its rows name it", () => {
  const r = createRemoteSessions({ home: () => false });
  expect(r.ownerOf(NEW)).toBeNull();
  r.claim(MAC, NEW);
  expect(r.ownerOf(NEW)).toBe(MAC);
  expect(r.idsOf(MAC)).toEqual([NEW]);
  r.apply(MAC, { type: "session_rows", rows: [row(NEW)], removed: [], projects: [] });
  expect(r.idsOf(MAC)).toEqual([NEW]);
});

test("a session id or project another machine already lists stays that machine's: a second machine cannot take, remove or claim it", () => {
  const STUDIO = "m_studio" as MachineId;
  const r = createRemoteSessions({ home: () => false });
  r.replace(MAC, listOf(row(S1)));
  const studio = r.replace(STUDIO, listOf(row(S1, STUDIO), row(S2, STUDIO)));
  expect(studio).toEqual({ type: "session_rows", rows: [row(S2, STUDIO)], removed: [], projects: [] });
  expect(r.ownerOf(S1)).toBe(MAC);
  r.claim(STUDIO, S1);
  expect(r.ownerOf(S1)).toBe(MAC);
  expect(r.apply(STUDIO, { type: "session_rows", rows: [], removed: [S1], projects: [] }).removed).toEqual([]);
  expect(r.ownerOf(S1)).toBe(MAC);
  expect(r.list().rows.map((x) => [x.id, x.machine])).toEqual([
    [S1, MAC],
    [S2, STUDIO],
  ]);
  expect(r.list().projects).toEqual([project]);
});

/** A home with the Sessions tab over an empty ~/.claude, and one enrolled machine the test answers for. */
function setup(world: World = emptyWorld()) {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-routing-"));
  roots.push(dir);
  let online = false;
  const change: (() => void)[] = [];
  const events: ((id: MachineId, e: { seq: number; at: string } & EventBody) => void)[] = [];
  const signals: ((id: MachineId, f: SessionSignal) => void)[] = [];
  const asked: SessionClientMessage[] = [];
  const intents: Intent[] = [];
  let answer: (m: SessionClientMessage) => SessionReply[] = (m) => (m.type === "watch_sessions" ? [listOf(row(S1))] : []);
  const mac: Machine = {
    id: MAC,
    name: "MacBook",
    profile: () => profileView(profileOf({ env: {}, platform: "darwin", name: "MacBook", homedir: "/Users/alex", username: "alex" })),
    status: () => ({ online, since: null }),
    async send(intent) {
      if (!online) return { ok: false, reason: "MacBook is offline", undelivered: true };
      intents.push(intent);
      return { ok: true };
    },
  };
  const links: NonNullable<HubDeps["links"]> = {
    machines: () => [mac],
    onChange: (f) => void change.push(f),
    onEvent: (f) => void events.push(f),
    onSignal: (f) => void signals.push(f),
    async ask(_, m) {
      if (!online) return { ok: false, reason: "MacBook is offline" };
      asked.push(m);
      return { ok: true, frames: answer(m) };
    },
  };
  const list: SessionsChannelFrame[] = [];
  const thread: { id: SessionId; frame: ThreadSignal }[] = [];
  const watchers = new Map<SessionId, number>();
  const notified: [SessionId, MessageId][] = [];
  const apps = { holders: () => new Map(), desktop: () => new Map(), desktopState: async () => "absent" as const, idleSeconds: async () => null, importToDesktop: async () => false, openInDesktop: async () => false, refresh() {}, onChange() {}, close() {} };
  const h = hubOver(world, {
    links,
    sessions: { epoch: "e1", projectsDir: join(dir, "projects"), apps, cacheDir: join(dir, "cache"), signal: { list: (f) => list.push(f), thread: (id, frame) => thread.push({ id, frame }) }, watchers: (id) => watchers.get(id) ?? 0, watch: false },
    push: { notify: () => true, notifySession: (id, cardId) => (notified.push([id, cardId]), true), tick() {}, nextDeadline: () => null },
  });
  let seq = 0;
  return {
    h,
    asked,
    intents,
    list,
    thread,
    watchers,
    notified,
    answers: (f: typeof answer) => (answer = f),
    async flip(to: boolean) {
      online = to;
      change.forEach((f) => f());
      await flush();
      await flush();
    },
    signal: (f: SessionSignal) => signals.forEach((s) => s(MAC, f)),
    event: (body: EventBody) => events.forEach((e) => e(MAC, { seq: ++seq, at, ...body })),
    ask: (m: SessionClientMessage) => h.hub.handle(m),
  };
}

const rowsOf = (frames: ServerMessage[]) => (frames[0]?.type === "sessions" ? frames[0].rows.map((r) => [r.id, r.machine]) : null);

test("the Sessions tab lists the home's rows and each machine's, by machine, for a client that never names a machine", async () => {
  const world = emptyWorld();
  world.sessions.set(S2, { id: S2, hidden: false, visitedAt: null, own: newDrive({ id: S2, cwd: "/tmp/x", created: true, at, model: null, mode: null, prompt: "Draft" }) });
  const m = setup(world);
  await m.flip(true);
  expect(m.asked.map((a) => a.type)).toEqual(["watch_sessions"]);
  expect(m.list).toEqual([{ type: "session_rows", rows: [row(S1)], removed: [], projects: [project] }]);
  const frames = await m.ask({ type: "watch_sessions" });
  expect(rowsOf(frames)).toEqual([
    [S2, HOME],
    [S1, MAC],
  ]);
  expect(frames[0]?.type === "sessions" && frames[0].projects.map((p) => p.name)).toContain("shop");
});

test("an offline machine's rows stay as last known", async () => {
  const m = setup();
  await m.flip(true);
  await m.flip(false);
  expect(rowsOf(await m.ask({ type: "watch_sessions" }))).toEqual([[S1, MAC]]);
});

test("a request about a machine's session goes to that machine and its frames come back; an id no machine lists stays on the home", async () => {
  const m = setup();
  await m.flip(true);
  m.answers((a) => (a.type === "session_stop" ? [{ type: "error", message: "Nothing is running." }] : []));
  const send = { type: "session_send", sessionId: S1, text: "Run the tests.", clientId: "c1", interrupt: false } as const;
  expect(await m.ask(send)).toEqual([]);
  expect(await m.ask({ type: "session_stop", sessionId: S1 })).toEqual([{ type: "error", message: "Nothing is running." }]);
  expect(m.asked.slice(1)).toEqual([send, { type: "session_stop", sessionId: S1 }]);

  expect(await m.ask({ type: "session_send", sessionId: S2, text: "x", clientId: "c2", interrupt: false })).toEqual([{ type: "error", message: "This session's transcript is gone." }]);
  expect(m.asked).toHaveLength(3);
});

test("session_create on a machine starts the session there, and the new id routes to it before its row arrives", async () => {
  const m = setup();
  await m.flip(true);
  m.answers((a) => (a.type === "session_create" ? [{ type: "session_created", ref: a.ref, sessionId: NEW }] : []));
  const create = { type: "session_create", ref: "r1", projectId: P, text: "Fix it.", model: null, mode: null, isolate: "none", machine: MAC } as const;
  expect(await m.ask(create)).toEqual([{ type: "session_created", ref: "r1", sessionId: NEW }]);
  await m.ask({ type: "watch_session", sessionId: NEW, after: null });
  expect(m.asked.slice(1).map((a) => a.type)).toEqual(["session_create", "watch_session"]);

  const { machine: _, ...here } = create;
  m.asked.length = 0;
  await m.ask(here);
  expect(m.asked).toEqual([]);
});

test("a send, a stop or a create on an offline machine is refused in words, and nothing waits to run later", async () => {
  const m = setup();
  await m.flip(true);
  await m.flip(false);
  m.asked.length = 0;
  expect(await m.ask({ type: "session_send", sessionId: S1, text: "x", clientId: "c1", interrupt: false })).toEqual([
    { type: "error", message: "MacBook is offline, so your message was not sent. Send it again when it is back." },
  ]);
  expect(await m.ask({ type: "session_stop", sessionId: S1 })).toEqual([{ type: "error", message: "MacBook is offline, so nothing was stopped." }]);
  expect(await m.ask({ type: "session_create", ref: "r", projectId: P, text: "x", model: null, mode: null, isolate: "none", machine: MAC })).toEqual([
    { type: "error", message: "MacBook is offline, so the session did not start." },
  ]);
  await m.flip(true);
  expect(m.asked.map((a) => a.type)).toEqual(["watch_sessions"]);
});

test("a decide on a machine's agent card goes to that machine as card.answer; one on its own session's card goes to its Sessions tab", async () => {
  const world = emptyWorld();
  const B = "b_eng" as BotId;
  world.bots.set(B, bot("eng"));
  const m = setup(world);
  await m.flip(true);
  const card = { kind: "permission", id: "c_gate" as MessageId, at, from: { kind: "agent", id: "a_mac1" as AgentId, title: "Fix" }, tool: "Bash", label: "Run", detail: "ls", always: "", answer: null, expiresAt: "2099-01-01T00:00:00.000Z" } as const;
  m.event({ kind: "card", botId: B, message: card });
  expect(await m.ask({ type: "session_decide", sessionId: S1, cardId: "c_gate" as MessageId, choice: "once" })).toEqual([]);
  expect(m.intents).toMatchObject([{ kind: "card.answer", botId: B, cardId: "c_gate", reply: { kind: "permission", choice: "once" } }]);

  await m.ask({ type: "session_decide", sessionId: S1, cardId: "c_own" as MessageId, choice: "deny" });
  expect(m.asked.at(-1)).toEqual({ type: "session_decide", sessionId: S1, cardId: "c_own" as MessageId, choice: "deny" });
});

test("a machine's channel frames reach the phones: rows stamped with the machine, a thread's only for a session it holds", async () => {
  const m = setup();
  await m.flip(true);
  m.list.length = 0;
  m.signal({ type: "session_rows", rows: [{ ...row(S1), status: "working" }], removed: [], projects: [] });
  expect(m.list).toEqual([{ type: "session_rows", rows: [{ ...row(S1), status: "working" }], removed: [], projects: [] }]);

  const delta = { type: "session_delta", sessionId: S1, itemId: "msg_1:0", offset: 0, text: "Run" } as SessionSignal;
  m.signal(delta);
  m.signal({ ...delta, sessionId: S2 } as SessionSignal);
  expect(m.thread).toEqual([{ id: S1, frame: delta as ThreadSignal }]);
});

test("when a machine links again, the threads phones still watch start over from a snapshot", async () => {
  const m = setup();
  await m.flip(true);
  m.watchers.set(S1, 1);
  await m.flip(false);
  const snapshot: SessionReply = { type: "session", sessionId: S1, epoch: "e9.1", rev: 0, items: [], before: null, controls: {} as never, live: null };
  m.answers((a) => (a.type === "watch_sessions" ? [listOf(row(S1))] : a.type === "watch_session" ? [snapshot] : []));
  await m.flip(true);
  expect(m.asked.slice(-1)).toEqual([{ type: "watch_session", sessionId: S1, after: null }]);
  expect(m.thread).toEqual([{ id: S1, frame: snapshot as ThreadSignal }]);
});

test("unwatching a machine's thread reaches the machine only once no phone here watches it", async () => {
  const m = setup();
  await m.flip(true);
  m.watchers.set(S1, 1);
  await m.ask({ type: "unwatch_session", sessionId: S1 });
  await flush();
  expect(m.asked.map((a) => a.type)).toEqual(["watch_sessions"]);
  m.watchers.set(S1, 0);
  await m.ask({ type: "unwatch_session", sessionId: S1 });
  await flush();
  expect(m.asked.map((a) => a.type)).toEqual(["watch_sessions", "unwatch_session"]);
});

test("a card in a session the phone drives on a machine pushes from the home", async () => {
  const m = setup();
  m.event({ kind: "sessionCard", sessionId: S1, cardId: "c_own" as MessageId });
  expect(m.notified).toEqual([[S1, "c_own" as MessageId]]);
});
