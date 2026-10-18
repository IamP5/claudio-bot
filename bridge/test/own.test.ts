import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, HookCallback, Options, PermissionResult, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeApps, DesktopEntry, Live } from "../src/claudeApps";
import { OWN_CARD_TTL_MS } from "../src/own";
import type { AgentId, BotId, MessageId, ServerMessage, SessionId, SessionItem, SessionRow, ThreadChannelFrame } from "../src/protocol";
import { GONE_ERROR } from "../src/session";
import { createSessions, type Sessions } from "../src/sessions";
import { emptySession, emptyWorld, type AgentRecord, type World } from "../src/world";
import { FakeQuery, result } from "./hub-kit";
import { player, replay } from "./transcript";

// The phone driving Claude Code sessions: through the Sessions facade, over a fake Claude Code whose canUseTool and
// PreToolUse hook the tests call the way Claude Code does, with transcripts recorded by scripts/record-transcript.ts.

const FIXTURES = join(import.meta.dir, "transcripts", "jsonl");
const ASK = "22222222-2222-4222-8222-222222222222" as SessionId;

let base: string;
let previous: string | undefined;
let repo: string;
let folder: string;
let world: World;
let sessions: Sessions;
let thread: { id: SessionId; frame: ThreadChannelFrame }[];
let holders: Map<SessionId, Live>;
let queries: FakeQuery[];
let directs: { agentId: string; text: string; clientId: string }[];
let gateDecisions: { botId: string; cardId: string; choice: string }[];
let clock: number;

const apps = (): ClaudeApps => ({
  holders: () => holders,
  desktop: () => new Map<SessionId, DesktopEntry>(),
  desktopState: async () => "absent",
  idleSeconds: async () => null,
  importToDesktop: async () => false,
  openInDesktop: async () => false,
  refresh() {},
  onChange() {},
  close() {},
});

const fileOf = (id: SessionId) => join(folder, `${id}.jsonl`);
const install = (name: string, id: SessionId) => writeFileSync(fileOf(id), readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").replaceAll("<cwd>", repo));
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function start(over: Partial<Parameters<typeof createSessions>[0]> = {}) {
  sessions = createSessions({
    epoch: "e1",
    projectsDir: join(base, "projects"),
    apps: apps(),
    cacheDir: join(base, "cache"),
    signal: { list() {}, thread: (id, frame) => thread.push({ id, frame: structuredClone(frame) }) },
    watchers: () => 1,
    coalesceMs: 0,
    watch: false,
    world,
    userName: "Alex",
    bridgeHome: join(base, "home"),
    agents: {
      session: () => null,
      direct: (rec, text, clientId) => (directs.push({ agentId: rec.agent.id, text, clientId }), null),
      stop: async () => true,
      message: async () => "",
    },
    decideGate: (botId, cardId, choice) => (gateDecisions.push({ botId, cardId, choice }), { ok: true }),
    ledger: { add() {}, headroom: () => ({ ok: true, capReached: false }), budgetLeft: () => null, dailyLeft: () => null },
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt, options);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
    scope: (cwd) => ({ bridgeHome: join(base, "home"), own: cwd, userMd: null, homedir: base }),
    scan: async () => [],
    persist: () => {},
    now: () => new Date(clock),
    log: () => {},
    ...over,
  });
  sessions.resume();
  return sessions.start();
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "own-")));
  previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = base;
  repo = join(base, "demo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  folder = join(base, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  install("own-ask", ASK);
  world = emptyWorld();
  thread = [];
  holders = new Map();
  queries = [];
  directs = [];
  gateDecisions = [];
  clock = Date.parse("2026-10-18T12:00:00.000Z");
});
afterEach(() => {
  sessions?.stop();
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(base, { recursive: true, force: true });
});

const handle = async (m: Parameters<Sessions["handle"]>[0]) => structuredClone(await sessions.handle(m));
const rows = async () => ((await handle({ type: "watch_sessions" }))[0] as Extract<ServerMessage, { type: "sessions" }>).rows;
const rowOf = async (id: SessionId) => (await rows()).find((r) => r.id === id) as SessionRow;
const snapshot = async (id: SessionId) => (await handle({ type: "watch_session", sessionId: id, after: null }))[0] as Extract<ServerMessage, { type: "session" }>;
const send = async (text: string, clientId = `c_${text}`, id = ASK) => {
  const r = await handle({ type: "session_send", sessionId: id, text, clientId, interrupt: false });
  await flush();
  return r;
};
const ask = (q: FakeQuery) => q.options.canUseTool as CanUseTool;
const call = (q: FakeQuery, tool: string, input: Record<string, unknown>, over: Partial<Parameters<CanUseTool>[2]> = {}) =>
  ask(q)(tool, input, { signal: new AbortController().signal, toolUseID: `toolu_${tool}_${Math.random().toString(36).slice(2, 8)}`, ...over } as Parameters<CanUseTool>[2]);
const openCard = async (kind: SessionItem["kind"], id?: string) => (await snapshot(ASK)).items.findLast((i) => i.kind === kind && (id === undefined || i.id === id))!;

describe("taking on a session from the phone", () => {
  test("the first send opens Claude Code on the transcript, in its cwd, with the user's own settings and its last mode", async () => {
    await start();
    expect(await send("Also add a test")).toEqual([]);
    const o = queries[0]!.options;
    expect([o.cwd, o.resume, o.sessionId, o.settingSources, o.permissionMode, o.model, o.sandbox]).toEqual([repo, ASK, undefined, ["user", "project", "local"], "default", "claude-haiku-5-5", undefined]);
    expect(queries[0]!.received).toEqual(["Also add a test"]);
    expect(world.sessions.get(ASK)?.own).toMatchObject({ cwd: repo, created: false });
    expect(await rowOf(ASK)).toMatchObject({ status: "working", holder: "claudio", origin: "sdk" });
  });

  test("a queued message shows in the thread until the transcript has it, under the id the phone gave it", async () => {
    await start();
    await send("First");
    await send("Second", "c_2");
    const items = (await snapshot(ASK)).items.filter((i) => i.kind === "user").slice(-2);
    expect(items).toMatchObject([
      { id: "c_First", text: "First", queued: false },
      { id: "c_2", text: "Second", queued: true },
    ]);
    expect((await snapshot(ASK)).controls).toMatchObject({ queued: 1, working: true });
    const lines = readFileSync(fileOf(ASK), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const leaf = lines.findLast((l) => typeof l.uuid === "string" && l.type !== "queue-operation")!;
    appendFileSync(fileOf(ASK), `${JSON.stringify({ parentUuid: leaf.uuid, isSidechain: false, type: "user", message: { role: "user", content: "First" }, uuid: crypto.randomUUID(), timestamp: new Date(clock).toISOString(), cwd: repo, sessionId: ASK })}\n`);
    await sessions.sync();
    const frame = thread.findLast((t) => t.frame.type === "session_items")!.frame as Extract<ThreadChannelFrame, { type: "session_items" }>;
    expect(frame.removed).toEqual(["c_First" as never]);
  });

  test("while the Claude app is busy on it the phone may not send, and a queued turn waits rather than runs beside it", async () => {
    await start();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "claude-desktop", kind: "interactive", cwd: repo, busy: true });
    expect((await snapshot(ASK)).controls).toMatchObject({ canSend: false, reason: "Working in the Claude app." });
    await send("Later");
    expect(queries).toHaveLength(0);
    expect(await rowOf(ASK)).toMatchObject({ status: "parked", holder: "desktop" });
  });

  test("a transcript Claude Code no longer has fails the turn with a notice; nothing starts in its place", async () => {
    await start();
    await send("Hello?");
    queries[0]!.emit(result(0, { subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${ASK}`], session_id: ASK }));
    await flush();
    await flush();
    expect(queries).toHaveLength(1);
    expect((await snapshot(ASK)).items.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: GONE_ERROR });
    expect((await rowOf(ASK)).status).toBe("failed");
  });

  test("model and mode change the live query at once and stick for the next one", async () => {
    await start();
    await send("Go");
    expect(await handle({ type: "session_set", sessionId: ASK, patch: { model: "opus", mode: "acceptEdits" } })).toEqual([]);
    expect(queries[0]!.controls).toEqual(["model opus", "mode acceptEdits"]);
    expect((await snapshot(ASK)).controls).toMatchObject({ model: "opus", mode: "acceptEdits" });
    expect(world.sessions.get(ASK)?.own).toMatchObject({ model: "opus", mode: "acceptEdits" });
  });
});

describe("what Claude Code asks", () => {
  test("a permission waits as a card; Always allows it with the suggestions scoped to the session", async () => {
    await start();
    await send("Clean the build");
    const suggestions = [{ type: "addRules" as const, rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow" as const, destination: "localSettings" as const }];
    const answer = call(queries[0]!, "Bash", { command: "rm -rf build" }, { suggestions, title: "Claude wants to run rm -rf build" });
    await flush();
    const item = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    expect(item.card).toMatchObject({ tool: "Bash", label: "Claude wants to run rm -rf build", detail: "rm -rf build", answer: null, from: null });
    expect((await rowOf(ASK)).status).toBe("awaiting_approval");
    expect(await handle({ type: "session_decide", sessionId: ASK, cardId: item.card.id, choice: "always" })).toEqual([]);
    expect(await answer).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" }, updatedPermissions: [{ ...suggestions[0]!, destination: "session" }] });
    expect(await handle({ type: "session_decide", sessionId: ASK, cardId: item.card.id, choice: "once" })).toEqual([{ type: "error", message: "That card was already answered" }]);
    expect(((await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>).card.answer).toBe("always");
  });

  test("Never denies and stops the turn; a card left two hours is denied as expired", async () => {
    await start();
    await send("Push it");
    const never = call(queries[0]!, "Bash", { command: "git push --force" });
    await flush();
    const first = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    await handle({ type: "session_decide", sessionId: ASK, cardId: first.card.id, choice: "never" });
    expect(await never).toMatchObject({ behavior: "deny", interrupt: true });
    const late = call(queries[0]!, "Bash", { command: "make deploy" });
    await flush();
    clock += OWN_CARD_TTL_MS + 1;
    sessions.tick(new Date(clock));
    expect(await late).toMatchObject({ behavior: "deny", message: expect.stringContaining("expired") });
  });

  test("AskUserQuestion is answered from the phone with updatedInput, as the recording shows Claude Code expects", async () => {
    const recorded = replay("own-ask").prompts.find((p) => p.tool === "AskUserQuestion")!;
    await start();
    await send("Pick for me");
    const answer = call(queries[0]!, "AskUserQuestion", recorded.input, { toolUseID: "toolu_ask1" });
    await flush();
    const item = (await openCard("ask", "toolu_ask1")) as Extract<SessionItem, { kind: "ask" }>;
    expect(item).toMatchObject({ id: "toolu_ask1", answers: null, questions: [{ question: "Pick a color", header: "Color" }] });
    expect((await rowOf(ASK)).status).toBe("awaiting_input");
    const answers = (recorded.reply as Extract<PermissionResult, { behavior: "allow" }>).updatedInput!.answers as Record<string, string>;
    expect(await handle({ type: "session_answer", sessionId: ASK, cardId: item.cardId!, answers })).toEqual([]);
    expect(await answer).toEqual(recorded.reply);
    expect(await openCard("ask", "toolu_ask1")).toMatchObject({ answers, cardId: null });
  });

  test("a dismissed question is a denial that says so", async () => {
    await start();
    await send("Ask me");
    const answer = call(queries[0]!, "AskUserQuestion", { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "" }], multiSelect: false }] }, { toolUseID: "toolu_ask2" });
    await flush();
    const item = (await openCard("ask", "toolu_ask2")) as Extract<SessionItem, { kind: "ask" }>;
    await handle({ type: "session_answer", sessionId: ASK, cardId: item.cardId!, answers: null });
    expect(await answer).toEqual({ behavior: "deny", message: "Alex dismissed the question without answering." });
  });

  test("an approved plan allows ExitPlanMode and puts the mode back; a rejected one keeps planning", async () => {
    const recorded = replay("own-plan").prompts.find((p) => p.tool === "ExitPlanMode")!;
    await start();
    await send("Plan it");
    await handle({ type: "session_set", sessionId: ASK, patch: { mode: "plan" } });
    const approve = call(queries[0]!, "ExitPlanMode", recorded.input, { toolUseID: "toolu_plan1" });
    await flush();
    const plan = (await openCard("plan")) as Extract<SessionItem, { kind: "plan" }>;
    expect(plan).toMatchObject({ id: "toolu_plan1", state: "proposed", text: expect.stringContaining("hello.txt") });
    await handle({ type: "session_decide", sessionId: ASK, cardId: plan.cardId!, choice: "once" });
    expect(await approve).toEqual(recorded.reply);
    expect(queries[0]!.controls.at(-1)).toBe("mode default");
    expect(world.sessions.get(ASK)?.own?.mode).toBe("default");

    const reject = call(queries[0]!, "ExitPlanMode", { plan: "Second try" }, { toolUseID: "toolu_plan2" });
    await flush();
    const again = (await snapshot(ASK)).items.find((i) => i.id === ("toolu_plan2" as never)) as Extract<SessionItem, { kind: "plan" }>;
    await handle({ type: "session_decide", sessionId: ASK, cardId: again.cardId!, choice: "deny" });
    expect(await reject).toMatchObject({ behavior: "deny", message: expect.stringContaining("keep planning") });
  });

  test("the recorded Write and Edit were allowed once, as the phone's Allow once answers", async () => {
    const recorded = replay("own-permission").prompts;
    await start();
    await send("Edit it");
    for (const p of recorded) {
      const answer = call(queries[0]!, p.tool, p.input);
      await flush();
      const card = ((await snapshot(ASK)).items.findLast((i) => i.kind === "permission") as Extract<SessionItem, { kind: "permission" }>).card;
      await handle({ type: "session_decide", sessionId: ASK, cardId: card.id, choice: "once" });
      expect(await answer).toEqual(p.reply);
    }
  });

  test("the floors deny what the phone must never reach; everything else is Claude Code's own call", async () => {
    await start();
    await send("Look around");
    const hook = queries[0]!.options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    const pre = (tool: string, tool_input: object) =>
      hook({ hook_event_name: "PreToolUse", session_id: ASK, transcript_path: "", cwd: repo, tool_name: tool, tool_input, tool_use_id: "toolu_f" } as never, "toolu_f", { signal: new AbortController().signal });
    expect(await pre("Read", { file_path: join(base, ".ssh", "id_ed25519") })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await pre("Read", { file_path: join(base, "home", "state.json") })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await pre("Bash", { command: "rm -rf build" })).toEqual({});
    expect(await pre("Edit", { file_path: join(repo, "a.ts"), old_string: "a", new_string: "b" })).toEqual({});
  });

  test("a card open when the bridge stopped is expired at the next start, with a notice", async () => {
    await start();
    await send("Go");
    void call(queries[0]!, "Bash", { command: "make" });
    await flush();
    sessions.stop();
    await start();
    const items = (await snapshot(ASK)).items;
    expect((items.find((i) => i.kind === "permission") as Extract<SessionItem, { kind: "permission" }>).card.answer).toBe("expired");
    expect(items.at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("expired") });
  });
});

describe("a session the phone starts", () => {
  test("it is created under a chosen id, lists at once under its project from the phone, and opens without a title", async () => {
    await start({ scan: async () => [{ name: "demo", path: repo, branch: "main", githubRepo: null }] });
    const project = ((await handle({ type: "watch_sessions" }))[0] as Extract<ServerMessage, { type: "sessions" }>).projects.find((p) => p.path === repo)!;
    const [created] = await handle({ type: "session_create", ref: "r1", projectId: project.id, text: "Add a mute button", model: null, mode: "acceptEdits", isolate: "none" });
    const id = (created as Extract<ServerMessage, { type: "session_created" }>).sessionId;
    expect(created).toEqual({ type: "session_created", ref: "r1", sessionId: id });
    await flush();
    expect(await rowOf(id)).toMatchObject({ projectId: project.id, origin: "phone", title: "Add a mute button", status: "working" });
    const o = queries[0]!.options;
    expect([o.sessionId, o.resume, o.title, o.permissionMode, o.cwd]).toEqual([id, undefined, undefined, "acceptEdits", repo]);
    expect((await snapshot(id)).items).toMatchObject([{ kind: "user", id: "r1", text: "Add a mute button", queued: false }]);
  });
});

describe("an agent's session", () => {
  const agent = (id: SessionId): AgentRecord => {
    const rec: AgentRecord = {
      agent: { id: "a_1" as AgentId, botId: "b_1" as BotId, title: "Pick a color", where: "mac", projectName: "demo", status: "waiting", url: null, createdAt: "2026-10-18T12:00:00.000Z", updatedAt: "2026-10-18T12:00:00.000Z", evidence: null, worktree: null },
      cwd: repo,
      repo,
      messages: [],
      session: emptySession(id),
      cloudSession: null,
      budgetUsd: null,
      startedBy: { kind: "user" },
    };
    world.agents.set(rec.agent.id, rec);
    return rec;
  };

  test("the user's message goes to the agent's own inbox, not a second writer, and its gate cards are decided by the gate", async () => {
    agent(ASK);
    await start();
    expect(await send("Use blue", "c_blue")).toEqual([]);
    expect(directs).toEqual([{ agentId: "a_1", text: "Use blue", clientId: "c_blue" }]);
    expect(queries).toHaveLength(0);
    expect(await handle({ type: "session_decide", sessionId: ASK, cardId: "m_card" as MessageId, choice: "once" })).toEqual([]);
    expect(gateDecisions).toEqual([{ botId: "b_1", cardId: "m_card", choice: "once" }]);
    expect(await handle({ type: "session_set", sessionId: ASK, patch: { mode: "plan" } })).toEqual([{ type: "error", message: expect.stringContaining("bot") }]);
  });

  test("a phone drive left on an id an agent now owns is dropped at start", async () => {
    agent(ASK);
    world.sessions.set(ASK, { id: ASK, hidden: false, visitedAt: null, own: { cwd: repo, created: false, at: "2026-10-18T12:00:00.000Z", model: null, mode: null, session: emptySession(ASK), cards: [] } });
    await start();
    expect(world.sessions.get(ASK)?.own).toBeUndefined();
  });
});

describe("streaming", () => {
  test("a recorded turn's text streams under the id its transcript item gets, so the upsert replaces the live text", async () => {
    const recording = replay("own-permission");
    const PERMISSION = "11111111-1111-4111-8111-111111111111" as SessionId;
    install("own-permission", PERMISSION);
    // The transcript as Claude Code had flushed it while the last text block streamed: everything before that block.
    const lines = readFileSync(fileOf(PERMISSION), "utf8").trim().split("\n");
    const last = lines.findLastIndex((l) => l.includes('"type":"assistant"') && l.includes('"type":"text"'));
    writeFileSync(fileOf(PERMISSION), `${lines.slice(0, last).join("\n")}\n`);
    const play = player(recording);
    await start({ claude: { query: play.query, executable: () => "/fake/claude" } });
    await handle({ type: "watch_session", sessionId: PERMISSION, after: null });
    const text = recording.outbound[0]!.message.content as string;
    await handle({ type: "session_send", sessionId: PERMISSION, text, clientId: "c_rec", interrupt: false });
    await Bun.sleep(150);
    const deltas = thread.filter((t) => t.frame.type === "session_delta").map((t) => t.frame as Extract<ThreadChannelFrame, { type: "session_delta" }>);
    expect(deltas.map((d) => [d.offset, d.text])).toEqual([[0, "DONE"]]);
    expect(((await snapshot(PERMISSION)).live)).toEqual({ itemId: deltas[0]!.itemId, text: "DONE" });

    appendFileSync(fileOf(PERMISSION), `${lines.slice(last).join("\n")}\n`);
    await sessions.sync();
    const upsert = thread.findLast((t) => t.frame.type === "session_items")!.frame as Extract<ThreadChannelFrame, { type: "session_items" }>;
    expect(upsert.items.find((i) => i.id === deltas[0]!.itemId)).toMatchObject({ kind: "assistant", text: "DONE" });
    expect((await snapshot(PERMISSION)).live).toBeNull();
    expect(queries).toHaveLength(0);
    expect(play.q()!.options.includePartialMessages).toBe(true);
  });
});
