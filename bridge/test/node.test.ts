import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { memoryJournal } from "../src/machine/journal";
import { createMachineNode } from "../src/machine/node";
import { newAgentId, newIntentId, type Event, type Intent } from "../src/machine/wire";
import type { AgentId, BotId, Message, MessageId } from "../src/protocol";
import { emptySession, emptyWorld, newBot, own, type AgentRecord, type MoveId, type MoveRecord } from "../src/world";
import { FakeQuery, cleanup, flush, result, roots, runBash, testProfile } from "./hub-kit";

afterEach(cleanup);

const B1 = "b_home" as BotId;
const at = "2026-10-21T12:00:00.000Z";
/** world.ts's HISTORY_KEEP and HISTORY_SLACK. */
const HISTORY_KEEP = 1000;
const HISTORY_SLACK = 100;

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-node-")));
  // The projects sit outside the bridge home, which the floors keep every agent out of.
  const code = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-code-")));
  roots.push(root, code);
  mkdirSync(join(code, "shop"));
  const world = emptyWorld();
  const queries: FakeQuery[] = [];
  const node = createMachineNode({
    world,
    profile: testProfile(root),
    userName: "Alex",
    model: undefined,
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt, options);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
    persist: () => {},
    log: () => {},
    now: () => new Date(),
    root,
    agentConfig: (id) => join(root, "agent-config", id),
    projectsDir: join(root, "projects"),
    scan: async () => [{ name: "shop", path: join(code, "shop"), branch: "main", githubRepo: null }],
    journal: memoryJournal(),
  });
  const events: Event[] = [];
  node.runtime.subscribe((e) => events.push(e));
  return { world, node, queries, events, root };
}

const start = (bot: { name: string; dailyCapUsd: number | null; connectorsOff: string[] }): Extract<Intent, { kind: "agent.start" }> => ({
  kind: "agent.start",
  intentId: newIntentId(),
  agentId: newAgentId(),
  bot: { id: B1, ...bot },
  title: "Fix tests",
  prompt: "Make the suite green.",
  project: { githubRepo: null, name: "shop" },
  where: "mac",
  isolate: "none",
  budgetUsd: null,
  slash: null,
  initiator: { kind: "user" },
});

test("agent.start on a machine creates the bot's stand-in from the intent, and a later start updates its home-owned fields", async () => {
  const m = machine();
  expect((await m.node.runtime.apply(start({ name: "Ana", dailyCapUsd: 5, connectorsOff: ["gmail"] }))).ok).toBe(true);
  expect(m.world.bots.get(B1)).toMatchObject({ name: "Ana", dailyCapUsd: 5, connectorsOff: ["gmail"], messages: [] });
  expect(m.queries[0]!.options.systemPrompt).toMatchObject({ append: expect.stringContaining("You were started by the bot Ana") });

  await m.node.runtime.apply(start({ name: "Ana B.", dailyCapUsd: null, connectorsOff: [] }));
  expect(m.world.bots.get(B1)).toMatchObject({ name: "Ana B.", dailyCapUsd: null, connectorsOff: [] });
  expect(m.world.bots.size).toBe(1);
});

test("a held call's card on the stand-in goes to the home as a card event, and card.answer from the home runs it once", async () => {
  const m = machine();
  await m.node.runtime.apply(start({ name: "Ana", dailyCapUsd: null, connectorsOff: [] }));
  await flush();
  const q = m.queries[0]!;
  await runBash(q, "git push origin main");
  const card = m.events.findLast((e): e is Extract<Event, { kind: "card" }> => e.kind === "card")!;
  expect(card).toMatchObject({ botId: B1, message: { kind: "permission", detail: "git push origin main", answer: null } });
  q.emit(result(0.1));
  await flush();

  const answer: Intent = { kind: "card.answer", intentId: newIntentId(), botId: B1, cardId: card.message.id, reply: { kind: "permission", choice: "once" }, signed: null };
  expect(await m.node.runtime.apply(answer)).toEqual({ ok: true });
  expect(m.events.findLast((e) => e.kind === "card")).toMatchObject({ message: { id: card.message.id, answer: "once" } });
  expect(await m.node.runtime.apply({ ...answer, intentId: newIntentId() })).toMatchObject({ ok: false });
});

test("a stand-in's chat is trimmed like a bot's: old messages go to the machine's archive, open cards stay", async () => {
  const m = machine();
  await m.node.runtime.apply(start({ name: "Ana", dailyCapUsd: null, connectorsOff: [] }));
  await flush();
  const standIn = m.world.bots.get(B1)!;
  const old = Array.from({ length: HISTORY_KEEP + HISTORY_SLACK }, (_, i): Message => ({ kind: "note", id: `n${i}` as MessageId, at: new Date().toISOString(), text: `old ${i}`, refs: [] }));
  standIn.messages.unshift(...old);
  await runBash(m.queries[0]!, "git push origin main");
  expect(standIn.messages.length).toBe(HISTORY_KEEP);
  expect(standIn.messages.at(-1)).toMatchObject({ kind: "permission", answer: null });
  expect(readFileSync(join(m.root, "machine", "history", `${B1}.jsonl`), "utf8").split("\n").filter(Boolean)).toHaveLength(HISTORY_SLACK + 1);
});

test("each usage row the machine's ledger charges goes to the home as a usage event, under the stand-in's bot", async () => {
  const m = machine();
  await m.node.runtime.apply(start({ name: "Ana", dailyCapUsd: null, connectorsOff: [] }));
  await flush();
  m.queries[0]!.emit(result(0.4));
  await flush();
  expect(m.events.filter((e) => e.kind === "usage")).toMatchObject([{ row: { actor: expect.stringMatching(/^agent:a_/), botId: B1, deltaUsd: 0.4 } }]);
});

test("projects lists this machine's own projects in the reply, applied afresh each time", async () => {
  const m = machine();
  const ask = { kind: "projects", intentId: newIntentId() } as const;
  const first = await m.node.runtime.apply(ask);
  expect(first).toMatchObject({ ok: true, reply: expect.stringContaining('"name": "shop"') });
  expect(await m.node.runtime.apply(ask)).toEqual(first);
});

test("at boot, agents whose bot moved to the home get a stand-in, from the frozen record when the move still holds it", async () => {
  const m = machine();
  const agentOf = (id: string, botId: string): AgentRecord => ({
    agent: { id: id as AgentId, botId: botId as BotId, title: "Fix", where: "mac", projectName: "shop", status: "waiting", url: null, createdAt: at, updatedAt: at, evidence: null, worktree: null },
    cwd: m.root,
    messages: [],
    session: emptySession("s_old"),
    cloudSession: null,
    budgetUsd: null,
    startedBy: { kind: "user" },
  });
  m.world.agents.set("a_frozen" as AgentId, agentOf("a_frozen", "b_ana"));
  m.world.agents.set("a_gone" as AgentId, agentOf("a_gone", "b_finished"));
  const ana = { ...newBot({ id: "b_ana" as BotId, name: "Ana", avatar: { shape: "circle", color: "gray" }, at }), dailyCapUsd: 3, connectorsOff: ["gmail"] };
  own<MoveRecord[]>(m.world.moves).push({ kind: "out", moveId: "mv_1" as MoveId, at, machine: "Mac", phase: "frozen", held: { bots: [ana], groups: [], exchanges: [] } });

  m.node.boot();
  expect(m.world.bots.get("b_ana" as BotId)).toMatchObject({ name: "Ana", dailyCapUsd: 3, connectorsOff: ["gmail"], messages: [] });
  expect(m.world.bots.get("b_finished" as BotId)).toMatchObject({ name: "b_finished", dailyCapUsd: null, connectorsOff: [] });
});
