import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgents } from "../src/agents";
import { newAgentId } from "../src/machine/wire";
import { connectorSettings } from "../src/connectors";
import { createGate } from "../src/gate";
import { createLedger } from "../src/ledger";
import type { BotId, Message } from "../src/protocol";
import { inputOf, notices } from "../src/prompts";
import { emptyWorld, newBot, post, type Actor, type AgentRecord, type World } from "../src/world";
import { PRIVATE } from "../src/private";
import { FakeQuery, cleanup, flush, result, roots, runBash, testProfile } from "./hub-kit";

// Phase 0 of docs/handoff-machines.md: a machine bridge holds no real bots, only a stand-in BotRecord per bot whose
// agents run there. The real gate, agents and ledger run against it the way the hub wires them.

afterEach(cleanup);

const B1 = "b_home" as BotId;
const user = { kind: "user" } as const;

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-standin-")));
  roots.push(root);
  const project = join(root, "shop");
  mkdirSync(project);
  const world: World = emptyWorld();
  const standIn = { ...newBot({ id: B1, name: "Ana", avatar: { shape: "circle", color: "white" }, at: new Date().toISOString() }), dailyCapUsd: 5, connectorsOff: ["gmail"] };
  world.bots.set(B1, standIn);

  let skewMs = 0;
  const now = () => new Date(Date.now() + skewMs);
  const queries: FakeQuery[] = [];
  const reports: string[] = [];
  const pushed: string[] = [];
  const ledger = createLedger({
    dir: join(root, "usage"),
    capFor: (id) => world.bots.get(id)?.dailyCapUsd ?? null,
    budgetFor: (id) => world.agents.get(id)?.budgetUsd ?? null,
    now,
    log: () => {},
  });
  const recOf = (actor: Actor): AgentRecord | undefined => (actor.kind === "agent" ? world.agents.get(actor.agentId) : undefined);
  const gate = createGate({
    world,
    scopeOf: () => ({ bridgeHome: join(root, ".claudiobot"), own: project, userMd: null, homedir: root, private: PRIVATE.darwin }),
    turnOf(actor) {
      const session = actor.kind === "agent" ? agents.session(actor.agentId) : null;
      return session?.current ? { initiator: session.current.initiator, stopping: session.lifecycle.kind === "stopping" } : null;
    },
    headroom: (actor, initiator) => ledger.headroom(actor, initiator),
    say: (bot, m) => void post(bot, m),
    deliver(actor, e) {
      const rec = recOf(actor);
      if (rec) agents.deliver(rec, inputOf(e, "Alex"));
    },
    notice(actor, text) {
      const rec = recOf(actor);
      if (rec) agents.notice(rec, text);
    },
    denied: (actor) => (actor.kind === "agent" ? agents.session(actor.agentId)?.denied() : undefined),
    notify: (_, reason, id) => pushed.push(`${reason} ${id}`),
    trusted: (root) => agents.trusted(root),
    persist: () => {},
    auditDir: join(root, "audit"),
    userName: "Alex",
    now,
    log: () => {},
  });
  const agents = createAgents({
    world,
    profile: testProfile(root),
    userName: "Alex",
    model: undefined,
    ledger,
    log: () => {},
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt, options);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
    hooks: (actor) => gate.hooks(actor),
    canUseTool: (actor) => gate.canUseTool(actor),
    beginTurn: (actor) => gate.beginTurn(actor),
    sandbox: () => ({ enabled: true }),
    configRoot: (id) => join(root, "agent-config", id),
    trustCard: (actor, repo) => gate.trustCard(actor, repo),
    settings: (actor) => connectorSettings(world.bots.get(actor.botId)?.connectorsOff ?? []),
    observe: () => {},
    idle: () => {},
    persist: () => {},
    now: () => now().toISOString(),
    changed: () => {},
    reported: (_, text) => reports.push(text),
    note: () => {},
    transcriptExists: () => false,
  });

  /** agent.start as the home would send it: the agent's first turn is open and holds a push to the default branch. */
  async function heldPush() {
    const rec = await agents.start(B1, {
      id: newAgentId(),
      title: "Fix tests",
      prompt: "Make the suite green.",
      project: { name: "shop", path: project, branch: "main", githubRepo: null },
      where: "mac",
      isolate: "auto",
      botName: "Ana",
      initiator: user,
      budgetUsd: null,
    });
    await flush();
    const q = queries.at(-1)!;
    const held = await runBash(q, "git push origin main");
    const cards = standIn.messages.filter((m): m is Extract<Message, { kind: "permission" }> => m.kind === "permission");
    expect(cards).toHaveLength(1);
    return { rec, q, held, card: cards[0]! };
  }

  return {
    world,
    standIn,
    gate,
    agents,
    reports,
    pushed,
    heldPush,
    q: () => queries.at(-1)!,
    later: (ms: number) => {
      skewMs += ms;
      return now();
    },
    now,
  };
}

const verdict = (out: unknown) => (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? "pass";
const cardIn = (bot: { messages: Message[] }, id: string) => bot.messages.find((m) => m.id === id) as Extract<Message, { kind: "permission" }>;

test("an agent's held call on a machine with only a bot stand-in posts its card, survives a tick, and Allow once runs it exactly once", async () => {
  const m = machine();
  expect(m.world.bots.size).toBe(1);
  const { rec, q, held, card } = await m.heldPush();

  expect(q.options.systemPrompt).toMatchObject({ append: expect.stringContaining("You were started by the bot Ana for Alex") });
  expect(q.options.settings).toEqual(connectorSettings(["gmail"]));
  expect(verdict(held)).toBe("deny");
  expect(card).toMatchObject({ tool: "Bash", detail: "git push origin main", answer: null, from: { kind: "agent", id: rec.agent.id, title: "Fix tests" } });
  expect(m.pushed).toEqual([`card ${card.id}`]);

  q.emit(result(0.1));
  await flush();
  expect(m.reports).toEqual([expect.stringContaining("ok")]);

  m.gate.tick(m.later(60_000));
  expect(cardIn(m.standIn, card.id).answer).toBeNull();
  expect(m.world.agents.get(rec.agent.id)!.agent.status).toBe("awaiting_approval");

  expect(m.gate.answer(B1, card.id, { kind: "permission", choice: "once" })).toEqual({ ok: true });
  await flush();
  expect(cardIn(m.standIn, card.id).answer).toBe("once");
  expect(q.received.at(-1)).toContain("git push origin main");

  expect(verdict(await runBash(q, "git push origin main"))).toBe("allow");
  expect(verdict(await runBash(q, "git push origin main"))).toBe("deny");
  expect(m.standIn.messages.filter((x) => x.kind === "permission")).toHaveLength(2);
});

test("an agent's card on a bot stand-in expires unanswered and the agent hears so on its next turn", async () => {
  const m = machine();
  const { rec, q, card } = await m.heldPush();
  q.emit(result(0.1));
  await flush();

  m.gate.tick(m.later(2 * 3600_000 + 1));
  expect(cardIn(m.standIn, card.id).answer).toBe("expired");
  expect(m.gate.answer(B1, card.id, { kind: "permission", choice: "once" })).toEqual({ ok: false, error: "That request expired" });

  await m.agents.message(rec, "Where are we?", user);
  await flush();
  expect(q.received.at(-1)).toContain(notices.expiredPermission("Alex", "Bash", "git push origin main"));
});
