import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHomes } from "../src/home";
import { createHub, tickEach } from "../src/hub";
import type { AgentId, BotId, Message, MessageId, RoutineId, RunId, ServerMessage, StreamPosition } from "../src/protocol";
import type { PushReason } from "../src/push";
import { emptySession, emptyWorld, newBot, type BotRecord, type EnvelopeId, type Fingerprint, type RoutineRecord, type Signature, type World } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function hubOver(world: World, opts: { persist?: (urgency?: "now") => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-hub-"));
  roots.push(root);
  const homes = createHomes(root);
  const events: string[] = [];
  const frames: ServerMessage[] = [];
  const pushes: { botId: BotId; reason: PushReason; messageId: MessageId }[] = [];
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
    scan: async () => [],
    broadcast: (m) => frames.push(m),
    persist: (urgency) => {
      opts.persist?.(urgency);
      events.push(`persist ${urgency ?? "later"} with ${[...world.bots.keys()].join(",") || "no bots"}`);
    },
    log: () => {},
    push: { notify: (bot, reason, messageId) => pushes.push({ botId: bot.id, reason, messageId }) },
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt, options);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
  });
  return { hub, homes, root, events, frames, pushes, queries, q: () => queries.at(-1)! };
}

/** The bridge's real gate, called the way Claude Code calls the PreToolUse hook the session was given. */
function runBash(q: FakeQuery, command: string) {
  const id = `toolu_${++uuid}`;
  const input = { hook_event_name: "PreToolUse", session_id: "s_1", transcript_path: "/tmp/t.jsonl", cwd: q.options.cwd!, tool_name: "Bash", tool_input: { command, description: "run" }, tool_use_id: id };
  return q.options.hooks!.PreToolUse![0]!.hooks[0]!(input as never, id, { signal: new AbortController().signal });
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
      pending: [{ id: "e1" as EnvelopeId, at, text: "[Routine digest fired]", initiator: { kind: "routine", run: { routineId: "r1" as RoutineId, runId: "run1" as RunId }, manual: false }, settles: null, attempts: 0 }],
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
    session: { ...emptySession(), pending: [{ id: "e1" as EnvelopeId, at, text: "[Routine digest fired]", initiator: { kind: "routine", run, manual: false }, settles: run, attempts: 0 }], lifecycle: { kind: "idle" }, notices: [] },
  });
  world.bots.set(b.id, b);
  const h = hubOver(world);
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

test("a hold whose time has passed does not skip a fire in the tick that clears it", async () => {
  const run = { routineId: "r_old" as RoutineId, runId: "run_old" as RunId };
  const lapsed = new Date(Date.now() - 60_000).toISOString();
  const h = await fired({
    session: { ...emptySession(), pending: [{ id: "e1" as EnvelopeId, at, text: "[Routine old fired]", initiator: { kind: "routine", run, manual: false }, settles: run, attempts: 0 }], lifecycle: { kind: "parked", reason: "daily_cap", until: lapsed }, notices: [] },
  });

  expect(h.routine.runs.map((r) => r.status)).toEqual(["running"]);
});

test("today's app answering Allow once on a held call grants it once for the turn's attendance and tells the bot", async () => {
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

test("an answer to a permission card from today's app is a decision; an option it never showed is refused", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  const card: Message = { kind: "permission", id: "m_card" as MessageId, at, from: null, tool: "Bash", label: "Push to the default branch", detail: "git push origin main", always: "git push to main", answer: null, expiresAt: inAnHour() };
  b.messages.push(card);
  world.bots.set(b.id, b);
  const h = hubOver(world);

  expect(await h.hub.handle({ type: "answer", botId: b.id, messageId: card.id, option: 2 })).toEqual([{ type: "error", message: "Unknown option" }]);
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
