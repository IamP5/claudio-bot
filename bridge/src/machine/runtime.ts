import { createAgents, type Agents } from "../agents";
import type { CardReply } from "../gate";
import { findProject, projectsText, type Project } from "../projects";
import type { AgentId, BotId, MessageId } from "../protocol";
import type { AgentRecord } from "../world";
import type { Journal } from "./journal";
import type { Applied, BotStandIn, Event, EventBody, Intent, IntentId, Seq } from "./wire";

type AgentsDeps = Parameters<typeof createAgents>[0];

export type RuntimeDeps = Omit<AgentsDeps, "changed" | "reported" | "note"> & {
  /** The projects under this machine's roots, where agent.start resolves its ProjectRef. */
  scan: () => Promise<Project[]>;
  /** gate.answer, for card.answer. */
  answer: (botId: BotId, cardId: MessageId, reply: CardReply) => { ok: true } | { ok: false; error: string };
  /**
   * Makes sure agent.start's bot is there to hold the agent's cards, rules and cap. False: the bot is gone. On the home
   * the bot's real record is its stand-in, and only the home writes it; a machine keeps a stand-in of its own.
   */
  standIn: (bot: BotStandIn) => boolean;
  /** bot.forget: what holds the bot's agents here lets go of them for good. Absent: the bot lives here, and the hub deletes it. */
  forgetBot?: (botId: BotId) => void;
  journal: Journal;
};

/**
 * What only code in the runtime's own process reaches: the gate's wiring (deliver, notice, trusted), the clock's
 * sessions, boot and bot deletion. The gate stays where the agent runs, so none of this ever crosses the wire.
 */
export type LocalAgents = Pick<Agents, "deliver" | "notice" | "session" | "sessions" | "resume" | "stopFor" | "trusted">;

export type AgentRuntime = {
  /** Applies an intent once: a repeated intentId gets the first application's result. */
  apply(intent: Intent): Promise<Applied>;
  /** The outbox after seq, oldest first: what the journal still keeps. */
  events(after: Seq): Event[];
  /** The newest seq emitted, 0 for none. */
  lastSeq(): Seq;
  /** The home handled every event through seq, so the journal may drop them. */
  ack(seq: Seq): void;
  /**
   * An event from outside the agents: a message the gate posted on a stand-in, for the home's mirror of the bot's chat,
   * a card's reminder, a card in a session the phone drives, a row the ledger charged, or this machine's profile at boot.
   */
  emit(body: Extract<EventBody, { kind: "card" | "reminder" | "sessionCard" | "usage" | "profile" }>): void;
  /** Called with each event as it is emitted, in order. Returns the unsubscribe. */
  subscribe(f: (e: Event) => void): () => void;
  local: LocalAgents;
};

const UNKNOWN_AGENT = "Unknown agent";
/** Each agent's newest messages in a snapshot, so one frame holds every agent; its agent events carry the whole thread. */
export const SNAPSHOT_MESSAGES = 200;

const ok: Applied = { ok: true };
const refuse = (reason: string): Applied => ({ ok: false, reason });

export function createAgentRuntime(deps: RuntimeDeps): AgentRuntime {
  const { scan, answer, standIn, forgetBot, journal, ...agentDeps } = deps;
  const subscribers = new Set<(e: Event) => void>();
  /** Intents still being applied. A finished one's answer is in the journal. */
  const applying = new Map<IntentId, Promise<Applied>>();

  function emit(body: EventBody) {
    const e: Event = { seq: journal.seq() + 1, at: deps.now(), ...body };
    journal.append(e);
    for (const f of subscribers) f(e);
  }

  const agents = createAgents({
    ...agentDeps,
    // A copy, so an event in the outbox stays what was true when it was emitted.
    changed: (rec) => emit({ kind: "agent", agent: rec.agent, messages: [...rec.messages] }),
    reported: (rec, text, by) => emit({ kind: "report", agentId: rec.agent.id, botId: rec.agent.botId, text, by }),
    note: (rec, text) => emit({ kind: "note", agentId: rec.agent.id, botId: rec.agent.botId, text }),
  });

  function started(rec: AgentRecord): string {
    const { id, where, status, projectName, url } = rec.agent;
    if (where === "mac") return `Started agent ${id} on ${projectName}. It reports back to you when its turn ends.`;
    if (status === "failed") return `The cloud agent failed to start: ${rec.messages.at(-1)?.text}`;
    return `Started cloud agent ${id}: ${url}\nCloud agents do not report back. Tell ${deps.userName} to follow the link.`;
  }

  async function start(i: Extract<Intent, { kind: "agent.start" }>): Promise<Applied> {
    const replayed = deps.world.agents.get(i.agentId);
    if (replayed) return { ok: true, reply: started(replayed) };
    const projects = await scan();
    if (!standIn(i.bot)) return refuse("This bot no longer exists.");
    const project = findProject(projects, i.project.name);
    if (!project) return refuse(`No project "${i.project.name}". Call list_projects for the names.`);
    if (i.where === "cloud" && !project.githubRepo) return refuse(`${project.name} has no GitHub remote, so start it with where "mac".`);
    const rec = await agents.start(i.bot.id, {
      id: i.agentId,
      title: i.title,
      prompt: i.prompt,
      project,
      where: i.where,
      isolate: i.isolate,
      botName: i.bot.name,
      initiator: i.initiator,
      budgetUsd: i.budgetUsd,
      slash: i.slash,
    });
    return { ok: true, reply: started(rec) };
  }

  async function onAgent(id: AgentId, f: (rec: AgentRecord) => Applied | Promise<Applied>): Promise<Applied> {
    const rec = deps.world.agents.get(id);
    return rec ? f(rec) : refuse(UNKNOWN_AGENT);
  }

  function snapshot(): EventBody {
    const mirror = [...deps.world.agents.values()].map((r) => ({ agent: r.agent, messages: r.messages.slice(-SNAPSHOT_MESSAGES) }));
    const openCards = deps.world.gate.open.flatMap((c) => {
      if (c.actor.kind !== "agent") return [];
      const message = deps.world.bots.get(c.actor.botId)?.messages.find((m) => m.id === c.cardId);
      return message ? [{ botId: c.actor.botId, message }] : [];
    });
    return { kind: "snapshot", agents: mirror, openCards };
  }

  async function run(intent: Intent): Promise<Applied> {
    switch (intent.kind) {
      case "agent.start":
        return start(intent);
      case "agent.message":
        return onAgent(intent.agentId, async (rec) => ({ ok: true, reply: await agents.message(rec, intent.text, intent.initiator) }));
      case "agent.direct":
        return onAgent(intent.agentId, (rec) => {
          const refusal = agents.direct(rec, intent.text, intent.clientId);
          return refusal === null ? ok : refuse(refusal);
        });
      case "agent.stop":
        return onAgent(intent.agentId, async (rec) => ((await agents.stop(rec)) ? ok : refuse("Nothing is running.")));
      case "agent.removeWorktree":
        return onAgent(intent.agentId, async (rec) => {
          const r = await agents.removeWorktree(rec);
          return r.ok ? ok : refuse(r.error);
        });
      case "card.answer": {
        const r = answer(intent.botId, intent.cardId, intent.reply);
        return r.ok ? ok : refuse(r.error);
      }
      case "bot.forget":
        if (!forgetBot) return refuse("This bridge holds the bot itself.");
        forgetBot(intent.botId);
        return ok;
      case "snapshot":
        emit(snapshot());
        return ok;
      case "projects":
        return { ok: true, reply: projectsText(await scan()) };
      default: {
        const unhandled: never = intent;
        throw new Error(`Unknown intent ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return {
    apply(intent) {
      if (intent.kind === "snapshot" || intent.kind === "projects") return run(intent);
      const done = journal.applied(intent.intentId);
      if (done) return Promise.resolve(done);
      const seen = applying.get(intent.intentId);
      if (seen) return seen;
      const result = run(intent).then((r) => {
        if (!r.ok) emit({ kind: "refused", intentId: intent.intentId, reason: r.reason });
        journal.remember(intent.intentId, r);
        return r;
      });
      applying.set(intent.intentId, result);
      void result.finally(() => applying.delete(intent.intentId)).catch(() => {});
      return result;
    },
    events: (after) => journal.after(after),
    lastSeq: () => journal.seq(),
    ack: (seq) => journal.ack(seq),
    emit,
    subscribe(f) {
      subscribers.add(f);
      return () => void subscribers.delete(f);
    },
    local: {
      deliver: agents.deliver,
      notice: agents.notice,
      session: agents.session,
      sessions: agents.sessions,
      resume: agents.resume,
      stopFor: agents.stopFor,
      trusted: agents.trusted,
    },
  };
}
