import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance, Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHomes } from "../src/home";
import { createHub, tickEach } from "../src/hub";
import type { Project } from "../src/projects";
import type { AgentId, BotId, Message, MessageId, RoutineId, RunId, ServerMessage, StreamPosition } from "../src/protocol";
import { createPush, type Push, type PushReason } from "../src/push";
import { BREAKER_NOTE } from "../src/session";
import { emptySession, emptyWorld, newBot, type AgentRecord, type BotRecord, type EnvelopeId, type Fingerprint, type GateState, type RoutineRecord, type Signature, type World } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

const at = "2026-10-17T12:00:00.000Z";
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const NO_RING: StreamPosition = { epoch: "", seq: 0, resumed: false };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A live SDK query the test drives: what the session sent it, and what it answers. */
class FakeQuery {
  readonly received: string[] = [];
  interrupts = 0;
  private queue: SDKMessage[] = [];
  private done = false;
  private wake: (() => void) | null = null;

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const m of prompt) this.received.push(m.message.content as string);
    })();
  }
  emit(...ms: SDKMessage[]) {
    this.queue.push(...ms);
    this.wake?.();
  }
  async interrupt() {
    this.interrupts++;
  }
  close() {
    this.done = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

let uuid = 0;
const assistant = (...content: object[]) =>
  ({ type: "assistant", uuid: `u${++uuid}`, session_id: "s_1", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (name: string) => ({ type: "tool_use", id: `t${++uuid}`, name, input: {} });
const result = (cost = 0.25, over: object = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: "ok", errors: [], session_id: "s_1", total_cost_usd: cost, ...over }) as unknown as SDKMessage;

type PushCall = { botId: BotId; reason: PushReason; messageId: MessageId };

/** sends: whether the fake push goes out (default: always). push: a real push instead of the fake. */
function hubOver(
  world: World,
  opts: { persist?: (urgency?: "now") => void; sends?: (call: PushCall, n: number) => boolean; push?: Push; scan?: () => Promise<Project[]> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-hub-"));
  roots.push(root);
  const homes = createHomes(root);
  const events: string[] = [];
  const frames: ServerMessage[] = [];
  const pushes: PushCall[] = [];
  const attempts: PushCall[] = [];
  const queries: FakeQuery[] = [];
  const hub = createHub({
    machine: "Mac",
    userName: "Alex",
    world,
    homes: {
      ...homes,
      trash(id, when) {
        events.push(`trash ${id}`);
        homes.trash(id, when);
      },
    },
    model: undefined,
    scan: opts.scan ?? (async () => []),
    broadcast: (m) => frames.push(m),
    persist: (urgency) => {
      opts.persist?.(urgency);
      events.push(`persist ${urgency ?? "later"} with ${[...world.bots.keys()].join(",") || "no bots"}`);
    },
    log: () => {},
    push: opts.push ?? {
      notify(bot, reason, messageId) {
        const call = { botId: bot.id, reason, messageId };
        attempts.push(call);
        const sent = opts.sends?.(call, attempts.length) ?? true;
        if (sent) pushes.push(call);
        return sent;
      },
      tick() {},
      nextDeadline: () => null,
    },
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt, options);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
  });
  return { hub, homes, root, events, frames, pushes, attempts, queries, q: () => queries.at(-1)! };
}

/** The bridge's real gate, called the way Claude Code calls the PreToolUse hook the session was given. */
function runBash(q: FakeQuery, command: string) {
  const id = `toolu_${++uuid}`;
  const input = { hook_event_name: "PreToolUse", session_id: "s_1", transcript_path: "/tmp/t.jsonl", cwd: q.options.cwd!, tool_name: "Bash", tool_input: { command, description: "run" }, tool_use_id: id };
  return q.options.hooks!.PreToolUse![0]!.hooks[0]!(input as never, id, { signal: new AbortController().signal });
}

/** One of the bot's own tools, called the way Claude Code calls it: over MCP. */
async function callTool(q: FakeQuery, name: string, args: Record<string, unknown>) {
  const [server, client] = InMemoryTransport.createLinkedPair();
  await (q.options.mcpServers!.claudio as McpSdkServerConfigWithInstance).instance.connect(server);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(client);
  return mcp.callTool({ name, arguments: args });
}

const bot = (name: string, patch: Partial<BotRecord> = {}): BotRecord => ({ ...newBot({ id: `b_${name}` as BotId, name, avatar: { shape: "circle", color: "white" }, at }), ...patch });

/** A routine due a few seconds ago, so the next tick fires it. */
function dueRoutine(b: BotRecord): RoutineRecord {
  const r: RoutineRecord = {
    id: "r_digest" as RoutineId,
    name: "digest",
    trigger: { kind: "cron", schedule: "*/15 * * * *" },
    prompt: "Check the repo.",
    enabled: true,
    nextRunAt: new Date(Date.now() - 5_000).toISOString(),
    runs: [],
    failStreak: 0,
  };
  (b.routines as RoutineRecord[]).push(r);
  return r;
}

const bubbles = (b: BotRecord) => b.messages.filter((m): m is Extract<Message, { kind: "bot" }> => m.kind === "bot").map((m) => m.text);

async function fired(over: Partial<BotRecord> = {}, routines = 1) {
  const world = emptyWorld();
  const b = bot("eng", over);
  world.bots.set(b.id, b);
  const routine = dueRoutine(b);
  for (let i = 1; i < routines; i++) (b.routines as RoutineRecord[]).push({ ...dueRoutine(b), id: `r_more${i}` as RoutineId, name: `more${i}` });
  if (routines > 1) (b.routines as RoutineRecord[]).splice(1, 1);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  h.hub.tick(new Date());
  await flush();
  return { ...h, bot: b, routine };
}

test("a bot shows parked only while its queue head is held, not because another bot hit the usage limit", () => {
  const world: World = { ...emptyWorld(), account: { parkedUntil: inAnHour() } };
  const held = bot("held", {
    session: {
      ...emptySession(),
      pending: [{ id: "e1" as EnvelopeId, kind: "envelope", at, text: "[Routine digest fired]", initiator: { kind: "routine", run: { routineId: "r1" as RoutineId, runId: "run1" as RunId }, manual: false }, settles: null, attempts: 0 }],
      lifecycle: { kind: "parked", reason: "usage_limit", until: inAnHour() },
    },
  });
  const resting = bot("resting");
  world.bots.set(held.id, held);
  world.bots.set(resting.id, resting);

  const hello = hubOver(world).hub.hello(NO_RING);

  expect(hello.type === "hello" && Object.fromEntries(hello.bots.map((b) => [b.name, b.status]))).toEqual({ held: "parked", resting: "idle" });
});

test("a permission card one of its agents opened shows the bot as awaiting approval", () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const call = { initiator: { kind: "user" as const }, tool: "Bash", signature: "Bash:git push" as Signature, fingerprint: "f" as Fingerprint, label: "Push to the default branch", detail: "git push origin main", always: "git push to main" };
  const agent = { kind: "agent" as const, id: "a_1" as AgentId, title: "Fix login" };
  b.messages.push({ kind: "permission", id: "m_card" as MessageId, at, from: agent, tool: call.tool, label: call.label, detail: call.detail, always: call.always, answer: null, expiresAt: inAnHour() });
  (world.gate.open as unknown[]).push({ kind: "permission", cardId: "m_card" as MessageId, actor: { kind: "agent", botId: b.id, agentId: agent.id }, remindAt: null, expiresAt: inAnHour(), call });

  const hello = hubOver(world).hub.hello(NO_RING);

  expect(hello.type === "hello" && hello.bots[0]?.status).toBe("awaiting_approval");
});

test("a scheduled fire is saved, with its run recorded and its next time advanced, before the bot's queue holds it", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const routine = dueRoutine(b);
  const before = routine.nextRunAt!;
  const saves: { pending: number; run: string | undefined; next: string | null }[] = [];
  const h = hubOver(world, { persist: (urgency) => urgency === "now" && saves.push({ pending: b.session.pending.length, run: routine.runs[0]?.status, next: routine.nextRunAt }) });

  h.hub.tick(new Date());

  expect(saves[0]).toMatchObject({ pending: 0, run: "running" });
  expect(saves[0]!.next! > before).toBe(true);
  expect(b.session.pending.map((p) => p.settles?.runId)).toEqual([routine.runs[0]!.id]);
});

test("a routine run that calls routine_no_update posts nothing, pushes nothing and settles quiet", async () => {
  const h = await fired();
  expect(h.q().received[0]).toStartWith("[Routine digest fired]");

  h.q().emit(assistant(text("Nothing new since yesterday."), toolUse("mcp__claudio__routine_no_update")), result());
  await flush();

  expect(bubbles(h.bot)).toEqual([]);
  expect(h.pushes).toEqual([]);
  expect(h.routine.runs.map((r) => r.status)).toEqual(["quiet"]);
});

test("a routine run's bubbles wait for its result, then post together with one push", async () => {
  const h = await fired();

  h.q().emit(assistant(text("Two PRs merged.\n\nBoth are green.")));
  await flush();
  expect(bubbles(h.bot)).toEqual([]);

  h.q().emit(result());
  await flush();
  expect(bubbles(h.bot)).toEqual(["Two PRs merged.", "Both are green."]);
  const first = h.bot.messages.find((m) => m.kind === "bot")!;
  expect(h.pushes).toEqual([{ botId: h.bot.id, reason: "message", messageId: first.id }]);
  expect(h.routine.runs.map((r) => r.status)).toEqual(["ok"]);
});

test("a routine run that asks posts what led up to the card at once, and is not quiet", async () => {
  const h = await fired();

  h.q().emit(assistant(text("The deploy failed twice."), toolUse("mcp__claudio__ask"), toolUse("mcp__claudio__routine_no_update")));
  await flush();
  expect(bubbles(h.bot)).toEqual(["The deploy failed twice."]);

  h.q().emit(result());
  await flush();
  expect(h.pushes.map((p) => p.reason)).toEqual(["message"]);
  expect(h.routine.runs.map((r) => r.status)).toEqual(["ok"]);
});

test("a user's turn posts each bubble as it arrives and pushes once", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  await h.hub.handle({ type: "send", botId: b.id, text: "status?", uploads: [] });
  await flush();

  h.q().emit(assistant(text("Looking.")));
  await flush();
  expect(bubbles(b)).toEqual(["Looking."]);
  h.q().emit(assistant(text("All green.")), result());
  await flush();

  expect(bubbles(b)).toEqual(["Looking.", "All green."]);
  expect(h.pushes).toHaveLength(1);
});

test("a turn whose first bubble was not pushed tries again with the next one", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world, { sends: (_, n) => n > 1 });
  await h.hub.handle({ type: "send", botId: b.id, text: "status?", uploads: [] });
  await flush();

  h.q().emit(assistant(text("Looking.")));
  await flush();
  h.q().emit(assistant(text("All green.")));
  await flush();

  const [looking, green] = b.messages.filter((m) => m.kind === "bot").map((m) => m.id);
  expect(h.attempts).toEqual([
    { botId: b.id, reason: "message", messageId: looking! },
    { botId: b.id, reason: "message", messageId: green! },
  ]);
});

test("a card held back while the phone was live is pushed by the hub's clock once the phone has gone quiet", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const sent: string[] = [];
  const quietAt = new Date(Date.now() + 45_000);
  const push = createPush({ world, persist: () => {}, sender: async (n) => void sent.push(n.text), liveUntil: () => quietAt, now: () => new Date(), log: () => {} });
  const h = hubOver(world, { push });
  h.homes.create(b.id, "# eng\n");
  await h.hub.handle({ type: "send", botId: b.id, text: "push it", uploads: [] });
  await flush();
  await runBash(h.q(), "git push origin main");
  await flush();
  expect(sent).toEqual([]);

  h.hub.tick(new Date(quietAt.getTime() + 1_000));
  await flush();

  expect(sent).toEqual(["eng needs you"]);
});

test("a turn still running 20 s after its push pushes its last bubble when it ends", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  await h.hub.handle({ type: "send", botId: b.id, text: "fix the build", uploads: [] });
  await flush();
  h.q().emit(assistant(text("On it.")));
  await flush();

  later(25_000);
  h.q().emit(assistant(text("Fixed.")));
  await flush();
  expect(h.pushes.map((p) => p.reason)).toEqual(["message"]);
  h.q().emit(result());
  await flush();

  const [onIt, fixed] = b.messages.filter((m) => m.kind === "bot").map((m) => m.id);
  expect(h.pushes).toEqual([
    { botId: b.id, reason: "message", messageId: onIt! },
    { botId: b.id, reason: "result", messageId: fixed! },
  ]);
});

test("a turn ending within 20 s of its push, or on the bubble it pushed, pushes nothing more", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  await h.hub.handle({ type: "send", botId: b.id, text: "status?", uploads: [] });
  await flush();
  h.q().emit(assistant(text("Looking.")));
  await flush();
  later(15_000);
  h.q().emit(assistant(text("All green.")), result());
  await flush();

  await h.hub.handle({ type: "send", botId: b.id, text: "and the deploy?", uploads: [] });
  await flush();
  later(11 * 60_000);
  h.q().emit(assistant(text("Deployed.")));
  await flush();
  later(60_000);
  h.q().emit(result());
  await flush();

  expect(h.pushes.map((p) => p.reason)).toEqual(["message", "message"]);
});

test("a turn whose bubbles were all held back by a live phone pushes its last bubble at the end", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world, { sends: (_, n) => n > 2 });
  await h.hub.handle({ type: "send", botId: b.id, text: "status?", uploads: [] });
  await flush();
  h.q().emit(assistant(text("Looking.")), assistant(text("All green.")));
  await flush();
  expect(h.pushes).toEqual([]);

  h.q().emit(result());
  await flush();

  const green = b.messages.findLast((m) => m.kind === "bot")!;
  expect(h.pushes).toEqual([{ botId: b.id, reason: "message", messageId: green.id }]);
});

test("a long routine run posts its held bubbles at the end with a single push", async () => {
  const h = await fired();
  h.q().emit(assistant(text("Two PRs merged.")));
  await flush();
  later(60_000);
  h.q().emit(assistant(text("Both are green.")), result());
  await flush();

  expect(h.pushes.map((p) => p.reason)).toEqual(["message"]);
});

test("output that arrives between turns still reaches the chat", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  await h.hub.handle({ type: "send", botId: b.id, text: "hi", uploads: [] });
  await flush();
  h.q().emit(assistant(text("Hello.")), result());
  await flush();

  h.q().emit(assistant(text("The background build finished.")));
  await flush();

  expect(bubbles(b)).toEqual(["Hello.", "The background build finished."]);
});

test("Stop on a running turn interrupts it and notes who stopped it", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  await h.hub.handle({ type: "send", botId: b.id, text: "long job", uploads: [] });
  await flush();

  expect(await h.hub.handle({ type: "stop", botId: b.id })).toEqual([]);
  expect(h.q().interrupts).toBe(1);
  h.q().emit(result(0.1, { subtype: "error_during_execution", is_error: true, errors: ["interrupted"] }));
  await flush();

  expect(b.messages.filter((m) => m.kind === "note").map((m) => (m.kind === "note" ? m.text : ""))).toEqual(["Stopped by Alex"]);
  expect(await h.hub.handle({ type: "stop", botId: b.id })).toEqual([{ type: "error", message: "Nothing is running." }]);
});

test("a fresh session's first result is charged in full to the bot's day", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  await h.hub.handle({ type: "send", botId: b.id, text: "hi", uploads: [] });
  await flush();

  h.q().emit(result(0.75));
  await flush();

  const usage = join(h.root, "usage");
  const rows = readdirSync(usage).flatMap((f) => readFileSync(join(usage, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
  expect(rows).toMatchObject([{ actor: `bot:${b.id}`, botId: b.id, initiator: { kind: "user" }, cumulativeUsd: 0.75, deltaUsd: 0.75, fresh: true }]);
});

test("raising a bot's daily cap starts its held routine at once instead of at the next tick", async () => {
  const world = emptyWorld();
  const run = { routineId: "r_digest" as RoutineId, runId: "run_1" as RunId };
  const b = bot("eng", {
    dailyCapUsd: 0,
    session: { ...emptySession(), pending: [{ id: "e1" as EnvelopeId, kind: "envelope", at, text: "[Routine digest fired]", initiator: { kind: "routine", run, manual: false }, settles: run, attempts: 0 }], lifecycle: { kind: "idle" }, notices: [] },
  });
  world.bots.set(b.id, b);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  h.hub.boot(false);
  await flush();
  const status = () => (h.hub.hello(NO_RING) as Extract<ServerMessage, { type: "hello" }>).bots[0]?.status;
  expect(status()).toBe("parked");
  expect(h.queries).toHaveLength(0);

  expect(await h.hub.handle({ type: "update_bot", botId: b.id, patch: { dailyCapUsd: 5 } })).toEqual([]);
  await flush();

  expect(h.q().received).toEqual(["[Routine digest fired]"]);
  expect(status()).toBe("working");
});

test("a routine run's held bubbles go out before a permission card its turn opens, and the run is not quiet", async () => {
  const h = await fired();

  h.q().emit(assistant(text("The release branch is ready.")));
  await flush();
  expect(bubbles(h.bot)).toEqual([]);
  const verdict = await runBash(h.q(), "git push origin main");
  h.q().emit(assistant(toolUse("mcp__claudio__routine_no_update")), result());
  await flush();

  expect(JSON.stringify(verdict)).toContain('"deny"');
  expect(h.bot.messages.filter((m) => m.kind === "bot" || m.kind === "permission").map((m) => m.kind)).toEqual(["bot", "permission"]);
  expect(h.routine.runs.map((r) => r.status)).toEqual(["ok"]);
});

test("Stop during a held routine run drops the queued one and still posts what the running one wrote", async () => {
  const h = await fired({}, 2);
  const [running, queued] = h.bot.routines as RoutineRecord[];
  h.q().emit(assistant(text("Halfway through the digest.")));
  await flush();

  expect(await h.hub.handle({ type: "stop", botId: h.bot.id })).toEqual([]);
  h.q().emit(result(0.1, { subtype: "error_during_execution", is_error: true, errors: ["interrupted"] }));
  await flush();

  expect(bubbles(h.bot)).toEqual(["Halfway through the digest."]);
  expect([running!.runs[0]?.status, queued!.runs[0]?.status]).toEqual(["skipped", "skipped"]);
  expect(h.q().received).toHaveLength(1);
});

test("a held routine run that still finishes quiet after Stop dropped the queued one posts nothing", async () => {
  const h = await fired({}, 2);
  const [running, queued] = h.bot.routines as RoutineRecord[];
  h.q().emit(assistant(text("Nothing changed since the last digest.")));
  await flush();

  await h.hub.handle({ type: "stop", botId: h.bot.id });
  h.q().emit(assistant(toolUse("mcp__claudio__routine_no_update")), result());
  await flush();

  expect(bubbles(h.bot)).toEqual([]);
  expect([running!.runs[0]?.status, queued!.runs[0]?.status]).toEqual(["quiet", "skipped"]);
});

test("three refused calls stop a routine run with the breaker's note alone, after what the run wrote", async () => {
  const h = await fired();
  h.q().emit(assistant(text("Checking the deploy keys.")));
  await flush();

  for (let i = 0; i < 3; i++) await runBash(h.q(), "cat ~/.ssh/id_rsa");
  expect(h.q().interrupts).toBe(1);
  h.q().emit(result(0.1, { subtype: "error_during_execution", is_error: true, errors: ["interrupted"] }));
  await flush();

  expect(h.bot.messages.flatMap((m) => (m.kind === "bot" ? [m.text] : m.kind === "note" ? [`note: ${m.text}`] : []))).toEqual(["Checking the deploy keys.", `note: ${BREAKER_NOTE}`]);
  expect(h.routine.runs.map((r) => [r.status, r.note])).toEqual([["skipped", BREAKER_NOTE]]);
});

test("a hold whose time has passed does not skip a fire in the tick that clears it", async () => {
  const run = { routineId: "r_old" as RoutineId, runId: "run_old" as RunId };
  const lapsed = new Date(Date.now() - 60_000).toISOString();
  const h = await fired({
    session: { ...emptySession(), pending: [{ id: "e1" as EnvelopeId, kind: "envelope", at, text: "[Routine old fired]", initiator: { kind: "routine", run, manual: false }, settles: run, attempts: 0 }], lifecycle: { kind: "parked", reason: "daily_cap", until: lapsed }, notices: [] },
  });

  expect(h.routine.runs.map((r) => r.status)).toEqual(["running"]);
});

test("a protocol 2 app answering Allow once on a held call grants it once for the turn's attendance and tells the bot", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  await h.hub.handle({ type: "send", botId: b.id, text: "push it", uploads: [] });
  await flush();
  await runBash(h.q(), "git push origin main");
  h.q().emit(result());
  await flush();
  const card = b.messages.find((m) => m.kind === "permission")!;

  expect(await h.hub.handle({ type: "answer", botId: b.id, messageId: card.id, option: 0 })).toEqual([]);
  await flush();

  expect(b.messages.find((m) => m.id === card.id)).toMatchObject({ answer: "once" });
  expect(world.gate.grants.map((g) => g.appliesTo)).toEqual(["attended"]);
  expect(h.q().received.at(-1)).toStartWith("[Alex allowed once: Bash `git push origin main`.");
});

test("Allow once's ten minutes start when the continuation's turn starts, not at the tap", async () => {
  setSystemTime(new Date(at));
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  await h.hub.handle({ type: "send", botId: b.id, text: "push it", uploads: [] });
  await flush();
  await runBash(h.q(), "git push origin main");
  const card = b.messages.find((m) => m.kind === "permission")!;

  await h.hub.handle({ type: "decide", botId: b.id, messageId: card.id, choice: "once" });
  const atTap = world.gate.grants.map((g) => g.expiresAt);
  later(5 * 60_000);
  h.q().emit(result());
  await flush();

  expect(h.q().received.at(-1)).toStartWith("[Alex allowed once: Bash `git push origin main`.");
  expect([atTap, world.gate.grants.map((g) => g.expiresAt)]).toEqual([["2026-10-18T12:00:00.000Z"], ["2026-10-17T12:15:00.000Z"]]);
});

test("a routine run the daily cap cuts short is skipped and says why, not failed", async () => {
  const h = await fired();
  h.q().emit(assistant(text("Half way.")), result(0.5, { subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.5)"] }));
  await flush();

  expect(h.routine.runs.map((r) => [r.status, r.note])).toEqual([["skipped", "Stopped at the daily cap"]]);
  expect(h.routine.failStreak).toBe(0);
  expect(h.bot.messages.filter((m) => m.kind === "note").map((m) => m.kind === "note" && m.text)).toEqual([
    "eng used today's budget; routines and other background work wait until tomorrow.",
  ]);
});

test("the stall note names the bot", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  await h.hub.handle({ type: "send", botId: b.id, text: "think hard", uploads: [] });
  await flush();
  later(31 * 60_000);
  h.hub.tick(new Date());

  expect(b.messages.filter((m) => m.kind === "note").map((m) => m.kind === "note" && m.text)).toEqual(["eng has been silent for 30 minutes; you can press Stop."]);
});

test("at the daily cap a scheduled fire is skipped, and Run now from the phone still runs", async () => {
  const h = await fired({ dailyCapUsd: 0 });
  expect(h.routine.runs.map((r) => [r.status, r.note])).toEqual([["skipped", "Paused by a limit"]]);
  expect(h.queries).toHaveLength(0);

  expect(await h.hub.handle({ type: "run_routine", botId: h.bot.id, routineId: h.routine.id })).toEqual([]);
  await flush();

  expect(h.routine.runs.map((r) => [r.status, r.manual])).toEqual([["running", true], ["skipped", false]]);
  expect(h.q().received[0]).toStartWith("[Routine digest fired]");
});

test("delete_bot saves the world without the bot before its home is moved to the trash", async () => {
  const world = emptyWorld();
  const doomed = bot("doomed");
  world.bots.set(doomed.id, doomed);
  const { hub, homes, events, frames } = hubOver(world);
  homes.create(doomed.id, "# doomed\n");

  expect(await hub.handle({ type: "delete_bot", botId: doomed.id })).toEqual([]);

  expect(events).toEqual(["persist now with no bots", "trash b_doomed"]);
  expect(existsSync(homes.homeOf(doomed.id))).toBe(false);
  expect(frames.at(-1)).toEqual({ type: "bot_removed", botId: doomed.id });
});

test("an answer to a permission card from a protocol 2 app is a decision; an option it never showed is refused", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  const card: Message = { kind: "permission", id: "m_card" as MessageId, at, from: null, tool: "Bash", label: "Push to the default branch", detail: "git push origin main", always: "git push to main", answer: null, expiresAt: inAnHour() };
  b.messages.push(card);
  world.bots.set(b.id, b);
  const h = hubOver(world);

  expect(await h.hub.handle({ type: "answer", botId: b.id, messageId: card.id, option: 2 })).toEqual([{ type: "error", message: "Unknown option" }]);
});

const notes = (n: number): Message[] => Array.from({ length: n }, (_, i) => ({ kind: "note", id: `m_${i}` as MessageId, at, text: `note ${i}`, refs: [] }));
const archived = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);

test("a bot keeps its newest 1000 messages and any open card; older ones go to its archive, and open sends what is kept", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  const history = notes(1100);
  history[3] = { kind: "question", id: "m_card" as MessageId, at, question: "Ship it?", options: ["Yes", "No"], answer: null, expiresAt: inAnHour() };
  b.messages.push(...history);
  (world.gate as GateState).open.push({ kind: "question", cardId: "m_card" as MessageId, actor: { kind: "bot", botId: b.id }, remindAt: null, expiresAt: inAnHour() });
  world.bots.set(b.id, b);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");

  await h.hub.handle({ type: "send", botId: b.id, text: "hi", uploads: [] });
  const [conversation] = await h.hub.handle({ type: "open", botId: b.id });

  const file = join(h.homes.homeOf(b.id), ".history", "bot.jsonl");
  const sent = conversation?.type === "conversation" ? conversation.messages : [];
  expect(sent).toHaveLength(1001);
  expect(sent[0]?.id).toBe("m_card" as MessageId);
  expect(sent.slice(1, 3).map((m) => m.id)).toEqual(["m_101", "m_102"] as MessageId[]);
  expect(sent.at(-1)).toMatchObject({ kind: "user", text: "hi" });
  expect(archived(file)).toEqual(history.slice(0, 101).filter((m) => m.id !== "m_card").map((m) => m.id));
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("an agent thread keeps its newest 1000 messages; older ones go to its own archive in its bot's home", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const cwd = mkdtempSync(join(tmpdir(), "claudiobot-agent-"));
  roots.push(cwd);
  const thread = Array.from({ length: 1100 }, (_, i) => ({ id: `m_${i}` as MessageId, at, from: "agent" as const, text: `step ${i}` }));
  const rec: AgentRecord = {
    agent: { id: "a_1" as AgentId, botId: b.id, title: "Fix login", where: "mac", projectName: "app", status: "working", url: null, createdAt: at, updatedAt: at },
    cwd,
    messages: [...thread],
    session: emptySession(),
    cloudSession: null,
    budgetUsd: null,
    startedBy: { kind: "user" },
  };
  world.agents.set(rec.agent.id, rec);
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");

  h.hub.boot(false);
  const [reply] = await h.hub.handle({ type: "agent", agentId: rec.agent.id });

  const kept = reply?.type === "agent" ? reply.messages : [];
  expect(kept).toHaveLength(1000);
  expect(kept[0]?.id).toBe("m_101" as MessageId);
  expect(kept.at(-1)?.text).toContain("bridge restarted");
  expect(archived(join(h.homes.homeOf(b.id), ".history", "a_1.jsonl"))).toEqual(thread.slice(0, 101).map((m) => m.id));
});

test("a routine run's held report and its settled run are saved before its turn end returns", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const routine = dueRoutine(b);
  const saves: { bubbles: number; run: string | undefined }[] = [];
  const h = hubOver(world, { persist: (urgency) => urgency === "now" && saves.push({ bubbles: bubbles(b).length, run: routine.runs[0]?.status }) });
  h.homes.create(b.id, "# eng\n");
  h.hub.tick(new Date());
  await flush();

  h.q().emit(assistant(text("Two PRs merged.")), result());
  await flush();

  expect(saves.at(-1)).toEqual({ bubbles: 1, run: "ok" });
});

test("start_agent on a bot deleted while the projects were being scanned starts nothing", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const cwd = mkdtempSync(join(tmpdir(), "claudiobot-project-"));
  roots.push(cwd);
  let scanned: (projects: Project[]) => void = () => {};
  const h = hubOver(world, { scan: () => new Promise((resolve) => (scanned = resolve)) });
  h.homes.create(b.id, "# eng\n");
  await h.hub.handle({ type: "send", botId: b.id, text: "fix the app", uploads: [] });
  await flush();

  const reply = callTool(h.q(), "start_agent", { title: "Fix login", prompt: "Fix it.", project: "app", where: "mac" });
  await Bun.sleep(20);
  await h.hub.handle({ type: "delete_bot", botId: b.id });
  scanned([{ name: "app", path: cwd, branch: "main", githubRepo: null }]);

  expect(await reply).toMatchObject({ isError: true, content: [{ type: "text", text: "This bot no longer exists." }] });
  expect([...world.agents.keys()]).toEqual([]);
});

test("a permission card an agent opens shows its bot as awaiting approval in the next bot frame", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const cwd = mkdtempSync(join(tmpdir(), "claudiobot-agent-"));
  roots.push(cwd);
  world.agents.set("a_1" as AgentId, {
    agent: { id: "a_1" as AgentId, botId: b.id, title: "Ship it", where: "mac", projectName: "app", status: "working", url: null, createdAt: at, updatedAt: at },
    cwd,
    messages: [],
    session: { ...emptySession(), pending: [{ id: "e1" as EnvelopeId, kind: "envelope", at, text: "Push the fix.", initiator: { kind: "user" }, settles: null, attempts: 0 }] },
    cloudSession: null,
    budgetUsd: null,
    startedBy: { kind: "user" },
  });
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  h.hub.boot(false);
  await flush();

  await runBash(h.q(), "git push origin main");

  const frame = h.frames.findLast((f) => f.type === "bot" && f.bot.id === b.id);
  expect(frame?.type === "bot" && frame.bot.status).toBe("awaiting_approval");
});

test("a bot's commands run sandboxed to its home and USER.md, and a mac agent's to its project, pushing over https", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-agent-")));
  roots.push(cwd);
  world.agents.set("a_1" as AgentId, {
    agent: { id: "a_1" as AgentId, botId: b.id, title: "Ship it", where: "mac", projectName: "app", status: "working", url: null, createdAt: at, updatedAt: at },
    cwd,
    messages: [],
    session: { ...emptySession(), pending: [{ id: "e1" as EnvelopeId, kind: "envelope", at, text: "Push the fix.", initiator: { kind: "user" }, settles: null, attempts: 0 }] },
    cloudSession: null,
    budgetUsd: null,
    startedBy: { kind: "user" },
  });
  const h = hubOver(world);
  h.homes.create(b.id, "# eng\n");
  h.hub.boot(false);
  await flush();
  const agentOptions = h.q().options;
  await h.hub.handle({ type: "send", botId: b.id, text: "hi", uploads: [] });
  await flush();
  const botOptions = h.q().options;
  const home = realpathSync(h.root);

  expect([botOptions.sandbox?.enabled, botOptions.sandbox?.allowUnsandboxedCommands, botOptions.sandbox?.filesystem?.allowWrite]).toEqual([
    true,
    false,
    [join(home, "bots", b.id), join(home, "USER.md")],
  ]);
  expect(botOptions.sandbox?.filesystem?.denyRead?.[0]).toBe(home);
  expect([agentOptions.sandbox?.filesystem?.allowWrite?.[0], agentOptions.env?.GIT_CONFIG_VALUE_1, botOptions.env]).toEqual([cwd, "ssh://git@github.com/", undefined]);
});

test("an agent in a repo with committed Claude settings runs on an empty config until the user trusts the repo", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-repo-")));
  roots.push(repo);
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.json"), "{}");
  const h = hubOver(world, { scan: async () => [{ name: "app", path: repo, branch: "main", githubRepo: null }] });
  h.homes.create(b.id, "# eng\n");
  await h.hub.handle({ type: "send", botId: b.id, text: "fix the app", uploads: [] });
  await flush();
  await callTool(h.q(), "start_agent", { title: "Fix login", prompt: "Fix it.", project: "app", where: "mac" });
  await flush();
  const agentQuery = h.q();
  const empty = agentQuery.options.projectConfigRoot!;
  const card = b.messages.find((m): m is Extract<Message, { kind: "permission" }> => m.kind === "permission")!;
  const status = () => (h.hub.hello(NO_RING) as Extract<ServerMessage, { type: "hello" }>).bots[0]?.status;

  expect([card.label, card.detail, readdirSync(empty), (statSync(empty).mode & 0o777).toString(8)]).toEqual(["Trust app's Claude settings", `.claude/settings.json in ${repo}`, [], "700"]);
  expect(empty.startsWith(join(h.root, "agent-config"))).toBe(true);
  agentQuery.emit(result());
  await flush();
  h.queries[0]!.emit(result());
  await flush();
  // The agent's report is unattended work, so it runs on a query of its own.
  h.q().emit(result());
  await flush();
  expect([h.queries.length, status()]).toEqual([3, "awaiting_approval"]);

  expect(await h.hub.handle({ type: "decide", botId: b.id, messageId: card.id, choice: "always" })).toEqual([]);
  const rec = [...world.agents.values()][0]!;
  await callTool(h.queries[2]!, "message_agent", { agentId: rec.agent.id, text: "Also add a test." });
  await flush();

  expect([h.q() === agentQuery, h.q().options.cwd, h.q().options.projectConfigRoot, status()]).toEqual([false, repo, undefined, "idle"]);
});

test("one ticker throwing is logged, and the tickers after it still run", () => {
  const ticked: string[] = [];
  const logs: string[] = [];
  const now = new Date(at);

  tickEach(
    {
      scheduler: { tick: () => { throw new Error("bad routine"); }, nextDeadline: () => null },
      gate: { tick: (t) => ticked.push(`gate ${t.toISOString()}`), nextDeadline: () => null },
    },
    now,
    (line) => logs.push(line),
  );

  expect(ticked).toEqual([`gate ${at}`]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("scheduler");
  expect(logs[0]).toContain("bad routine");
});
