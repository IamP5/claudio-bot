import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createCloudSession, followUpCloudSession } from "./cloud";
import type { AgentId, AgentStatus, BotId } from "./protocol";
import { agentPrompt } from "./prompts";
import type { Project } from "./projects";
import { createSession, type Session } from "./session";
import { newMessageId, type AgentRecord, type World } from "./world";

export function createAgents(deps: {
  world: World;
  userName: string;
  model: string | undefined;
  now: () => string;
  changed: (agent: AgentRecord) => void;
  reported: (agent: AgentRecord, text: string) => void;
  logResult: (label: string, sessionId: string, totalCostUsd: number) => void;
}) {
  const sessions = new Map<AgentId, Session>();
  const cloudQueues = new Map<AgentId, Promise<void>>();

  function update(rec: AgentRecord, status: AgentStatus, said?: { from: "bot" | "agent"; text: string }) {
    const at = deps.now();
    rec.agent = { ...rec.agent, status, updatedAt: at };
    if (said) rec.messages.push({ id: newMessageId(), at, ...said });
    deps.changed(rec);
  }

  function report(rec: AgentRecord, status: AgentStatus, text: string) {
    update(rec, status, { from: "agent", text });
    deps.reported(rec, text);
  }

  function macSession(rec: AgentRecord): Session {
    const id = rec.agent.id;
    const existing = sessions.get(id);
    if (existing) return existing;
    const session = createSession({
      options: (): Options => ({
        cwd: rec.cwd,
        resume: rec.sessionId ?? undefined,
        settingSources: ["user", "project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "auto",
        // Nobody is at the agent's terminal to answer; it reports to its bot instead.
        disallowedTools: ["AskUserQuestion"],
        model: deps.model,
      }),
      onMessage(m) {
        if (m.session_id && m.session_id !== rec.sessionId) {
          rec.sessionId = m.session_id;
          deps.changed(rec);
        }
        if (m.type !== "result") return;
        deps.logResult(`agent ${id}`, m.session_id, m.total_cost_usd);
        const text = m.subtype === "success" ? m.result : `The agent stopped with an error: ${m.errors.join("; ") || m.subtype}`;
        report(rec, m.subtype === "success" ? "waiting" : "failed", text.trim() || "(no final message)");
      },
      onWorking() {},
      onCrash(error) {
        report(rec, "failed", `The agent crashed: ${error}`);
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
    async start(botId: BotId, a: { title: string; prompt: string; project: Project; where: "mac" | "cloud"; botName: string }) {
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
        sessionId: null,
      };
      deps.world.agents.set(rec.agent.id, rec);
      deps.changed(rec);
      const prompt = agentPrompt({ botName: a.botName, userName: deps.userName, prompt: a.prompt });
      if (a.where === "mac") {
        macSession(rec).push(prompt);
        return rec;
      }
      await cloud(rec, async () => {
        try {
          const created = await createCloudSession(rec.cwd, prompt);
          rec.sessionId = created.sessionId;
          rec.agent = { ...rec.agent, url: created.url };
          update(rec, "in_cloud");
        } catch (e) {
          update(rec, "failed", { from: "agent", text: (e as Error).message });
        }
      });
      return rec;
    },

    async message(rec: AgentRecord, text: string): Promise<string> {
      if (rec.agent.where === "mac") {
        update(rec, "working", { from: "bot", text });
        macSession(rec).push(text);
        return `Sent. ${rec.agent.title} will report back.`;
      }
      if (!rec.sessionId) return "This cloud agent has no session to follow up on.";
      update(rec, rec.agent.status, { from: "bot", text });
      let result = "";
      await cloud(rec, async () => {
        try {
          await followUpCloudSession(rec.cwd, rec.sessionId!, text);
          result = `Sent to the cloud session. Follow it at ${rec.agent.url}`;
        } catch (e) {
          result = (e as Error).message;
        }
      });
      return result;
    },

    // A mac agent that was mid-turn when the bridge stopped will never report, so tell its bot.
    recover() {
      for (const rec of deps.world.agents.values()) {
        if (rec.agent.where === "mac" && rec.agent.status === "working") {
          report(rec, "failed", "The bridge restarted while this agent was working. Send it a message to resume it.");
        }
      }
    },

    stopFor(botId: BotId) {
      for (const [id, session] of sessions) {
        if (deps.world.agents.get(id)?.agent.botId !== botId) continue;
        session.close();
        sessions.delete(id);
      }
    },
  };
}

export type Agents = ReturnType<typeof createAgents>;
