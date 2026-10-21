import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { HubDeps } from "../src/hub";
import { createMirror } from "../src/machine/mirror";
import type { Machine, Sent } from "../src/machine/machines";
import { profileOf } from "../src/machine/profile";
import { profileView, type Event, type EventBody, type Intent, type MachineId } from "../src/machine/wire";
import { machinesBlock } from "../src/prompts";
import type { Agent, AgentId, BotId, Message, MessageId } from "../src/protocol";
import { createPush } from "../src/push";
import { emptyWorld, own, type SessionState, type World } from "../src/world";
import { assistant, bot, callTool, cleanup, flush, hubOver, later, placedOn, result, text } from "./hub-kit";

afterEach(cleanup);

const MAC = "m_mac" as MachineId;
const at = new Date().toISOString();
const expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();

/** One enrolled machine the test drives: whether it is online, what it answers each intent, and the events it sends. */
function remote() {
  let online = true;
  let seq = 0;
  const intents: Intent[] = [];
  let answer: (i: Intent) => Sent = () => ({ ok: true });
  const change: (() => void)[] = [];
  const events: ((id: MachineId, e: Event) => void)[] = [];
  const mac: Machine = {
    id: MAC,
    name: "MacBook",
    profile: () => profileView(profileOf({ env: { CLAUDIOBOT_ACCESS: "full", CLAUDIOBOT_SANDBOX: "off" }, platform: "darwin", name: "MacBook", homedir: "/Users/alex", username: "alex" }), []),
    status: () => ({ online, since: null }),
    async send(intent) {
      if (!online) return { ok: false, reason: "MacBook is offline", undelivered: true };
      intents.push(intent);
      return answer(intent);
    },
  };
  let enrolled = true;
  const removed: MachineId[] = [];
  const links: NonNullable<HubDeps["links"]> = {
    machines: () => (enrolled ? [mac] : []),
    remove(id) {
      removed.push(id);
      enrolled = false;
      online = false;
      return true;
    },
    onChange: (f) => void change.push(f),
    onEvent: (f) => void events.push(f),
    ask: async () => ({ ok: false, reason: "MacBook is offline" }),
    onSignal: () => {},
  };
  return {
    links,
    removed,
    intents,
    answers: (f: (i: Intent) => Sent) => (answer = f),
    flip(to: boolean) {
      online = to;
      change.forEach((f) => f());
    },
    send: (body: EventBody) => events.forEach((f) => f(MAC, { seq: ++seq, at, ...body })),
  };
}

const B = "b_eng" as BotId;
/** The intents sent besides the bot.update every link brings. */
const besidesUpdates = (intents: Intent[]) => intents.filter((i) => i.kind !== "bot.update");
const A = "a_mac1" as AgentId;
const agent = (status: Agent["status"] = "working"): Agent => ({
  id: A,
  botId: B,
  title: "Push fix",
  where: "mac",
  projectName: "shop",
  status,
  url: null,
  createdAt: at,
  updatedAt: at,
  evidence: null,
  worktree: null,
});
const card = (answer: "once" | null = null): Message => ({
  kind: "permission",
  id: "c_mac1" as MessageId,
  at,
  from: { kind: "agent", id: A, title: "Push fix" },
  tool: "Bash",
  label: "Push to the default branch",
  detail: "git push origin main",
  always: "",
  answer,
  expiresAt,
});

function home(world: World = emptyWorld(), seed?: (root: string) => void) {
  const m = remote();
  world.bots.set(B, bot("eng"));
  const h = hubOver(world, { links: m.links, ...(seed && { seed }) });
  h.homes.create(B, "# eng\n");
  return { ...m, h, world, botFrame: () => h.frames.findLast((f) => f.type === "bot" && f.bot.id === B) };
}

/** The bot's first turn, so its tools can be called. */
async function turn(r: ReturnType<typeof home>) {
  await r.h.hub.handle({ type: "send", botId: B, text: "fix the shop", uploads: [] });
  await flush();
}

/** A home that placed agent A of bot B on the MacBook before it restarted, so the MacBook may speak for it. */
const placed = (world?: World) => home(world, placedOn({ agentId: A, machine: MAC, botId: B }));

test("a remote agent's card shows in its bot's chat, pushes, and holds the bot at awaiting approval; this gate never expires it", async () => {
  const r = placed();
  r.send({ kind: "agent", agent: agent(), messages: [] });
  r.send({ kind: "card", botId: B, message: card() });
  expect(r.world.bots.get(B)!.messages.at(-1)).toEqual(card());
  expect(r.h.pushes).toEqual([{ botId: B, reason: "card", messageId: "c_mac1" as MessageId }]);
  expect(r.botFrame()).toMatchObject({ bot: { status: "awaiting_approval", question: "Push to the default branch: git push origin main" } });

  later(3 * 3600_000);
  r.h.hub.tick(new Date());
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ id: "c_mac1", answer: null });
  r.send({ kind: "card", botId: B, message: card() });
  expect(r.h.pushes).toHaveLength(1);
});

test("a phone decide on a mirrored card goes to its machine as card.answer and leaves this gate alone; the machine's card event closes it", async () => {
  const r = placed();
  r.send({ kind: "card", botId: B, message: card() });
  expect(await r.h.hub.handle({ type: "decide", botId: B, messageId: "c_mac1" as MessageId, choice: "once" })).toEqual([]);
  expect(r.intents).toMatchObject([{ kind: "card.answer", botId: B, cardId: "c_mac1", reply: { kind: "permission", choice: "once" }, signed: null }]);
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ answer: null });
  expect(r.world.gate.grants).toEqual([]);

  r.send({ kind: "card", botId: B, message: card("once") });
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ id: "c_mac1", answer: "once" });
  expect(r.botFrame()).toMatchObject({ bot: { status: "idle", question: null } });
});

test("an answer to a card of an offline machine waits for it, says so in the chat, and goes when it links", async () => {
  const r = placed();
  r.send({ kind: "card", botId: B, message: card() });
  r.flip(false);
  expect(await r.h.hub.handle({ type: "decide", botId: B, messageId: "c_mac1" as MessageId, choice: "deny" })).toEqual([]);
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ kind: "note", text: 'MacBook is offline, so your answer to "Push to the default branch" goes to it when it is back.' });
  expect(r.intents).toEqual([]);
  r.flip(true);
  await flush();
  expect(besidesUpdates(r.intents)).toMatchObject([{ kind: "card.answer", reply: { choice: "deny" } }]);
});

test("an answer queued for a machine asleep past its card's expiry still goes, and the machine's refusal is the note in the chat", async () => {
  const r = placed();
  r.send({ kind: "card", botId: B, message: card() });
  r.flip(false);
  await r.h.hub.handle({ type: "decide", botId: B, messageId: "c_mac1" as MessageId, choice: "once" });
  later(3 * 3600_000);
  r.h.hub.tick(new Date());
  r.answers((i) => (i.kind === "card.answer" ? { ok: false, reason: "That request expired" } : { ok: true }));
  r.flip(true);
  await flush();
  expect(besidesUpdates(r.intents).map((i) => i.kind)).toEqual(["card.answer"]);
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ kind: "note", text: 'Your answer to "Push to the default branch" on MacBook did not go through: That request expired' });
});

test("a snapshot that no longer holds a mirrored card closes it in the chat as expired", async () => {
  const r = placed();
  r.send({ kind: "card", botId: B, message: card() });
  r.send({ kind: "snapshot", agents: [], openCards: [] });
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ id: "c_mac1", answer: "expired" });
});

test("start_agent with a machine starts the agent there: the home mints the id and the bot hears the machine's reply", async () => {
  const r = home();
  r.answers((i) => ({ ok: true, reply: `Started agent ${i.kind === "agent.start" ? i.agentId : ""} on shop.` }));
  await turn(r);
  const reply = await callTool(r.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "/Users/alex/code/shop", machine: "macbook" });
  const start = r.intents[0] as Extract<Intent, { kind: "agent.start" }>;
  expect(start).toMatchObject({ kind: "agent.start", bot: { id: B, name: "eng" }, project: { githubRepo: null, name: "shop" }, where: "mac" });
  expect(reply).toMatchObject({ content: [{ text: `Started agent ${start.agentId} on shop.` }] });
  expect(r.world.agents.size).toBe(0);
});

test("start_agent on an offline machine waits for it: the bot hears so, and the start goes when it links", async () => {
  const r = home();
  r.flip(false);
  await turn(r);
  const reply = await callTool(r.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "shop", machine: "MacBook" });
  expect(reply).toMatchObject({ content: [{ text: expect.stringMatching(/^Waiting for MacBook; agent a_[\w-]+ starts when MacBook is online\.$/) }] });
  r.flip(true);
  await flush();
  expect(besidesUpdates(r.intents).map((i) => i.kind)).toEqual(["agent.start"]);
});

test("a bot whose agents run on a machine starts there when it names none; an unknown machine is refused", async () => {
  const r = home();
  r.world.bots.get(B)!.agentsOn = MAC;
  await turn(r);
  await callTool(r.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "shop" });
  expect(r.intents.map((i) => i.kind)).toEqual(["agent.start"]);
  const other = home();
  await turn(other);
  expect(await callTool(other.h.q(), "start_agent", { title: "x", prompt: "y", project: "shop", machine: "studio" })).toMatchObject({
    content: [{ text: 'No machine "studio". Machines: Mac, MacBook.' }],
  });
});

test("list_projects with a machine lists that machine's projects", async () => {
  const r = home();
  r.answers((i) => (i.kind === "projects" ? { ok: true, reply: '[{"name": "shop"}]' } : { ok: true }));
  await turn(r);
  expect(await callTool(r.h.q(), "list_projects", { machine: "MacBook" })).toMatchObject({ content: [{ text: '[{"name": "shop"}]' }] });
});

test("a remote agent shows in its bot's details under its machine, and the phone's stop and the bot's message go to that machine", async () => {
  const r = placed();
  r.send({ kind: "agent", agent: agent(), messages: [{ id: "m1" as MessageId, at, from: "bot", text: "Push it." }] });
  expect(r.h.frames.findLast((f) => f.type === "agent")).toMatchObject({ agent: { id: A, machine: MAC, budgetUsd: null } });
  const [details] = await r.h.hub.handle({ type: "details", botId: B });
  expect(details?.type === "details" && details.agents.map((a): string[] => [a.id, a.machine])).toEqual([[A, MAC]]);
  expect(await r.h.hub.handle({ type: "agent", agentId: A })).toMatchObject([{ type: "agent", agent: { machine: MAC }, messages: [{ text: "Push it." }] }]);

  expect(await r.h.hub.handle({ type: "stop_agent", agentId: A })).toEqual([]);
  await turn(r);
  await callTool(r.h.q(), "message_agent", { agentId: A, text: "Also tag it." });
  expect(r.intents).toMatchObject([
    { kind: "agent.stop", agentId: A },
    { kind: "agent.message", agentId: A, text: "Also tag it." },
  ]);
});

test("a remote agent's report reaches its bot as a local agent's does, with the exchange counted", async () => {
  const r = placed();
  await turn(r);
  r.h.q().emit(assistant(text("On it.")), result());
  await flush();
  r.send({ kind: "agent", agent: agent(), messages: [] });
  r.send({ kind: "report", agentId: A, botId: B, text: "Pushed to main.", by: { kind: "user" } });
  await flush();
  expect(r.h.q().received.at(-1)).toContain("Pushed to main.");
  expect(r.world.bots.get(B)!.messages.findLast((m) => m.kind === "exchange")).toMatchObject({ peer: { kind: "agent", id: A }, received: 1 });
});

test("a remote agent's usage counts toward its bot's day here", async () => {
  const r = placed();
  const day = new Date().toLocaleDateString("en-CA");
  r.send({ kind: "usage", row: { at, actor: `agent:${A}`, botId: B, sessionId: "s_mac", initiator: { kind: "user" }, cumulativeUsd: 0.6, deltaUsd: 0.6, day } });
  expect(r.botFrame()).toMatchObject({ bot: { spentTodayUsd: 0.6 } });
});

test("with a machine enrolled, the bot's prompt lists each machine: online or not, platform, access in words, connector chips", async () => {
  const r = home();
  r.world.bots.get(B)!.agentsOn = MAC;
  r.flip(false);
  await turn(r);
  const append = (r.h.q().options.systemPrompt as { append: string }).append;
  expect(append).toContain(
    [
      "Machines your agents can run on. start_agent and list_projects take machine, by name. A start on an offline machine waits until it is back.",
      `- Mac (this computer, online): ${process.platform === "darwin" ? "macOS" : "Linux"}, `,
    ].join("\n"),
  );
  expect(append).toContain("- MacBook (offline): macOS, full access, no sandbox.\nYour agents start on MacBook unless you name another.");
});

test("the Machines block names chips for Chrome and computer use only, and is empty while the home is alone", () => {
  const m = { name: "Omarchy", home: true, online: true, platform: "linux" as const, access: { full: false, sandbox: true }, connectors: [] };
  expect(machinesBlock([m], null)).toBe("");
  const mac = { ...m, name: "Mac", home: false, platform: "darwin" as const, connectors: [{ kind: "chrome" as const }, { kind: "other" as const }, { kind: "computer-use" as const }] };
  expect(machinesBlock([m, mac], null).split("\n").slice(1)).toEqual(["- Omarchy (this computer, online): Linux, guarded, sandboxed.", "- Mac (online): macOS, guarded, sandboxed. Chrome, Computer use."]);
});

test("deleting a bot tells each machine with its agents to forget it, also one asleep, and the home stops hearing them", async () => {
  const r = placed();
  r.send({ kind: "agent", agent: agent(), messages: [] });
  r.flip(false);
  expect(await r.h.hub.handle({ type: "delete_bot", botId: B })).toEqual([]);
  r.flip(true);
  await flush();
  expect(r.intents).toMatchObject([{ kind: "bot.forget", botId: B }]);
  expect(await r.h.hub.handle({ type: "agent", agentId: A })).toEqual([{ type: "error", message: "Unknown agent" }]);
  r.send({ kind: "agent", agent: agent(), messages: [] });
  expect(r.h.frames.filter((f) => f.type === "agent")).toHaveLength(1);
});

test("deleting a bot drops the start still waiting for its offline machine, so nothing starts when it links", async () => {
  const r = home();
  r.flip(false);
  await turn(r);
  await callTool(r.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "shop", machine: "MacBook" });
  expect(await r.h.hub.handle({ type: "delete_bot", botId: B })).toEqual([]);
  r.flip(true);
  await flush();
  expect(besidesUpdates(r.intents).filter((i) => i.kind !== "bot.forget")).toEqual([]);
});

test("a remote card's reminder pushes from the home once, even when its event comes again, and not after the card closed", async () => {
  const world = emptyWorld();
  const sent: string[] = [];
  const push = createPush({ world, persist: () => {}, sender: async (n) => void sent.push(n.text), liveUntil: () => null, now: () => new Date(), log: () => {} });
  const m = remote();
  world.bots.set(B, bot("eng"));
  hubOver(world, { links: m.links, push, seed: placedOn({ agentId: A, machine: MAC, botId: B }) });
  m.send({ kind: "card", botId: B, message: card() });
  m.send({ kind: "reminder", botId: B, cardId: "c_mac1" as MessageId });
  m.send({ kind: "reminder", botId: B, cardId: "c_mac1" as MessageId });
  await flush();
  expect(sent).toEqual(["eng needs you", "eng is still waiting for you"]);

  m.send({ kind: "card", botId: B, message: { ...card("once"), id: "c_mac2" as MessageId } });
  m.send({ kind: "reminder", botId: B, cardId: "c_mac2" as MessageId });
  await flush();
  expect(sent).toHaveLength(2);
});

test("a remote card a live phone held back is pushed once when the phone goes quiet, and not again on a replay", async () => {
  const world = emptyWorld();
  const sent: string[] = [];
  const quietAt = new Date(Date.now() + 45_000);
  let liveUntil: Date | null = quietAt;
  let h: ReturnType<typeof hubOver> | undefined;
  const push = createPush({ world, persist: () => {}, sender: async (n) => void sent.push(n.text), liveUntil: () => liveUntil, now: () => new Date(), log: () => {}, remoteCards: () => h!.hub.remoteCards() });
  const m = remote();
  world.bots.set(B, bot("eng"));
  h = hubOver(world, { links: m.links, push, seed: placedOn({ agentId: A, machine: MAC, botId: B }) });
  m.send({ kind: "card", botId: B, message: card() });
  await flush();
  expect(sent).toEqual([]);

  h.hub.tick(new Date(quietAt.getTime() + 1_000));
  await flush();
  expect(sent).toEqual(["eng needs you"]);

  liveUntil = null;
  m.send({ kind: "card", botId: B, message: card() });
  h.hub.tick(new Date(quietAt.getTime() + 2_000));
  await flush();
  expect(sent).toEqual(["eng needs you"]);
});

test("a machine is heard only about agents the home placed on it: another's agent, card, report, note and row are dropped", async () => {
  const r = home();
  const before = r.world.bots.get(B)!.messages.length;
  r.send({ kind: "agent", agent: agent(), messages: [] });
  r.send({ kind: "card", botId: B, message: card() });
  r.send({ kind: "report", agentId: A, botId: B, text: "Pushed.", by: { kind: "user" } });
  r.send({ kind: "note", agentId: A, botId: B, text: "hi" });
  r.send({ kind: "usage", row: { at, actor: `agent:${A}`, botId: B, sessionId: "s_mac", initiator: { kind: "user" }, cumulativeUsd: 5, deltaUsd: 5, day: new Date().toLocaleDateString("en-CA") } });
  await flush();
  expect(r.h.frames.filter((f) => f.type === "agent")).toEqual([]);
  expect(r.world.bots.get(B)!.messages).toHaveLength(before);
  expect(r.h.pushes).toEqual([]);
  expect(await r.h.hub.handle({ type: "agent", agentId: A })).toEqual([{ type: "error", message: "Unknown agent" }]);
  expect(r.botFrame()?.type === "bot" ? r.botFrame()! : null).toBeFalsy();
});

test("an agent placed for one bot cannot speak for another bot, nor post a card from another bot's agent", async () => {
  const world = emptyWorld();
  const other = bot("ops");
  world.bots.set(other.id, other);
  const r = placed(world);
  r.send({ kind: "agent", agent: { ...agent(), botId: other.id }, messages: [] });
  r.send({ kind: "card", botId: other.id, message: card() });
  r.send({ kind: "report", agentId: A, botId: other.id, text: "Pushed.", by: { kind: "user" } });
  await flush();
  expect(r.h.frames.filter((f) => f.type === "agent")).toEqual([]);
  expect(world.bots.get(other.id)!.messages).toEqual([]);
});

test("a report reaches the bot under the turn the home sent, whatever hops and origin the machine claims", async () => {
  const sent = { kind: "bot" as const, botId: "b_ops" as BotId, hops: 2, origin: { kind: "user" as const } };
  const r = home(emptyWorld(), placedOn({ agentId: A, machine: MAC, botId: B, by: sent }));
  await turn(r);
  r.send({ kind: "agent", agent: agent(), messages: [] });
  const routine = { kind: "routine" as const, run: { routineId: "r1" as never, runId: "x" as never }, manual: false };
  r.send({ kind: "report", agentId: A, botId: B, text: "Pushed to main.", by: { kind: "agent", agentId: A, hops: 0, origin: routine } });
  await flush();
  expect(own<SessionState>(r.world.bots.get(B)!.session).pending.at(-1)?.initiator).toEqual({ kind: "agent", agentId: A, hops: 2, origin: { kind: "user" } });
});

test("a card under an id the bot's chat already holds is refused, so a machine cannot replace or answer the home's own card", async () => {
  const r = placed();
  const own = { ...(card() as Extract<Message, { kind: "permission" }>), id: "c_home" as MessageId, from: null };
  r.world.bots.get(B)!.messages.push(own);
  r.send({ kind: "card", botId: B, message: { ...own, label: "Something else", from: null } });
  r.send({ kind: "card", botId: B, message: { ...own, answer: "once", from: null } });
  expect(r.world.bots.get(B)!.messages.filter((m) => m.id === "c_home")).toEqual([own]);
  expect(r.h.pushes).toEqual([]);
});

test("a remote usage row never moves the baseline of the home's own session, and counts on today at the latest", async () => {
  const r = placed();
  await turn(r);
  r.h.q().emit(assistant(text("On it.")), result(0.25));
  await flush();
  expect(r.botFrame()).toMatchObject({ bot: { spentTodayUsd: 0.25 } });
  r.send({ kind: "usage", row: { at, actor: `agent:${A}`, botId: B, sessionId: "s_1", initiator: { kind: "user" }, cumulativeUsd: 100, deltaUsd: 0.1, day: "2999-01-01" } });
  expect(r.botFrame()).toMatchObject({ bot: { spentTodayUsd: 0.35 } });
  await r.h.hub.handle({ type: "send", botId: B, text: "and again", uploads: [] });
  await flush();
  r.h.q().emit(assistant(text("Again.")), result(0.5));
  await flush();
  expect(r.botFrame()).toMatchObject({ bot: { spentTodayUsd: 0.6 } });
});

test("an agent the bot starts on a machine is heard from that machine at once, and from no other", async () => {
  const r = home();
  await turn(r);
  await callTool(r.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "shop", machine: "MacBook" });
  const start = r.intents.find((i): i is Extract<Intent, { kind: "agent.start" }> => i.kind === "agent.start")!;
  r.send({ kind: "agent", agent: { ...agent(), id: start.agentId }, messages: [] });
  expect(r.h.frames.findLast((f) => f.type === "agent")).toMatchObject({ agent: { id: start.agentId, machine: MAC } });
});

test("a start the machine refuses leaves it nothing to speak for", async () => {
  const r = home();
  r.answers((i) => (i.kind === "agent.start" ? { ok: false, reason: 'No project "shop".' } : { ok: true }));
  await turn(r);
  await callTool(r.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "shop", machine: "MacBook" });
  const start = r.intents.find((i): i is Extract<Intent, { kind: "agent.start" }> => i.kind === "agent.start")!;
  r.send({ kind: "agent", agent: { ...agent(), id: start.agentId }, messages: [] });
  expect(r.h.frames.filter((f) => f.type === "agent")).toEqual([]);
});

test("remove_machine closes its link, expires its open cards with a note, drops what waits for it, and stops hearing it", async () => {
  const r = placed();
  r.send({ kind: "agent", agent: agent(), messages: [] });
  r.send({ kind: "card", botId: B, message: card() });
  r.flip(false);
  await turn(r);
  await callTool(r.h.q(), "message_agent", { agentId: A, text: "Also tag it." });
  expect(await r.h.hub.handle({ type: "remove_machine", machineId: MAC })).toEqual([{ type: "machines", machines: [expect.objectContaining({ role: "home" })] }]);
  expect(r.removed).toEqual([MAC]);
  expect(r.h.frames.at(-1)).toMatchObject({ type: "machines" });
  const chat = r.world.bots.get(B)!.messages;
  expect(chat.find((m) => m.id === "c_mac1")).toMatchObject({ answer: "expired" });
  expect(chat.at(-1)).toMatchObject({ kind: "note", text: expect.stringContaining("MacBook was removed") });
  expect(await r.h.hub.handle({ type: "agent", agentId: A })).toEqual([{ type: "error", message: "Unknown agent" }]);
  const [details] = await r.h.hub.handle({ type: "details", botId: B });
  expect(details?.type === "details" && details.agents).toEqual([]);

  r.send({ kind: "agent", agent: agent(), messages: [] });
  expect(await r.h.hub.handle({ type: "agent", agentId: A })).toEqual([{ type: "error", message: "Unknown agent" }]);
  r.flip(true);
  await flush();
  expect(r.intents).toEqual([]);
});

test("remove_machine refuses the home itself and a machine it does not know", async () => {
  const r = home();
  expect(await r.h.hub.handle({ type: "remove_machine", machineId: "m_test" as MachineId })).toEqual([{ type: "error", message: "This is the home: it cannot be removed." }]);
  expect(await r.h.hub.handle({ type: "remove_machine", machineId: "m_nope" as MachineId })).toEqual([{ type: "error", message: "Unknown machine" }]);
  expect(r.removed).toEqual([]);
});

test("at boot, a mirror slice of a machine no longer enrolled is dropped and its open cards expire", () => {
  const GONE = "m_gone" as MachineId;
  const before = (root: string) => {
    placedOn({ agentId: A, machine: GONE, botId: B })(root);
    const mirror = createMirror({ path: join(root, "machine", "mirror.json"), log: () => {}, owner: { agent: () => GONE, card: () => GONE } });
    mirror.apply(GONE, { seq: 1, at, kind: "agent", agent: agent(), messages: [] });
    mirror.apply(GONE, { seq: 2, at, kind: "card", botId: B, message: card() });
    world.bots.get(B)!.messages.push(card());
  };
  const world = emptyWorld();
  const r = home(world, before);
  expect(r.world.bots.get(B)!.messages.find((m) => m.id === "c_mac1")).toMatchObject({ answer: "expired" });
  const hello = r.h.hub.hello({ epoch: "", seq: 0, resumed: false });
  expect(hello.type === "hello" && hello.bots.find((b) => b.id === B)?.status).toBe("idle");
});

test("a cap change, a rename and a connector toggle reach each machine with the bot's agents as bot.update, with the home's spend today", async () => {
  const r = placed();
  const day = new Date().toLocaleDateString("en-CA");
  r.send({ kind: "usage", row: { at, actor: `agent:${A}`, botId: B, sessionId: "s_mac", initiator: { kind: "user" }, cumulativeUsd: 0.6, deltaUsd: 0.6, day } });
  await r.h.hub.handle({ type: "update_bot", botId: B, patch: { dailyCapUsd: 5 } });
  await r.h.hub.handle({ type: "update_bot", botId: B, patch: { name: "eng2" } });
  await turn(r);
  expect(await r.h.hub.handle({ type: "set_connector", botId: B, name: "chrome-devtools", enabled: false })).toMatchObject([{ type: "connectors" }]);
  await flush();
  expect(r.intents.filter((i) => i.kind === "bot.update")).toMatchObject([
    { bot: { id: B, name: "eng", dailyCapUsd: 5, connectorsOff: [] }, spentTodayUsd: 0.6 },
    { bot: { id: B, name: "eng2", dailyCapUsd: 5 } },
    { bot: { id: B, connectorsOff: ["chrome-devtools"] } },
  ]);
});

test("a machine that links again hears each of its bots' stand-ins and spend afresh; a start carries the spend too", async () => {
  const r = placed();
  r.flip(false);
  r.flip(true);
  await flush();
  expect(r.intents).toMatchObject([{ kind: "bot.update", bot: { id: B }, spentTodayUsd: 0 }]);
  const other = home();
  await turn(other);
  await callTool(other.h.q(), "start_agent", { title: "Push fix", prompt: "Push it.", project: "shop", machine: "MacBook" });
  expect(other.intents).toMatchObject([{ kind: "agent.start", spentTodayUsd: 0 }]);
});
