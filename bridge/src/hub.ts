import { createAgents } from "./agents";
import { describe, isDue, parseCron } from "./cron";
import type { Homes } from "./home";
import type { Project } from "./projects";
import type { AgentId, Avatar, Bot, BotId, ClientMessage, Message, RoutineId, ServerMessage } from "./protocol";
import { botMemory, envelope, onboarding, persona, type Envelope } from "./prompts";
import { createSession, type Session } from "./session";
import { botToolServer, type BotActions } from "./tools";
import { freshTurn, readTurn } from "./turn";
import {
  agentPeer,
  botPeer,
  findBot,
  linksOf,
  newBot,
  newMessageId,
  post,
  randomAvatar,
  recordExchange,
  routinePeer,
  settleQuestion,
  sortBots,
  toBot,
  upsertRoutine,
  type BotRecord,
  type World,
} from "./world";

export function createHub(deps: {
  machine: string;
  userName: string;
  world: World;
  homes: Homes;
  model: string | undefined;
  scan: () => Promise<Project[]>;
  broadcast: (message: ServerMessage) => void;
  persist: () => void;
  log: (line: string) => void;
}) {
  const { world, homes, userName } = deps;
  const brains = new Map<BotId, Session>();
  const now = () => new Date().toISOString();

  const view = (bot: BotRecord): Bot => toBot(bot, brains.get(bot.id)?.working ? "working" : "idle");

  function changed(bot: BotRecord) {
    deps.broadcast({ type: "bot", bot: view(bot) });
    deps.persist();
  }

  function say(bot: BotRecord, message: Message) {
    deps.broadcast({ type: "message", botId: bot.id, message: post(bot, message) });
    changed(bot);
  }

  const note = (bot: BotRecord, text: string, refs: Extract<Message, { kind: "note" }>["refs"] = []) =>
    say(bot, { kind: "note", id: newMessageId(), at: now(), text, refs });

  function exchange(bot: BotRecord, peer: Parameters<typeof recordExchange>[1], direction: "sent" | "received") {
    deps.broadcast({ type: "message", botId: bot.id, message: recordExchange(bot, peer, direction, now()) });
    changed(bot);
  }

  const logResult = (label: string, sessionId: string, cost: number) => deps.log(`result ${label} session=${sessionId} totalCostUsd=${cost}`);

  function brain(bot: BotRecord): Session {
    const existing = brains.get(bot.id);
    if (existing) return existing;
    let turn = freshTurn;
    const session = createSession({
      options: () => ({
        cwd: homes.homeOf(bot.id),
        resume: bot.sessionId ?? undefined,
        settingSources: ["user", "project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: persona({ name: bot.name, userName, userMd: homes.userMd }) },
        permissionMode: "auto",
        mcpServers: { claudio: botToolServer(bot.id, actions) },
        // A bot asks with its own ask tool, which posts a card instead of blocking the turn.
        disallowedTools: ["AskUserQuestion"],
        model: deps.model,
      }),
      onMessage(m) {
        if (!world.bots.has(bot.id)) return;
        if (m.session_id && m.session_id !== bot.sessionId) {
          bot.sessionId = m.session_id;
          deps.persist();
        }
        const read = readTurn(turn, m);
        turn = read.turn;
        for (const { id, text } of read.bubbles) say(bot, { kind: "bot", id, at: now(), text });
        if (m.type === "result") {
          logResult(`bot ${bot.id}`, m.session_id, m.total_cost_usd);
          if (m.subtype !== "success") note(bot, `${bot.name} stopped with an error: ${m.errors.join("; ") || m.subtype}`);
        }
      },
      onWorking() {
        if (world.bots.has(bot.id)) changed(bot);
      },
      onCrash(error) {
        turn = freshTurn;
        if (world.bots.has(bot.id)) note(bot, `${bot.name} crashed: ${error}`);
      },
    });
    brains.set(bot.id, session);
    return session;
  }

  function deliver(bot: BotRecord, e: Envelope) {
    const text = envelope(e, userName);
    deps.log(`envelope ${bot.id} ${text.split("\n")[0]}`);
    brain(bot).push(text);
  }

  function makeBot(fields: { name: string; avatar: Avatar; job: string }, by: Extract<Envelope, { from: "created" }>): BotRecord {
    const bot = newBot({ id: `b_${crypto.randomUUID()}` as BotId, name: fields.name, avatar: fields.avatar, at: now() });
    homes.create(bot.id, botMemory({ name: fields.name, job: fields.job }));
    world.bots.set(bot.id, bot);
    changed(bot);
    deliver(bot, by);
    return bot;
  }

  const agents = createAgents({
    world,
    userName,
    model: deps.model,
    now,
    logResult,
    changed(rec) {
      deps.broadcast({ type: "agent", agent: rec.agent, messages: rec.messages });
      deps.persist();
    },
    reported(rec, text) {
      const bot = world.bots.get(rec.agent.botId);
      if (!bot) return;
      exchange(bot, agentPeer(rec.agent), "received");
      deliver(bot, { from: "agent", title: rec.agent.title, agentId: rec.agent.id, text });
    },
  });

  function owned(botId: BotId): BotRecord {
    const bot = world.bots.get(botId);
    if (!bot) throw new Error("This bot no longer exists.");
    return bot;
  }

  function findProject(projects: Project[], ref: string): Project | undefined {
    const key = ref.trim().toLowerCase();
    return projects.find((p) => p.path === ref.trim()) ?? projects.find((p) => p.name.toLowerCase() === key);
  }

  const actions: BotActions = {
    ask(botId, a) {
      say(owned(botId), { kind: "question", id: newMessageId(), at: now(), question: a.question, options: a.options, answer: null });
      return "Card posted. End your turn; the answer arrives as a new message.";
    },

    async startAgent(botId, a) {
      const bot = owned(botId);
      const project = findProject(await deps.scan(), a.project);
      if (!project) return `No project "${a.project}". Call list_projects for the names.`;
      if (a.where === "cloud" && !project.githubRepo) return `${project.name} has no GitHub remote, so start it with where "mac".`;
      const rec = await agents.start(botId, { ...a, project, botName: bot.name });
      exchange(bot, agentPeer(rec.agent), "sent");
      if (rec.agent.where === "mac") return `Started agent ${rec.agent.id} on ${project.name}. It reports back to you when its turn ends.`;
      if (rec.agent.status === "failed") return `The cloud agent failed to start: ${rec.messages.at(-1)?.text}`;
      return `Started cloud agent ${rec.agent.id}: ${rec.agent.url}\nCloud agents do not report back. Tell ${userName} to follow the link.`;
    },

    async messageAgent(botId, a) {
      const bot = owned(botId);
      const rec = world.agents.get(a.agentId as AgentId);
      if (!rec || rec.agent.botId !== botId) return `No agent ${a.agentId} of yours.`;
      exchange(bot, agentPeer(rec.agent), "sent");
      return agents.message(rec, a.text);
    },

    async listProjects() {
      const projects = await deps.scan();
      return projects.length === 0 ? "No projects found." : JSON.stringify(projects, null, 1);
    },

    messageBot(botId, a) {
      const from = owned(botId);
      const to = findBot(world, a.bot);
      if (!to) return `No bot "${a.bot}". Bots: ${[...world.bots.values()].map((b) => b.name).join(", ")}.`;
      if (to.id === from.id) return "That is you.";
      exchange(from, botPeer(to), "sent");
      exchange(to, botPeer(from), "received");
      deliver(to, { from: "bot", name: from.name, text: a.text });
      return `Delivered to ${to.name}.`;
    },

    createBot(botId, a) {
      const creator = owned(botId);
      const avatar = { ...randomAvatar(), ...(a.shape && { shape: a.shape }), ...(a.color && { color: a.color }) };
      const bot = makeBot({ name: a.name, avatar, job: a.job }, { from: "created", by: { bot: creator.name }, brief: a.job });
      note(creator, "Created {0}", [botPeer(bot)]);
      return `Created ${bot.name} (${bot.id}). It has its brief and starts now.`;
    },

    updateSelf(botId, a) {
      const bot = owned(botId);
      if (a.name !== undefined) bot.name = a.name;
      if (a.title !== undefined) bot.title = a.title.trim() || null;
      bot.avatar = { shape: a.shape ?? bot.avatar.shape, color: a.color ?? bot.avatar.color };
      changed(bot);
      return "Updated.";
    },

    setRoutine(botId, a) {
      const bot = owned(botId);
      const cron = parseCron(a.schedule);
      if ("error" in cron) return `Invalid schedule: ${cron.error}`;
      const enabled = a.enabled ?? bot.routines.find((r) => r.name === a.name)?.enabled ?? true;
      const { routine, created } = upsertRoutine(
        bot,
        { name: a.name, schedule: a.schedule.trim(), describe: describe(a.schedule), prompt: a.prompt, enabled },
        () => `r_${crypto.randomUUID()}` as RoutineId,
      );
      note(bot, created ? "Created routine {0}" : "Updated routine {0}", [routinePeer(routine)]);
      return `Routine ${routine.name}: ${routine.describe}${routine.enabled ? "" : " (paused)"}.`;
    },

    deleteRoutine(botId, a) {
      const bot = owned(botId);
      const before = bot.routines.length;
      bot.routines = bot.routines.filter((r) => r.name !== a.name);
      if (bot.routines.length === before) return `No routine named ${a.name}.`;
      note(bot, `Deleted routine ${a.name}`);
      return `Deleted ${a.name}.`;
    },
  };

  const error = (message: string): ServerMessage[] => [{ type: "error", message }];

  async function handle(message: ClientMessage): Promise<ServerMessage[]> {
    if (message.type === "create_bot") {
      const bot = makeBot(
        { name: "New Bot", avatar: randomAvatar(), job: `Not decided yet. Learn what ${userName} wants help with first.` },
        { from: "created", by: "user", brief: onboarding(userName) },
      );
      return [{ type: "created", ref: message.ref, botId: bot.id }];
    }
    if (message.type === "agent") {
      const rec = world.agents.get(message.agentId);
      return rec ? [{ type: "agent", agent: rec.agent, messages: rec.messages }] : error("Unknown agent");
    }

    const bot = world.bots.get(message.botId);
    if (!bot) return error("Unknown bot");

    switch (message.type) {
      case "open":
        bot.unread = 0;
        changed(bot);
        return [{ type: "conversation", botId: bot.id, messages: bot.messages }];
      case "send": {
        const attachments = homes.saveUploads(bot.id, message.uploads);
        if ("error" in attachments) return error(attachments.error);
        say(bot, { kind: "user", id: newMessageId(), at: now(), text: message.text, attachments });
        deliver(bot, { from: "user", text: message.text, attachments });
        return [];
      }
      case "answer":
      case "dismiss": {
        const settled = settleQuestion(
          bot.messages.find((m) => m.id === message.messageId),
          message.type === "answer" ? message.option : "dismissed",
        );
        if (!settled.ok) return error(settled.error);
        const q = settled.message;
        say(bot, q);
        deliver(bot, q.answer === "dismissed" ? { from: "dismiss", question: q.question } : { from: "answer", question: q.question, option: q.options[q.answer!]! });
        return [];
      }
      case "update_bot":
        Object.assign(bot, message.patch);
        changed(bot);
        return [];
      case "mark_unread":
        bot.unread = Math.max(1, bot.unread);
        changed(bot);
        return [];
      case "delete_bot":
        brains.get(bot.id)?.close();
        brains.delete(bot.id);
        agents.stopFor(bot.id);
        for (const [id, rec] of world.agents) if (rec.agent.botId === bot.id) world.agents.delete(id);
        world.bots.delete(bot.id);
        homes.trash(bot.id, new Date());
        deps.broadcast({ type: "bot_removed", botId: bot.id });
        deps.persist();
        return [];
      case "set_routine": {
        const routine = bot.routines.find((r) => r.id === message.routineId);
        if (!routine) return error("Unknown routine");
        routine.enabled = message.enabled;
        changed(bot);
        return [];
      }
      case "details": {
        const own = [...world.agents.values()].filter((a) => a.agent.botId === bot.id).map((a) => a.agent);
        own.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return [{ type: "details", botId: bot.id, library: homes.library(bot.id), links: linksOf(bot, own), agents: own }];
      }
      case "file": {
        const file = await homes.read(bot.id, message.path);
        if ("error" in file) return error(file.error);
        return [{ type: "file", botId: bot.id, path: message.path, ...file }];
      }
    }
  }

  function tick(at: Date) {
    for (const bot of world.bots.values()) {
      for (const routine of bot.routines) {
        if (!isDue(routine, at)) continue;
        routine.lastRunAt = at.toISOString();
        changed(bot);
        deliver(bot, { from: "routine", name: routine.name, prompt: routine.prompt });
      }
    }
  }

  return {
    hello: (): ServerMessage => ({ type: "hello", machine: deps.machine, userName, bots: sortBots([...world.bots.values()].map(view)) }),
    handle,
    tick,

    boot(firstRun: boolean) {
      homes.ensureUserMd(userName);
      if (firstRun) {
        makeBot(
          { name: "Claudio Bot", avatar: { shape: "circle", color: "white" }, job: `General assistant. Take real work off ${userName}'s plate.` },
          { from: "created", by: "user", brief: null },
        );
      }
      agents.recover();
    },

    // Wakes at the start of every minute. isDue makes a second wake in the same minute harmless.
    startTicker(): () => void {
      let timer: ReturnType<typeof setTimeout>;
      const schedule = () => {
        timer = setTimeout(() => {
          tick(new Date());
          schedule();
        }, 60_000 - (Date.now() % 60_000) + 50);
      };
      schedule();
      return () => clearTimeout(timer);
    },

    close() {
      for (const session of brains.values()) session.close();
      for (const bot of world.bots.values()) agents.stopFor(bot.id);
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
