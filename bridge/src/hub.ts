import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { SDKMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import { createActivity } from "./activity";
import { createAgents } from "./agents";
import { strictMcp, type UsageRead } from "./claudeCode";
import { createClock, type Tickable } from "./clock";
import { commandOf, createCommands, probeCommands, slashName } from "./commands";
import { connectorSettings, createConnectors } from "./connectors";
import { accessOf } from "./access";
import { createGate } from "./gate";
import { chainBudget, createChains, GROUP_SIZE, mentionedIn, membersError, newGroup, targetsOf, transcript, typingLine } from "./groups";
import type { Homes } from "./home";
import { createLedger, localDay } from "./ledger";
import { createMemory, writeAtomic } from "./memory";
import type { Scope } from "./policy";
import type { Project } from "./projects";
import {
  PROTOCOL,
  type Agent,
  type AgentId,
  type AgentView,
  type Avatar,
  type Bot,
  type BotId,
  type BotPatch,
  type ClientMessage,
  type Feature,
  type Mention,
  type Message,
  type MessageId,
  type Peer,
  type ServerMessage,
  type Signal,
  type StreamPosition,
} from "./protocol";
import { botMemory, DEFAULT_BOT, defaultBotJob, inputOf, NO_AUTO_MEMORY, onboarding, persona, type Envelope } from "./prompts";
import { cardReply } from "./protocol2";
import type { Push } from "./push";
import type { Result } from "./result";
import { gitDirsOf, sandboxFor } from "./sandbox";
import { createScheduler, type RunOutcome } from "./scheduler";
import { BREAKER_NOTE, createSession, usedBudget, type Session, type SessionSpec, type TurnEnd } from "./session";
import { createSkills } from "./skills";
import { createUsageMonitor } from "./usage";
import { appendArchive, type Persist } from "./store";
import { BOT_NAME_MAX, errorText, hasHiddenCharacters } from "./text";
import { botToolServer, type BotActions } from "./tools";
import { freshTurn, readTurn, type Bubble, type Turn } from "./turn";
import { createWebhooks } from "./webhook";
import {
  agentPeer,
  botActor,
  botPeer,
  botStatus,
  exchangeBetween,
  findBot,
  forgetExchanges,
  HOP_LIMIT,
  holdOf,
  hopsAfter,
  hopsOf,
  isOpenCard,
  linksOf,
  resolveMentions,
  logExchange,
  newBot,
  newMessageId,
  post,
  randomAvatar,
  recordExchange,
  rootOf,
  routinesText,
  routineView,
  sortBots,
  splitHistory,
  toBot,
  toGroup,
  type Actor,
  type BotRecord,
  type ChatRecord,
  type GroupRecord,
  type EnvelopeId,
  type Initiator,
  type Pending,
  type World,
} from "./world";

// Orchestration only. Each client message and each tool call is a one-line route to the module that owns the state;
// card, routine, policy, usage and session logic live in those modules.

export type Hub = {
  /** The snapshot a socket gets first, at the stream's position. */
  hello(position: StreamPosition): ServerMessage;
  /** The live frames a protocol 3 socket gets right after its hello and replay: the latest plan usage. */
  greeting(): ServerMessage[];
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
  /** Live sockets only, no seq, no replay: the activity line. */
  signal: (message: Signal) => void;
  persist: Persist;
  log: (line: string) => void;
  push: Push;
  /** The loopback port webhook routines answer on; null: no listener. */
  webhookPort: number | null;
  /** Tests pass a fake SDK. The bridge uses the real query and the claude on PATH. */
  claude: Pick<SessionSpec, "query" | "executable">;
  /** The plan's usage limits: how to read them, and whether a phone is live to see them. Absent: no "usage" feature. */
  usage?: { read: () => Promise<UsageRead>; watched: () => boolean };
};

/** The routine's own scheduled fire. Its bubbles wait for the result, so a run with nothing to say posts nothing. */
const holdsBubbles = (p: Pending) => p.settles !== null && p.initiator.kind === "routine" && !p.initiator.manual;

/**
 * What the hub has read of one turn's output. held is null once its bubbles go out as they arrive. pushed: the bubble
 * whose push went out, and when; until one does, each new bubble tries again. last: the newest bubble posted. carded:
 * the turn opened a permission card of its own, so the run has something to tell even if it then calls
 * routine_no_update. group: the group a group turn answers in (Pending.group), and said: what it posted there so far.
 * A group turn never settles a run, so its held is always null.
 */
type Reading = { id: EnvelopeId; turn: Turn; held: Bubble[] | null; carded: boolean; group: BotId | null; said: Bubble[] } & Pushes;
type Pushes = { pushed: { id: MessageId; at: number } | null; last: MessageId | null };

/** What hello advertises: the FEATURES this bridge serves. Each new one joins when the hub implements it. */
const SERVED: readonly Feature[] = ["memory", "activity", "mute", "worktrees", "connectors", "skills", "webhooks", "spend", "mentions", "commands", "exchanges", "groups"];

/** A client request about one chat: a bot's, or a group's. */
type ChatRequest = Extract<ClientMessage, { botId: BotId }>;
type GroupRequest = "open" | "send" | "stop" | "update_bot" | "mark_unread" | "delete_bot" | "details";
/** What a group has none of, by the request that would reach it. Its members have their own. */
const NOT_IN_GROUPS: Record<Exclude<ChatRequest["type"], GroupRequest>, string> = {
  answer: "cards",
  dismiss: "cards",
  decide: "cards",
  set_routine: "routines",
  run_routine: "routines",
  webhook_token: "routines",
  file: "files",
  connectors: "connectors",
  set_connector: "connectors",
  skills: "skills",
  delete_skill: "skills",
  commands: "commands",
  exchange: "exchanges",
};

const BAD_NAME = `A bot name is 1 to ${BOT_NAME_MAX} characters, with no control or invisible characters.`;
/** The same rule as the bot tools' name: a name a phone would show cut short or other than it reads is refused. */
const nameOk = (name: string) => name.trim() !== "" && Array.from(name.trim()).length <= BOT_NAME_MAX && !hasHiddenCharacters(name);

/** CLAUDE.md as the bridge wrote it, or null for a link or anything else a bot may have put there. */
function readOwn(path: string): string | null {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** The text under a markdown "## heading", trimmed, or null. */
function section(doc: string, heading: string): string | null {
  const m = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(doc);
  return m ? m[1]!.trim() || null : null;
}

/** Ten years: as long as the bot lives, in practice. */
const KEEP_TRANSCRIPTS = { cleanupPeriodDays: 3650 } as const;
/** A turn still running this long after its push pushes its last bubble again when it ends. */
const LONG_TURN_MS = 20_000;

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
  // Each bot's turn in flight, as read so far. Stop can end queued envelopes while it runs, and those must not reset it.
  const readings = new Map<BotId, Reading>();
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
  /**
   * No turn of that attendance can start now. The account's usage limit holds every turn, and so does a model limit
   * that parked this bot's session alone. The daily cap, reached or parking the session, holds only unattended ones.
   */
  function parked(bot: BotRecord, attended: boolean): boolean {
    // The scheduler ticks before the sessions, so it can see a hold whose time has passed but is not yet cleared.
    const hold = holdOf(bot.session);
    const held = hold !== null && hold.until > now() ? hold : null;
    if (accountParked() || held?.reason === "usage_limit") return true;
    return !attended && (held !== null || !ledger.headroom(botActor(bot.id), system).ok);
  }

  function view(bot: BotRecord): Bot {
    const session = brains.get(bot.id);
    const status = botStatus({
      unavailable: session?.unavailable ?? false,
      working: session?.working ?? false,
      held: session ? session.parkedFor !== null : holdOf(bot.session) !== null,
      awaitingApproval: world.gate.open.some((c) => c.kind !== "question" && c.actor.botId === bot.id),
    });
    return { ...toBot(bot, status), ...ledger.botSpend(bot.id) };
  }

  const membersOf = (group: GroupRecord): BotRecord[] => group.members.flatMap((id) => world.bots.get(id) ?? []);
  /** The members running a turn for this group right now. A member busy in its own chat is not one. */
  const typists = (group: GroupRecord): BotRecord[] => membersOf(group).filter((b) => brains.get(b.id)?.current?.group === group.id);

  /** A group works only through its members' turns for it. Its spend is none: the ledger has no row for its id. */
  const groupView = (group: GroupRecord): Bot => ({ ...toGroup(group, typists(group).length > 0 ? "working" : "idle"), ...ledger.botSpend(group.id) });

  /** The typing line each group last sent, so a member's change re-sends only the groups whose line it changes. */
  const typing = new Map<BotId, string | null>();

  /** The group's status and its activity line ("engineer is typing…") follow the members' turns for it. */
  function retype(group: GroupRecord) {
    const line = typingLine(typists(group).map((b) => b.name));
    if ((typing.get(group.id) ?? null) === line) return;
    typing.set(group.id, line);
    deps.broadcast({ type: "bot", bot: groupView(group) });
    deps.signal({ type: "activity", botId: group.id, agentId: null, text: line, at: now() });
  }
  const retypeFor = (botId: BotId) => {
    for (const group of world.groups.values()) if (group.members.includes(botId)) retype(group);
  };

  const agentView = (agent: Agent): AgentView =>
    agent.where === "mac" ? { ...agent, ...ledger.agentSpend(agent.id) } : { ...agent, spentUsd: null, budgetUsd: null };

  /**
   * Every deadline change reaches the clock through here: say, note, scheduler and gate changes, and each session's
   * onChange all call it. A module that moves a deadline any other way leaves the clock asleep until its 60 s cap.
   * "now" saves before returning and throws when it cannot: the scheduler's at-most-once fire rests on it.
   */
  function changed(bot: BotRecord, urgency?: "now") {
    deps.persist(urgency);
    deps.broadcast({ type: "bot", bot: view(bot) });
    poke();
  }

  const archiveOf = (botId: BotId, thread: string) => join(homes.homeOf(botId), ".history", `${thread}.jsonl`);

  /** Moves a thread's oldest messages to its archive. Written there first: when that fails they stay in state. */
  function trim<M>(messages: M[], file: string, pinned: (m: M) => boolean) {
    const split = splitHistory(messages, pinned);
    if (split === null) return;
    try {
      appendArchive(file, split.archived);
    } catch (e) {
      deps.log(`history: could not archive to ${file}, keeping it in state.json: ${errorText(e)}`);
      return;
    }
    messages.splice(0, messages.length, ...split.kept);
  }

  function say(bot: BotRecord, message: Message) {
    // A card the bot's own turn opens shows after what that turn wrote before it.
    if (message.kind === "permission" && message.from === null && message.answer === null) {
      const r = readings.get(bot.id);
      if (r) r.carded = true;
      release(bot);
    }
    const opened = isOpenCard(message) && (message.kind === "question" || message.from === null) && !bot.messages.some((m) => m.id === message.id);
    deps.broadcast({ type: "message", botId: bot.id, message: post(bot, message) });
    trim(bot.messages, archiveOf(bot.id, "bot"), isOpenCard);
    changed(bot);
    // The user answers a card in the bot's own chat, so a group turn that opens one points there.
    const group = opened ? groupFor(brains.get(bot.id)?.current?.group, bot) : null;
    if (group) noteInGroup(group, "{0} needs you in its own chat.", [botPeer(bot)]);
  }

  /** The group a turn answers in (Pending.group), while the bot is still one of its members. */
  function groupFor(id: BotId | null | undefined, bot: BotRecord): GroupRecord | null {
    const group = id == null ? undefined : world.groups.get(id);
    return group?.members.includes(bot.id) ? group : null;
  }

  // The message is in the chat's messages before the push, because the push's throttle reads it. A group turn's
  // bubbles post to the group as the bot.
  function postBubbles(bot: BotRecord, r: Pushes, bubbles: readonly Bubble[], group: GroupRecord | null = null) {
    for (const { id, text } of bubbles) {
      if (group) sayInGroup(group, { kind: "bot", id, at: now(), text, from: bot.id });
      else say(bot, { kind: "bot", id, at: now(), text });
      r.last = id;
      if (r.pushed === null && deps.push.notify(group ?? bot, "message", id)) r.pushed = { id, at: clockNow().getTime() };
    }
  }

  /**
   * The end of a turn with something to tell. Its last bubble pushes when no push for the turn went out yet (a live
   * phone held them back, and may since have gone), or when the push that did went out 20 s or more ago.
   */
  function pushEnd(chat: ChatRecord, r: Pushes) {
    if (r.last === null || r.last === r.pushed?.id) return;
    if (r.pushed === null) deps.push.notify(chat, "message", r.last);
    else if (clockNow().getTime() - r.pushed.at >= LONG_TURN_MS) deps.push.notify(chat, "result", r.last);
  }

  const groupArchive = (id: BotId) => join(root, "groups", `${id}.jsonl`);

  function groupChanged(group: GroupRecord) {
    deps.persist();
    deps.broadcast({ type: "bot", bot: groupView(group) });
  }

  function sayInGroup(group: GroupRecord, message: Message) {
    deps.broadcast({ type: "message", botId: group.id, message: post(group, message) });
    trim(group.messages, groupArchive(group.id), () => false);
    groupChanged(group);
  }

  const noteInGroup = (group: GroupRecord, text: string, refs: Peer[] = []) => sayInGroup(group, { kind: "note", id: newMessageId(), at: now(), text, refs });

  /** The turns each user message in a group has caused, so mentions between members stop at a budget. */
  const chains = createChains();
  /** A turn saved before chains were recorded is a chain of its own. */
  const chainOf = (turn: Pending): MessageId => turn.chain ?? (turn.id as string as MessageId);

  /** One member's turn on a message in the group. skip: the message itself, which the envelope carries apart. */
  function handTo(group: GroupRecord, member: BotRecord, message: { text: string; addressed: boolean; skip: ReadonlySet<MessageId> }, chain: MessageId, by: Extract<Envelope, { from: "group" }>["by"]) {
    const nameOf = (id: BotId) => world.bots.get(id)?.name ?? "a former member";
    deliver(botActor(member.id), {
      from: "group",
      group: { id: group.id, name: group.name },
      chain,
      members: membersOf(group).map((b) => ({ name: b.name, you: b.id === member.id })),
      transcript: transcript(group, nameOf, userName, message.skip),
      text: message.text,
      addressed: message.addressed,
      by,
    });
  }

  /**
   * A member's reply that @mentions other members hands each of them a turn, one hop further down the chain the reply
   * was part of. A turn at HOP_LIMIT hands nothing on, as message_bot would be refused there, so mentions never loop.
   * Nor does a chain past its budget (groups.chainBudget), which says so in the group once.
   */
  function relay(from: BotRecord, turn: Pending, said: readonly Bubble[]) {
    const group = groupFor(turn.group, from);
    if (!group || said.length === 0 || hopsOf(turn.initiator) >= HOP_LIMIT) return;
    const text = said.map((b) => b.text).join("\n\n");
    const others = membersOf(group).filter((b) => b.id !== from.id);
    const by = { kind: "bot" as const, name: from.name, botId: from.id, hops: hopsAfter(turn.initiator), origin: rootOf(turn.initiator) };
    const skip = new Set(said.map((b) => b.id));
    const chain = chainOf(turn);
    const budget = chainBudget(group.members.length);
    for (const id of mentionedIn(text, others)) {
      const verdict = chains.handOn(chain, budget);
      if (verdict === "run") handTo(group, world.bots.get(id)!, { text, addressed: true, skip }, chain, by);
      else if (verdict === "stop and note") noteInGroup(group, `Stopped passing the conversation on after ${budget} replies. Send a message to keep going.`);
    }
  }

  /** The turn's held bubbles go out now, ahead of a card or note it caused; the rest of the turn posts as it arrives. */
  function release(bot: BotRecord) {
    const r = readings.get(bot.id);
    if (!r || r.held === null) return;
    const held = r.held;
    r.held = null;
    postBubbles(bot, r, held);
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
    const home = realpathSync(homedir());
    // So ~name in a command resolves for the user and for root.
    const users = { [userInfo().username]: home, root: process.platform === "darwin" ? "/var/root" : "/root" };
    const { full } = accessOf(process.env);
    if (actor.kind === "bot") return { bridgeHome, own: realpathSync(homes.homeOf(actor.botId)), userMd: join(bridgeHome, "USER.md"), homedir: home, users, full };
    const rec = world.agents.get(actor.agentId);
    if (!rec) throw new Error(`Unknown agent ${actor.agentId}`);
    return { bridgeHome, own: realpathSync(rec.cwd), userMd: null, homedir: home, users, full };
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

  /** quiet: the turn called routine_no_update and asked nothing. */
  function outcomeOf(end: Exclude<TurnEnd, { kind: "deferred" }>, quiet: boolean): RunOutcome {
    // A run the daily cap cut short is held by a limit, not broken, so it does not count toward turning the routine off.
    if (usedBudget(end)) return { status: "skipped", note: "Stopped at the daily cap" };
    switch (end.kind) {
      case "done":
        if (end.result.subtype !== "success") return { status: "failed", note: end.result.errors.join("; ") || end.result.subtype };
        return { status: quiet ? "quiet" : "ok", note: null };
      case "failed":
        return { status: "failed", note: end.error };
      case "stopped":
        return { status: "skipped", note: end.by === "breaker" ? BREAKER_NOTE : `Stopped by ${userName}` };
      case "dropped":
        return { status: "skipped", note: `Stopped by ${userName}` };
    }
  }

  const pausedNote = (until: string, why: "usage_limit" | "daily_cap") =>
    `Paused until ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${why === "usage_limit" ? "usage limit" : "daily cap"})`;

  function endTurn(bot: BotRecord, turn: Pending, end: TurnEnd, quiet: boolean) {
    // A group turn's end is told where its reply would have been.
    const group = groupFor(turn.group, bot);
    const tell = (text: string) => (group ? noteInGroup(group, text) : note(bot, text));
    switch (end.kind) {
      case "done":
        if (usedBudget(end)) tell(`${bot.name} used today's budget; routines and other background work wait until tomorrow.`);
        else if (end.result.subtype !== "success") tell(`${bot.name} stopped with an error: ${end.result.errors.join("; ") || end.result.subtype}`);
        break;
      case "failed":
        tell(`${bot.name} crashed: ${end.error}`);
        break;
      case "stopped":
        // The breaker already left its own note.
        if (end.by === "user") tell(group ? `${bot.name} was stopped by ${userName}` : `Stopped by ${userName}`);
        break;
      case "deferred":
        if (end.why !== "retry") tell(pausedNote(end.until, end.why));
        return;
      case "dropped":
        break;
    }
    if (turn.settles !== null) scheduler.settle(bot.id, turn.settles, outcomeOf(end, quiet));
  }

  /**
   * The flag settings of every query the bot and its agents open. Claude Code deletes transcripts older than
   * cleanupPeriodDays (30 by default) at startup, and a bot's session lives far longer. The user's own claude runs still
   * sweep with their setting, so session.ts also recovers from a transcript that is gone.
   */
  function settingsFor(botId: BotId): Settings {
    return { ...NO_AUTO_MEMORY, ...KEEP_TRANSCRIPTS, ...connectorSettings(world.bots.get(botId)?.connectorsOff ?? []) };
  }

  const claudeMdOf = (botId: BotId) => join(homes.homeOf(botId), "CLAUDE.md");

  /** A rename reaches CLAUDE.md's heading, which a new session reads as the bot's instructions. */
  function retitle(botId: BotId, name: string) {
    const path = claudeMdOf(botId);
    const doc = readOwn(path);
    if (doc === null) return;
    const next = doc.replace(/^# .*$/m, () => `# ${name}`);
    if (next === doc) return;
    try {
      writeAtomic(path, next);
    } catch (e) {
      deps.log(`retitle ${botId}: ${errorText(e)}`);
    }
  }

  /** update_self's job replaces CLAUDE.md's ## Job section, which the standing brief and a new session read. */
  function rejob(botId: BotId, job: string) {
    const path = claudeMdOf(botId);
    const doc = readOwn(path);
    if (doc === null) return;
    const body = `## Job\n\n${job}\n\n`;
    const next = /^## Job\s*$/m.test(doc) ? doc.replace(/^## Job\s*\n[\s\S]*?(?=^## |(?![\s\S]))/m, () => body) : `${doc.trimEnd()}\n\n${body}`;
    try {
      writeAtomic(path, next);
    } catch (e) {
      deps.log(`rejob ${botId}: ${errorText(e)}`);
    }
  }

  /**
   * Who the bot is now. A resumed session keeps the system prompt it started with, so a rename, a new userName or a
   * newer persona reaches it as this, on the first turn after it changes.
   */
  function standingBrief(bot: BotRecord): string {
    const job = section(readOwn(claudeMdOf(bot.id)) ?? "", "Job");
    return [
      "[Standing brief: this replaces what you were told before where they differ.]",
      persona({ name: bot.name, userName }),
      ...(job === null ? [] : [`\nYour job: ${job}`]),
    ].join("\n");
  }

  /** The bot's and its agents' live queries close at their next chance, so the next ones open with fresh options. */
  function reopenFor(botId: BotId, which: "agents" | "all") {
    if (which === "all") brains.get(botId)?.reopen();
    for (const rec of world.agents.values()) if (rec.agent.botId === botId) agents.session(rec.agent.id)?.reopen();
  }

  const activity = createActivity({ signal: deps.signal, now: clockNow });
  const usage =
    deps.usage &&
    createUsageMonitor({
      ...deps.usage,
      changed: (u) => deps.signal({ type: "usage", usage: u }),
      poke: () => poke(),
      now: clockNow,
      log: deps.log,
    });
  /** A turn's result or a rate limit event moves the plan's usage. */
  const metered = (m: SDKMessage) => {
    if (m.type === "result" || m.type === "rate_limit_event") usage?.nudge();
  };
  const memory = createMemory({
    homes,
    botName: (id) => world.bots.get(id)?.name ?? "a bot",
    turnOf: (id) => brains.get(id)?.current?.initiator ?? system,
    changed: () => deps.broadcast({ type: "memory", facts: memory.facts() }),
    reopen: (id) => {
      for (const botId of id === null ? world.bots.keys() : [id]) brains.get(botId)?.reopen();
    },
    now: clockNow,
    log: deps.log,
  });
  const skills = createSkills({
    homes,
    changed: (id) => {
      brains.get(id)?.reopen();
      deps.broadcast({ type: "skills", botId: id, skills: skills.list(id) });
      commands.refresh(id);
    },
  });
  const commands = createCommands({
    live: (id) => brains.get(id)?.mcp() ?? null,
    // What the bot's own query would offer: its home's project skills, the user's and plugins'. No MCP server starts, so
    // only an open query's list has MCP prompts.
    probe: (id) => {
      homes.ensureFolders(id);
      return probeCommands(deps.claude, { cwd: homes.homeOf(id), settingSources: ["user", "project"], settings: settingsFor(id), ...strictMcp(), mcpServers: {} });
    },
    saved: (id) => skills.list(id),
    changed: (id, menu) => {
      if (world.bots.has(id)) deps.broadcast({ type: "commands", botId: id, commands: menu });
    },
    log: deps.log,
  });

  function brain(bot: BotRecord): Session {
    const existing = brains.get(bot.id);
    if (existing) return existing;
    const actor = botActor(bot.id);
    const session = createSession({
      actor,
      state: bot.session,
      account: world.account,
      ledger,
      persist: deps.persist,
      userName,
      log: deps.log,
      name: () => bot.name,
      continuing: () => gate.beginTurn(actor),
      context: () => memory.context(bot.id),
      brief: () => standingBrief(bot),
      ...deps.claude,
      options: () => {
        homes.ensureFolders(bot.id);
        return {
          cwd: homes.homeOf(bot.id),
          resume: bot.session.id ?? undefined,
          settingSources: ["user", "project"],
          systemPrompt: { type: "preset", preset: "claude_code", append: persona({ name: bot.name, userName }) },
          permissionMode: "auto",
          mcpServers: { claudio: botToolServer(bot.id, actions) },
          // A bot asks with its own ask tool, which posts a card instead of blocking the turn. Plan mode would wait for
          // an approval nobody can give.
          disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
          model: deps.model,
          hooks: gate.hooks(actor),
          canUseTool: gate.canUseTool(actor),
          sandbox: sandboxFor(actor, scopeOf(actor), process.env),
          settings: settingsFor(bot.id),
        };
      },
      onMessage(m, pending) {
        metered(m);
        if (!world.bots.has(bot.id)) return;
        if (m.type === "system" && m.subtype === "init") commands.refresh(bot.id);
        if (m.type === "system" && m.subtype === "commands_changed") commands.seen(bot.id, m.commands);
        // Output between turns, such as a background task finishing, has no turn to wait for, and no turn end would
        // clear an activity line it set.
        if (pending === null) return postBubbles(bot, { pushed: null, last: null }, readTurn(freshTurn, m).bubbles);
        activity.observe(actor, m);
        let r = readings.get(bot.id);
        if (r?.id !== pending.id) {
          const group = pending.group ?? null;
          r = { id: pending.id, turn: freshTurn, held: holdsBubbles(pending) ? [] : null, pushed: null, last: null, carded: false, group, said: [] };
          readings.set(bot.id, r);
          // A turn that follows the last without a pause changes no session status, so its first output tells.
          retypeFor(bot.id);
        }
        const read = readTurn(r.turn, m);
        r.turn = read.turn;
        if (r.group !== null) {
          // The group went, or the bot left it, mid-turn: what it says there goes nowhere.
          const group = groupFor(r.group, bot);
          if (!group) return;
          postBubbles(bot, r, read.bubbles, group);
          r.said.push(...read.bubbles);
          return;
        }
        if (r.held === null) return postBubbles(bot, r, read.bubbles);
        r.held.push(...read.bubbles);
        // A question card is the last thing a turn shows, so what led up to it goes out before the card does.
        if (r.turn.asked) release(bot);
      },
      onTurnEnd(pending, end) {
        if (world.bots.has(bot.id)) {
          // A deferred turn waits (a retry, a limit) with nothing running, so its line clears too.
          activity.clear(actor);
          const r = readings.get(bot.id);
          let quiet = false;
          if (end.kind !== "deferred" && r?.id === pending.id) {
            readings.delete(bot.id);
            quiet = r.turn.quiet && !r.turn.asked && !r.carded;
            if (r.held !== null && !quiet) postBubbles(bot, r, r.held);
            const chat = r.group === null ? bot : groupFor(r.group, bot);
            if (chat && !quiet) pushEnd(chat, r);
            if (end.kind === "done") relay(bot, pending, r.said);
          }
          endTurn(bot, pending, end, quiet);
          retypeFor(bot.id);
          // The session saved the turn's end before calling here, so a held run's report and its settled run would
          // otherwise wait for the debounced save.
          if (end.kind !== "deferred" && holdsBubbles(pending)) deps.persist("now");
        }
        // After relay, so the chain still holds this turn while it hands on.
        if (end.kind !== "deferred" && pending.group !== undefined) chains.end(chainOf(pending));
      },
      onChange() {
        if (!world.bots.has(bot.id)) return;
        changed(bot);
        retypeFor(bot.id);
      },
      note(text) {
        if (!world.bots.has(bot.id)) return;
        // The breaker's note comes mid-turn; what the turn wrote before it goes first.
        release(bot);
        note(bot, text);
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
    notify(bot, reason, id) {
      deps.push.notify(bot, reason, id);
      // The gate posts a card before it records it as open, so the bot frame say() sent did not count it yet.
      if (reason === "card") changed(bot);
    },
    trusted: (root) => agents.trusted(root),
    persist: deps.persist,
    auditDir: join(root, "audit"),
    userName,
    now: clockNow,
    log: deps.log,
  });

  const scheduler = createScheduler({
    world,
    log: deps.log,
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
    log: deps.log,
    claude: deps.claude,
    hooks: (actor) => gate.hooks(actor),
    canUseTool: (actor) => gate.canUseTool(actor),
    beginTurn: (actor) => gate.beginTurn(actor),
    sandbox(actor) {
      const scope = scopeOf(actor);
      return sandboxFor(actor, scope, process.env, gitDirsOf(scope.own));
    },
    configRoot: (id) => homes.agentConfig(id),
    trustCard: (actor, repo) => gate.trustCard(actor, repo),
    settings: (actor) => settingsFor(actor.botId),
    observe(actor, m) {
      metered(m);
      activity.observe(actor, m);
    },
    idle: (actor) => activity.clear(actor),
    persist: deps.persist,
    now,
    changed(rec) {
      trim(rec.messages, archiveOf(rec.agent.botId, rec.agent.id), () => false);
      deps.broadcast({ type: "agent", agent: agentView(rec.agent), messages: rec.messages });
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

  const connectors = createConnectors({ world, live: (id) => brains.get(id)?.mcp() ?? null, reopen: reopenFor, persist: deps.persist, log: deps.log });
  const webhooks = createWebhooks({ world, scheduler, port: deps.webhookPort, now: clockNow, log: deps.log });

  const allSessions = () => [...brains.values(), ...agents.sessions()];
  const sessions: Tickable = {
    tick: (at) => allSessions().forEach((s) => s.tick(at)),
    nextDeadline: () => earliest(allSessions().map((s) => s.nextDeadline())),
  };
  // Each bot frame carries today's spend, which resets at local midnight with no event of its own.
  let today = localDay(clockNow());
  const midnight: Tickable = {
    tick(at) {
      if (localDay(at) === today) return;
      today = localDay(at);
      for (const bot of world.bots.values()) deps.broadcast({ type: "bot", bot: view(bot) });
    },
    nextDeadline: () => {
      const next = clockNow();
      next.setHours(24, 0, 0, 0);
      return next.toISOString();
    },
  };
  const tickers = { scheduler, gate, sessions, push: deps.push, midnight, ...(usage && { usage }) };
  const clock = createClock({ tickers: Object.values(tickers), now: clockNow, log: deps.log });
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
      const scanned = await deps.scan();
      const bot = owned(botId);
      const project = findProject(scanned, a.project);
      if (!project) return `No project "${a.project}". Call list_projects for the names.`;
      if (a.where === "cloud" && !project.githubRepo) return `${project.name} has no GitHub remote, so start it with where "mac".`;
      const slash = a.slash?.trim().replace(/^\//, "") ?? null;
      if (slash !== null) {
        if (a.where === "cloud") return "slash works for mac agents only. Start it with where \"mac\", or put the request in the prompt.";
        if (slashName(`/${slash}`) !== slash) return "slash is one skill or command name, without spaces, such as code-review.";
        if (commands.hidden(botId, slash)) return `/${slash} changes or ends a Claude Code session, so an agent is not started with it.`;
      }
      const rec = await agents.start(botId, { ...a, slash, project, botName: bot.name, initiator: initiatorNow(bot), budgetUsd: null });
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
      if (!to) return `No bot "${a.bot}". Bots: ${[...world.bots.values()].map((b) => (b.title ? `${b.name} (${b.title})` : b.name)).join(", ")}.`;
      if (to.id === from.id) return "That is you.";
      logExchange(world, { id: newMessageId(), at: now(), from: from.id, text: a.text }, to.id);
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
      const bot = makeBot({ name: a.name.trim(), avatar, job: a.job }, { from: "created", by, brief: a.job });
      note(creator, "Created {0}", [botPeer(bot)]);
      return `Created ${bot.name} (${bot.id}). It has its brief and starts now.`;
    },

    updateSelf(botId, a) {
      const bot = owned(botId);
      // The job is the bot's standing instructions: a routine's or another bot's turn could be talking it into new ones.
      if (a.job !== undefined && (brains.get(botId)?.current?.initiator ?? system).kind !== "user")
        return `Only ${userName} can change your job, in a turn they start. Nothing was changed; ask them.`;
      if (a.job !== undefined) rejob(bot.id, a.job.replace(/\s+/g, " ").trim());
      if (a.name !== undefined) {
        bot.name = a.name.trim();
        retitle(bot.id, bot.name);
      }
      if (a.title !== undefined) bot.title = a.title.trim() || null;
      bot.avatar = { shape: a.shape ?? bot.avatar.shape, color: a.color ?? bot.avatar.color };
      changed(bot);
      return "Updated.";
    },

    setRoutine(botId, a) {
      if (a.trigger === "webhook") return scheduler.upsertHook(botId, a);
      if (a.schedule === undefined) return "A cron routine needs a schedule.";
      return scheduler.upsert(botId, { ...a, schedule: a.schedule });
    },
    deleteRoutine: (botId, a) => scheduler.remove(botId, a.name),
    listRoutines: (botId) => routinesText(owned(botId).routines),
    routineNoUpdate: (botId) => scheduler.noUpdate(botId),
    remember: (botId, a) => memory.remember(botId, a),
    saveSkill: (botId, a) => skills.save(botId, a),
  };

  // A send can wait (on the bot's connectors or its commands), so each bot's sends are handled one after another: a
  // later one never overtakes it into the chat or the bot's queue.
  const sending = new Map<BotId, Promise<unknown>>();
  function inOrder<T>(botId: BotId, op: () => Promise<T>): Promise<T> {
    const next = (sending.get(botId) ?? Promise.resolve()).then(op);
    sending.set(botId, next.catch(() => {}));
    return next;
  }

  /** The connectors a mention may point at: the bot's, turned on. Asked only when the user pointed at one. */
  async function connectorsOn(botId: BotId, mentions: readonly Mention[]): Promise<Set<string>> {
    if (!mentions.some((m) => m.kind === "connector")) return new Set();
    return new Set((await connectors.list(botId)).filter((c) => c.enabled).map((c) => c.name));
  }

  async function send(m: Extract<ClientMessage, { type: "send" }>): Promise<ServerMessage[]> {
    const bot = world.bots.get(m.botId);
    if (!bot) return error("Unknown bot");
    // A phone resends what it never saw echoed after a reconnect; the first copy may have arrived. The echo goes back
    // to the sender so its pending send settles.
    const sent = m.clientId === undefined ? undefined : bot.messages.find((x) => x.kind === "user" && x.clientId === m.clientId);
    if (sent) return [{ type: "message", botId: bot.id, message: sent }];
    const on = await connectorsOn(bot.id, m.mentions ?? []);
    // "/name args" with no uploads runs a command the bot's menu offers; anything else is an ordinary message.
    const command = m.uploads.length === 0 && slashName(m.text) !== null ? commandOf(m.text, await commands.list(bot.id)) : null;
    if (!world.bots.has(bot.id)) return error("Unknown bot");
    const mentions = resolveMentions(world, m.mentions ?? [], on);
    const attachments = homes.saveUploads(bot.id, m.uploads);
    if ("error" in attachments) return error(attachments.error);
    say(bot, {
      kind: "user",
      id: newMessageId(),
      at: now(),
      text: m.text,
      attachments,
      ...(m.clientId !== undefined && { clientId: m.clientId }),
      ...(mentions.length > 0 && { mentions }),
    });
    const others = mentions.filter((x) => x.kind !== "bot" || x.id !== bot.id);
    deliver(botActor(bot.id), command !== null ? { from: "command", line: m.text.trim() } : { from: "user", text: m.text, attachments, mentions: others });
    return [];
  }

  const error = (message: string): ServerMessage[] => [{ type: "error", message }];
  const replyTo = (r: Result): ServerMessage[] => (r.ok ? [] : error(r.error));
  const done = (failure: string | null): ServerMessage[] => (failure === null ? [] : error(failure));

  /** A deleted bot leaves every group it was in. A group left with too few stays, and says so. */
  function leave(group: GroupRecord, bot: BotRecord) {
    group.members = group.members.filter((id) => id !== bot.id);
    const few = group.members.length < GROUP_SIZE.min ? ` A group needs ${GROUP_SIZE.min} bots to talk among themselves: add one in its profile.` : "";
    noteInGroup(group, `${bot.name} was deleted, so it left the group.${few}`);
    retype(group);
  }

  /**
   * The user's message in a group goes to the members it mentions, or to every member when it mentions none. Each gets
   * a turn of its own whose text posts back to the group. A group has no folder, so it takes no uploads.
   */
  function sendInGroup(group: GroupRecord, m: Extract<ClientMessage, { type: "send" }>): ServerMessage[] {
    const sent = m.clientId === undefined ? undefined : group.messages.find((x) => x.kind === "user" && x.clientId === m.clientId);
    if (sent) return [{ type: "message", botId: group.id, message: sent }];
    if (m.uploads.length > 0) return error("A group has no folder for files. Send them to one of its bots.");
    const mentions = resolveMentions(world, m.mentions ?? [], new Set());
    const message: Message = {
      kind: "user",
      id: newMessageId(),
      at: now(),
      text: m.text,
      attachments: [],
      ...(m.clientId !== undefined && { clientId: m.clientId }),
      ...(mentions.length > 0 && { mentions }),
    };
    sayInGroup(group, message);
    const targets = targetsOf(group, mentions);
    const addressed = targets.length < group.members.length;
    const members = membersOf(group).filter((b) => targets.includes(b.id));
    chains.start(message.id, members.length, chainBudget(group.members.length));
    for (const member of members) handTo(group, member, { text: m.text, addressed, skip: new Set([message.id]) }, message.id, { kind: "user" });
    return [];
  }

  function updateGroup(group: GroupRecord, patch: BotPatch): ServerMessage[] {
    const { members, dailyCapUsd, ...rest } = patch;
    if (dailyCapUsd !== undefined) return error("A group has no spending of its own: its bots do.");
    if (rest.name !== undefined && !nameOk(rest.name)) return error(BAD_NAME);
    const why = members === undefined ? null : membersError(world, members);
    if (why !== null) return error(why);
    Object.assign(group, rest, rest.name !== undefined && { name: rest.name.trim() }, members !== undefined && { members: [...members] });
    groupChanged(group);
    retype(group);
    return [];
  }

  /** A group answers what a chat of messages can: the rest reaches a bot's session, home or cards, which it has none of. */
  async function handleGroup(group: GroupRecord, message: ChatRequest): Promise<ServerMessage[]> {
    switch (message.type) {
      case "open":
        group.unread = 0;
        groupChanged(group);
        return [{ type: "conversation", botId: group.id, messages: group.messages }];
      case "send":
        return sendInGroup(group, message);
      case "stop": {
        const running = typists(group);
        if (running.length === 0) return error("Nothing is running.");
        await Promise.all(running.map((b) => brains.get(b.id)?.interrupt()));
        return [];
      }
      case "update_bot":
        return updateGroup(group, message.patch);
      case "mark_unread":
        group.unread = Math.max(1, group.unread);
        groupChanged(group);
        return [];
      case "delete_bot":
        // Its members and their own chats stay. A member's turn still running for it posts nowhere.
        world.groups.delete(group.id);
        typing.delete(group.id);
        deps.persist("now");
        deps.broadcast({ type: "bot_removed", botId: group.id });
        return [];
      case "details":
        return [{ type: "details", botId: group.id, library: [], links: linksOf(group, []), agents: [], routines: [] }];
      default:
        return error(`A group has no ${NOT_IN_GROUPS[message.type]}: its bots have their own.`);
    }
  }

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
        return rec ? [{ type: "agent", agent: agentView(rec.agent), messages: rec.messages }] : error("Unknown agent");
      }
      case "stop_agent": {
        const rec = world.agents.get(message.agentId);
        if (!rec) return error("Unknown agent");
        return (await agents.stop(rec)) ? [] : error("Nothing is running.");
      }
      case "remove_worktree": {
        const rec = world.agents.get(message.agentId);
        return rec ? replyTo(await agents.removeWorktree(rec)) : error("Unknown agent");
      }
      case "memory":
        return [{ type: "memory", facts: memory.facts() }];
      case "set_fact":
        return replyTo(memory.setFact(message.factId, message.text));
      case "forget_fact":
        return replyTo(memory.forgetFact(message.factId));
      case "confirm_fact":
        return replyTo(memory.confirmFact(message.factId));
      case "devices":
      case "revoke_device":
      case "pair_code":
        return error("This bridge cannot manage devices yet.");
      case "refresh_usage":
        return usage ? [{ type: "usage", usage: await usage.refresh() }] : error("This bridge does not read plan usage.");
      case "create_group": {
        if (!nameOk(message.name)) return error(BAD_NAME);
        const why = membersError(world, message.members);
        if (why !== null) return error(why);
        const first = world.bots.get(message.members[0]!)!;
        const group = newGroup({ id: `g_${crypto.randomUUID()}` as BotId, name: message.name.trim(), members: [...message.members], avatar: { ...first.avatar }, at: now() });
        world.groups.set(group.id, group);
        groupChanged(group);
        return [{ type: "created", ref: message.ref, botId: group.id }];
      }
    }

    const group = world.groups.get(message.botId);
    if (group) return handleGroup(group, message);
    const bot = world.bots.get(message.botId);
    if (!bot) return error("Unknown bot");

    switch (message.type) {
      case "open":
        bot.unread = 0;
        changed(bot);
        return [{ type: "conversation", botId: bot.id, messages: bot.messages }];
      case "send":
        return inOrder(bot.id, () => send(message));
      case "answer":
      case "dismiss": {
        const reply = cardReply(bot.messages.find((m) => m.id === message.messageId), message);
        return reply ? replyTo(gate.answer(bot.id, message.messageId, reply)) : error("Unknown option");
      }
      case "decide":
        return replyTo(gate.answer(bot.id, message.messageId, { kind: "permission", choice: message.choice }));
      case "stop":
        return (await brains.get(bot.id)?.interrupt()) ? [] : error("Nothing is running.");
      case "update_bot":
        if (message.patch.members !== undefined) return error("Only a group has members.");
        if (message.patch.name !== undefined && !nameOk(message.patch.name)) return error(BAD_NAME);
        Object.assign(bot, message.patch, message.patch.name !== undefined && { name: message.patch.name.trim() });
        if (message.patch.name !== undefined) retitle(bot.id, bot.name);
        changed(bot);
        // A raised cap may lift a daily-cap park at once instead of at the next tick.
        if (message.patch.dailyCapUsd !== undefined) {
          brains.get(bot.id)?.recheck();
          for (const rec of world.agents.values()) if (rec.agent.botId === bot.id) agents.session(rec.agent.id)?.recheck();
        }
        return [];
      case "mark_unread":
        bot.unread = Math.max(1, bot.unread);
        changed(bot);
        return [];
      case "delete_bot": {
        // Worktrees outlive the bot and no phone screen reaches them after it goes, so the phone lists them first.
        const held = [...world.agents.values()].flatMap((rec) => (rec.agent.botId === bot.id && rec.agent.worktree ? [rec.agent.worktree.branch] : []));
        if (held.length > 0 && message.force !== true)
          return error(`${bot.name}'s agents still hold worktrees on ${held.join(", ")}. Remove them from each agent, or delete anyway to keep them on the Mac.`);
        brains.get(bot.id)?.close();
        brains.delete(bot.id);
        readings.delete(bot.id);
        sending.delete(bot.id);
        commands.forget(bot.id);
        agents.stopFor(bot.id);
        // Before the agents go: the gate finds the agents' grants through them.
        gate.forgetBot(bot.id);
        const doomed = [...world.agents.values()].filter((rec) => rec.agent.botId === bot.id).map((rec) => rec.agent.id);
        activity.clear(botActor(bot.id));
        for (const id of doomed) activity.clear({ kind: "agent", botId: bot.id, agentId: id });
        for (const id of doomed) world.agents.delete(id);
        world.bots.delete(bot.id);
        forgetExchanges(world, bot.id);
        for (const group of world.groups.values()) if (group.members.includes(bot.id)) leave(group, bot);
        // A crash between these two leaves an orphan home rather than a bot whose home is gone.
        deps.persist("now");
        homes.trash(bot.id, new Date());
        for (const id of doomed) {
          try {
            homes.removeAgentConfig(id);
          } catch (e) {
            deps.log(`delete_bot: could not remove the config folder of ${id}: ${errorText(e)}`);
          }
        }
        deps.broadcast({ type: "bot_removed", botId: bot.id });
        return [];
      }
      case "set_routine":
        return done(scheduler.setEnabled(bot.id, message.routineId, message.enabled));
      case "run_routine":
        return done(scheduler.runNow(bot.id, message.routineId));
      case "details": {
        const own = [...world.agents.values()].filter((a) => a.agent.botId === bot.id).map((a) => a.agent);
        own.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return [{ type: "details", botId: bot.id, library: homes.library(bot.id), links: linksOf(bot, own), agents: own.map(agentView), routines: bot.routines.map((r) => routineView(r)) }];
      }
      case "file": {
        const file = await homes.read(bot.id, message.path);
        if ("error" in file) return error(file.error);
        return [{ type: "file", botId: bot.id, path: message.path, ...file }];
      }
      case "connectors":
        return [{ type: "connectors", botId: bot.id, connectors: await connectors.list(bot.id) }];
      case "set_connector": {
        const result = await connectors.set(bot.id, message.name, message.enabled);
        return result.ok ? [{ type: "connectors", botId: bot.id, connectors: await connectors.list(bot.id) }] : error(result.error);
      }
      case "skills":
        return [{ type: "skills", botId: bot.id, skills: skills.list(bot.id) }];
      case "delete_skill": {
        const result = skills.remove(bot.id, message.name);
        return result.ok ? [] : error(result.error);
      }
      case "webhook_token": {
        const made = webhooks.token(bot.id, message.routineId);
        return "error" in made ? error(made.error) : [{ type: "webhook_token", botId: bot.id, routineId: message.routineId, ...made }];
      }
      case "commands":
        return [{ type: "commands", botId: bot.id, commands: await commands.list(bot.id) }];
      case "exchange":
        return [{ type: "exchange", botId: bot.id, peer: message.peer, messages: exchangeBetween(world, bot.id, message.peer) }];
    }
  }

  return {
    hello: (position) => ({
      type: "hello",
      protocol: PROTOCOL,
      features: usage ? [...SERVED, "usage"] : [...SERVED],
      ...position,
      machine: deps.machine,
      userName,
      bots: sortBots([...[...world.bots.values()].map(view), ...[...world.groups.values()].map(groupView)]),
    }),
    greeting() {
      const latest = usage?.opened() ?? null;
      return latest ? [{ type: "usage", usage: latest }] : [];
    },
    handle,
    tick: (at) => tickEach(tickers, at, deps.log),

    boot(firstRun) {
      gate.resume(clockNow());
      // Without USER.md the bots still run; remember about the user fails until the folder is writable again.
      try {
        homes.ensureUserMd(userName);
      } catch (e) {
        deps.log(`USER.md could not be created at ${homes.userMd}: ${errorText(e)}`);
      }
      if (firstRun) {
        makeBot(
          { name: DEFAULT_BOT.name, avatar: { ...DEFAULT_BOT.avatar }, job: defaultBotJob(userName) },
          { from: "created", by: "user", brief: null },
        );
      }
      for (const bot of world.bots.values()) {
        if (bot.session.pending.length > 0 || bot.session.lifecycle.kind !== "idle") brain(bot);
      }
      agents.resume();
      webhooks.start();
    },

    startTicker() {
      clock.start();
      return () => clock.stop();
    },

    close() {
      clock.stop();
      webhooks.stop();
      for (const session of brains.values()) session.close();
      for (const bot of world.bots.values()) agents.stopFor(bot.id);
    },
  };
}
