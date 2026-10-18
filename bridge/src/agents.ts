import type { CanUseTool, HookCallbackMatcher, HookEvent, Options, SandboxSettings, SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { createCloudSession, followUpCloudSession } from "./cloud";
import { readEvidence, reportText } from "./evidence";
import type { Ledger } from "./ledger";
import type { AgentId, AgentStatus, BotId } from "./protocol";
import { agentPrompt, type SessionInput } from "./prompts";
import type { Project } from "./projects";
import { createSession, usedBudget, type Session, type SessionSpec, type TurnEnd } from "./session";
import { refused, type Result } from "./result";
import { accessOf } from "./access";
import { agentGitEnv } from "./sandbox";
import type { Persist } from "./store";
import { errorText } from "./text";
import type { Isolate } from "./tools";
import { prepareWorkspace, removeWorktree, worktreesRoot, type Workspace } from "./worktree";
import { emptySession, newMessageId, repoTrust, type Actor, type AgentActor, type AgentRecord, type Initiator, type World } from "./world";

// Agents are actors like bots: mac agents run on the same session module behind the same gate, metered by the same
// ledger. Cloud agents run on claude.ai: the bridge neither gates nor meters them.
export type Agents = {
  /**
   * initiator: the bot turn's, so an agent started by a routine runs as routine work; kept as startedBy. budgetUsd null:
   * the default. slash (mac only): the agent's first turn is the command "/<slash> <prompt>" instead of the agent prompt.
   */
  start(
    botId: BotId,
    a: {
      title: string;
      prompt: string;
      project: Project;
      where: "mac" | "cloud";
      isolate: Isolate;
      botName: string;
      initiator: Initiator;
      budgetUsd: number | null;
      slash?: string | null;
    },
  ): Promise<AgentRecord>;
  /** The phone's remove_worktree. Refused while the agent works, or while its worktree holds uncommitted work or ignored files other than build folders. */
  removeWorktree(rec: AgentRecord): Promise<Result>;
  /** Bot → agent follow-up: recorded in the agent's thread, queued with the bot turn's initiator. */
  message(rec: AgentRecord, text: string, initiator: Initiator): Promise<string>;
  /** Gate → mac agent (a decision envelope): queued, not recorded in the thread. Ignored for cloud agents. */
  deliver(rec: AgentRecord, input: SessionInput): void;
  notice(rec: AgentRecord, text: string): void;
  /** Stop from the phone. False when nothing runs (and always for cloud agents). The turn's end reports to the bot. */
  stop(rec: AgentRecord): Promise<boolean>;
  session(id: AgentId): Session | null;
  sessions(): Session[];
  /** At start: tell bots about mac agents a restart cut off, and start sessions with queued envelopes. */
  resume(): void;
  stopFor(botId: BotId): void;
  /** The agents in this repo may now load its own config: each live query is replaced at its next chance. */
  trusted(root: string): void;
};

/** The folder's realpath, or the path as given when it does not resolve (yet). */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const queued = (text: string, initiator: Initiator): SessionInput => ({ kind: "envelope", text, initiator, settles: null });

/**
 * What a repo carries that Claude Code would load and run from it: project settings and their hooks, .mcp.json
 * servers, commands, agents and skills. Relative paths, sorted. An empty folder loads nothing, so it does not count:
 * Claude Code itself leaves an empty .claude/.cc-writes in a folder an agent wrote to.
 */
export function projectConfigOf(root: string): string[] {
  const found = existsSync(join(root, ".mcp.json")) ? [".mcp.json"] : [];
  const dir = join(root, ".claude");
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && readdirSync(join(dir, entry.name)).length === 0) continue;
      found.push(`.claude/${entry.name}`);
    }
  } catch {}
  return found.sort();
}

const CAPPED = "Paused at today's spending cap; it resumes when you message it tomorrow or raise the cap.";

/** Statuses that hold only while the session or an open card says so. */
const LIVE: ReadonlySet<AgentStatus> = new Set(["working", "parked", "awaiting_approval", "unavailable"]);

export function createAgents(deps: {
  world: World;
  userName: string;
  model: string | undefined;
  ledger: Ledger;
  log: (line: string) => void;
  /** Tests pass a fake SDK. */
  claude: Pick<SessionSpec, "query" | "executable">;
  hooks: (actor: Actor) => Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** gate.canUseTool: what Claude Code asks about on its own becomes a card in the bot's chat. */
  canUseTool: (actor: Actor) => CanUseTool;
  /** An approval continuation's turn starts (gate.beginTurn). */
  beginTurn: (actor: Actor) => void;
  /** The OS sandbox for the agent's Bash calls (sandbox.sandboxFor), read as each query opens. */
  sandbox: (actor: Actor) => SandboxSettings;
  /** An empty folder only the bridge writes, standing in for the repo's own config until the repo is trusted. */
  configRoot: (agentId: AgentId) => string;
  /** gate.trustCard: ask the user whether the repo's own config may load. */
  trustCard: (actor: AgentActor, repo: { root: string; name: string; found: readonly string[] }) => void;
  persist: Persist;
  now: () => string;
  /** The record or something its status derives from changed, including its session's lifecycle and deadlines. */
  changed: (agent: AgentRecord) => void;
  /** by: the initiator of the agent turn that reported, so the bot's turn continues that chain's lineage. */
  reported: (agent: AgentRecord, text: string, by: Initiator) => void;
  /** A line about the agent in its bot's chat. */
  note: (agent: AgentRecord, text: string) => void;
  /** Flag settings for the agent's queries: no auto memory, and its bot's connector choices. */
  settings: (actor: AgentActor) => Settings;
  /** Every SDK message of a mac agent's live query (activity.observe). */
  observe: (actor: AgentActor, m: SDKMessage) => void;
  /** A mac agent's turn ended (activity.clear). */
  idle: (actor: AgentActor) => void;
  /** Where worktrees go; tests pass a temp folder. Default worktree.worktreesRoot(). */
  worktrees?: string;
}): Agents {
  const sessions = new Map<AgentId, Session>();
  const cloudQueues = new Map<AgentId, Promise<void>>();
  // A report waits for git, so reports run in turn order per agent.
  const reportQueues = new Map<AgentId, Promise<void>>();
  const removing = new Set<AgentId>();
  /** Mac agents whose workspace is being prepared, by project realpath: each may yet take the folder. */
  const preparing = new Map<AgentId, string>();

  /** The checkout repo trust and project config are keyed on, also for an agent in a worktree. */
  const repoOf = (rec: AgentRecord) => rec.repo ?? rec.cwd;

  const worktrees = deps.worktrees ?? worktreesRoot();
  /** Its worktree is being or was removed: the folder its session resumes in no longer exists. */
  const gone = (rec: AgentRecord) => {
    const root = existsSync(worktrees) ? realpathSync(worktrees) : worktrees;
    return removing.has(rec.agent.id) || (rec.cwd.startsWith(root + sep) && !existsSync(rec.cwd));
  };

  /** A mac agent shows what its session is doing, or an open card; once neither holds, what its last report left. */
  function statusOf(rec: AgentRecord, reported: AgentStatus): AgentStatus {
    if (rec.agent.where === "cloud") return reported;
    const id = rec.agent.id;
    const session = sessions.get(id);
    if (session?.unavailable) return "unavailable";
    if (session?.working) return "working";
    if (session?.parkedFor) return "parked";
    if (deps.world.gate.open.some((c) => c.kind === "permission" && c.actor.kind === "agent" && c.actor.agentId === id)) return "awaiting_approval";
    return LIVE.has(reported) ? "waiting" : reported;
  }

  function record(rec: AgentRecord, said: { from: "bot" | "agent"; text: string }) {
    const at = deps.now();
    rec.messages.push({ id: newMessageId(), at, ...said });
    rec.agent = { ...rec.agent, updatedAt: at };
  }

  function update(rec: AgentRecord, reported: AgentStatus, said?: { from: "bot" | "agent"; text: string }) {
    if (said) record(rec, said);
    const status = statusOf(rec, reported);
    if (status !== rec.agent.status) rec.agent = { ...rec.agent, status, updatedAt: deps.now() };
    deps.changed(rec);
  }

  // The gate closes an agent's card through deliver (a decision) or notice (expiry), so those refresh it too.
  const refresh = (rec: AgentRecord) => update(rec, rec.agent.status);

  /** Every report waits behind the ones before it, so a stop or crash never overtakes a turn's report still reading git. */
  function queueReport(rec: AgentRecord, op: () => void | Promise<void>) {
    const id = rec.agent.id;
    const next = (reportQueues.get(id) ?? Promise.resolve()).then(op);
    reportQueues.set(id, next.catch((e) => deps.log(`agent ${id} report: ${errorText(e)}`)));
  }

  function report(rec: AgentRecord, status: AgentStatus, text: string, by: Initiator) {
    queueReport(rec, () => {
      update(rec, status, { from: "agent", text });
      deps.reported(rec, text, by);
    });
  }

  /** The bridge's git line goes above the agent's words, so nothing the agent writes can stand in for it. */
  function reportWithEvidence(rec: AgentRecord, status: AgentStatus, text: string, by: Initiator) {
    queueReport(rec, async () => {
      const evidence = await readEvidence(rec.cwd, text, new Date(deps.now()), rec.base ?? null);
      rec.agent = { ...rec.agent, evidence };
      update(rec, status, { from: "agent", text });
      deps.reported(rec, reportText(evidence, text), by);
    });
  }

  function turnEnded(rec: AgentRecord, by: Initiator, end: TurnEnd) {
    if (usedBudget(end)) {
      // The ledger caps each query at the smaller of the bot's daily room and the agent's own budget.
      if (deps.ledger.budgetLeft(rec.agent.id) > 0) return report(rec, "capped", CAPPED, by);
      return report(rec, "failed", "The agent used its budget.", by);
    }
    switch (end.kind) {
      case "done": {
        const m = end.result;
        const text = m.subtype === "success" ? m.result : `The agent stopped with an error: ${m.errors.join("; ") || m.subtype}`;
        return reportWithEvidence(rec, m.subtype === "success" ? "waiting" : "failed", text.trim() || "(no final message)", by);
      }
      case "stopped":
        return report(rec, "waiting", `Stopped by ${deps.userName}.`, by);
      case "failed":
        return report(rec, "failed", `The agent crashed: ${end.error}`, by);
      case "dropped":
      case "deferred":
        return;
    }
  }

  function macSession(rec: AgentRecord): Session {
    const id = rec.agent.id;
    const existing = sessions.get(id);
    if (existing) return existing;
    const actor: AgentActor = { kind: "agent", botId: rec.agent.botId, agentId: id };
    const session = createSession({
      actor,
      state: rec.session,
      account: deps.world.account,
      ledger: deps.ledger,
      persist: deps.persist,
      userName: deps.userName,
      name: () => "The agent",
      continuing: () => deps.beginTurn(actor),
      log: deps.log,
      ...deps.claude,
      // Called as a query opens, after the headroom check let the queue head start, so it is above 0. The SDK counts
      // spend from the query's start, across every turn the live query serves, which matches a lifetime budget. The
      // session lowers it to what is left of the daily cap for a query it opens for an unattended turn.
      options: (): Options => {
        const maxBudgetUsd = deps.ledger.budgetLeft(id);
        const repo = repoOf(rec);
        // Full access loads every repo's own config, as the user's own Claude Code does.
        const trusted = accessOf(process.env).full || repoTrust(deps.world.gate, repo, id) === true;
        return {
          cwd: rec.cwd,
          // Project settings, hooks and .mcp.json come from here instead of the checkout, which the agent and every
          // branch it checks out can change. A trusted worktree loads them from its main checkout, the one trusted.
          ...(!trusted ? { projectConfigRoot: deps.configRoot(id) } : rec.agent.worktree ? { projectConfigRoot: repo } : {}),
          resume: rec.session.id ?? undefined,
          settingSources: ["user", "project"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: "auto",
          // Nobody is at the agent's terminal to answer; it reports to its bot instead.
          disallowedTools: ["AskUserQuestion"],
          model: deps.model,
          hooks: deps.hooks(actor),
          canUseTool: deps.canUseTool(actor),
          sandbox: deps.sandbox(actor),
          settings: deps.settings(actor),
          // The SDK replaces the environment rather than adding to it.
          env: { ...process.env, ...agentGitEnv(process.env) },
          maxBudgetUsd,
        };
      },
      // Output between turns has no turn end to clear the line it would set.
      onMessage: (m, pending) => pending !== null && deps.observe(actor, m),
      onTurnEnd(pending, end) {
        deps.idle(actor);
        turnEnded(rec, pending.initiator, end);
      },
      onChange: () => refresh(rec),
      note: (text) => deps.note(rec, text),
      // Its record keeps everything; a follow-up or decision makes a new session that resumes it.
      onDormant() {
        sessions.delete(id);
        session.close();
      },
    });
    sessions.set(id, session);
    return session;
  }

  function cloud(rec: AgentRecord, op: () => Promise<void>) {
    const id = rec.agent.id;
    const next = (cloudQueues.get(id) ?? Promise.resolve()).then(op);
    cloudQueues.set(id, next.catch(() => {}));
    return next;
  }

  return {
    async start(botId, a) {
      const id = `a_${crypto.randomUUID()}` as AgentId;
      const repo = realpathOr(a.project.path);
      // Another live agent in the project folder, or one still being placed, makes auto isolate. Cloud agents ignore isolate.
      const busy =
        [...preparing.values()].includes(repo) || [...deps.world.agents.values()].some((r) => repoOf(r) === repo && !r.agent.worktree && sessions.has(r.agent.id));
      let workspace: Workspace = { cwd: a.project.path, worktree: null, base: null, note: null };
      if (a.where === "mac") {
        preparing.set(id, repo);
        try {
          workspace = await prepareWorkspace(a.project, id, a.isolate, { busy, root: worktrees });
        } finally {
          preparing.delete(id);
        }
      }
      const at = deps.now();
      // A command runs only as the bare text, so it goes without the agent prompt's framing.
      const command = a.where === "mac" && a.slash ? `/${a.slash} ${a.prompt}` : null;
      const rec: AgentRecord = {
        agent: {
          id,
          botId,
          title: a.title,
          where: a.where,
          projectName: a.project.name,
          status: "working",
          url: null,
          createdAt: at,
          updatedAt: at,
          evidence: null,
          worktree: workspace.worktree,
        },
        cwd: workspace.cwd,
        repo,
        base: workspace.base,
        messages: [{ id: newMessageId(), at, from: "bot", text: command ?? a.prompt }],
        session: emptySession(),
        cloudSession: null,
        budgetUsd: a.budgetUsd,
        startedBy: a.initiator,
      };
      deps.world.agents.set(rec.agent.id, rec);
      deps.changed(rec);
      const prompt = agentPrompt({ botName: a.botName, userName: deps.userName, prompt: a.prompt });
      if (a.where === "mac") {
        if (workspace.note) deps.note(rec, workspace.note);
        macSession(rec).push(command === null ? queued(prompt, a.initiator) : { kind: "command", text: command, initiator: a.initiator, settles: null });
        const found = accessOf(process.env).full ? [] : projectConfigOf(repo);
        if (found.length > 0) deps.trustCard({ kind: "agent", botId, agentId: rec.agent.id }, { root: repo, name: a.project.name, found });
        return rec;
      }
      await cloud(rec, async () => {
        try {
          const created = await createCloudSession(rec.cwd, prompt);
          rec.cloudSession = created.sessionId;
          rec.agent = { ...rec.agent, url: created.url };
          update(rec, "in_cloud");
        } catch (e) {
          update(rec, "failed", { from: "agent", text: errorText(e) });
        }
      });
      return rec;
    },

    async message(rec, text, initiator) {
      if (gone(rec)) return `${rec.agent.title} worked in a worktree that was removed, so it cannot continue. Start a new agent.`;
      if (rec.agent.where === "mac") {
        // Recorded before the push, which can end the turn at once (a used-up budget) and report after it.
        record(rec, { from: "bot", text });
        macSession(rec).push(queued(text, initiator));
        refresh(rec);
        return `Sent. ${rec.agent.title} will report back.`;
      }
      const cloudSession = rec.cloudSession;
      if (!cloudSession) return "This cloud agent has no session to follow up on.";
      update(rec, rec.agent.status, { from: "bot", text });
      let result = "";
      await cloud(rec, async () => {
        try {
          await followUpCloudSession(rec.cwd, cloudSession, text);
          result = `Sent to the cloud session. Follow it at ${rec.agent.url}`;
        } catch (e) {
          result = errorText(e);
        }
      });
      return result;
    },

    deliver(rec, input) {
      if (rec.agent.where !== "mac" || gone(rec)) return;
      macSession(rec).push(input);
      refresh(rec);
    },

    notice(rec, text) {
      if (rec.agent.where !== "mac" || gone(rec)) return;
      macSession(rec).notice(text);
      refresh(rec);
    },

    async removeWorktree(rec) {
      const id = rec.agent.id;
      const worktree = rec.agent.worktree;
      if (!worktree) return refused("This agent works in the project folder, not a worktree.");
      const session = sessions.get(id);
      const carded = deps.world.gate.open.some((c) => c.actor.kind === "agent" && c.actor.agentId === id);
      if (session?.working || rec.session.pending.length > 0 || carded) return refused("The agent is still working. Stop it or wait for its report first.");
      if (removing.has(id)) return refused("The worktree is already being removed.");
      removing.add(id);
      try {
        const result = await removeWorktree(repoOf(rec), worktree);
        if (!result.ok) return result;
      } finally {
        removing.delete(id);
      }
      sessions.get(id)?.close();
      sessions.delete(id);
      rec.agent = { ...rec.agent, worktree: null, updatedAt: deps.now() };
      deps.changed(rec);
      return { ok: true };
    },

    async stop(rec) {
      const session = sessions.get(rec.agent.id);
      return session ? session.interrupt() : false;
    },

    session: (id) => sessions.get(id) ?? null,
    sessions: () => [...sessions.values()],

    resume() {
      for (const rec of deps.world.agents.values()) {
        if (rec.agent.where !== "mac") continue;
        if (rec.session.pending.length > 0) macSession(rec);
        // A mac agent cut off mid-turn with nothing queued will never report, so tell its bot.
        else if (rec.agent.status === "working") report(rec, "failed", "The bridge restarted while this agent was working. Send it a message to resume it.", rec.startedBy);
      }
    },

    trusted(root) {
      for (const [id, session] of sessions) {
        const rec = deps.world.agents.get(id);
        if (rec && repoOf(rec) === root) session.reopen();
      }
    },

    stopFor(botId) {
      for (const [id, session] of sessions) {
        if (deps.world.agents.get(id)?.agent.botId !== botId) continue;
        session.close();
        sessions.delete(id);
      }
    },
  };
}
