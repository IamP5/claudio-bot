import { afterEach, expect, test } from "bun:test";
import type { Links } from "../src/machine/links";
import type { Machine, Sent } from "../src/machine/machines";
import { profileOf } from "../src/machine/profile";
import { profileView, type Event, type EventBody, type Intent, type MachineId } from "../src/machine/wire";
import type { Agent, AgentId, BotId, Message, MessageId } from "../src/protocol";
import { emptyWorld, type World } from "../src/world";
import { assistant, bot, callTool, cleanup, flush, hubOver, later, result, text } from "./hub-kit";

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
    profile: () => profileView(profileOf({ env: { CLAUDIOBOT_ACCESS: "full", CLAUDIOBOT_SANDBOX: "off" }, platform: "darwin", name: "MacBook", homedir: "/Users/alex", username: "alex" })),
    status: () => ({ online, since: null }),
    async send(intent) {
      if (!online) return { ok: false, reason: "MacBook is offline", undelivered: true };
      intents.push(intent);
      return answer(intent);
    },
  };
  const links: Pick<Links, "machines" | "onEvent" | "onChange"> = {
    machines: () => [mac],
    onChange: (f) => void change.push(f),
    onEvent: (f) => void events.push(f),
  };
  return {
    links,
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
const agent = (status: Agent["status"] = "working"): Agent => ({
  id: "a_mac1" as AgentId,
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
  from: { kind: "agent", id: "a_mac1" as AgentId, title: "Push fix" },
  tool: "Bash",
  label: "Push to the default branch",
  detail: "git push origin main",
  always: "",
  answer,
  expiresAt,
});

function home(world: World = emptyWorld()) {
  const m = remote();
  world.bots.set(B, bot("eng"));
  const h = hubOver(world, { links: m.links });
  h.homes.create(B, "# eng\n");
  return { ...m, h, world, botFrame: () => h.frames.findLast((f) => f.type === "bot" && f.bot.id === B) };
}

/** The bot's first turn, so its tools can be called. */
async function turn(r: ReturnType<typeof home>) {
  await r.h.hub.handle({ type: "send", botId: B, text: "fix the shop", uploads: [] });
  await flush();
}

test("a remote agent's card shows in its bot's chat, pushes, and holds the bot at awaiting approval; this gate never expires it", async () => {
  const r = home();
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
  const r = home();
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
  const r = home();
  r.send({ kind: "card", botId: B, message: card() });
  r.flip(false);
  expect(await r.h.hub.handle({ type: "decide", botId: B, messageId: "c_mac1" as MessageId, choice: "deny" })).toEqual([]);
  expect(r.world.bots.get(B)!.messages.at(-1)).toMatchObject({ kind: "note", text: 'MacBook is offline, so your answer to "Push to the default branch" goes to it when it is back.' });
  expect(r.intents).toEqual([]);
  r.flip(true);
  await flush();
  expect(r.intents).toMatchObject([{ kind: "card.answer", reply: { choice: "deny" } }]);
});

test("a snapshot that no longer holds a mirrored card closes it in the chat as expired", () => {
  const r = home();
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
  expect(r.intents.map((i) => i.kind)).toEqual(["agent.start"]);
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
  const r = home();
  r.send({ kind: "agent", agent: agent(), messages: [{ id: "m1" as MessageId, at, from: "bot", text: "Push it." }] });
  expect(r.h.frames.findLast((f) => f.type === "agent")).toMatchObject({ agent: { id: "a_mac1", machine: MAC, budgetUsd: null } });
  const [details] = await r.h.hub.handle({ type: "details", botId: B });
  expect(details?.type === "details" && details.agents.map((a): string[] => [a.id, a.machine])).toEqual([["a_mac1", MAC]]);
  expect(await r.h.hub.handle({ type: "agent", agentId: "a_mac1" as AgentId })).toMatchObject([{ type: "agent", agent: { machine: MAC }, messages: [{ text: "Push it." }] }]);

  expect(await r.h.hub.handle({ type: "stop_agent", agentId: "a_mac1" as AgentId })).toEqual([]);
  await turn(r);
  await callTool(r.h.q(), "message_agent", { agentId: "a_mac1", text: "Also tag it." });
  expect(r.intents).toMatchObject([
    { kind: "agent.stop", agentId: "a_mac1" },
    { kind: "agent.message", agentId: "a_mac1", text: "Also tag it." },
  ]);
});

test("a remote agent's report reaches its bot as a local agent's does, with the exchange counted", async () => {
  const r = home();
  await turn(r);
  r.h.q().emit(assistant(text("On it.")), result());
  await flush();
  r.send({ kind: "agent", agent: agent(), messages: [] });
  r.send({ kind: "report", agentId: "a_mac1" as AgentId, botId: B, text: "Pushed to main.", by: { kind: "user" } });
  await flush();
  expect(r.h.q().received.at(-1)).toContain("Pushed to main.");
  expect(r.world.bots.get(B)!.messages.findLast((m) => m.kind === "exchange")).toMatchObject({ peer: { kind: "agent", id: "a_mac1" }, received: 1 });
});

test("a remote agent's usage counts toward its bot's day here", () => {
  const r = home();
  const day = new Date().toLocaleDateString("en-CA");
  r.send({ kind: "usage", row: { at, actor: "agent:a_mac1", botId: B, sessionId: "s_mac", initiator: { kind: "user" }, cumulativeUsd: 0.6, deltaUsd: 0.6, day } });
  expect(r.botFrame()).toMatchObject({ bot: { spentTodayUsd: 0.6 } });
});
