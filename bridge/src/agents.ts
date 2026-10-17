import type { HookCallbackMatcher, HookEvent, Options } from "@anthropic-ai/claude-agent-sdk";
import { createCloudSession, followUpCloudSession } from "./cloud";
import type { Ledger } from "./ledger";
import type { AgentId, AgentStatus, BotId } from "./protocol";
import { agentPrompt, type SessionInput } from "./prompts";
import type { Project } from "./projects";
import { createSession, usedBudget, type Session, type SessionSpec, type TurnEnd } from "./session";
import type { Persist } from "./store";
import { errorText } from "./text";
import { emptySession, newMessageId, type Actor, type AgentRecord, type Initiator, type World } from "./world";

// Agents are actors like bots: mac agents run on the same session module behind the same gate, metered by the same
// ledger. Cloud agents run on claude.ai: the bridge neither gates nor meters them.
export type Agents = {
  /** initiator: the bot turn's, so an agent started by a routine runs as routine work; kept as startedBy. budgetUsd null: the default. */
  start(
    botId: BotId,
    a: { title: string; prompt: string; project: Project; where: "mac" | "cloud"; botName: string; initiator: Initiator; budgetUsd: number | null },
  ): Promise<AgentRecord>;
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
};

const queued = (text: string, initiator: Initiator): SessionInput => ({ kind: "envelope", text, initiator, settles: null });

/** Statuses that hold only while the session or an open card says so. */
const LIVE: ReadonlySet<AgentStatus> = new Set(["working", "parked", "awaiting_approval"]);

export function createAgents(deps: {
  world: World;
  userName: string;
  model: string | undefined;
  ledger: Ledger;
  log: (line: string) => void;
  /** Tests pass a fake SDK. */
  claude?: Pick<SessionSpec, "query" | "executable">;
  hooks: (actor: Actor) => Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** An approval continuation's turn starts (gate.beginTurn). */
  beginTurn: (actor: Actor) => void;
  persist: Persist;
  now: () => string;
  /** The record or something its status derives from changed, including its session's lifecycle and deadlines. */
  changed: (agent: AgentRecord) => void;
  /** by: the initiator of the agent turn that reported, so the bot's turn continues that chain's lineage. */
  reported: (agent: AgentRecord, text: string, by: Initiator) => void;
  /** A line about the agent in its bot's chat. */
  note: (agent: AgentRecord, text: string) => void;
}): Agents {
  const sessions = new Map<AgentId, Session>();
  const cloudQueues = new Map<AgentId, Promise<void>>();

  /** A mac agent shows what its session is doing, or an open card; once neither holds, what its last report left. */
  function statusOf(rec: AgentRecord, reported: AgentStatus): AgentStatus {
    if (rec.agent.where === "cloud") return reported;
    const id = rec.agent.id;
    const session = sessions.get(id);
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

  function report(rec: AgentRecord, status: AgentStatus, text: string, by: Initiator) {
    update(rec, status, { from: "agent", text });
    deps.reported(rec, text, by);
  }

  function turnEnded(rec: AgentRecord, by: Initiator, end: TurnEnd) {
    if (usedBudget(end)) return report(rec, "failed", "The agent used its budget.", by);
    switch (end.kind) {
      case "done": {
        const m = end.result;
        const text = m.subtype === "success" ? m.result : `The agent stopped with an error: ${m.errors.join("; ") || m.subtype}`;
        return report(rec, m.subtype === "success" ? "waiting" : "failed", text.trim() || "(no final message)", by);
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
    const actor: Actor = { kind: "agent", botId: rec.agent.botId, agentId: id };
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
        return {
          cwd: rec.cwd,
          resume: rec.session.id ?? undefined,
          settingSources: ["user", "project"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: "auto",
          // Nobody is at the agent's terminal to answer; it reports to its bot instead.
          disallowedTools: ["AskUserQuestion"],
          model: deps.model,
          hooks: deps.hooks(actor),
          maxBudgetUsd,
        };
      },
      onMessage() {},
      onTurnEnd: (pending, end) => turnEnded(rec, pending.initiator, end),
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
      const at = deps.now();
      const rec: AgentRecord = {
        agent: {
          id: `a_${crypto.randomUUID()}` as AgentId,
          botId,
          title: a.title,
          where: a.where,
          projectName: a.project.name,
          status: "working",
          url: null,
          createdAt: at,
          updatedAt: at,
        },
        cwd: a.project.path,
        messages: [{ id: newMessageId(), at, from: "bot", text: a.prompt }],
        session: emptySession(),
        cloudSession: null,
        budgetUsd: a.budgetUsd,
        startedBy: a.initiator,
      };
      deps.world.agents.set(rec.agent.id, rec);
      deps.changed(rec);
      const prompt = agentPrompt({ botName: a.botName, userName: deps.userName, prompt: a.prompt });
      if (a.where === "mac") {
        macSession(rec).push(queued(prompt, a.initiator));
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
      if (rec.agent.where !== "mac") return;
      macSession(rec).push(input);
      refresh(rec);
    },

    notice(rec, text) {
      if (rec.agent.where !== "mac") return;
      macSession(rec).notice(text);
      refresh(rec);
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

    stopFor(botId) {
      for (const [id, session] of sessions) {
        if (deps.world.agents.get(id)?.agent.botId !== botId) continue;
        session.close();
        sessions.delete(id);
      }
    },
  };
}
