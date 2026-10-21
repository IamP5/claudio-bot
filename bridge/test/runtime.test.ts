import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Ledger } from "../src/ledger";
import { profileOf } from "../src/machine/profile";
import { fileJournal, memoryJournal, type Journal } from "../src/machine/journal";
import { createAgentRuntime, type RuntimeDeps } from "../src/machine/runtime";
import { newAgentId, newIntentId, type Event, type Intent } from "../src/machine/wire";
import type { BotId } from "../src/protocol";
import type { Project } from "../src/projects";
import { emptyWorld, newBot, type Initiator, type World } from "../src/world";

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

function runtime(opts: { journal?: Journal; world?: World; standIn?: RuntimeDeps["standIn"] } = {}) {
  const world = opts.world ?? emptyWorld();
  if (!opts.world) world.bots.set(B1, newBot({ id: B1, name: "Ana", avatar: { shape: "circle", color: "white" }, at: AT }));
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
    standIn: opts.standIn ?? ((bot) => world.bots.has(bot.id)),
    journal: opts.journal ?? memoryJournal(),
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
  spentTodayUsd: 0,
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

test("a snapshot carries each agent's newest 200 messages, so a long thread never makes it too big for a frame", async () => {
  const h = runtime();
  const start = startOf();
  await h.rt.apply(start);
  const rec = h.world.agents.get(start.agentId)!;
  for (let i = 0; i < 500; i++) rec.messages.push({ id: `m${i}` as never, at: AT, from: "agent", text: `line ${i}` });
  await h.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  const snapshot = h.rt.events(0).at(-1);
  if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
  const sent = snapshot.agents[0]!.messages;
  expect(sent).toHaveLength(200);
  expect(sent.at(-1)).toMatchObject({ text: "line 499" });
  expect(rec.messages.length).toBeGreaterThan(500);
});

function machineDir() {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-journal-"));
  dirs.push(dir);
  return dir;
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("after a kill, a machine replays exactly the events its home has not acked, and seq carries on", async () => {
  const dir = machineDir();
  const before = runtime({ journal: fileJournal(dir, () => {}) });
  for (let i = 0; i < 5; i++) await before.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  const emitted = before.rt.events(0);
  const acked = emitted.at(-3)!.seq;
  before.rt.ack(acked);

  const after = runtime({ journal: fileJournal(dir, () => {}) });
  expect(after.rt.events(0)).toEqual(emitted.filter((e) => e.seq > acked));
  expect(after.rt.lastSeq()).toBe(emitted.at(-1)!.seq);
  await after.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  expect(after.rt.events(0).map((e) => e.seq)).toEqual([acked + 1, acked + 2, acked + 3]);
});

test("an outbox the home acked in full restarts empty but keeps counting from its last seq", async () => {
  const dir = machineDir();
  const before = runtime({ journal: fileJournal(dir, () => {}) });
  await before.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  await before.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  before.rt.ack(2);
  const after = runtime({ journal: fileJournal(dir, () => {}) });
  expect([after.rt.events(0), after.rt.lastSeq()]).toEqual([[], 2]);
});

test("a torn last line in the outbox, from a kill mid-append, is skipped", async () => {
  const dir = machineDir();
  const before = runtime({ journal: fileJournal(dir, () => {}) });
  await before.rt.apply({ kind: "snapshot", intentId: newIntentId() });
  appendFileSync(join(dir, "outbox.jsonl"), '{"seq":2,"at":"2026-');
  const after = runtime({ journal: fileJournal(dir, () => {}) });
  expect(after.rt.events(0).map((e) => e.seq)).toEqual([1]);
});

test("an intent replayed after a restart gets its first answer from the journal and runs nothing", async () => {
  const dir = machineDir();
  const world = emptyWorld();
  world.bots.set(B1, newBot({ id: B1, name: "Ana", avatar: { shape: "circle", color: "white" }, at: AT }));
  const before = runtime({ world, journal: fileJournal(dir, () => {}) });
  const refused = startOf({ project: { githubRepo: null, name: "nope" } });
  const first = await before.rt.apply(refused);

  const after = runtime({ world, journal: fileJournal(dir, () => {}) });
  const seq = after.rt.lastSeq();
  expect(await after.rt.apply(refused)).toEqual(first);
  expect(after.rt.lastSeq()).toBe(seq);
  expect(after.queries).toEqual([]);
});

test("a machine's stand-in hook decides whether agent.start may run for the bot", async () => {
  const seen: string[] = [];
  const h = runtime({ world: emptyWorld(), standIn: (bot) => (seen.push(bot.name), true) });
  const intent = startOf();
  expect((await h.rt.apply(intent)).ok).toBe(true);
  expect(seen).toEqual(["Ana"]);
});
