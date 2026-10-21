import { expect, test } from "bun:test";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Ledger } from "../src/ledger";
import { profileOf } from "../src/machine/profile";
import { createAgentRuntime } from "../src/machine/runtime";
import { newAgentId, newIntentId, type Event, type Intent } from "../src/machine/wire";
import type { BotId } from "../src/protocol";
import type { Project } from "../src/projects";
import { emptyWorld, newBot, type Initiator } from "../src/world";

const AT = "2026-10-17T12:00:00.000Z";
const B1 = "b_1" as BotId;
const user: Initiator = { kind: "user" };
const shop: Project = { name: "shop", path: "/code/shop", branch: "main", githubRepo: null };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeQuery {
  readonly received: string[] = [];
  private queue: SDKMessage[] = [];
  private wake: (() => void) | null = null;
  closed = false;
  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const m of prompt) this.received.push(m.message.content as string);
    })();
  }
  emit(m: SDKMessage) {
    this.queue.push(m);
    this.wake?.();
  }
  async interrupt() {}
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

function runtime() {
  const world = emptyWorld();
  world.bots.set(B1, newBot({ id: B1, name: "Ana", avatar: { shape: "circle", color: "white" }, at: AT }));
  const queries: FakeQuery[] = [];
  const ledger: Ledger = { add: () => {}, headroom: () => ({ ok: true, capReached: false }), budgetLeft: () => null, dailyLeft: () => null };
  const rt = createAgentRuntime({
    world,
    profile: profileOf({ env: {}, platform: "darwin", name: "Mac", homedir: "/Users/alex", username: "alex" }),
    userName: "Alex",
    model: undefined,
    ledger,
    log: () => {},
    claude: {
      query: (({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
    hooks: () => ({}),
    canUseTool: () => async () => ({ behavior: "deny", message: "no" }),
    beginTurn: () => {},
    sandbox: () => ({ enabled: true }),
    configRoot: (id) => `/bridge/agent-config/${id}`,
    trustCard: () => {},
    settings: () => ({}),
    observe: () => {},
    idle: () => {},
    persist: () => {},
    now: () => AT,
    transcriptExists: () => false,
    scan: async () => [shop],
    answer: () => ({ ok: false, error: "Unknown card" }),
  });
  const seen: Event[] = [];
  rt.subscribe((e) => seen.push(e));
  return { world, rt, queries, seen };
}

const startOf = (over: Partial<Extract<Intent, { kind: "agent.start" }>> = {}): Extract<Intent, { kind: "agent.start" }> => ({
  kind: "agent.start",
  intentId: newIntentId(),
  agentId: newAgentId(),
  bot: { id: B1, name: "Ana", dailyCapUsd: null, connectorsOff: [] },
  title: "Fix tests",
  prompt: "Make the suite green.",
  project: { githubRepo: null, name: "shop" },
  where: "mac",
  isolate: "none",
  budgetUsd: null,
  slash: null,
  initiator: user,
  ...over,
});

test("agent.start runs the agent under the home's id and tells the bot as start_agent always has", async () => {
  const h = runtime();
  const intent = startOf();
  expect(await h.rt.apply(intent)).toEqual({ ok: true, reply: `Started agent ${intent.agentId} on shop. It reports back to you when its turn ends.` });
  await flush();
  expect([h.world.agents.get(intent.agentId)?.agent.projectName, h.queries[0]?.received.length]).toEqual(["shop", 1]);
  expect(h.seen.map((e) => e.kind)).toContain("agent");
});

test("a repeated intent applies once and gets the first result; a replayed start under the same agent id is a no-op", async () => {
  const h = runtime();
  const intent = startOf();
  const [first, again] = await Promise.all([h.rt.apply(intent), h.rt.apply(intent)]);
  const replay = await h.rt.apply({ ...intent, intentId: newIntentId() });
  await flush();
  expect([again, replay]).toEqual([first, first]);
  expect([h.world.agents.size, h.queries.length]).toEqual([1, 1]);
});

test.each([
  ["an unknown project", startOf({ project: { githubRepo: null, name: "nope" } }), 'No project "nope". Call list_projects for the names.'],
  ["a cloud agent on a project with no remote", startOf({ where: "cloud" }), 'shop has no GitHub remote, so start it with where "mac".'],
  ["a bot that is gone", startOf({ bot: { id: "b_gone" as BotId, name: "Gone", dailyCapUsd: null, connectorsOff: [] } }), "This bot no longer exists."],
] as const)("agent.start refuses %s, and the refusal is an event", async (_, intent, reason) => {
  const h = runtime();
  expect(await h.rt.apply(intent)).toEqual({ ok: false, reason });
  expect(h.world.agents.size).toBe(0);
  expect(h.rt.events(0).at(-1)).toMatchObject({ kind: "refused", intentId: intent.intentId, reason });
});

test.each(["agent.stop", "agent.removeWorktree"] as const)("%s on an agent the machine does not run is refused", async (kind) => {
  const h = runtime();
  expect(await h.rt.apply({ kind, intentId: newIntentId(), agentId: newAgentId() })).toEqual({ ok: false, reason: "Unknown agent" });
});

test("a mac agent's report is an event, after the record that holds it", async () => {
  const h = runtime();
  const intent = startOf();
  await h.rt.apply(intent);
  await flush();
  h.queries[0]!.emit({ type: "result", subtype: "success", is_error: false, result: "All green.", errors: [], session_id: "s", total_cost_usd: 0.1 } as unknown as SDKMessage);
  for (let i = 0; i < 50 && !h.seen.some((e) => e.kind === "report"); i++) await flush();
  const report = h.seen.findIndex((e) => e.kind === "report");
  expect(h.seen[report]).toMatchObject({ kind: "report", agentId: intent.agentId, botId: B1, by: user });
  expect(h.seen[report - 1]).toMatchObject({ kind: "agent", agent: { id: intent.agentId, status: "waiting" } });
});

test("events count up from 1 and events(after) returns only what came after", async () => {
  const h = runtime();
  await h.rt.apply(startOf());
  await h.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  const all = h.rt.events(0);
  expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  expect(h.rt.events(all.length - 1)).toEqual([all.at(-1)!]);
  expect(all.at(-1)).toMatchObject({ kind: "snapshot", agents: [{ agent: { title: "Fix tests" } }], openCards: [] });
});
