import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createAgents } from "./agents";
import { createClock, type Tickable } from "./clock";
import { createGate, type Gate } from "./gate";
import type { Homes } from "./home";
import { createLedger } from "./ledger";
import type { Scope } from "./policy";
import type { Project } from "./projects";
import {
  PROTOCOL,
  type AgentId,
  type Avatar,
  type Bot,
  type BotId,
  type ClientMessage,
  type Message,
  type Peer,
  type ServerMessage,
  type StreamPosition,
} from "./protocol";
import { botMemory, inputOf, onboarding, persona, type Envelope } from "./prompts";
import type { Push } from "./push";
import { createScheduler, type RunOutcome } from "./scheduler";
import { createSession, type Session, type TurnEnd } from "./session";
import type { Persist } from "./store";
import { botToolServer, type BotActions } from "./tools";
import { freshTurn, readTurn } from "./turn";
import {
  agentPeer,
  botActor,
  botPeer,
  botStatus,
  findBot,
  holdOf,
  hopsAfter,
  hopsOf,
  linksOf,
  newBot,
  newMessageId,
  post,
  randomAvatar,
  recordExchange,
  rootOf,
  routineView,
  sortBots,
  toBot,
  type Actor,
  type BotRecord,
  type Initiator,
  type Pending,
  type World,
} from "./world";

// Orchestration only. Each client message and each tool call is a one-line route to the module that owns the state;
// card, routine, policy, usage and session logic live in those modules.

export type Hub = {
  /** The snapshot a socket gets first. main.ts passes the stream's position; without one, there is no replay ring. */
  hello(position?: StreamPosition): ServerMessage;
  /** Every client message. The transport ones (devices, revoke_device, pair_code) belong to main.ts, which answers them first. */
  handle(message: ClientMessage): Promise<ServerMessage[]>;
  /** Runs every stored-deadline owner once at `now`. One that throws is logged and the rest still run. */
  tick(now: Date): void;
  /** USER.md, the first bot on a first run, and sessions with queued envelopes (bots and agents). */
  boot(firstRun: boolean): void;
  startTicker(): () => void;
  close(): void;
};

export type HubDeps = {
  machine: string;
  userName: string;
  world: World;
  homes: Homes;
  model: string | undefined;
  scan: () => Promise<Project[]>;
  broadcast: (message: ServerMessage) => void;
  persist: Persist;
  log: (line: string) => void;
  /** main.ts passes this once push exists; without it nothing is pushed. */
  push?: Push;
};

const NO_RING: StreamPosition = { epoch: "", seq: 0, resumed: false };

const earliest = (deadlines: (string | null)[]): string | null =>
  deadlines.reduce<string | null>((min, d) => (d !== null && (min === null || d < min) ? d : min), null);

/** Ticks each in turn. A throw is logged under the ticker's name and never stops the ones after it. */
export function tickEach(tickers: Readonly<Record<string, Tickable>>, now: Date, log: (line: string) => void) {
  for (const [name, ticker] of Object.entries(tickers)) {
    try {
      ticker.tick(now);
    } catch (e) {
      log(`tick ${name} failed: ${(e as Error).stack ?? e}`);
    }
  }
}

export function createHub(deps: HubDeps): Hub {
  const { world, homes, userName } = deps;
  // USER.md sits at the root of the bridge home, the only path Homes exposes there.
  const root = dirname(homes.userMd);
  const clockNow = () => new Date();
  const now = () => clockNow().toISOString();
  const brains = new Map<BotId, Session>();
  const system: Initiator = { kind: "system" };
  // The clock is created last, once every ticker exists; a module may report a change while the hub is being built.
  let poke = () => {};

  const ledger = createLedger({
    dir: join(root, "usage"),
    capFor: (id) => world.bots.get(id)?.dailyCapUsd ?? null,
    budgetFor: (id) => world.agents.get(id)?.budgetUsd ?? null,
    now: clockNow,
    log: deps.log,
  });

  const accountParked = () => world.account.parkedUntil !== null && world.account.parkedUntil > now();
  // No turn of that attendance can start now: the usage limit holds every turn, the daily cap only unattended ones.
  // attended defaults to false only until U4's SchedulerDeps passes it.
  const parked = (bot: BotRecord, attended = false) => accountParked() || (!attended && !ledger.headroom(botActor(bot.id), system).ok);

  const view = (bot: BotRecord): Bot =>
    toBot(
      bot,
      botStatus({
        working: brains.get(bot.id)?.working ?? false,
        held: holdOf(bot.session) !== null,
        awaitingApproval: world.gate.open.some((c) => c.kind === "permission" && c.actor.kind === "bot" && c.actor.botId === bot.id),
      }),
    );

  // Every deadline change reaches the clock through here: say, note, scheduler and gate changes, and each session's
  // onChange all call it. A module that moves a deadline any other way leaves the clock asleep until its 60 s cap.
  function changed(bot: BotRecord) {
    deps.broadcast({ type: "bot", bot: view(bot) });
    deps.persist();
    poke();
  }

  function say(bot: BotRecord, message: Message) {
    deps.broadcast({ type: "message", botId: bot.id, message: post(bot, message) });
    changed(bot);
  }

  const note = (bot: BotRecord, text: string, refs: Peer[] = []) => say(bot, { kind: "note", id: newMessageId(), at: now(), text, refs });

  function exchange(bot: BotRecord, peer: Peer, direction: "sent" | "received") {
    deps.broadcast({ type: "message", botId: bot.id, message: recordExchange(bot, peer, direction, now()) });
    changed(bot);
  }

  const sessionOf = (actor: Actor): Session | null =>
    actor.kind === "bot" ? (brains.get(actor.botId) ?? null) : agents.session(actor.agentId);

  const initiatorNow = (bot: BotRecord): Initiator => brains.get(bot.id)?.current?.initiator ?? system;

  function scopeOf(actor: Actor): Scope {
    const bridgeHome = realpathSync(root);
    if (actor.kind === "bot") return { bridgeHome, own: realpathSync(homes.homeOf(actor.botId)), userMd: join(bridgeHome, "USER.md"), homedir: realpathSync(homedir()) };
    const rec = world.agents.get(actor.agentId);
    if (!rec) throw new Error(`Unknown agent ${actor.agentId}`);
    return { bridgeHome, own: realpathSync(rec.cwd), userMd: null, homedir: realpathSync(homedir()) };
  }

  function deliver(actor: Actor, e: Envelope) {
    const input = inputOf(e, userName);
    if (actor.kind === "bot") {
      const bot = world.bots.get(actor.botId);
      if (!bot) return;
      deps.log(`envelope ${bot.id} ${input.text.split("\n")[0]}`);
      brain(bot).push(input);
      return;
    }
    const rec = world.agents.get(actor.agentId);
    if (!rec) return;
    deps.log(`envelope ${rec.agent.id} ${input.text.split("\n")[0]}`);
    agents.deliver(rec, input);
  }

  function outcomeOf(end: Exclude<TurnEnd, { kind: "deferred" }>): RunOutcome {
    switch (end.kind) {
      case "done":
        return end.result.subtype === "success" ? { status: "ok", note: null } : { status: "failed", note: end.result.errors.join("; ") || end.result.subtype };
      case "failed":
        return { status: "failed", note: end.error };
      case "stopped":
      case "dropped":
        return { status: "skipped", note: `Stopped by ${userName}` };
    }
  }

  const pausedNote = (until: string, why: "usage_limit" | "daily_cap") =>
    `Paused until ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${why === "usage_limit" ? "usage limit" : "daily cap"})`;

  function endTurn(bot: BotRecord, turn: Pending, end: TurnEnd) {
    switch (end.kind) {
      case "done":
        if (end.result.subtype !== "success") note(bot, `${bot.name} stopped with an error: ${end.result.errors.join("; ") || end.result.subtype}`);
        break;
      case "failed":
        note(bot, `${bot.name} crashed: ${end.error}`);
        break;
      case "stopped":
        note(bot, `Stopped by ${userName}`);
        break;
      case "deferred":
        if (end.why !== "retry") note(bot, pausedNote(end.until, end.why));
        return;
      case "dropped":
        break;
    }
    if (turn.settles) scheduler.settle(bot.id, turn.settles, outcomeOf(end));
  }

  function brain(bot: BotRecord): Session {
    const existing = brains.get(bot.id);
    if (existing) return existing;
    const actor = botActor(bot.id);
    let turn = freshTurn;
    let pushed = false;
    const session = createSession({
      actor,
      state: bot.session,
      account: world.account,
      ledger,
      persist: deps.persist,
      options: () => ({
        cwd: homes.homeOf(bot.id),
        resume: bot.session.id ?? undefined,
        settingSources: ["user", "project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: persona({ name: bot.name, userName, userMd: homes.userMd }) },
        permissionMode: "auto",
        mcpServers: { claudio: botToolServer(bot.id, actions) },
        // A bot asks with its own ask tool, which posts a card instead of blocking the turn.
        disallowedTools: ["AskUserQuestion"],
        model: deps.model,
        hooks: gate.hooks(actor),
      }),
      onMessage(m) {
        if (!world.bots.has(bot.id)) return;
        const read = readTurn(turn, m);
        turn = read.turn;
        for (const { id, text } of read.bubbles) {
          say(bot, { kind: "bot", id, at: now(), text });
          if (!pushed) deps.push?.notify(bot, "message", id);
          pushed = true;
        }
      },
      onTurnEnd(pending, end) {
        turn = freshTurn;
        pushed = false;
        if (world.bots.has(bot.id)) endTurn(bot, pending, end);
      },
      onChange() {
        if (world.bots.has(bot.id)) changed(bot);
      },
      note(text) {
        if (world.bots.has(bot.id)) note(bot, text);
      },
    });
    brains.set(bot.id, session);
    return session;
  }

  function makeBot(fields: { name: string; avatar: Avatar; job: string }, by: Extract<Envelope, { from: "created" }>): BotRecord {
    const bot = newBot({ id: `b_${crypto.randomUUID()}` as BotId, name: fields.name, avatar: fields.avatar, at: now() });
    homes.create(bot.id, botMemory({ name: fields.name, job: fields.job }));
    world.bots.set(bot.id, bot);
    changed(bot);
    deliver(botActor(bot.id), by);
    return bot;
  }

  const gate = createGate({
    world,
    scopeOf,
    turnOf(actor) {
      const session = sessionOf(actor);
      const current = session?.current;
      return session && current ? { initiator: current.initiator, stopping: session.lifecycle.kind === "stopping" } : null;
    },
    headroom: (actor, initiator) => ledger.headroom(actor, initiator),
    say,
    deliver,
    notice(actor, text) {
      if (actor.kind === "bot") {
        const bot = world.bots.get(actor.botId);
        if (bot) brain(bot).notice(text);
        return;
      }
      const rec = world.agents.get(actor.agentId);
      if (rec) agents.notice(rec, text);
    },
    denied: (actor) => sessionOf(actor)?.denied(),
    notify: (bot, reason, id) => deps.push?.notify(bot, reason, id),
    persist: deps.persist,
    auditDir: join(root, "audit"),
    userName,
    now: clockNow,
    log: deps.log,
  });

  const scheduler = createScheduler({
    world,
    deliver: (bot, e) => deliver(botActor(bot.id), e),
    note,
    changed,
    parked,
    now: clockNow,
  });

  const agents = createAgents({
    world,
    userName,
    model: deps.model,
    ledger,
    hooks: (actor) => gate.hooks(actor),
    persist: deps.persist,
    now,
    changed(rec) {
      deps.broadcast({ type: "agent", agent: rec.agent, messages: rec.messages });
      deps.persist();
      poke();
    },
    reported(rec, text, by) {
      const bot = world.bots.get(rec.agent.botId);
      if (!bot) return;
      exchange(bot, agentPeer(rec.agent), "received");
      deliver(botActor(bot.id), { from: "agent", title: rec.agent.title, agentId: rec.agent.id, text, hops: hopsOf(by), origin: rootOf(by) });
    },
    note(rec, text) {
      const bot = world.bots.get(rec.agent.botId);
      if (bot) note(bot, `{0}: ${text}`, [agentPeer(rec.agent)]);
    },
  });

  const allSessions = () => [...brains.values(), ...agents.sessions()];
  const sessions: Tickable = {
    tick: (at) => allSessions().forEach((s) => s.tick(at)),
    nextDeadline: () => earliest(allSessions().map((s) => s.nextDeadline())),
  };
  const tickers = { scheduler, gate, sessions };
  const clock = createClock({ tickers: Object.values(tickers), now: clockNow });
  poke = () => clock.poke();

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
    ask: (botId, a) => gate.ask(botId, a),

    async startAgent(botId, a) {
      const bot = owned(botId);
      const project = findProject(await deps.scan(), a.project);
      if (!project) return `No project "${a.project}". Call list_projects for the names.`;
      if (a.where === "cloud" && !project.githubRepo) return `${project.name} has no GitHub remote, so start it with where "mac".`;
      const rec = await agents.start(botId, { ...a, project, botName: bot.name, initiator: initiatorNow(bot), budgetUsd: null });
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
      return agents.message(rec, a.text, initiatorNow(bot));
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
      const by = initiatorNow(from);
      deliver(botActor(to.id), { from: "bot", name: from.name, botId: from.id, hops: hopsAfter(by), origin: rootOf(by), text: a.text });
      return `Delivered to ${to.name}.`;
    },

    createBot(botId, a) {
      const creator = owned(botId);
      const avatar = { ...randomAvatar(), ...(a.shape && { shape: a.shape }), ...(a.color && { color: a.color }) };
      const turn = initiatorNow(creator);
      const by = { bot: creator.name, botId: creator.id, hops: hopsAfter(turn), origin: rootOf(turn) };
      const bot = makeBot({ name: a.name, avatar, job: a.job }, { from: "created", by, brief: a.job });
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

    setRoutine: (botId, a) => scheduler.upsert(botId, a),
    deleteRoutine: (botId, a) => scheduler.remove(botId, a.name),
    routineNoUpdate: (botId) => scheduler.noUpdate(botId),
  };

  const error = (message: string): ServerMessage[] => [{ type: "error", message }];
  const replyTo = (r: { ok: true } | { ok: false; error: string }): ServerMessage[] => (r.ok ? [] : error(r.error));
  const done = (failure: string | null): ServerMessage[] => (failure === null ? [] : error(failure));

  async function handle(message: ClientMessage): Promise<ServerMessage[]> {
    switch (message.type) {
      case "create_bot": {
        const bot = makeBot(
          { name: "New Bot", avatar: randomAvatar(), job: `Not decided yet. Learn what ${userName} wants help with first.` },
          { from: "created", by: "user", brief: onboarding(userName) },
        );
        return [{ type: "created", ref: message.ref, botId: bot.id }];
      }
      case "agent": {
        const rec = world.agents.get(message.agentId);
        return rec ? [{ type: "agent", agent: rec.agent, messages: rec.messages }] : error("Unknown agent");
      }
      case "stop_agent": {
        const rec = world.agents.get(message.agentId);
        if (!rec) return error("Unknown agent");
        return (await agents.stop(rec)) ? [] : error("Nothing is running.");
      }
      case "devices":
      case "revoke_device":
      case "pair_code":
        return error("This bridge cannot manage devices yet.");
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
        deliver(botActor(bot.id), { from: "user", text: message.text, attachments });
        return [];
      }
      case "answer":
        return replyTo(gate.answer(bot.id, message.messageId, { kind: "option", index: message.option }));
      case "dismiss":
        return replyTo(gate.answer(bot.id, message.messageId, { kind: "dismiss" }));
      case "decide":
        return replyTo(gate.answer(bot.id, message.messageId, { kind: "permission", choice: message.choice }));
      case "stop":
        return (await brains.get(bot.id)?.interrupt()) ? [] : error("Nothing is running.");
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
        // U1 adds forgetBot to Gate; this cast goes once it lands.
        (gate as Gate & { forgetBot?(botId: BotId): void }).forgetBot?.(bot.id);
        // A crash between these two leaves an orphan home rather than a bot whose home is gone.
        deps.persist("now");
        homes.trash(bot.id, new Date());
        deps.broadcast({ type: "bot_removed", botId: bot.id });
        return [];
      case "set_routine":
        return done(scheduler.setEnabled(bot.id, message.routineId, message.enabled));
      case "run_routine":
        return done(scheduler.runNow(bot.id, message.routineId));
      case "details": {
        const own = [...world.agents.values()].filter((a) => a.agent.botId === bot.id).map((a) => a.agent);
        own.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return [{ type: "details", botId: bot.id, library: homes.library(bot.id), links: linksOf(bot, own), agents: own, routines: bot.routines.map((r) => routineView(r)) }];
      }
      case "file": {
        const file = await homes.read(bot.id, message.path);
        if ("error" in file) return error(file.error);
        return [{ type: "file", botId: bot.id, path: message.path, ...file }];
      }
    }
  }

  return {
    hello: (position = NO_RING) => ({
      type: "hello",
      protocol: PROTOCOL,
      ...position,
      machine: deps.machine,
      userName,
      bots: sortBots([...world.bots.values()].map(view)),
    }),
    handle,
    tick: (at) => tickEach(tickers, at, deps.log),

    boot(firstRun) {
      homes.ensureUserMd(userName);
      if (firstRun) {
        makeBot(
          { name: "Claudio Bot", avatar: { shape: "circle", color: "white" }, job: `General assistant. Take real work off ${userName}'s plate.` },
          { from: "created", by: "user", brief: null },
        );
      }
      for (const bot of world.bots.values()) {
        if (bot.session.pending.length > 0 || bot.session.lifecycle.kind !== "idle") brain(bot);
      }
      agents.resume();
    },

    startTicker() {
      clock.start();
      return () => clock.stop();
    },

    close() {
      clock.stop();
      for (const session of brains.values()) session.close();
      for (const bot of world.bots.values()) agents.stopFor(bot.id);
    },
  };
}
