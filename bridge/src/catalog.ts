import { watch } from "node:fs";
import { join } from "node:path";
import type { Tickable } from "./clock";
import type { ClaudeApps } from "./claudeApps";
import type { Project, ProjectOf } from "./projects";
import type { Holder, SessionId, SessionOrigin, SessionProject, SessionRow, SessionsChannelFrame, SessionStatus } from "./protocol";
import type { Head, Heads } from "./transcript";
import type { AgentRecord, World } from "./world";

// The index of every Claude Code session on this Mac: the transcripts' heads joined with what the bridge drives, who
// else holds a session, the Claude app's list and the overlay (hidden, visited). Rows are computed, never stored, and
// diffs go to the sockets watching the list at most every 500 ms.

/** What the bridge's own writer on an id says, when it has one. */
export type Driven = { status: SessionStatus; working: boolean };

export type CatalogDeps = {
  projectsDir: string;
  heads: Heads;
  projects: { of(cwd: string): ProjectOf; save(): void };
  apps: ClaudeApps;
  world: World;
  /** The bridge's writer on the id (an agent's session, or the phone's), null when it has none. */
  driven(id: SessionId): Driven | null;
  /** A socket has the thread open, so nothing in it is unread. */
  watched(id: SessionId): boolean;
  /** The project folders under the roots, so a project with no session yet still lists. */
  scan(): Promise<Project[]>;
  publish(frame: SessionsChannelFrame): void;
  /** A transcript changed on disk: the threads module reads its new lines. */
  appended(path: string): void;
  /** Rows that left the list: their transcripts are gone. */
  gone(ids: SessionId[]): void;
  now(): Date;
  log(line: string): void;
  coalesceMs?: number;
  /** Watches the projects folder; tests pass none and call changed(). */
  watch?: boolean;
};

export type Catalog = Tickable & {
  start(): Promise<void>;
  snapshot(): { projects: SessionProject[]; rows: SessionRow[] };
  head(id: SessionId): Head | null;
  /** A row's inputs changed (a driver, an agent record, the overlay): the next coalesced pass rebuilds the rows. */
  touch(): void;
  /** A transcript file changed: its head is read again in the next pass. */
  changed(path: string): void;
  /** Rebuilds now and publishes the diff. */
  flush(): Promise<void>;
  /** Lists every transcript again (the sweep a missed watch event waits for), then flushes. */
  sync(): Promise<void>;
  stop(): void;
};

const ROWS_COALESCE_MS = 500;
const SWEEP_MS = 60_000;
/** While a thread is open the live-process registry is read this often, in case a watch event was missed. */
const HOLDER_POLL_MS = 5_000;

function holderOf(entrypoint: string): Holder {
  if (entrypoint === "claude-desktop") return "desktop";
  if (entrypoint === "cli") return "terminal";
  return "other";
}

function originOf(head: Head | null): SessionOrigin {
  const entry = head?.firstEntry ?? "";
  if (entry === "claude-desktop") return "desktop";
  if (entry.startsWith("sdk")) return "sdk";
  return "terminal";
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createCatalog(deps: CatalogDeps): Catalog {
  const heads = new Map<SessionId, Head>();
  const dirty = new Set<string>();
  let seeds: ProjectOf[] = [];
  let sent = { rows: new Map<SessionId, string>(), projects: new Map<string, string>() };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let sweepAt = 0;
  let pollAt = 0;
  let sweeping: Promise<void> | null = null;
  let stopped = false;

  /** Every session the bridge links to an agent, by its id. */
  function agentsById(): Map<SessionId, AgentRecord> {
    const out = new Map<SessionId, AgentRecord>();
    for (const rec of deps.world.agents.values()) {
      const id = (rec.agent.where === "mac" ? rec.session.id : null) as SessionId | null;
      if (id) out.set(id, rec);
    }
    return out;
  }

  function build(): { projects: SessionProject[]; rows: SessionRow[] } {
    const agents = agentsById();
    const holders = deps.apps.holders();
    const desktop = deps.apps.desktop();
    const ids = new Set<SessionId>([...heads.keys(), ...agents.keys()]);
    const projects = new Map<string, SessionProject>();
    const rows: SessionRow[] = [];
    for (const seed of seeds) projects.set(seed.id, { id: seed.id, name: seed.name, path: seed.root, githubRepo: seed.githubRepo, lastAt: null, canCloud: false });
    for (const id of ids) {
      const head = heads.get(id) ?? null;
      const rec = agents.get(id) ?? null;
      const cwd = head?.cwd ?? rec?.cwd;
      if (cwd === undefined) continue;
      const project = deps.projects.of(cwd);
      const overlay = deps.world.sessions.get(id);
      const driven = deps.driven(id);
      const held = holders.get(id);
      const lastAt = head?.lastAt ?? Date.parse(rec!.agent.updatedAt);
      const createdAt = head?.createdAt ?? Date.parse(rec!.agent.createdAt);
      const visited = overlay?.visitedAt ?? null;
      const unread =
        !deps.watched(id) && (driven !== null || rec !== null || visited !== null) && head?.lastRole === "assistant" && (visited === null || lastAt > Date.parse(visited));
      const status: SessionStatus = driven?.status ?? (held?.busy ? "working" : "idle");
      const holder: Holder = driven?.working ? "claudio" : held ? holderOf(held.entrypoint) : "none";
      rows.push({
        id,
        projectId: project.id,
        parentId: desktop.get(id)?.parent ?? null,
        title: head?.title ?? rec!.agent.title,
        origin: rec ? "agent" : originOf(head),
        agent: rec ? { botId: rec.agent.botId, agentId: rec.agent.id } : null,
        status,
        holder,
        unread,
        branch: head?.branch ?? rec?.agent.worktree?.branch ?? null,
        worktree: project.worktree,
        pr: head?.pr ?? null,
        mirror: desktop.has(id) ? "imported" : overlay?.mirror?.failed ? "failed" : overlay?.mirror && deps.world.sessionPrefs.mirror === "auto" ? "pending" : "none",
        hidden: overlay?.hidden ?? false,
        url: null,
        createdAt: iso(createdAt),
        lastAt: iso(lastAt),
      });
      const p = projects.get(project.id) ?? { id: project.id, name: project.name, path: project.root, githubRepo: project.githubRepo, lastAt: null, canCloud: false };
      if (p.lastAt === null || iso(lastAt) > p.lastAt) p.lastAt = iso(lastAt);
      projects.set(project.id, p);
    }
    // A parent the list does not show leaves its child at the top level.
    const shown = new Set(rows.map((r) => r.id));
    for (const r of rows) if (r.parentId !== null && !shown.has(r.parentId)) r.parentId = null;
    rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    const ordered = [...projects.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.name.localeCompare(b.name));
    return { projects: ordered, rows };
  }

  async function readDirty() {
    const paths = [...dirty];
    dirty.clear();
    for (const path of paths) {
      const head = await deps.heads.refresh(path);
      const id = path.split("/").pop()!.replace(/\.jsonl$/, "") as SessionId;
      if (head) heads.set(head.id, head);
      else heads.delete(id);
    }
  }

  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    await readDirty();
    const now = build();
    const rows = new Map(now.rows.map((r) => [r.id, JSON.stringify(r)]));
    const projects = new Map(now.projects.map((p) => [p.id, JSON.stringify(p)]));
    const changedRows = now.rows.filter((r) => sent.rows.get(r.id) !== rows.get(r.id));
    const removed = [...sent.rows.keys()].filter((id) => !rows.has(id));
    const changedProjects = now.projects.filter((p) => sent.projects.get(p.id) !== projects.get(p.id));
    sent = { rows, projects };
    deps.projects.save();
    if (changedRows.length + removed.length + changedProjects.length === 0 || stopped) return;
    if (removed.length > 0) deps.gone(removed);
    deps.publish({ type: "session_rows", rows: changedRows, removed, projects: changedProjects });
  }

  function schedule() {
    if (timer || stopped) return;
    timer = setTimeout(() => void flush().catch((e) => deps.log(`sessions: rows failed: ${e}`)), deps.coalesceMs ?? ROWS_COALESCE_MS);
  }

  async function sweep() {
    for (const head of await deps.heads.scan()) heads.set(head.id, head);
    const listed = new Set(deps.heads.cached().map((h) => h.id));
    for (const id of heads.keys()) if (!listed.has(id)) heads.delete(id);
    seeds = (await deps.scan().catch(() => [])).map((p) => deps.projects.of(p.path));
    sweepAt = deps.now().getTime() + SWEEP_MS;
  }

  function background(op: () => Promise<void>) {
    if (sweeping) return;
    sweeping = op()
      .then(() => flush())
      .catch((e) => deps.log(`sessions: sweep failed: ${e}`))
      .finally(() => (sweeping = null));
  }

  deps.apps.onChange(schedule);

  return {
    async start() {
      await sweep();
      if (deps.watch !== false) {
        try {
          watcher = watch(deps.projectsDir, { recursive: true }, (_, name) => {
            if (typeof name !== "string" || !name.endsWith(".jsonl")) return;
            const path = join(deps.projectsDir, name);
            dirty.add(path);
            deps.appended(path);
            schedule();
          });
          watcher.on("error", (e) => deps.log(`sessions: watching ${deps.projectsDir} stopped: ${e}`));
        } catch (e) {
          deps.log(`sessions: cannot watch ${deps.projectsDir}, the 60 s sweep keeps the list: ${e}`);
        }
      }
      await flush();
    },
    snapshot: build,
    head: (id) => heads.get(id) ?? null,
    touch: schedule,
    changed(path) {
      dirty.add(path);
      schedule();
    },
    flush,
    async sync() {
      await sweep();
      await flush();
    },
    tick(at) {
      const t = at.getTime();
      if (t >= sweepAt) background(sweep);
      if (t >= pollAt) {
        pollAt = t + HOLDER_POLL_MS;
        deps.apps.refresh();
      }
    },
    nextDeadline: () => new Date(Math.min(sweepAt || Date.now(), pollAt || Date.now())).toISOString(),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      deps.apps.close();
    },
  };
}
