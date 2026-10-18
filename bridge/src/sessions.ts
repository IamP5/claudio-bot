import { renameSession } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Agents } from "./agents";
import { createCatalog, type Driven } from "./catalog";
import type { ClaudeApps } from "./claudeApps";
import type { Tickable } from "./clock";
import { createProjects, type Project } from "./projects";
import {
  PHONE_MODES,
  type ServerMessage,
  type SessionClientMessage,
  type SessionControls,
  type SessionId,
  type SessionsChannelFrame,
  type SessionStatus,
  type ThreadChannelFrame,
} from "./protocol";
import type { Persist } from "./store";
import { errorText } from "./text";
import { createThreads } from "./threads";
import { createHeads, sdkReaders, type Head, type SdkReaders } from "./transcript";
import { own, type AgentRecord, type SessionPrefs, type SessionRecord, type World } from "./world";

// The facade the hub calls for every session verb. It owns the index (catalog.ts), the threads (threads.ts) and the
// one rule for who writes a session (driverOf), and keeps the overlay in World.sessions.

/** What the bridge needs from where it runs: Claude Code's folders, the Claude app, and the sockets' channels. */
export type SessionsEnv = {
  /** The bridge's stream epoch, as the hello carries it. */
  epoch: string;
  /** ~/.claude/projects. */
  projectsDir: string;
  apps: ClaudeApps;
  /** Where the index and the project cache are kept between starts. */
  cacheDir: string;
  signal: { list(frame: SessionsChannelFrame): void; thread(id: SessionId, frame: ThreadChannelFrame): void };
  watchers(id: SessionId): number;
  sdk?: SdkReaders & { renameSession?: typeof renameSession };
  coalesceMs?: number;
  /** false: no fs.watch on the projects folder (tests). */
  watch?: boolean;
};

export type SessionsDeps = SessionsEnv & {
  world: World;
  userName: string;
  /** The bridge home: a session whose cwd is under it is a bot's, shown in the Bots view instead. */
  bridgeHome: string;
  agents: Pick<Agents, "session">;
  scan(): Promise<Project[]>;
  persist: Persist;
  now(): Date;
  log(line: string): void;
};

export type Sessions = Tickable & {
  start(): Promise<void>;
  /** Reads the transcripts again now, as the sweep and the open threads' polls do. */
  sync(): Promise<void>;
  handle(m: SessionClientMessage): Promise<ServerMessage[]>;
  /** An agent record changed: its row and its thread's controls follow. */
  agentChanged(rec: AgentRecord): void;
  /** A mac agent's turn ended done: its session becomes due for the Claude app (the mirror policy). */
  agentTurnDone(rec: AgentRecord): void;
  stop(): void;
};

/** Who writes a session. An agent link wins; the phone drives only what no agent owns. */
type Writer = { kind: "agent"; rec: AgentRecord } | { kind: "none"; reason: string };

const INDEX_FILE = "sessions-index.json";
/** The mirror policy (docs/sessions-design.md §8.4): one import a minute at most, for a day, on an idle Mac. */
const MIRROR_EVERY_MS = 60_000;
const MIRROR_WINDOW_MS = 24 * 3_600_000;
const MIRROR_IDLE_S = 120;

function readIndex(file: string): Head[] {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? (v as Head[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(file: string, heads: readonly Head[]) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.new`;
  writeFileSync(tmp, JSON.stringify(heads), { mode: 0o600 });
  renameSync(tmp, file);
}

/** An open thread's transcript is checked this often, so a missed watch event delays it at most this long. */
const THREAD_POLL_MS = 1_000;

const READ_ONLY = "Sending from the phone is not on in this bridge yet.";

export function createSessions(deps: SessionsDeps): Sessions {
  const sdk = deps.sdk ?? sdkReaders;
  const indexFile = join(deps.cacheDir, INDEX_FILE);
  const botHome = (cwd: string) => cwd === deps.bridgeHome || cwd.startsWith(deps.bridgeHome + sep);
  const heads = createHeads({ projectsDir: deps.projectsDir, sdk, seed: readIndex(indexFile), exclude: botHome });
  const projects = createProjects({ file: join(deps.cacheDir, "projects.json") });
  let savedAt = 0;
  let polledAt = 0;
  let mirrorAt = 0;
  let mirroring = false;
  /** The session id each agent last had, so a restart under a new id moves its watchers there. */
  const lastIds = new Map<string, SessionId>();

  function agentOf(id: SessionId): AgentRecord | null {
    for (const rec of deps.world.agents.values()) if (rec.agent.where === "mac" && rec.session.id === id) return rec;
    return null;
  }

  function driverOf(id: SessionId): Writer {
    const rec = agentOf(id);
    if (rec) return { kind: "agent", rec };
    return { kind: "none", reason: READ_ONLY };
  }

  function driven(id: SessionId): Driven | null {
    const w = driverOf(id);
    if (w.kind !== "agent") return null;
    const session = deps.agents.session(w.rec.agent.id);
    const status: SessionStatus = session?.working ? "working" : session?.parkedFor ? "parked" : AGENT_STATUS[w.rec.agent.status];
    return { status, working: session?.working ?? false };
  }

  function controls(id: SessionId): SessionControls {
    const w = driverOf(id);
    const head = catalog.head(id);
    const working = w.kind === "agent" ? (deps.agents.session(w.rec.agent.id)?.working ?? false) : (deps.apps.holders().get(id)?.busy ?? false);
    return {
      canSend: false,
      reason: w.kind === "none" ? w.reason : READ_ONLY,
      working,
      queued: 0,
      model: null,
      models: [],
      mode: head?.mode ?? "default",
      modes: [...PHONE_MODES],
    };
  }

  const watched = (id: SessionId) => deps.watchers(id) > 0;

  const catalog = createCatalog({
    projectsDir: deps.projectsDir,
    heads,
    projects,
    apps: deps.apps,
    world: deps.world,
    driven,
    watched,
    scan: deps.scan,
    publish: deps.signal.list,
    appended: (path) => threads.appended(path),
    gone: (ids) => ids.forEach((id) => threads.removed(id, null)),
    now: deps.now,
    log: deps.log,
    ...(deps.coalesceMs !== undefined && { coalesceMs: deps.coalesceMs }),
    ...(deps.watch !== undefined && { watch: deps.watch }),
  });

  const threads = createThreads({
    epoch: deps.epoch,
    head: (id) => catalog.head(id),
    context: (id, head) => ({ cwd: head?.cwd ?? agentOf(id)?.cwd ?? "", userName: deps.userName, agent: agentOf(id) !== null }),
    overlay: () => [],
    controls,
    publish: deps.signal.thread,
    watched,
    log: deps.log,
    sdk,
  });

  /** The overlay record, made on first need. */
  function recordOf(id: SessionId): SessionRecord {
    let rec = deps.world.sessions.get(id);
    if (!rec) deps.world.sessions.set(id, (rec = { id, hidden: false, visitedAt: null }));
    return rec;
  }

  const listFrame = (): ServerMessage => ({ type: "sessions", ...catalog.snapshot(), mirror: deps.world.sessionPrefs.mirror });
  const known = (id: SessionId) => catalog.head(id) !== null || agentOf(id) !== null;
  const gone = (id: SessionId): ServerMessage[] => [{ type: "session_removed", sessionId: id, movedTo: null }];
  const error = (message: string): ServerMessage[] => [{ type: "error", message }];

  async function rename(id: SessionId, title: string): Promise<ServerMessage[]> {
    const head = catalog.head(id);
    if (!head) return error("This session has no transcript to rename yet.");
    try {
      await (deps.sdk?.renameSession ?? renameSession)(id, title.trim(), { dir: head.cwd });
    } catch (e) {
      return error(`Claude Code could not rename the session: ${errorText(e)}`);
    }
    catalog.changed(head.file);
    return [];
  }

  /** Asks the Claude app to list the newest due session, when every gate of the mirror policy holds. */
  async function mirrorOne() {
    const now = deps.now().getTime();
    const desktop = deps.apps.desktop();
    const due = [...deps.world.sessions.values()].filter((r) => r.mirror && !r.mirror.failed);
    for (const r of due) {
      if (desktop.has(r.id) || now - Date.parse(r.mirror!.dueAt) > MIRROR_WINDOW_MS || !known(r.id)) {
        delete r.mirror;
        deps.persist();
        catalog.touch();
      }
    }
    if (deps.world.sessionPrefs.mirror !== "auto") return;
    const next = due.filter((r) => r.mirror && !driven(r.id)?.working).sort((a, b) => b.mirror!.dueAt.localeCompare(a.mirror!.dueAt))[0];
    if (!next) return;
    if ((await deps.apps.desktopState()) !== "background") return;
    if (((await deps.apps.idleSeconds()) ?? 0) < MIRROR_IDLE_S) return;
    const ok = await deps.apps.importToDesktop(next.id);
    deps.log(`sessions: the Claude app ${ok ? "lists" : "did not list"} ${next.id}`);
    if (ok) delete next.mirror;
    else if (next.mirror) next.mirror.failed = true;
    deps.persist();
    catalog.touch();
  }

  async function openInDesktop(id: SessionId): Promise<ServerMessage[]> {
    const ok = await deps.apps.openInDesktop(id);
    const rec = deps.world.sessions.get(id);
    if (ok && rec?.mirror) {
      delete rec.mirror;
      deps.persist();
    }
    catalog.touch();
    return ok ? [] : error("The Claude app did not list this session. Check that claude:// links open the Claude app, then try again.");
  }

  function save() {
    try {
      writeIndex(indexFile, heads.cached());
    } catch (e) {
      deps.log(`sessions: the index cache was not saved: ${errorText(e)}`);
    }
  }

  return {
    async start() {
      await catalog.start();
      save();
      savedAt = deps.now().getTime();
    },

    async handle(m) {
      switch (m.type) {
        case "watch_sessions":
          return [listFrame()];
        case "unwatch_sessions":
          return [];
        case "watch_session":
          if (!known(m.sessionId)) return gone(m.sessionId);
          return threads.watch(m.sessionId, m.after);
        case "unwatch_session": {
          if (known(m.sessionId)) {
            recordOf(m.sessionId).visitedAt = deps.now().toISOString();
            deps.persist();
            catalog.touch();
          }
          // The socket's topic is dropped after this message is handled, so the count is read on the next turn.
          setTimeout(() => threads.release(m.sessionId), 0);
          return [];
        }
        case "session_page":
          return known(m.sessionId) ? threads.page(m.sessionId, m.before) : gone(m.sessionId);
        case "session_tool":
          return threads.tool(m.sessionId, m.toolUseId);
        case "session_set": {
          if (!known(m.sessionId)) return gone(m.sessionId);
          const { title, hidden, model, mode } = m.patch;
          if (model !== undefined || mode !== undefined) return error(READ_ONLY);
          if (hidden !== undefined) {
            recordOf(m.sessionId).hidden = hidden;
            deps.persist();
            catalog.touch();
          }
          return title !== undefined ? rename(m.sessionId, title) : [];
        }
        case "session_prefs":
          own<SessionPrefs>(deps.world.sessionPrefs).mirror = m.mirror;
          deps.persist();
          return [listFrame()];
        case "session_open_desktop":
          return known(m.sessionId) ? openInDesktop(m.sessionId) : gone(m.sessionId);
        case "session_send":
        case "session_stop":
        case "session_decide":
        case "session_answer":
        case "session_create":
          return error(READ_ONLY);
      }
    },

    agentChanged(rec) {
      catalog.touch();
      const id = rec.session.id as SessionId | null;
      const was = lastIds.get(rec.agent.id);
      if (id) lastIds.set(rec.agent.id, id);
      if (was && id && was !== id) threads.removed(was, id);
      if (id) threads.refresh(id);
    },

    agentTurnDone(rec) {
      const id = rec.session.id as SessionId | null;
      if (!id || deps.world.sessionPrefs.mirror !== "auto" || deps.apps.desktop().has(id)) return;
      const r = recordOf(id);
      if (r.mirror) return;
      r.mirror = { dueAt: deps.now().toISOString(), failed: false };
      deps.persist();
      catalog.touch();
      mirrorAt = 0;
    },

    async sync() {
      await catalog.sync();
      await threads.poll();
    },

    tick(at) {
      catalog.tick(at);
      if (at.getTime() - polledAt >= THREAD_POLL_MS) {
        polledAt = at.getTime();
        void threads.poll();
      }
      if (at.getTime() >= mirrorAt && !mirroring) {
        mirrorAt = at.getTime() + MIRROR_EVERY_MS;
        mirroring = true;
        void mirrorOne()
          .catch((e) => deps.log(`sessions: the Claude app import failed: ${errorText(e)}`))
          .finally(() => (mirroring = false));
      }
      if (at.getTime() - savedAt >= 60_000) {
        savedAt = at.getTime();
        save();
      }
    },
    nextDeadline: () => {
      const soonest = Math.min(polledAt + THREAD_POLL_MS, mirrorAt);
      const own = new Date(soonest).toISOString();
      const index = catalog.nextDeadline();
      return index !== null && index < own ? index : own;
    },

    stop() {
      save();
      catalog.stop();
      threads.stop();
    },
  };
}

const AGENT_STATUS: Record<AgentRecord["agent"]["status"], SessionStatus> = {
  working: "working",
  waiting: "idle",
  failed: "failed",
  in_cloud: "idle",
  awaiting_approval: "awaiting_approval",
  parked: "parked",
  unavailable: "unavailable",
  capped: "parked",
};
