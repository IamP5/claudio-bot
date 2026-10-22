import { renameSession, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { Agents } from "./agents";
import { createCatalog, type Driven } from "./catalog";
import type { ClaudeApps } from "./claudeApps";
import type { Tickable } from "./clock";
import type { Ledger } from "./ledger";
import { createOwn, newDrive, type OwnDeps } from "./own";
import type { Scope } from "./policy";
import { createProjects } from "./projects";
import {
  PHONE_MODES,
  type ErrorAbout,
  type ItemId,
  type MessageId,
  type PermissionChoice,
  type PhoneMode,
  type ServerMessage,
  type SessionClientMessage,
  type SessionControls,
  type SessionId,
  type SessionItem,
  type SessionsChannelFrame,
  type SessionStatus,
  type ThreadChannelFrame,
} from "./protocol";
import type { Result } from "./result";
import type { SessionSpec } from "./session";
import type { Persist } from "./store";
import { RESTING, rowRun, runControls, runningSteps, runs, type StepPatch } from "./tasks";
import { displayName, errorText } from "./text";
import { createThreads } from "./threads";
import { createHeads, folderOf, sdkReaders, statOf, stepLabel, transcriptExists, type Head, type SdkReaders } from "./transcript";
import { prepareWorkspace } from "./worktree";
import { own, type AgentRecord, type SessionPrefs, type SessionRecord, type World } from "./world";

// The facade the hub calls for every session verb. It owns the index (catalog.ts), the threads (threads.ts) and the
// one rule for who writes a session (driverOf), and keeps the overlay in World.sessions.

/** What the bridge needs from where it runs: Claude Code's folders, the Claude app, and the sockets' channels. */
export type SessionsEnv = {
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
  /** The project roots, by realpath: a session under a temp folder lists only when it is under one of these. */
  roots: string[];
  agents: Pick<Agents, "session" | "direct" | "stop" | "message">;
  /** The gate's answer to one of its cards: an agent's permission card, decided from the agent's thread. */
  decideGate(botId: string, cardId: MessageId, choice: PermissionChoice): Result;
  ledger: Ledger;
  claude: Pick<SessionSpec, "query" | "executable" | "shells" | "leaders">;
  /** Paths the floors protect, for a session working in cwd. */
  scope(cwd: string): Scope;
  /** A card in a session the phone drives: a push that says only that a session needs the user. */
  notify?(id: SessionId, cardId: MessageId): void;
  /** The project folders under the roots (no git run), so a project with no session yet lists. */
  folders(): string[];
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
  /** At start: open cards of the phone's sessions expire, and those with queued input start. */
  resume(): void;
  /** A message of an agent's live query on the session: its text streams into the thread. */
  stream(id: SessionId, m: SDKMessage): void;
  stop(): void;
};

/**
 * Who writes a session: the one rule, encoded here only. An agent link wins. Otherwise the phone drives it once it
 * has sent to it (own), or may take it on (open) while Claude Code has its transcript.
 */
type Writer =
  | { kind: "agent"; rec: AgentRecord }
  | { kind: "cloud"; rec: AgentRecord }
  | { kind: "own"; rec: SessionRecord }
  | { kind: "open"; head: Head }
  | { kind: "none"; reason: string };

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

const GONE = "This session's transcript is gone.";
const SENT_KEPT = 50;
const DRAFT_TITLE_MAX = 80;
/** Shown cards per agent, so a settled gate card stays in the agent's thread with its answer. */
const GATE_CARDS_KEPT = 20;

/** The user's settings.permissions.defaultMode, when the phone may use it. */
function settingsMode(configDir: string): PhoneMode | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    const mode = (v as { permissions?: { defaultMode?: unknown } })?.permissions?.defaultMode;
    return typeof mode === "string" && (PHONE_MODES as readonly string[]).includes(mode) ? (mode as PhoneMode) : null;
  } catch {
    return null;
  }
}

const TEMP_DIRS = [...new Set([realpathSync(tmpdir()), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"])];

const HELD_BY: Record<string, string> = { "claude-desktop": "Working in the Claude app.", cli: "Working in a terminal." };

export function createSessions(deps: SessionsDeps): Sessions {
  const sdk = deps.sdk ?? sdkReaders;
  const indexFile = join(deps.cacheDir, INDEX_FILE);
  const under = (dir: string) => (cwd: string) => cwd === dir || cwd.startsWith(dir + sep);
  const botHome = under(deps.bridgeHome);
  const temp = TEMP_DIRS.map(under);
  const inRoots = deps.roots.map(under);
  /** Bots' sessions, and the leftovers of scripts and test runs in temp folders, outside the user's projects. */
  const excluded = (cwd: string) => botHome(cwd) || (temp.some((t) => t(cwd)) && !inRoots.some((r) => r(cwd)));
  const heads = createHeads({ projectsDir: deps.projectsDir, sdk, seed: readIndex(indexFile), exclude: excluded });
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

  function cloudOf(id: SessionId): AgentRecord | null {
    for (const rec of deps.world.agents.values()) if (rec.agent.where === "cloud" && rec.cloudSession === id) return rec;
    return null;
  }

  const cwdOf = (id: SessionId): string | null => catalog.head(id)?.cwd ?? agentOf(id)?.cwd ?? deps.world.sessions.get(id)?.own?.cwd ?? null;

  /** A session's transcript: the index's head, else, for one the bridge drives, the file Claude Code writes in its cwd's folder before the index has read it. */
  function transcript(id: SessionId): { file: string; cwd: string } | null {
    const head = catalog.head(id);
    if (head) return { file: head.file, cwd: head.cwd };
    const cwd = cwdOf(id);
    if (cwd === null) return null;
    const file = join(deps.projectsDir, folderOf(cwd), `${id}.jsonl`);
    return statOf(file) ? { file, cwd } : null;
  }

  function driverOf(id: SessionId): Writer {
    const agent = agentOf(id);
    if (agent) return { kind: "agent", rec: agent };
    const cloud = cloudOf(id);
    if (cloud) return { kind: "cloud", rec: cloud };
    const rec = deps.world.sessions.get(id);
    if (rec?.own) return { kind: "own", rec };
    const head = catalog.head(id);
    return head ? { kind: "open", head } : { kind: "none", reason: GONE };
  }

  /** The phone takes the session on: its drive is made, with the cwd its transcript names. */
  function take(id: SessionId, head: Head): SessionRecord {
    const rec = recordOf(id);
    rec.own ??= newDrive({ id, cwd: head.cwd, created: false, at: deps.now().toISOString(), model: null, mode: null });
    deps.persist("now");
    return rec;
  }

  /** Why the phone must wait to send: another live Claude Code is busy on the id. */
  function blocked(id: SessionId): string | null {
    const held = deps.apps.holders().get(id);
    if (held?.status !== "busy") return null;
    return HELD_BY[held.entrypoint] ?? "Another Claude Code is working on this session.";
  }

  function driven(id: SessionId): Driven | null {
    const w = driverOf(id);
    if (w.kind === "own") return drivers.status(w.rec);
    if (w.kind === "cloud") return { status: w.rec.agent.status === "failed" ? "failed" : "idle", working: false };
    if (w.kind !== "agent") return null;
    const session = deps.agents.session(w.rec.agent.id);
    const a = session?.activity() ?? RESTING;
    const working = (session?.working ?? false) || runs(a);
    const status: SessionStatus = working ? "working" : session?.parkedFor ? "parked" : AGENT_STATUS[w.rec.agent.status];
    return { status, working, ...(working && rowRun(a, null, (c, target) => stepLabel(c.tool, c.input, w.rec.cwd, target))) };
  }

  function controls(id: SessionId): SessionControls {
    const w = driverOf(id);
    switch (w.kind) {
      case "own":
        return drivers.controls(w.rec);
      case "cloud":
        return { canSend: true, reason: null, working: false, queued: 0, model: null, models: [], mode: "default", modes: [] };
      case "agent": {
        const session = deps.agents.session(w.rec.agent.id);
        const pending = w.rec.session.pending.length;
        const life = w.rec.session.lifecycle;
        const busy = life.kind === "working" || life.kind === "stopping" ? 1 : 0;
        const a = session?.activity() ?? RESTING;
        return {
          canSend: true,
          reason: null,
          working: (session?.working ?? false) || runs(a),
          queued: Math.max(0, pending - busy),
          model: null,
          models: [],
          mode: "auto",
          modes: [],
          ...runControls(a, () => null),
        };
      }
      case "open":
      case "none": {
        const wait = w.kind === "none" ? w.reason : blocked(id);
        const head = catalog.head(id);
        const mode = head?.mode && (PHONE_MODES as readonly string[]).includes(head.mode) ? (head.mode as PhoneMode) : (settingsMode(configDir) ?? "default");
        return { canSend: wait === null, reason: wait, working: deps.apps.holders().get(id)?.status === "busy", queued: 0, model: null, models: MODELS_SHOWN, mode, modes: [...PHONE_MODES] };
      }
    }
  }

  /** The gate's cards of an agent, shown in its thread: the open ones, and the newest it showed since the bridge started. */
  const gateShown = new Map<string, MessageId[]>();
  function agentOverlay(rec: AgentRecord): SessionItem[] {
    const open = deps.world.gate.open.filter((c) => c.kind === "permission" && c.actor.kind === "agent" && c.actor.agentId === rec.agent.id).map((c) => c.cardId);
    const shown = [...new Set([...(gateShown.get(rec.agent.id) ?? []), ...open])].slice(-GATE_CARDS_KEPT);
    gateShown.set(rec.agent.id, shown);
    const bot = deps.world.bots.get(rec.agent.botId);
    const items: SessionItem[] = [];
    for (const id of shown) {
      const m = bot?.messages.find((x) => x.id === id);
      if (m?.kind === "permission") items.push({ kind: "permission", id: id as string as ItemId, at: m.at, card: { ...m } });
    }
    const life = rec.session.lifecycle;
    const turn = life.kind === "working" || life.kind === "stopping" ? life.turn : null;
    for (const p of rec.session.pending) {
      if (p.clientId === undefined) continue;
      const text = p.text.split("\n").slice(1).join("\n");
      const took = p.id === turn?.pending ? turn.startedAt : null;
      items.push({ kind: "user", id: p.clientId as ItemId, at: took ?? p.at, text, from: "user", queued: took === null });
    }
    return items;
  }

  /** A cloud agent's thread is what the bridge said to it and heard back: the bridge never has its transcript. */
  const cloudOverlay = (rec: AgentRecord): SessionItem[] =>
    rec.messages.map((m): SessionItem => (m.from === "bot" ? { kind: "user", id: m.id as string as ItemId, at: m.at, text: m.text, from: "bot", queued: false } : { kind: "assistant", id: m.id as string as ItemId, at: m.at, text: m.text }));

  function steps(id: SessionId): Map<string, StepPatch> {
    const w = driverOf(id);
    if (w.kind === "own") return drivers.steps(w.rec);
    if (w.kind !== "agent") return new Map();
    return runningSteps(deps.agents.session(w.rec.agent.id)?.activity() ?? RESTING);
  }

  function overlay(id: SessionId): SessionItem[] {
    const w = driverOf(id);
    if (w.kind === "agent") return agentOverlay(w.rec);
    if (w.kind === "cloud") return cloudOverlay(w.rec);
    if (w.kind === "own") return drivers.overlay(w.rec);
    return [];
  }

  const configDir = dirname(deps.projectsDir);
  const ownDeps: OwnDeps = {
    world: deps.world,
    userName: deps.userName,
    ledger: deps.ledger,
    persist: deps.persist,
    claude: deps.claude,
    last: (id) => {
      const head = catalog.head(id);
      return { mode: head?.mode ?? null, model: head?.model ?? null };
    },
    transcriptExists: (id, cwd) => transcriptExists(deps.projectsDir, id, cwd),
    blocked,
    elsewhere: (id) => deps.apps.holders().has(id),
    defaultMode: () => settingsMode(configDir),
    scope: deps.scope,
    changed(id) {
      // The row's last activity follows the transcript, so a turn's end re-reads it even when no watch event came.
      const file = transcript(id)?.file;
      if (file) catalog.changed(file);
      else catalog.touch();
      threads.refresh(id);
    },
    done(id) {
      if (deps.world.sessions.get(id)?.own?.created) due(id);
    },
    ...(deps.notify && { notify: deps.notify }),
    observe: (id, m) => threads.stream(id, m),
    options: { includePartialMessages: true },
    now: deps.now,
    log: deps.log,
  };
  const drivers = createOwn(ownDeps);
  // The bridge always yields: a session another Claude Code turned busy on loses the bridge's idle query.
  deps.apps.onChange(() => {
    for (const rec of deps.world.sessions.values()) {
      if (!rec.own) continue;
      if (blocked(rec.id) !== null) drivers.yieldTo(rec.id);
      else if (rec.own.session.pending.length > 0) drivers.unblock(rec.id);
    }
  });

  const watched = (id: SessionId) => deps.watchers(id) > 0;

  const catalog = createCatalog({
    projectsDir: deps.projectsDir,
    heads,
    projects,
    apps: deps.apps,
    world: deps.world,
    driven,
    drafts: () =>
      [...deps.world.sessions.values()].flatMap((r) =>
        r.own?.created ? [{ id: r.id, cwd: r.own.cwd, title: displayName((r.own.prompt ?? "New session").split("\n")[0]!, DRAFT_TITLE_MAX), at: r.own.at }] : [],
      ),
    watched,
    folders: deps.folders,
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
    transcript,
    context: (id) => ({ cwd: cwdOf(id) ?? "", userName: deps.userName, agent: agentOf(id) !== null }),
    overlay,
    steps,
    cuts: (id) => {
      const w = driverOf(id);
      return w.kind === "own" ? drivers.cuts(w.rec) : [];
    },
    controls,
    publish: deps.signal.thread,
    watched,
    now: deps.now,
    log: deps.log,
    sdk,
  });

  function recordOf(id: SessionId): SessionRecord {
    let rec = deps.world.sessions.get(id);
    if (!rec) deps.world.sessions.set(id, (rec = { id, hidden: false, visitedAt: null }));
    return rec;
  }

  const listFrame = (): ServerMessage => ({ type: "sessions", ...catalog.snapshot(), mirror: deps.world.sessionPrefs.mirror });
  const known = (id: SessionId) => catalog.head(id) !== null || agentOf(id) !== null || cloudOf(id) !== null || deps.world.sessions.get(id)?.own?.created === true;
  const gone = (id: SessionId): ServerMessage[] => [{ type: "session_removed", sessionId: id, movedTo: null }];
  const error = (message: string, about?: ErrorAbout): ServerMessage[] => [{ type: "error", message, ...(about && { about }) }];

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

  /** The session is due for the Claude app once, after its first finished turn, while the setting is Automatically. */
  function due(id: SessionId) {
    if (deps.world.sessionPrefs.mirror !== "auto" || deps.apps.desktop().has(id)) return;
    const r = recordOf(id);
    if (r.mirror) return;
    r.mirror = { dueAt: deps.now().toISOString(), failed: false };
    deps.persist();
    catalog.touch();
    mirrorAt = 0;
  }

  const reply = (r: Result): ServerMessage[] => (r.ok ? [] : error(r.error));

  /** The phone's clientIds each session took, so a resend after a reconnect runs nothing twice. */
  const taken = new Map<SessionId, string[]>();
  async function send(m: Extract<SessionClientMessage, { type: "session_send" }>): Promise<ServerMessage[]> {
    const seen = taken.get(m.sessionId) ?? [];
    if (seen.includes(m.clientId)) return [];
    const replies = await route(m);
    if (replies.length === 0) taken.set(m.sessionId, [...seen, m.clientId].slice(-SENT_KEPT));
    return replies;
  }

  async function route(m: Extract<SessionClientMessage, { type: "session_send" }>): Promise<ServerMessage[]> {
    const w = driverOf(m.sessionId);
    switch (w.kind) {
      case "agent": {
        if (m.interrupt) await deps.agents.stop(w.rec);
        const refusal = deps.agents.direct(w.rec, m.text, m.clientId);
        return refusal === null ? [] : error(refusal);
      }
      case "cloud": {
        const said = await deps.agents.message(w.rec, m.text, { kind: "user" });
        return said.startsWith("Sent") ? [] : error(said);
      }
      case "own":
        return reply(await drivers.send(w.rec, m.text, m.clientId, m.interrupt));
      case "open":
        return reply(await drivers.send(take(m.sessionId, w.head), m.text, m.clientId, m.interrupt));
      case "none":
        return error(w.reason);
    }
  }

  async function stop(m: Extract<SessionClientMessage, { type: "session_stop" }>): Promise<ServerMessage[]> {
    const target = m.target ?? "all";
    const about: ErrorAbout = { kind: "stop", sessionId: m.sessionId };
    const w = driverOf(m.sessionId);
    if (w.kind === "cloud") return error("A cloud session runs on claude.ai; stop it there.", about);
    if (w.kind === "agent") {
      if (target !== "all") return error("An agent's session stops as a whole.", about);
      return (await deps.agents.stop(w.rec)) ? [] : error("Nothing is running.", about);
    }
    if (w.kind !== "own") return error("Nothing is running.", about);
    // A stop is aimed at the run the phone saw: one meant for a turn that has since ended never reaches a newer one.
    const turn = drivers.controls(w.rec).turn ?? null;
    if (m.turnStartedAt !== undefined && (turn !== null ? turn.startedAt !== m.turnStartedAt : target === "turn")) {
      return error(turn !== null ? "That turn ended, and a newer one runs now. Stop again to stop it." : "That turn already ended.", about);
    }
    const r = await drivers.stop(w.rec, target);
    return r.ok ? [] : error(r.error, about);
  }

  function unqueue(m: Extract<SessionClientMessage, { type: "session_unqueue" }>): ServerMessage[] {
    const w = driverOf(m.sessionId);
    const about: ErrorAbout = { kind: "send", sessionId: m.sessionId, clientId: m.clientId };
    if (w.kind !== "own") return error("Only a message you queued in this session can be withdrawn.", about);
    const r = drivers.unqueue(w.rec, m.clientId);
    return r.ok ? [] : error(r.error, about);
  }

  function decide(m: Extract<SessionClientMessage, { type: "session_decide" }>): ServerMessage[] {
    const w = driverOf(m.sessionId);
    if (w.kind === "own") return reply(drivers.decide(w.rec, m.cardId, m.choice));
    if (w.kind === "agent") return reply(deps.decideGate(w.rec.agent.botId, m.cardId, m.choice));
    return error("Unknown card");
  }

  async function create(m: Extract<SessionClientMessage, { type: "session_create" }>): Promise<ServerMessage[]> {
    const project = catalog.snapshot().projects.find((p) => p.id === m.projectId);
    if (!project) return error("Unknown project");
    if (!existsSync(project.path)) return error(`${project.name}'s folder is gone from this Mac.`);
    const id = crypto.randomUUID() as SessionId;
    let cwd = project.path;
    if (m.isolate === "worktree") {
      try {
        cwd = (await prepareWorkspace({ path: project.path, name: project.name }, id, "worktree")).cwd;
      } catch (e) {
        return error(errorText(e));
      }
    }
    const rec = recordOf(id);
    rec.own = newDrive({ id, cwd, created: true, at: deps.now().toISOString(), model: m.model, mode: m.mode, prompt: m.text });
    deps.persist("now");
    const sent = await drivers.send(rec, m.text, m.ref, false);
    if (!sent.ok) return error(sent.error);
    catalog.touch();
    return [{ type: "session_created", ref: m.ref, sessionId: id }];
  }

  async function set(m: Extract<SessionClientMessage, { type: "session_set" }>): Promise<ServerMessage[]> {
    const id = m.sessionId;
    const { title, hidden, model, mode } = m.patch;
    if (model !== undefined || mode !== undefined) {
      const w = driverOf(id);
      if (w.kind === "agent" || w.kind === "cloud") return error("An agent runs with its bot's model and mode.");
      if (w.kind === "none") return error(w.reason);
      const rec = w.kind === "own" ? w.rec : take(id, w.head);
      const r = await drivers.set(rec, { ...(model !== undefined && { model }), ...(mode !== undefined && { mode }) });
      if (!r.ok) return error(r.error, { kind: "set", sessionId: id });
    }
    if (hidden !== undefined) {
      recordOf(id).hidden = hidden;
      deps.persist();
      catalog.touch();
    }
    return title !== undefined ? rename(id, title) : [];
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

  /**
   * A session the bridge started (an agent's, the phone's) whose transcript the index has not seen yet: its file is
   * where Claude Code puts it, so a missed watch event does not hold its row and thread back until the sweep.
   */
  function awaited() {
    const waiting = [
      ...[...deps.world.agents.values()].flatMap((r) => (r.agent.where === "mac" && r.session.id ? [{ id: r.session.id, cwd: r.cwd }] : [])),
      ...[...deps.world.sessions.values()].flatMap((r) => (r.own?.created ? [{ id: r.id, cwd: r.own.cwd }] : [])),
    ];
    for (const w of waiting) {
      if (catalog.head(w.id as SessionId)) continue;
      const path = join(deps.projectsDir, folderOf(w.cwd), `${w.id}.jsonl`);
      if (statOf(path)) catalog.changed(path);
    }
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
      // After the index, so a queued turn opens with the transcript's last model and mode.
      drivers.restart();
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
        case "session_set":
          return known(m.sessionId) ? set(m) : gone(m.sessionId);
        case "session_prefs":
          own<SessionPrefs>(deps.world.sessionPrefs).mirror = m.mirror;
          deps.persist();
          return [listFrame()];
        case "session_open_desktop":
          return known(m.sessionId) ? openInDesktop(m.sessionId) : gone(m.sessionId);
        case "session_send":
          return send(m);
        case "session_stop":
          return stop(m);
        case "session_unqueue":
          return unqueue(m);
        case "session_decide":
          return decide(m);
        case "session_answer": {
          const w = driverOf(m.sessionId);
          return w.kind === "own" ? reply(drivers.answer(w.rec, m.cardId, m.answers)) : error("Unknown card");
        }
        case "session_create":
          return create(m);
      }
    },

    agentChanged(rec) {
      catalog.touch();
      const id = (rec.agent.where === "cloud" ? rec.cloudSession : rec.session.id) as SessionId | null;
      const was = lastIds.get(rec.agent.id);
      if (id) lastIds.set(rec.agent.id, id);
      if (was && id && was !== id) threads.removed(was, id);
      if (id) threads.refresh(id);
    },

    stream: (id, m) => threads.stream(id, m),

    agentTurnDone(rec) {
      if (rec.session.id) due(rec.session.id as SessionId);
    },

    resume() {
      // An overlay record an agent now owns (a phone drive on its id from before) is dropped: one writer per id.
      for (const rec of deps.world.sessions.values()) {
        if (rec.own && agentOf(rec.id)) {
          deps.log(`sessions: ${rec.id} belongs to an agent, so the phone's drive on it was dropped`);
          delete rec.own;
        }
      }
      drivers.resume();
    },

    async sync() {
      await catalog.sync();
      await threads.poll();
    },

    tick(at) {
      catalog.tick(at);
      drivers.tick(at);
      if (at.getTime() - polledAt >= THREAD_POLL_MS) {
        polledAt = at.getTime();
        awaited();
        void threads.poll();
        threads.beat();
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
      const soonest = new Date(Math.min(polledAt + THREAD_POLL_MS, mirrorAt)).toISOString();
      return [catalog.nextDeadline(), drivers.nextDeadline()].reduce<string>((min, d) => (d !== null && d < min ? d : min), soonest);
    },

    stop() {
      save();
      drivers.close();
      catalog.stop();
      threads.stop();
    },
  };
}

const MODELS_SHOWN = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

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
