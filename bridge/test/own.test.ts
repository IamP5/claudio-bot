import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, HookCallback, Options, PermissionResult, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeApps, DesktopEntry, Live } from "../src/claudeApps";
import { alwaysText, END_SETTLE_MS, OWN_CARD_TTL_MS } from "../src/own";
import type { TaskRun } from "../src/procs";
import type { AgentId, BotId, MessageId, ServerMessage, SessionId, SessionItem, SessionRow, TaskId, ThreadChannelFrame } from "../src/protocol";
import { EXIT_SETTLE_MS, GONE_ERROR, GONE_LOOK_MAX_MS } from "../src/session";
import { createSessions, type Sessions } from "../src/sessions";
import { emptySession, emptyWorld, type AgentRecord, type World } from "../src/world";
import { FakeQuery, result } from "./hub-kit";
import { alive, backgroundCommand } from "./shells";
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
/** The process group of each background command Claude Code runs, as the Mac's process table shows it. */
let shells: () => Promise<Map<string, number>>;
/** Claude Code's group-leading shells with their command lines, as ps shows them. */
let leaders: () => Promise<{ group: number; command: string }[]>;
/** Whether a saved group still runs its command; undefined: the process table says. */
let taskRunOf: ((group: number, id: string) => Promise<TaskRun>) | undefined;
let appChanged: (() => void)[] = [];

const apps = (): ClaudeApps => ({
  holders: () => holders,
  desktop: () => new Map<SessionId, DesktopEntry>(),
  desktopState: async () => "absent",
  idleSeconds: async () => null,
  importToDesktop: async () => false,
  openInDesktop: async () => false,
  refresh() {},
  onChange: (f) => void appChanged.push(f),
  close() {},
});

const fileOf = (id: SessionId) => join(folder, `${id}.jsonl`);
/** The recording's history is moved to the hour before the tests' clock, so what a test adds comes after it, as live. */
const install = (name: string, id: SessionId) =>
  writeFileSync(fileOf(id), readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").replaceAll("<cwd>", repo).replaceAll('"2026-10-18T19:', '"2026-10-18T11:'));
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
    roots: [base],
    agents: {
      session: () => null,
      direct: (rec, text, clientId) => (directs.push({ agentId: rec.agent.id, text, clientId }), null),
      stop: async () => true,
      message: async (rec, text) => (directs.push({ agentId: rec.agent.id, text, clientId: "cloud" }), "Sent to the cloud session."),
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
      shells: () => shells(),
      leaders: () => leaders(),
      ...(taskRunOf && { taskRun: taskRunOf }),
    },
    scope: (cwd) => ({ bridgeHome: join(base, "home"), own: cwd, userMd: null, homedir: base }),
    folders: () => [],
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
  appChanged = [];
  shells = async () => new Map();
  leaders = async () => [];
  taskRunOf = undefined;
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
/** A main-thread call as Claude Code makes it: written to the transcript, then asked about. */
const asked = (q: FakeQuery, tool: string, input: Record<string, unknown>, over: Partial<Parameters<CanUseTool>[2]> = {}) => {
  const toolUseID = over.toolUseID ?? `toolu_${tool}_${Math.random().toString(36).slice(2, 8)}`;
  write(calledEntry(toolUseID, tool, input));
  return call(q, tool, input, { ...over, toolUseID });
};
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

  test("a stop for a task that is not running says so, and only a message still queued can be withdrawn", async () => {
    await start();
    await send("Sleep for a minute");
    await send("Then tidy up", "c_tidy");
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk2x9q7" as TaskId } })).toEqual([{ type: "error", message: "That task is not running.", about: { kind: "stop", sessionId: ASK } }]);
    expect(await handle({ type: "session_unqueue", sessionId: ASK, clientId: "c_Sleep for a minute" })).toEqual([
      { type: "error", message: expect.stringContaining("already went to Claude"), about: { kind: "send", sessionId: ASK, clientId: "c_Sleep for a minute" } },
    ]);
    expect(await handle({ type: "session_unqueue", sessionId: ASK, clientId: "c_tidy" })).toEqual([]);
    expect(await handle({ type: "session_unqueue", sessionId: ASK, clientId: "c_tidy" })).toEqual([
      { type: "error", message: "That message was already withdrawn.", about: { kind: "send", sessionId: ASK, clientId: "c_tidy" } },
    ]);
    expect([(await snapshot(ASK)).items.some((i) => i.id === ("c_tidy" as never)), (await snapshot(ASK)).controls.queued]).toEqual([false, 0]);
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    expect(queries[0]!.received).toEqual(["Sleep for a minute"]);
  });

  test("the bridge's own settings stay out of the session's environment", async () => {
    process.env.CLAUDIOBOT_PUSH_URL = "https://ntfy.example/secret-topic";
    try {
      await start();
      await send("Hi");
      expect(Object.keys(queries[0]!.options.env ?? {}).filter((k) => k.startsWith("CLAUDIOBOT_"))).toEqual([]);
    } finally {
      delete process.env.CLAUDIOBOT_PUSH_URL;
    }
  });

  test("a message queued when the bridge stopped runs once the next start has read the index", async () => {
    await start();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "busy", waitingFor: null });
    await send("Queued before the restart");
    sessions.stop();
    holders.clear();
    queries.length = 0;
    await start();
    // It waited on the terminal before the stop, so it starts at that wait's end.
    clock += 31_000;
    sessions.tick(new Date(clock));
    await flush();
    expect(queries.map((q) => [q.options.model, q.received])).toEqual([["claude-haiku-5-5", ["Queued before the restart"]]]);
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
    expect(frame.items).toContainEqual(expect.objectContaining({ kind: "user", text: "First", queued: false }));
  });

  test("while the Claude app is busy on it the phone may not send, and a queued turn waits rather than runs beside it", async () => {
    await start();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "claude-desktop", kind: "interactive", cwd: repo, status: "busy", waitingFor: null });
    expect((await snapshot(ASK)).controls).toMatchObject({ canSend: false, reason: "Working in the Claude app." });
    await send("Later");
    expect(queries).toHaveLength(0);
    expect(await rowOf(ASK)).toMatchObject({ status: "parked", holder: "desktop" });
  });

  test("the moment the other Claude Code lets go, the waiting turn runs, and the composer never claims it was working", async () => {
    await start();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "busy", waitingFor: null });
    await send("When you can");
    expect((await snapshot(ASK)).controls).toMatchObject({ canSend: false, working: false, reason: "Working in a terminal." });
    expect((await snapshot(ASK)).items.filter((i) => i.kind === "notice")).toEqual([]);
    holders.clear();
    for (const f of appChanged) f();
    await flush();
    expect(queries.map((q) => q.received)).toEqual([["When you can"]]);
  });

  test("a message the phone sends again after a reconnect runs once, even after its turn ended", async () => {
    await start();
    await send("Once", "c_once");
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    await send("Once", "c_once");
    await flush();
    expect(queries.flatMap((q) => q.received)).toEqual(["Once"]);
  });

  test("a thread opened while its turn runs shows the user's message once", async () => {
    await start();
    await send("Only once");
    const lines = readFileSync(fileOf(ASK), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const leaf = lines.findLast((l) => typeof l.uuid === "string" && l.type !== "queue-operation")!;
    appendFileSync(fileOf(ASK), `${JSON.stringify({ parentUuid: leaf.uuid, isSidechain: false, type: "user", message: { role: "user", content: "Only once" }, uuid: crypto.randomUUID(), timestamp: new Date(Date.now() + 1000).toISOString(), cwd: repo, sessionId: ASK })}\n`);
    sessions.stop();
    await start();
    const users = (await snapshot(ASK)).items.filter((i) => i.kind === "user" && i.text === "Only once");
    expect(users).toHaveLength(1);
  });

  test("a session the phone took on resumes even when its transcript is gone, so it fails rather than starts afresh", async () => {
    await start();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "busy", waitingFor: null });
    await send("Queued");
    rmSync(fileOf(ASK));
    holders.clear();
    for (const f of appChanged) f();
    await flush();
    expect([queries[0]!.options.resume, queries[0]!.options.sessionId]).toEqual([ASK, undefined]);
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
    const answer = asked(queries[0]!, "Bash", { command: "rm -rf build" }, { suggestions, title: "Claude wants to run rm -rf build" });
    await flush();
    const item = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    expect(item.card).toMatchObject({ tool: "Bash", label: "Claude wants to run rm -rf build", detail: "rm -rf build", always: "Bash: rm -rf build", answer: null, from: null });
    expect((await rowOf(ASK)).status).toBe("awaiting_approval");
    expect(await handle({ type: "session_decide", sessionId: ASK, cardId: item.card.id, choice: "always" })).toEqual([]);
    expect(await answer).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" }, updatedPermissions: [{ ...suggestions[0]!, destination: "session" }] });
    expect(await handle({ type: "session_decide", sessionId: ASK, cardId: item.card.id, choice: "once" })).toEqual([{ type: "error", message: "That card was already answered" }]);
    expect(((await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>).card.answer).toBe("always");
  });

  test("Never denies and stops the turn; a card left two hours is denied as expired", async () => {
    await start();
    await send("Push it");
    const never = asked(queries[0]!, "Bash", { command: "git push --force" });
    await flush();
    const first = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    await handle({ type: "session_decide", sessionId: ASK, cardId: first.card.id, choice: "never" });
    expect(await never).toMatchObject({ behavior: "deny", interrupt: true });
    const late = asked(queries[0]!, "Bash", { command: "make deploy" });
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
      const answer = asked(queries[0]!, p.tool, p.input);
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
    expect(items.find((i) => i.kind === "notice")).toMatchObject({ text: expect.stringContaining("expired"), reason: "restart" });
  });
});

// Claude Code's task frames as CLI 2.1.305 sends them.
const sys = (subtype: string, fields: object) => ({ type: "system", subtype, uuid: crypto.randomUUID(), session_id: ASK, ...fields }) as unknown as SDKMessage;
const agentTask = (task_id: string, tool_use_id: string, description: string) => ({ task_id, tool_use_id, description, task_type: "local_agent", subagent_type: "general-purpose", is_backgrounded: true });
const shellTask = (task_id: string, tool_use_id: string, description: string, parent_task_id?: string) => ({ task_id, tool_use_id, description, task_type: "local_bash", is_backgrounded: true, ...(parent_task_id && { parent_task_id }) });
const taskStarted = (t: object) => sys("task_started", t);
const level = (...ts: object[]) => sys("background_tasks_changed", { tasks: ts });
const completed = (task_id: string) => sys("task_updated", { task_id, patch: { status: "completed", end_time: 0 } });
const notifiedOf = (task_id: string, tool_use_id: string, status = "completed") => sys("task_notification", { task_id, tool_use_id, status, summary: "done", output_file: "" });
const wakeInit = () => sys("init", {});
const progressOf = (task_id: string, tools: number, last: string) => sys("task_progress", { task_id, description: "Running", usage: { total_tokens: 1, tool_uses: tools, duration_ms: 1 }, last_tool_name: last });
const toolCall = (id: string, name: string, input: object, parent: string | null = null) =>
  ({ type: "assistant", uuid: crypto.randomUUID(), session_id: ASK, parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } }) as unknown as SDKMessage;
const toolResult = (id: string, text: string) =>
  ({ type: "user", uuid: crypto.randomUUID(), session_id: ASK, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }) as unknown as SDKMessage;

/** Writes main-thread entries after the transcript's leaf, as Claude Code does, without the bridge reading them. */
function write(...entries: Record<string, unknown>[]) {
  for (const entry of entries) {
    const lines = readFileSync(fileOf(ASK), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const leaf = lines.findLast((l) => typeof l.uuid === "string" && ["user", "assistant", "attachment", "system"].includes(String(l.type)))!;
    appendFileSync(fileOf(ASK), `${JSON.stringify({ parentUuid: leaf.uuid, isSidechain: false, cwd: repo, sessionId: ASK, timestamp: new Date(clock).toISOString(), uuid: crypto.randomUUID(), ...entry })}\n`);
  }
}
async function transcribe(...entries: Record<string, unknown>[]) {
  write(...entries);
  await sessions.sync();
}
const calledEntry = (id: string, name: string, input: object) => ({ type: "assistant", message: { role: "assistant", id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }] } });
const resultEntry = (id: string, text: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const stepOf = async (id: string) => (await snapshot(ASK)).items.flatMap((i) => (i.kind === "work" ? i.steps : [])).find((s) => s.id === id)!;
const controlsNow = async () => (await snapshot(ASK)).controls;
const noticesNow = async () => (await snapshot(ASK)).items.filter((i): i is Extract<SessionItem, { kind: "notice" }> => i.kind === "notice");

describe("live work", () => {
  test("background subagents keep the session working, with Stop, until the last one and the turns it wakes have ended; an announced turn works only once it begins", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(taskStarted(agentTask("a1", "toolu_a1", "sleeper one")), level(agentTask("a1", "toolu_a1", "sleeper one")));
    await flush();
    clock += 1_000;
    q.emit(taskStarted(agentTask("a2", "toolu_a2", "sleeper two")), level(agentTask("a1", "toolu_a1", "sleeper one"), agentTask("a2", "toolu_a2", "sleeper two")));
    q.emit(progressOf("a1", 1, "Bash"), result());
    await flush();
    const busy = await controlsNow();
    expect(busy.working).toBe(true);
    expect(busy.turn).toBeUndefined();
    expect(busy.tasks).toEqual([
      { id: "a1" as TaskId, stepId: "toolu_a1", kind: "agent", label: "sleeper one", background: true, startedAt: "2026-10-18T12:00:00.000Z", owner: null, progress: { tools: 1, last: "Bash", at: "2026-10-18T12:00:01.000Z" }, waiting: null },
      { id: "a2" as TaskId, stepId: "toolu_a2", kind: "agent", label: "sleeper two", background: true, startedAt: "2026-10-18T12:00:01.000Z", owner: null, progress: null, waiting: null },
    ]);
    expect(await rowOf(ASK)).toMatchObject({ status: "working", holder: "claudio", since: "2026-10-18T12:00:00.000Z", running: { agents: 2, commands: 0 }, activity: "Background: sleeper one and 1 more" });

    clock += 30_000;
    q.emit(completed("a1"), notifiedOf("a1", "toolu_a1"), level(agentTask("a2", "toolu_a2", "sleeper two")), wakeInit());
    await flush();
    expect(await controlsNow()).toMatchObject({ working: true, turn: { startedAt: "2026-10-18T12:00:31.000Z", wake: true }, tasks: [{ id: "a2" }] });
    q.emit(result(), completed("a2"), notifiedOf("a2", "toolu_a2"), level());
    await flush();
    expect([(await controlsNow()).working, (await controlsNow()).turn]).toEqual([false, undefined]);
    clock += 1_000;
    q.emit(wakeInit());
    await flush();
    expect(await controlsNow()).toMatchObject({ working: true, turn: { startedAt: "2026-10-18T12:00:32.000Z", wake: true }, tasks: [] });
    expect((await rowOf(ASK)).status).toBe("working");
    q.emit(result());
    await flush();
    const rest = await controlsNow();
    expect([rest.working, rest.turn, rest.tasks]).toEqual([false, undefined, []]);
    const row = await rowOf(ASK);
    expect([row.status, row.since, row.running, row.activity]).toEqual(["idle", undefined, undefined, undefined]);
  });

  test("a background command reads running in the thread and the row, with Stop, until it ends", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    const input = { command: "sleep 75 && echo bg-done > bg.txt", description: "Sleep 75 seconds then write bg-done marker", run_in_background: true };
    q.emit(toolCall("toolu_bg", "Bash", input));
    await flush();
    expect((await rowOf(ASK)).activity).toBe("Run in background: Sleep 75 seconds then write bg-done marker");
    q.emit(taskStarted(shellTask("bp4", "toolu_bg", input.description)), level(shellTask("bp4", "toolu_bg", input.description)), toolResult("toolu_bg", "Command running in background with ID: bp4."), result());
    await transcribe(calledEntry("toolu_bg", "Bash", input), resultEntry("toolu_bg", "Command running in background with ID: bp4."));
    expect(await stepOf("toolu_bg")).toMatchObject({ state: "running", output: null, startedAt: "2026-10-18T12:00:00.000Z" });
    expect(await controlsNow()).toMatchObject({ working: true, tasks: [{ id: "bp4", kind: "command", stepId: "toolu_bg", background: true }] });
    expect(await rowOf(ASK)).toMatchObject({ status: "working", running: { agents: 0, commands: 1 }, activity: "Background: sleep 75 && echo bg-done > bg.txt" });

    thread.length = 0;
    q.emit(completed("bp4"), notifiedOf("bp4", "toolu_bg"), level(), wakeInit(), result());
    await transcribe({ type: "user", message: { role: "user", content: "<task-notification>\n<task-id>bp4</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>" } });
    const frames = thread.flatMap(({ frame }) => (frame.type === "session_items" ? frame.items : []));
    expect(frames.flatMap((i) => (i.kind === "work" ? i.steps : [])).findLast((s) => s.id === "toolu_bg")?.state).toBe("ok");
    expect((await controlsNow()).working).toBe(false);
    expect((await noticesNow()).map((n) => n.text)).toEqual(["Background command completed (exit code 0)"]);
  });

  test("a subagent's background command keeps the subagent's step running and names it as owner; killed unannounced, the thread says so", async () => {
    await start();
    await send("Start a starter");
    const q = queries[0]!;
    const starter = agentTask("a1", "toolu_starter", "starter");
    const shell = shellTask("b1", "toolu_sleep", "Run delayed write of nested.txt in background", "a1");
    q.emit(taskStarted(starter), level(starter), toolResult("toolu_starter", "Async agent launched successfully."), result());
    q.emit(toolCall("toolu_sleep", "Bash", { command: "sleep 60 && echo nested-done > nested.txt", run_in_background: true }, "toolu_starter"));
    q.emit(level(starter, shell), taskStarted(shell), completed("a1"), notifiedOf("a1", "toolu_starter"), level(shell));
    await transcribe(calledEntry("toolu_starter", "Agent", { description: "starter", prompt: "go", subagent_type: "general-purpose", run_in_background: true }), resultEntry("toolu_starter", "Async agent launched successfully."));
    expect(await stepOf("toolu_starter")).toMatchObject({ label: "Agent: starter", state: "running" });
    expect(await controlsNow()).toMatchObject({ working: true, tasks: [{ id: "b1", kind: "command", owner: "toolu_starter" }] });

    q.emit(wakeInit(), result(), level());
    await flush();
    expect((await noticesNow()).map((n) => [n.text, n.reason])).toEqual([
      ['The background command "sleep 60 && echo nested-done > nested.txt", started by starter, was stopped when starter returned.', "task"],
    ]);
    expect(await stepOf("toolu_starter")).toMatchObject({ state: "ok" });
    expect((await controlsNow()).working).toBe(false);
  });

  test("a call waits for its card instead of reading running, and runs from the moment it is allowed", async () => {
    await start();
    await send("Sleep");
    const input = { command: "perl -e 'sleep 120'", description: "Sleep two minutes" };
    await transcribe(calledEntry("toolu_wait", "Bash", input));
    const answer = call(queries[0]!, "Bash", input, { toolUseID: "toolu_wait" });
    await flush();
    expect(await stepOf("toolu_wait")).toMatchObject({ state: "waiting" });
    const card = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    expect([card.stepId, card.subagent]).toEqual(["toolu_wait", undefined]);
    expect((await rowOf(ASK)).activity).toBe("Waiting for approval: Bash");
    clock += 90_000;
    await handle({ type: "session_decide", sessionId: ASK, cardId: card.card.id, choice: "once" });
    await answer;
    expect(await stepOf("toolu_wait")).toMatchObject({ state: "running", startedAt: "2026-10-18T12:01:30.000Z" });
  });

  test("a card goes out with the waiting step of its call, which Claude Code wrote to the transcript just before asking", async () => {
    await start();
    await send("Sleep");
    await snapshot(ASK);
    thread.length = 0;
    const input = { command: "perl -e 'sleep 120'", description: "Sleep two minutes" };
    write(calledEntry("toolu_wait", "Bash", input));
    void call(queries[0]!, "Bash", input, { toolUseID: "toolu_wait" });
    await flush();
    const first = thread.map(({ frame }) => frame).find((f) => f.type === "session_items" && f.items.some((i) => i.kind === "permission"));
    const items = first?.type === "session_items" ? first.items : [];
    expect(items.flatMap((i) => (i.kind === "work" ? i.steps : []))).toMatchObject([{ id: "toolu_wait", state: "waiting" }]);
  });

  test("a card waits for Claude Code to write its call to the transcript, and goes out alone after 2 s if it never does", async () => {
    await start();
    await send("Sleep");
    await snapshot(ASK);
    thread.length = 0;
    const input = { command: "perl -e 'sleep 120'", description: "Sleep two minutes" };
    void call(queries[0]!, "Bash", input, { toolUseID: "toolu_late" });
    await flush();
    expect(thread.some(({ frame }) => frame.type === "session_items" && frame.items.some((i) => i.kind === "permission"))).toBe(false);
    await transcribe(calledEntry("toolu_late", "Bash", input));
    const together = thread.map(({ frame }) => frame).find((f) => f.type === "session_items" && f.items.some((i) => i.kind === "permission"));
    expect(together?.type === "session_items" && together.items.flatMap((i) => (i.kind === "work" ? i.steps : []))).toMatchObject([{ id: "toolu_late", state: "waiting" }]);

    void call(queries[0]!, "Bash", { command: "true" }, { toolUseID: "toolu_never" });
    await flush();
    expect((await snapshot(ASK)).items.filter((i) => i.kind === "permission")).toHaveLength(1);
    clock += 2_000;
    sessions.tick(new Date(clock));
    await flush();
    expect((await snapshot(ASK)).items.filter((i) => i.kind === "permission")).toHaveLength(2);
  });

  test("a subagent's card names the subagent, holds back its step, and marks its task waiting", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(taskStarted(agentTask("a2", "toolu_a2", "sleeper two")), level(agentTask("a2", "toolu_a2", "sleeper two")));
    await flush();
    void call(q, "Bash", { command: "perl -e 'sleep 30'" }, { toolUseID: "toolu_inner", agentID: "a2" });
    await flush();
    const card = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    expect([card.stepId, card.subagent]).toEqual(["toolu_a2", "sleeper two"]);
    expect((await controlsNow()).tasks).toMatchObject([{ id: "a2", waiting: card.card.id }]);
  });

  test("a watched thread whose session works hears from the bridge at least every 25 s, even when Claude Code is silent", async () => {
    await start();
    await send("Sleep two minutes");
    await snapshot(ASK);
    thread.length = 0;
    clock += 24_000;
    sessions.tick(new Date(clock));
    await flush();
    expect(thread.length).toBe(0);
    clock += 2_000;
    sessions.tick(new Date(clock));
    await flush();
    expect(thread.map(({ frame }) => frame.type === "session_items" && [frame.items.length, frame.controls?.working])).toEqual([[0, true]]);
  });

  test("Stop can aim at one task, whose end is then no surprise, and a turn Claude Code started on its own is stopped too", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(taskStarted(agentTask("a1", "toolu_a1", "sleeper one")), level(agentTask("a1", "toolu_a1", "sleeper one")), result());
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "a1" as TaskId } })).toEqual([]);
    expect(q.stoppedTasks).toEqual(["a1"]);
    q.emit(sys("task_updated", { task_id: "a1", patch: { status: "killed" } }), level(), wakeInit());
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([]);
    expect(q.interrupts).toBe(1);
    expect((await noticesNow()).map((n) => n.text)).toEqual(['Stopped by you: agent "sleeper one".']);
    q.emit(result(0, { subtype: "error_during_execution", is_error: true, errors: [] }));
    await flush();
    expect((await noticesNow()).map((n) => [n.text, n.reason])).toEqual([
      ['Stopped by you: agent "sleeper one".', "stop"],
      ["Stopped by you: the turn.", "stop"],
    ]);
  });

  test("between a background task's end and the wake turn it announces the session rests, and a Stop then keeps that turn from running", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bp4", "toolu_bg", "Sleep")), level(shellTask("bp4", "toolu_bg", "Sleep")), result());
    await flush();
    q.emit(completed("bp4"), notifiedOf("bp4", "toolu_bg"), level());
    await flush();
    expect(await controlsNow()).toMatchObject({ working: false, tasks: [] });
    expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([]);
    expect(q.interrupts).toBe(1);
    q.emit(wakeInit());
    await flush();
    expect(q.interrupts).toBe(2);
  });

  test("a turn stopped while its foreground subagent runs comes to rest at once, with no wake turn to wait for", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(wakeInit(), taskStarted({ ...agentTask("af", "toolu_af", "long sleeper"), is_backgrounded: false }), taskStarted({ ...shellTask("bz", "toolu_bz", "Sleep 45 seconds", "af"), is_backgrounded: false }));
    await flush();
    expect(await controlsNow()).toMatchObject({ working: true, tasks: [{ id: "af" }, { id: "bz", owner: "toolu_af" }] });
    expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([]);
    q.emit(notifiedOf("bz", "toolu_bz", "stopped"), sys("task_updated", { task_id: "af", patch: { status: "killed" } }), notifiedOf("af", "toolu_af", "stopped"), result());
    await flush();
    expect(await controlsNow()).toMatchObject({ working: false, tasks: [] });
    expect((await rowOf(ASK)).status).toBe("idle");
  });

  test("a command task that Claude Code names by its raw command reaches the phone with its secrets masked", async () => {
    await start();
    await send("Fetch it");
    const q = queries[0]!;
    const command = "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnop' -u alice:hunter2pass https://example.com && mysql -u root -ptopsecret9 db";
    const shell = shellTask("bk", "toolu_k", command);
    q.emit(toolCall("toolu_k", "Bash", { command, run_in_background: true }), taskStarted(shell), level(shell), toolResult("toolu_k", "Command running in background with ID: bk."), result());
    await flush();
    const live = JSON.stringify([await controlsNow(), await rowOf(ASK)]);
    expect(live).toContain("Bearer «redacted");
    q.emit(level());
    await flush();
    const notices = await noticesNow();
    expect(notices).toHaveLength(1);
    for (const secret of ["sk-ant-api03", "hunter2pass", "topsecret9"]) expect(JSON.stringify([live, notices])).not.toContain(secret);
  });

  test("a refusal to stop many commands names two, cut short, and counts the rest", async () => {
    await start();
    await send("Start them");
    const q = queries[0]!;
    const shells = ["sleep 901", "sleep 906 && echo integration-suite-charlie-finished-at-last", "sleep 902", "sleep 904"].map((c, i) => shellTask(`b${i}`, `toolu_${i}`, c));
    q.emit(...shells.map((t) => taskStarted(t)), level(...shells), result());
    await flush();
    q.refuseStop = true;
    expect(await handle({ type: "session_stop", sessionId: ASK, target: "all" })).toEqual([
      { type: "error", message: "Claude Code did not stop sleep 901, sleep 906 && echo… and 2 more.", about: { kind: "stop", sessionId: ASK } },
    ]);
  });

  for (const [labels, said] of [
    [["a-very-long-header-name-x:sk-ant-api03-abcdefghijklmnopqrstuvwx", "   "], "a-very-long-header-name-x:… and an unnamed command"],
    [["curl -H token:sk-ant-api03-abcdefghijklmnopqrstuvwx https://example.test"], "curl -H token:«redacted:37 chars»…"],
  ] as const) {
    test(`a refusal keeps a masked secret whole and names a command with no name: ${said}`, async () => {
      await start();
      await send("Start them");
      const q = queries[0]!;
      const shells = labels.map((c, i) => shellTask(`b${i}`, `toolu_${i}`, c));
      q.emit(...shells.map((t) => taskStarted(t)), level(...shells), result());
      await flush();
      q.refuseStop = true;
      expect(await handle({ type: "session_stop", sessionId: ASK, target: "all" })).toEqual([
        { type: "error", message: `Claude Code did not stop ${said}.`, about: { kind: "stop", sessionId: ASK } },
      ]);
    });
  }

  test("a Stop Claude Code refuses says so, and the task's later end is still named", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    const shell = shellTask("bk", "toolu_k", "sleep 600");
    q.emit(taskStarted(shell), level(shell), result());
    await flush();
    q.refuseStop = true;
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([{ type: "error", message: "Claude Code did not stop sleep 600.", about: { kind: "stop", sessionId: ASK } }]);
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level());
    await flush();
    expect((await noticesNow()).map((n) => [n.text, n.tone])).toEqual([
      ['Couldn\'t stop command "sleep 600". It may still be running.', "error"],
      ['The background command "sleep 600" was stopped by Claude Code.', "info"],
    ]);
  });

  test("Stop stays offered while the bridge's background task runs, even when another Claude Code is busy on the session", async () => {
    await start();
    await send("Go");
    const q = queries[0]!;
    const shell = shellTask("b1", "toolu_b1", "sleep 600");
    q.emit(taskStarted(shell), level(shell), result());
    await flush();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "busy", waitingFor: null });
    for (const f of appChanged) f();
    await flush();
    const controls = await controlsNow();
    expect([controls.canSend, controls.working, controls.tasks?.map((t) => t.id)]).toEqual([false, true, ["b1" as TaskId]]);
  });

  test("the row's activity line masks a secret before it cuts the command short", async () => {
    await start();
    await send("Upload it");
    const command = "./scripts/upload-release-artifacts.sh --channel stable --mirror eu Zq8vR2kLm9Xw4TbN7pHs3JdF6yGc1VaE";
    queries[0]!.emit(toolCall("toolu_up", "Bash", { command }));
    await flush();
    const activity = (await rowOf(ASK)).activity!;
    expect([activity.startsWith("Run ./scripts/upload-release-artifacts.sh"), activity.includes("Zq8v")]).toEqual([true, false]);
  });

  test("Claude Code stopping a foreground subagent's background command is named, and the session rests when the turn ends", async () => {
    await start();
    await send("Start a starter");
    const q = queries[0]!;
    const starter = { ...agentTask("af", "toolu_af", "starter"), is_backgrounded: false };
    const shell = shellTask("bs", "toolu_bs", "Run delayed write to nested.txt in background", "af");
    q.emit(wakeInit(), taskStarted(starter), toolCall("toolu_bs", "Bash", { command: "sleep 60 && echo nested-done > nested.txt", run_in_background: true }, "toolu_af"), level(shell), taskStarted(shell));
    await flush();
    q.emit(sys("task_updated", { task_id: "bs", patch: { status: "killed" } }), notifiedOf("bs", "toolu_bs", "stopped"), level(), completed("af"), notifiedOf("af", "toolu_af"), result());
    await flush();
    expect((await noticesNow()).map((n) => n.text)).toEqual(['The background command "sleep 60 && echo nested-done > nested.txt", started by starter, was stopped by Claude Code.']);
    expect(await controlsNow()).toMatchObject({ working: false, tasks: [] });
  });

  test("a background task that ends during a turn does not make the session read working after the turn", async () => {
    await start();
    await send("Start it and reply");
    const q = queries[0]!;
    const shell = shellTask("bq", "toolu_bq", "sleep 8");
    q.emit(wakeInit(), taskStarted(shell), level(shell), completed("bq"), notifiedOf("bq", "toolu_bq"), level(), result());
    await flush();
    expect(await controlsNow()).toMatchObject({ working: false, tasks: [] });
  });

  test("a terminal or Claude app session waiting on its user reads as needing them", async () => {
    await start();
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "waiting", waitingFor: "permission prompt" });
    expect((await rowOf(ASK)).status).toBe("awaiting_approval");
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "waiting", waitingFor: "input needed" });
    expect((await rowOf(ASK)).status).toBe("awaiting_input");
  });
});

describe("a session the phone starts", () => {
  test("it is created under a chosen id, lists at once under its project from the phone, and opens without a title", async () => {
    await start({ folders: () => [repo] });
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

describe("a cloud agent's session", () => {
  test("lists under its repo with its claude.ai link, shows what was said to it, and a send follows up through claude", async () => {
    const rec: AgentRecord = {
      agent: { id: "a_cloud" as AgentId, botId: "b_1" as BotId, title: "Bump deps", where: "cloud", projectName: "demo", status: "in_cloud", url: "https://claude.ai/code/session_01abc", createdAt: "2026-10-18T12:00:00.000Z", updatedAt: "2026-10-18T12:05:00.000Z", evidence: null, worktree: null },
      cwd: repo,
      repo,
      messages: [
        { id: "m_1" as MessageId, at: "2026-10-18T12:00:00.000Z", from: "bot", text: "Bump the deps." },
        { id: "m_2" as MessageId, at: "2026-10-18T12:05:00.000Z", from: "agent", text: "Opened a PR." },
      ],
      session: emptySession(),
      cloudSession: "session_01abc",
      budgetUsd: null,
      startedBy: { kind: "user" },
    };
    world.agents.set(rec.agent.id, rec);
    await start();
    expect(await rowOf("session_01abc" as SessionId)).toMatchObject({ origin: "cloud", url: "https://claude.ai/code/session_01abc", title: "Bump deps", status: "idle", agent: { agentId: "a_cloud" } });
    expect((await snapshot("session_01abc" as SessionId)).items.map((i) => [i.kind, "text" in i ? i.text : null])).toEqual([
      ["user", "Bump the deps."],
      ["assistant", "Opened a PR."],
    ]);
    expect(await send("Also bump bun", "c_c", "session_01abc" as SessionId)).toEqual([]);
    expect(directs).toEqual([{ agentId: "a_cloud", text: "Also bump bun", clientId: "cloud" }]);
    expect(await handle({ type: "session_stop", sessionId: "session_01abc" as SessionId })).toEqual([{ type: "error", message: expect.stringContaining("claude.ai"), about: { kind: "stop", sessionId: "session_01abc" as SessionId } }]);
  });
});

describe("how a run ends", () => {
  const cardItem = async () => (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
  const restart = async () => {
    sessions.stop();
    queries.length = 0;
    await start();
    await flush();
  };
  const interrupted = () => result(0, { subtype: "error_during_execution", is_error: true, errors: [] });

  test("Stop says what it stopped, closes the open card as stopped, and the row keeps the outcome until the next send", async () => {
    await start();
    await send("Build and watch");
    const q = queries[0]!;
    const shell = shellTask("bk", "toolu_k", "sleep 600");
    q.emit(taskStarted(shell), level(shell));
    const answer = asked(q, "Bash", { command: "make" });
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([]);
    expect(await answer).toEqual({ behavior: "deny", message: "Alex stopped the session. It did not run." });
    expect((await cardItem()).card.answer).toBe("stopped");
    expect(q.stoppedTasks).toEqual(["bk"]);
    expect(await noticesNow()).toEqual([]);
    q.emit(interrupted(), sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level());
    await flush();
    expect((await noticesNow()).map((n) => [n.text, n.reason])).toEqual([['Stopped by you: the turn and command "sleep 600".', "stop"]]);
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "stopped", text: "Stopped by you: the turn, 1 command" } });
    await send("Next");
    expect((await rowOf(ASK)).outcome).toBeUndefined();
  });

  test("Stop and send stops the turn alone: the background command keeps running", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    const shell = shellTask("bk", "toolu_k", "sleep 45");
    q.emit(taskStarted(shell), level(shell), toolCall("toolu_p", "Bash", { command: "perl -e 'sleep 40'" }));
    await flush();
    expect(await handle({ type: "session_send", sessionId: ASK, text: "Reply ok", clientId: "c_ok", interrupt: true })).toEqual([]);
    await flush();
    expect([q.interrupts, q.stoppedTasks]).toEqual([1, []]);
    expect((await controlsNow()).tasks?.map((t) => t.id)).toEqual(["bk" as TaskId]);
    q.emit(interrupted());
    await flush();
    expect((await noticesNow()).map((n) => n.text)).toEqual(["Stopped by you: the turn."]);
    expect(q.received).toEqual(["Start it", "Reply ok"]);
  });

  test("a message queued behind a stopped turn starts a new run, which ends finished", async () => {
    await start();
    await send("First");
    await send("Second", "c_2");
    const q = queries[0]!;
    q.emit(toolCall("toolu_p", "Bash", { command: "perl -e 'sleep 40'" }));
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    clock += 1_000;
    q.emit(interrupted());
    await flush();
    expect((await rowOf(ASK)).outcome).toBeUndefined();
    q.emit(result(0.01, { session_id: ASK }));
    await flush();
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished" } });
  });

  test("a stop meant for an earlier turn never reaches a newer one", async () => {
    await start();
    await send("Go");
    const turn = (await controlsNow()).turn!;
    expect(await handle({ type: "session_stop", sessionId: ASK, turnStartedAt: "2026-10-18T11:00:00.000Z" })).toEqual([
      { type: "error", message: expect.stringContaining("newer one"), about: { kind: "stop", sessionId: ASK } },
    ]);
    expect(queries[0]!.interrupts).toBe(0);
    expect(await handle({ type: "session_stop", sessionId: ASK, turnStartedAt: turn.startedAt })).toEqual([]);
    expect(queries[0]!.interrupts).toBe(1);
  });

  test("a prompt stopped before Claude Code wrote it down stays in the thread, also after a restart", async () => {
    await start();
    await send("Write a haiku", "c_haiku");
    await handle({ type: "session_stop", sessionId: ASK });
    queries[0]!.emit(interrupted());
    await flush();
    const tail = async () => (await snapshot(ASK)).items.slice(-2).map((i) => [i.kind, i.id === ("c_haiku" as never) || ("text" in i && i.text)]);
    const kept = [
      ["user", true],
      ["notice", "Stopped by you before Claude replied."],
    ];
    expect(await tail()).toEqual(kept);
    await restart();
    expect(await tail()).toEqual(kept);
  });

  test("Stop on one background task waits for Claude Code, and its step reads stopped once the task is gone; the answered turn reads finished", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_k", "Bash", { command: "sleep 600", run_in_background: true }), resultEntry("toolu_k", "Command running in background with ID: bk."));
    const shell = shellTask("bk", "toolu_k", "sleep 600");
    q.emit(taskStarted(shell), level(shell), result());
    await flush();
    expect((await stepOf("toolu_k")).state).toBe("running");
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level());
    await flush();
    expect(await stepOf("toolu_k")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished" } });
  });

  test("when Claude Code dies, its running step and card end, the row says why, and all of it outlives a bridge restart", async () => {
    await start();
    await send("Sleep a while");
    const q = queries[0]!;
    const allowed = asked(q, "Bash", { command: "perl -e 'sleep 90'" }, { toolUseID: "toolu_s" });
    await flush();
    await handle({ type: "session_decide", sessionId: ASK, cardId: (await cardItem()).card.id, choice: "once" });
    await allowed;
    q.emit(toolCall("toolu_s", "Bash", { command: "perl -e 'sleep 90'" }));
    const signal = new AbortController();
    void call(q, "Bash", { command: "make" }, { signal: signal.signal });
    await flush();
    q.crash("Claude Code process terminated by signal SIGKILL");
    signal.abort();
    await flush();
    const cause = "Claude Code stopped unexpectedly (terminated by signal SIGKILL)";
    const check = async () => {
      expect(await stepOf("toolu_s")).toMatchObject({ state: "error", cause });
      expect(await rowOf(ASK)).toMatchObject({ status: "failed", outcome: { kind: "failed", text: cause } });
      expect((await cardItem()).card.answer).toBe("closed");
      const failure = (await noticesNow()).filter((n) => n.reason === "failure");
      expect(failure.map((n) => [n.text.split("\n")[0], n.tone])).toEqual([["Claude Code stopped unexpectedly. Send a message to start it again.", "error"]]);
    };
    await check();
    await restart();
    await check();
  });

  test("a restart that killed background work says so, and the row reads the work as lost", async () => {
    const killed = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    process.kill(-killed.pid!, "SIGKILL");
    await new Promise((r) => killed.once("exit", r));
    shells = async () => new Map([["bk", killed.pid!]]);
    await start();
    await send("Start it");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_k", "Bash", { command: "sleep 600", run_in_background: true }), resultEntry("toolu_k", "Command running in background with ID: bk."));
    q.emit(taskStarted(shellTask("bk", "toolu_k", "sleep 600")), level(shellTask("bk", "toolu_k", "sleep 600")), result());
    await flush();
    await flush();
    await restart();
    expect(queries).toHaveLength(0);
    expect((await noticesNow()).map((n) => [n.text, n.reason])).toEqual([["The bridge restarted, so Claude Code's background work stopped: sleep 600.", "restart"]]);
    expect(await rowOf(ASK)).toMatchObject({ status: "failed", outcome: { kind: "lost" } });
    expect(await stepOf("toolu_k")).toMatchObject({ state: "stopped", cause: "The bridge restarted" });
  });

  test("a failure the transcript already shows gets no second notice", async () => {
    await start();
    await send("Hello");
    const said = "There's an issue with the selected model (claude-nope).";
    await transcribe({ type: "assistant", isApiErrorMessage: true, message: { role: "assistant", id: "msg_err", content: [{ type: "text", text: said }] } });
    queries[0]!.emit(result(0, { is_error: true, result: said }));
    await flush();
    expect((await noticesNow()).map((n) => n.text)).toEqual([said]);
    expect(await rowOf(ASK)).toMatchObject({ status: "failed", outcome: { kind: "failed", text: said } });
  });

  test("a run that finishes background work ends on Claude Code's own summary", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bp", "toolu_bg", "Sleep")), level(shellTask("bp", "toolu_bg", "Sleep")), result());
    await flush();
    const summary = 'Background command "sleep 75" completed (exit code 0)';
    q.emit(completed("bp"), sys("task_notification", { task_id: "bp", tool_use_id: "toolu_bg", status: "completed", summary, output_file: "" }), level(), wakeInit(), result());
    await flush();
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished", text: summary } });
  });

  test("a subagent's call the user denied shows on its Agent step, which no longer reads a plain ok", async () => {
    await start();
    await send("Delegate it");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_af", "Agent", { description: "long sleeper", subagent_type: "general-purpose", prompt: "Sleep." }));
    q.emit(taskStarted({ ...agentTask("af", "toolu_af", "long sleeper"), is_backgrounded: false }));
    await flush();
    const denied = call(q, "Bash", { command: "perl -e 'sleep 45'" }, { agentID: "af" });
    await flush();
    await handle({ type: "session_decide", sessionId: ASK, cardId: (await cardItem()).card.id, choice: "deny" });
    expect(await denied).toMatchObject({ behavior: "deny" });
    q.emit(completed("af"), notifiedOf("af", "toolu_af"));
    await transcribe(resultEntry("toolu_af", "I could not run the command."));
    expect(await stepOf("toolu_af")).toMatchObject({ state: "denied", cause: "You denied its Bash: perl -e 'sleep 45'" });
  });

  test("a mode Claude Code refuses is not shown as the mode, and the error names the change", async () => {
    await start();
    await send("Go");
    queries[0]!.refuseModes = true;
    expect(await handle({ type: "session_set", sessionId: ASK, patch: { mode: "acceptEdits" } })).toEqual([
      { type: "error", message: expect.stringContaining("cannot switch to acceptEdits"), about: { kind: "set", sessionId: ASK } },
    ]);
    expect((await controlsNow()).mode).toBe("default");
    expect(world.sessions.get(ASK)?.own?.mode).toBeNull();
  });

  test("a queued message that runs after a failed turn, or after a restart cut the turn off, starts a new run", async () => {
    await start();
    await send("First");
    await send("Second", "c_2");
    queries[0]!.emit(result(0, { is_error: true, result: "API Error: 400 bad request" }));
    await flush();
    expect(queries[0]!.received).toEqual(["First", "Second"]);
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished" } });

    await send("Third", "c_3");
    await send("Fourth", "c_4");
    queries[0]!.emit(toolCall("toolu_p", "Bash", { command: "perl -e 'sleep 40'" }));
    await flush();
    await restart();
    expect([(await rowOf(ASK)).status, (await rowOf(ASK)).outcome]).toEqual(["working", undefined]);
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished" } });
  });

  test("a Stop that Claude Code refused stops nothing, so the run still ends finished", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bk", "toolu_k", "sleep 30")), level(shellTask("bk", "toolu_k", "sleep 30")), result());
    await flush();
    q.refuseStop = true;
    expect(await handle({ type: "session_stop", sessionId: ASK, target: "all" })).toEqual([{ type: "error", message: expect.stringContaining("did not stop"), about: { kind: "stop", sessionId: ASK } }]);
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toHaveLength(1);
    q.emit(completed("bk"), level());
    await flush();
    expect((await rowOf(ASK)).outcome?.kind).toBe("finished");
    expect(world.sessions.get(ASK)?.own?.cut).toBeUndefined();
  });

  test("a subagent's card that Claude Code abandons after a stop of the turn alone reads closed", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(taskStarted(agentTask("a2", "toolu_a2", "sleeper two")), level(agentTask("a2", "toolu_a2", "sleeper two")));
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    q.emit(interrupted());
    await flush();
    const signal = new AbortController();
    void call(q, "Bash", { command: "make" }, { signal: signal.signal, agentID: "a2" });
    await flush();
    q.crash("Claude Code process terminated by signal SIGKILL");
    signal.abort();
    await flush();
    expect((await cardItem()).card.answer).toBe("closed");
  });

  test("a task stop Claude Code takes late counts once the task is gone: its card and step read stopped, and the answered turn finished", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_a1", "Agent", { description: "sleeper one", subagent_type: "general-purpose", prompt: "Sleep." }));
    q.emit(taskStarted(agentTask("a1", "toolu_a1", "sleeper one")), level(agentTask("a1", "toolu_a1", "sleeper one")), result());
    await flush();
    const signal = new AbortController();
    void call(q, "Bash", { command: "make" }, { signal: signal.signal, agentID: "a1" });
    await flush();
    let take = () => {};
    q.holdStop = new Promise<void>((r) => (take = r));
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "a1" as TaskId } })).toEqual([
      { type: "error", message: expect.stringContaining("not confirmed"), about: { kind: "stop", sessionId: ASK } },
    ]);
    expect((await cardItem()).card.answer).toBeNull();
    take();
    signal.abort();
    q.emit(sys("task_updated", { task_id: "a1", patch: { status: "killed" } }), level());
    await flush();
    expect((await cardItem()).card.answer).toBe("stopped");
    expect(await stepOf("toolu_a1")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
    expect((await noticesNow()).map((n) => n.text).at(-1)).toBe('Stopped by you: agent "sleeper one".');
    expect((await rowOf(ASK)).outcome).toMatchObject({ kind: "finished" });
  }, 10_000);

  test("a stopped task's step still reads stopped after a bridge restart, and a step left running at rest ends", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    await transcribe(
      calledEntry("toolu_k", "Bash", { command: "sleep 600", run_in_background: true }),
      resultEntry("toolu_k", "Command running in background with ID: bk."),
      calledEntry("toolu_w", "Bash", { command: "sleep 700", run_in_background: true }),
      resultEntry("toolu_w", "Command running in background with ID: bw."),
    );
    const shells = [shellTask("bk", "toolu_k", "sleep 600"), shellTask("bw", "toolu_w", "sleep 700")];
    q.emit(...shells.map(taskStarted), level(...shells), result());
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } });
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level(shells[1]!), sys("task_updated", { task_id: "bw", patch: { status: "killed" } }), level());
    await flush();
    await restart();
    expect(await stepOf("toolu_k")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
    expect(await stepOf("toolu_w")).toMatchObject({ state: "stopped", cause: "It ended without a result" });
  });

  test("a denied subagent command's step cause keeps its secrets masked", async () => {
    await start();
    await send("Delegate it");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_af", "Agent", { description: "long sleeper", subagent_type: "general-purpose", prompt: "Sleep." }));
    q.emit(taskStarted({ ...agentTask("af", "toolu_af", "long sleeper"), is_backgrounded: false }));
    await flush();
    const denied = call(q, "Bash", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' https://x.test" }, { agentID: "af" });
    await flush();
    await handle({ type: "session_decide", sessionId: ASK, cardId: (await cardItem()).card.id, choice: "deny" });
    await denied;
    q.emit(completed("af"), notifiedOf("af", "toolu_af"));
    await transcribe(resultEntry("toolu_af", "I could not run the command."));
    expect((await stepOf("toolu_af")).cause).not.toContain("sk-ant-api03");
  });

  test("a Stop aimed at a wake turn reaches it once it runs", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(taskStarted(agentTask("a1", "toolu_a1", "sleeper one")), level(agentTask("a1", "toolu_a1", "sleeper one")), result());
    await flush();
    clock += 10_000;
    q.emit(completed("a1"), notifiedOf("a1", "toolu_a1"), level());
    await flush();
    clock += 2_000;
    q.emit(wakeInit());
    await flush();
    const seen = (await controlsNow()).turn!;
    expect(await handle({ type: "session_stop", sessionId: ASK, turnStartedAt: seen.startedAt })).toEqual([]);
  });

  test("the same failure twice in two turns shows twice; once, when the transcript already has it", async () => {
    await start();
    await send("Hello");
    const said = "There's an issue with the selected model (claude-nope).";
    await transcribe({ type: "assistant", isApiErrorMessage: true, message: { role: "assistant", id: "msg_err", content: [{ type: "text", text: said }] } });
    queries[0]!.emit(result(0, { is_error: true, result: said }));
    await flush();
    clock += 60_000;
    await send("Again", "c_again");
    queries[0]!.emit(result(0, { is_error: true, result: said }));
    await flush();
    expect((await noticesNow()).filter((n) => n.text === said)).toHaveLength(2);
  });

  test("a kept prompt and its stop notice stay where they happened when a later turn follows", async () => {
    await start();
    await send("Write a haiku", "c_haiku");
    await handle({ type: "session_stop", sessionId: ASK });
    queries[0]!.emit(interrupted());
    await flush();
    clock += 60_000;
    await send("Next one", "c_next");
    await transcribe({ type: "user", message: { role: "user", content: "Next one" } }, { type: "assistant", message: { role: "assistant", id: "msg_r", content: [{ type: "text", text: "Here it is." }] } });
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    const tail = (await snapshot(ASK)).items.slice(-4).map((i) => [i.kind, "text" in i ? i.text : ""]);
    expect(tail).toEqual([
      ["user", "Write a haiku"],
      ["notice", "Stopped by you before Claude replied."],
      ["user", "Next one"],
      ["assistant", "Here it is."],
    ]);
  });

  test("one stop of a background agent shows one stop line", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_a1", "Agent", { description: "long sleeper", subagent_type: "general-purpose", prompt: "Sleep.", run_in_background: true }));
    q.emit(taskStarted(agentTask("a1", "toolu_a1", "long sleeper")), level(agentTask("a1", "toolu_a1", "long sleeper")), result());
    await flush();
    clock += 1000;
    await handle({ type: "session_stop", sessionId: ASK });
    q.emit(sys("task_updated", { task_id: "a1", patch: { status: "killed" } }), level());
    await flush();
    clock += 1000;
    await transcribe({ type: "user", message: { role: "user", content: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_a1</tool-use-id>\n<status>killed</status>\n<summary>Agent "long sleeper" was stopped by user</summary>\n</task-notification>' } });
    expect((await noticesNow()).map((n) => n.reason)).toEqual(["stop"]);
  });

  test("a step another Claude Code still holds is not ended at rest, even idle at its prompt across a bridge restart", async () => {
    await start();
    await send("Hi");
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    clock += 60_000;
    await transcribe(calledEntry("toolu_t", "Bash", { command: "sleep 900", run_in_background: true }), resultEntry("toolu_t", "Command running in background with ID: bt."));
    holders.set(ASK, { pid: 9, sessionId: ASK, entrypoint: "cli", kind: "interactive", cwd: repo, status: "idle", waitingFor: null });
    for (const f of appChanged) f();
    await flush();
    clock += 60_000;
    await restart();
    expect((await stepOf("toolu_t")).state).toBe("running");
  });

  test("Claude Code's word that the user stopped a task hides only when the bridge just said so itself", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_a1", "Agent", { description: "worker", subagent_type: "general-purpose", prompt: "Sleep.", run_in_background: true }));
    q.emit(taskStarted(agentTask("a1", "toolu_a1", "worker")), level(agentTask("a1", "toolu_a1", "worker")), result());
    await flush();
    await handle({ type: "session_stop", sessionId: ASK });
    q.emit(sys("task_updated", { task_id: "a1", patch: { status: "killed" } }), level());
    await flush();
    clock += 3_600_000;
    await transcribe(calledEntry("toolu_a2", "Agent", { description: "worker", subagent_type: "general-purpose", prompt: "Sleep.", run_in_background: true }));
    clock += 1000;
    await transcribe({ type: "user", message: { role: "user", content: '<task-notification>\n<task-id>a2</task-id>\n<tool-use-id>toolu_a2</tool-use-id>\n<status>killed</status>\n<summary>Agent "worker" was stopped by user</summary>\n</task-notification>' } });
    expect((await noticesNow()).map((n) => n.reason)).toEqual(["stop", "task"]);
  });

  test("Always names the tool once and lists each rule as its own item", () => {
    const rules = [
      { toolName: "Bash", ruleContent: "perl -e 'sleep 45'" },
      { toolName: "Bash", ruleContent: "echo late *" },
    ];
    expect(alwaysText([{ type: "addRules", rules, behavior: "allow", destination: "localSettings" }])).toBe("Bash: perl -e 'sleep 45' · echo late *");
    expect(alwaysText([])).toBe("this");
  });
});

describe("telling the phone how a run ended", () => {
  let endings: [string, string][];
  const begin = () => {
    endings = [];
    return start({ ended: (_, end, at) => void endings.push([end, at]) });
  };
  const wait = (ms: number) => {
    clock += ms;
    sessions.tick(new Date(clock));
  };
  const interrupted = () => result(0, { subtype: "error_during_execution", is_error: true, errors: [] });

  test("a background command's run is told finished once, after its wake turn, never while the command runs", async () => {
    await begin();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bp4", "toolu_bg", "Sleep")), level(shellTask("bp4", "toolu_bg", "Sleep")), result());
    await flush();
    wait(END_SETTLE_MS + 1);
    q.emit(completed("bp4"), notifiedOf("bp4", "toolu_bg"), level());
    await flush();
    wait(END_SETTLE_MS + 1);
    expect(endings).toEqual([]);
    q.emit(wakeInit(), result());
    await flush();
    const restedAt = new Date(clock).toISOString();
    wait(END_SETTLE_MS - 1);
    expect(endings).toEqual([]);
    wait(1);
    wait(END_SETTLE_MS);
    expect(endings).toEqual([["finished", restedAt]]);
  });

  test("a run the user stopped is never told; one where they stopped only a task is told finished", async () => {
    await begin();
    await send("Work");
    const q = queries[0]!;
    q.emit(toolCall("toolu_p", "Bash", { command: "perl -e 'sleep 40'" }));
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    q.emit(interrupted());
    await flush();
    wait(END_SETTLE_MS);
    expect(endings).toEqual([]);

    await send("Again", "c_again");
    const shell = shellTask("bk", "toolu_k", "sleep 600");
    q.emit(taskStarted(shell), level(shell), result());
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } });
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level());
    await flush();
    wait(END_SETTLE_MS);
    expect(endings.map(([end]) => end)).toEqual(["finished"]);
  });

  test("a failed run is told failed", async () => {
    await begin();
    await send("Work");
    queries[0]!.emit(result(0, { subtype: "error_during_execution", is_error: true, errors: ["overloaded"] }));
    await flush();
    wait(END_SETTLE_MS);
    expect(endings.map(([end]) => end)).toEqual(["failed"]);
  });

  test("a run a bridge restart cut off is told lost once, at the restart, and not again after another restart", async () => {
    await begin();
    await send("Work");
    queries[0]!.emit(toolCall("toolu_p", "Bash", { command: "make" }));
    await flush();
    const restart = async () => {
      sessions.stop();
      queries.length = 0;
      await start({ ended: (_, end, at) => void endings.push([end, at]) });
      await flush();
    };
    await restart();
    const lostAt = (await rowOf(ASK)).outcome?.at;
    expect(endings).toEqual([["lost", lostAt!]]);
    await restart();
    wait(END_SETTLE_MS);
    expect(endings).toEqual([["lost", lostAt!]]);
  });

  test("background work found gone after a restart, with no turn cut, is not told as a lost run", async () => {
    const gone = backgroundCommand("bk");
    await gone.end();
    shells = async () => new Map([["bk", gone.pid]]);
    await begin();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bk", "toolu_k", "sleep 600")), level(shellTask("bk", "toolu_k", "sleep 600")), result());
    await flush();
    await flush();
    sessions.stop();
    queries.length = 0;
    await start({ ended: (_, end, at) => void endings.push([end, at]) });
    for (let i = 0; i < 50 && (await rowOf(ASK)).outcome?.kind !== "lost"; i++) await Bun.sleep(20);
    expect([(await rowOf(ASK)).outcome?.kind, endings.filter(([end]) => end === "lost")]).toEqual(["lost", []]);
  });

  test("a card nobody answers is denied at its time, with a notice that names what was refused, secrets masked", async () => {
    await start({ cardTtlMs: 90_000 });
    await send("Deploy");
    const late = asked(queries[0]!, "Bash", { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' https://x.test" });
    await flush();
    const card = (await openCard("permission")) as Extract<SessionItem, { kind: "permission" }>;
    expect(Date.parse(card.card.expiresAt) - clock).toBe(90_000);
    clock += 90_000;
    sessions.tick(new Date(clock));
    expect(await late).toMatchObject({ behavior: "deny" });
    const [notice] = (await noticesNow()).map((n) => [n.text, n.reason]);
    expect(notice![1]).toBe("approval");
    expect(notice![0]).toMatch(/^The request to allow ".+" waited 2 minutes unanswered, so it was denied\. You did not say no\.$/);
    expect(notice![0]).not.toContain("sk-ant-api03");
  });
});

describe("the thread says what stopped only once it did", () => {
  const interrupted = () => result(0, { subtype: "error_during_execution", is_error: true, errors: [] });
  const stopLines = async () => (await noticesNow()).filter((n) => n.reason === "stop").map((n) => n.text);
  const restartLines = async () => (await noticesNow()).filter((n) => n.reason === "restart").map((n) => n.text);
  const restart = async () => {
    sessions.stop();
    queries.length = 0;
    await start();
    await flush();
  };
  const until = async (what: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await what()); i++) await Bun.sleep(20);
  };
  /** Claude Code started a background command bk and the bridge found its shell; the Mac runs it as `pid`. */
  const startedInBackground = async (pids: Record<string, number>) => {
    shells = async () => new Map(Object.entries(pids));
    await start();
    await send("Start it");
    const q = queries[0]!;
    const ids = Object.keys(pids);
    await transcribe(...ids.flatMap((id) => [calledEntry(`toolu_${id}`, "Bash", { command: `sleep ${id}`, run_in_background: true }), resultEntry(`toolu_${id}`, `Command running in background with ID: ${id}.`)]));
    const listed = ids.map((id) => shellTask(id, `toolu_${id}`, `sleep ${id}`));
    q.emit(...listed.map(taskStarted), level(...listed), result());
    await flush();
    await flush();
    return q;
  };

  test("a stop Claude Code takes before the turn it aims at begins reaches that turn as it begins, and only then is it said", async () => {
    await start();
    await send("Run three commands", "c_3");
    const q = queries[0]!;
    // Claude Code is paused: the message waits in its input, and no turn has begun.
    expect(await handle({ type: "session_stop", sessionId: ASK, target: "turn" })).toEqual([]);
    expect([q.interrupts, await stopLines(), (await controlsNow()).working]).toEqual([1, [], true]);
    // It resumes, takes the interrupt while no turn runs, then begins the turn for the message.
    q.emit(sys("init", { user_message_uuids: [q.uuids[0]] }));
    await flush();
    expect([q.interrupts, await stopLines()]).toEqual([2, []]);
    q.emit(interrupted());
    await flush();
    expect(await stopLines()).toEqual(["Stopped by you before Claude replied."]);
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "stopped" } });
  });

  test("a turn Claude Code finishes before the stop reaches it reads finished, and the thread says the stop came too late", async () => {
    await start();
    await send("Say hi");
    const q = queries[0]!;
    q.emit(sys("init", { user_message_uuids: [q.uuids[0]] }));
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    expect(await stopLines()).toEqual([]);
    q.emit(result(0.01, { session_id: ASK }));
    await flush();
    expect([q.interrupts, await stopLines()]).toEqual([1, ["Claude finished this turn before your stop reached it."]]);
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished" } });
  });

  test("two stops of one task that Claude Code confirms late name it once", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    const shell = shellTask("bk", "toolu_k", "sleep 470");
    q.emit(taskStarted(shell), level(shell), result());
    await flush();
    let take = () => {};
    q.holdStop = new Promise<void>((r) => (take = r));
    const late = [{ type: "error" as const, message: expect.stringContaining("not confirmed"), about: { kind: "stop" as const, sessionId: ASK } }];
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual(late);
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual(late);
    take();
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level());
    await flush();
    expect(await stopLines()).toEqual(['Claude Code has not confirmed the stop of command "sleep 470" yet.', 'Stopped by you: command "sleep 470".']);
  }, 15_000);

  test("a task stop Claude Code confirms on the second try is named once", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    const shell = shellTask("bk", "toolu_k", "sleep 470");
    q.emit(taskStarted(shell), level(shell), result());
    await flush();
    let take = () => {};
    q.holdStop = new Promise<void>((r) => (take = r));
    await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } });
    take();
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level());
    await flush();
    expect((await stopLines()).filter((t) => t.startsWith("Stopped by you"))).toEqual(['Stopped by you: command "sleep 470".']);
  }, 10_000);

  test("a stop of one background task leaves the turn Claude Code answered reading finished", async () => {
    await start();
    await send("Start it and carry on");
    const q = queries[0]!;
    const shell = shellTask("bk", "toolu_k", "sleep 300");
    q.emit(taskStarted(shell), level(shell));
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), level(), result(0.01, { session_id: ASK }));
    await flush();
    expect(await stopLines()).toEqual(['Stopped by you: command "sleep 300".']);
    expect(await rowOf(ASK)).toMatchObject({ status: "idle", outcome: { kind: "finished" } });
  });

  test("with no Claude Code running, a model the phone does not offer is refused and not kept", async () => {
    await start();
    expect(await handle({ type: "session_set", sessionId: ASK, patch: { model: "claude-nope" } })).toEqual([
      { type: "error", message: expect.stringContaining("claude-nope"), about: { kind: "set", sessionId: ASK } },
    ]);
    expect((await controlsNow()).model).toBeNull();
    expect(await handle({ type: "session_set", sessionId: ASK, patch: { model: "sonnet" } })).toEqual([]);
    await send("Hi");
    expect(queries[0]!.options.model).toBe("sonnet");
  });

  test("after a restart, a background command still running on the Mac is said to run, stays a task Stop can end, and one that ended is said to have stopped", async () => {
    const running = backgroundCommand("bk");
    const ended = backgroundCommand("bw");
    await ended.end();
    try {
      await startedInBackground({ bk: running.pid, bw: ended.pid });
      await restart();
      await until(async () => (await restartLines()).length === 2);
      expect(await restartLines()).toEqual([
        "The bridge restarted, so Claude Code's background work stopped: sleep bw.",
        'The bridge restarted, and Claude Code no longer follows command "sleep bk", which still runs on this Mac. Stop ends it.',
      ]);
      expect((await controlsNow()).tasks?.map((t) => [t.id, t.label, t.stepId])).toEqual([["bk", "sleep bk", "toolu_bk"]]);
      expect([(await controlsNow()).working, (await rowOf(ASK)).status]).toEqual([true, "working"]);
      expect((await stepOf("toolu_bk")).state).toBe("running");
      expect(await stepOf("toolu_bw")).toMatchObject({ state: "stopped", cause: "The bridge restarted" });

      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
      expect(alive(running.pid)).toBe(false);
      expect((await stopLines()).at(-1)).toBe('Stopped by you: command "sleep bk".');
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
      expect((await controlsNow()).working).toBe(false);
    } finally {
      await running.end();
    }
  });

  test("a background command that outlived Claude Code and then ends is said to have ended, and the session rests", async () => {
    const running = backgroundCommand("bk");
    try {
      await startedInBackground({ bk: running.pid });
      await restart();
      await until(async () => (await controlsNow()).working === true);
      await running.end();
      clock += 10_000;
      sessions.tick(new Date(clock));
      await until(async () => (await controlsNow()).working === false);
      expect((await noticesNow()).at(-1)?.text).toBe('Command "sleep bk" ended. Claude Code no longer followed it, so how it ended is not known.');
      expect((await rowOf(ASK)).status).toBe("idle");
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "ended", cause: "It ended without a result" });
    } finally {
      await running.end();
    }
  });

  test("a saved group that is alive but does not write the command's output may still be it: said so and settled, never signalled, and its end is said once", async () => {
    const other = backgroundCommand("someone-else");
    try {
      await startedInBackground({ bk: other.pid });
      await restart();
      await until(async () => (await restartLines()).length === 1);
      expect(await restartLines()).toEqual(["The bridge restarted, and Claude Code's background work may still run on this Mac: sleep bk."]);
      expect([(await controlsNow()).tasks, (await controlsNow()).working, alive(other.pid), (await rowOf(ASK)).status]).toEqual([[], false, true, "idle"]);
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "unsure", cause: "Can't tell whether this still runs on your Mac" });
      clock += 10_000;
      sessions.tick(new Date(clock));
      await flush();
      expect(alive(other.pid)).toBe(true);
      await other.end();
      for (const s of [10_000, 40_000, 40_000]) {
        clock += s;
        sessions.tick(new Date(clock));
        await until(async () => (await noticesNow()).some((n) => n.text.includes("ended.")));
      }
      expect((await noticesNow()).filter((n) => n.text.includes("ended.")).map((n) => n.text)).toEqual(['Command "sleep bk" ended. Claude Code no longer followed it, so how it ended is not known.']);
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "ended", cause: "It ended without a result" });
    } finally {
      await other.end();
    }
  });

  test("after a restart, background work the bridge could not look up is said to maybe still run, and its step is not cut off", async () => {
    await startedInBackground({});
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bk", "toolu_k", "sleep 600")), level(shellTask("bk", "toolu_k", "sleep 600")));
    await transcribe(calledEntry("toolu_k", "Bash", { command: "sleep 600", run_in_background: true }), resultEntry("toolu_k", "Command running in background with ID: bk."));
    await flush();
    await restart();
    await until(async () => (await restartLines()).length === 1);
    expect(await restartLines()).toEqual(["The bridge restarted, and Claude Code's background work may still run on this Mac: sleep 600."]);
    expect((await rowOf(ASK)).outcome?.kind).not.toBe("lost");
    expect([(await stepOf("toolu_k")), (await controlsNow()).working]).toMatchObject([{ state: "unsure", cause: "Can't tell whether this still runs on your Mac" }, false]);
  });

  test("background work saved by an older bridge, with no group or step, is said to maybe still run and its step is not cut off", async () => {
    await startedInBackground({});
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_k", "Bash", { command: "sleep 600", run_in_background: true }), resultEntry("toolu_k", "Command running in background with ID: bk."));
    q.emit(taskStarted(shellTask("bk", "toolu_k", "sleep 600")), level(shellTask("bk", "toolu_k", "sleep 600")));
    await flush();
    sessions.stop();
    (world.sessions.get(ASK)!.own!.session as { background?: unknown }).background = [{ id: "bk", description: "sleep 600" }];
    queries.length = 0;
    await start();
    await until(async () => (await restartLines()).length === 1);
    expect(await restartLines()).toEqual(["The bridge restarted, and Claude Code's background work may still run on this Mac: sleep 600."]);
    expect(await stepOf("toolu_k")).toMatchObject({ state: "unsure", cause: "Can't tell whether this still runs on your Mac" });
  });

  test("a later Claude Code's word that a command the bridge cannot tell about stopped is not taken either", async () => {
    const other = backgroundCommand("someone-else");
    try {
      await startedInBackground({ bk: other.pid });
      await restart();
      await until(async () => (await restartLines()).length === 1);
      await send("Say hi", "c_hi");
      await transcribe({
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>bk</task-id>\n<tool-use-id>toolu_bk</tool-use-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>",
        },
      });
      expect((await noticesNow()).map((n) => n.text).filter((t) => t.includes("didn't finish"))).toEqual([]);
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "unsure", cause: "Can't tell whether this still runs on your Mac" });
    } finally {
      await other.end();
    }
  });

  test("after a restart, a later Claude Code's word that an outlived command stopped is not taken: it still runs and shows so", async () => {
    const running = backgroundCommand("bk");
    try {
      await startedInBackground({ bk: running.pid });
      await restart();
      await until(async () => (await controlsNow()).working === true);
      await send("Say hi", "c_hi");
      await transcribe({
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>bk</task-id>\n<tool-use-id>toolu_bk</tool-use-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>",
        },
      });
      expect((await noticesNow()).map((n) => n.text).filter((t) => t.includes("didn't finish"))).toEqual([]);
      expect((await stepOf("toolu_bk")).state).toBe("running");
      expect((await controlsNow()).tasks?.map((t) => t.id)).toEqual(["bk" as TaskId]);
      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
      expect((await noticesNow()).map((n) => n.text).filter((t) => t.includes("didn't finish"))).toEqual([]);
    } finally {
      await running.end();
    }
  });

  test("an outlived command that stops writing its output is let go as unsure, and a Stop then refuses rather than claims", async () => {
    const running = backgroundCommand("bk");
    try {
      await startedInBackground({ bk: running.pid });
      await restart();
      await until(async () => (await controlsNow()).working === true);
      await running.redirect();
      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([
        { type: "error", message: expect.stringContaining("did not stop it"), about: { kind: "stop", sessionId: ASK } },
      ]);
      expect(alive(running.pid)).toBe(true);
      expect((await noticesNow()).map((n) => n.text).filter((t) => t.startsWith("Stopped by you"))).toEqual([]);
      expect((await noticesNow()).at(-1)?.text).toContain("may still run on this Mac");
      expect([(await controlsNow()).working, await stepOf("toolu_bk")]).toMatchObject([false, { state: "unsure", cause: "Can't tell whether this still runs on your Mac" }]);
    } finally {
      await running.end();
    }
  });

  test("the poll lets an outlived command go as unsure when it stops writing its output, and never says it ended", async () => {
    const running = backgroundCommand("bk");
    try {
      await startedInBackground({ bk: running.pid });
      await restart();
      await until(async () => (await controlsNow()).working === true);
      await running.redirect();
      clock += 10_000;
      sessions.tick(new Date(clock));
      await until(async () => (await controlsNow()).working === false);
      const said = (await noticesNow()).map((n) => n.text);
      expect(said.some((t) => t.includes("ended"))).toBe(false);
      expect(said.at(-1)).toContain("may still run on this Mac");
      expect(alive(running.pid)).toBe(true);
    } finally {
      await running.end();
    }
  });

  test("a state write that fails while the bridge looks at outlived commands is logged, not thrown", async () => {
    const running = backgroundCommand("bk");
    const logs: string[] = [];
    let failing = false;
    try {
      shells = async () => new Map([["bk", running.pid]]);
      const over = {
        persist: () => {
          if (failing) throw new Error("EACCES: state.json");
        },
        log: (l: string) => void logs.push(l),
      };
      await start(over);
      await send("Start it");
      const q = queries[0]!;
      q.emit(taskStarted(shellTask("bk", "toolu_bk", "sleep bk")), level(shellTask("bk", "toolu_bk", "sleep bk")), result());
      await flush();
      await flush();
      sessions.stop();
      queries.length = 0;
      await start(over);
      await until(async () => (await controlsNow()).working === true);
      await running.end();
      failing = true;
      clock += 10_000;
      sessions.tick(new Date(clock));
      await until(async () => logs.some((l) => l.includes("looking at outlived commands failed")));
      expect(logs.filter((l) => l.includes("looking at outlived commands failed"))).toHaveLength(1);
      failing = false;
      clock += 10_000;
      sessions.tick(new Date(clock));
      await until(async () => (await noticesNow()).some((n) => n.text.includes("ended.")));
      expect((await noticesNow()).at(-1)?.text).toBe('Command "sleep bk" ended. Claude Code no longer followed it, so how it ended is not known.');
      expect((await controlsNow()).working).toBe(false);
    } finally {
      failing = false;
      await running.end();
    }
  });

  test("a second Stop of an outlived command queued behind the first, as one phone sends them, is not refused", async () => {
    const running = backgroundCommand("bk");
    try {
      await startedInBackground({ bk: running.pid });
      await restart();
      await until(async () => (await controlsNow()).working === true);
      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
      expect((await stopLines()).filter((t) => t.startsWith("Stopped by you"))).toEqual(['Stopped by you: command "sleep bk".']);
    } finally {
      await running.end();
    }
  });

  test("a command found only by its shell's command line is checked again after a restart, and its end is said once", async () => {
    const shell = backgroundCommand("not-its-output");
    try {
      leaders = async () => [{ group: shell.pid, command: "/bin/zsh -c source snap.sh && eval 'sleep bk' < /dev/null" }];
      await startedInBackground({});
      const q = queries[0]!;
      await transcribe(calledEntry("toolu_bk", "Bash", { command: "sleep bk", run_in_background: true }), resultEntry("toolu_bk", "Command running in background with ID: bk."));
      q.emit(toolCall("toolu_bk", "Bash", { command: "sleep bk" }), taskStarted(shellTask("bk", "toolu_bk", "Sleep")), level(shellTask("bk", "toolu_bk", "Sleep")), result());
      await flush();
      await flush();
      await restart();
      await until(async () => (await restartLines()).length === 1);
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "unsure", cause: "Can't tell whether this still runs on your Mac" });
      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([
        { type: "error", message: expect.stringContaining("can't tell whether"), about: { kind: "stop", sessionId: ASK } },
      ]);
      expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([
        { type: "error", message: expect.stringContaining("can't tell whether"), about: { kind: "stop", sessionId: ASK } },
      ]);
      expect(alive(shell.pid)).toBe(true);
      await shell.end();
      for (const gap of [40_000, 40_000]) {
        clock += gap;
        sessions.tick(new Date(clock));
        await until(async () => (await noticesNow()).some((n) => n.text.includes("ended.")));
      }
      expect((await noticesNow()).filter((n) => n.text.includes("ended.")).map((n) => n.text)).toEqual(['Command "sleep bk" ended. Claude Code no longer followed it, so how it ended is not known.']);
      expect(await stepOf("toolu_bk")).toMatchObject({ state: "ended", cause: "It ended without a result" });
    } finally {
      await shell.end();
    }
  });

  test("between a task's end and the wake turn it announces, its step is not cut off as ended before its result lands", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_bg", "Bash", { command: "sleep 8", run_in_background: true }), resultEntry("toolu_bg", "Command running in background with ID: bp."));
    q.emit(taskStarted(shellTask("bp", "toolu_bg", "sleep 8")), level(shellTask("bp", "toolu_bg", "sleep 8")), result());
    await flush();
    // Claude Code marks the task completed a moment before it notifies and before its result reaches the transcript.
    q.emit(completed("bp"));
    await flush();
    expect((await stepOf("toolu_bg")).state).toBe("running");
    q.emit(notifiedOf("bp", "toolu_bg"), level());
    await flush();
    expect((await stepOf("toolu_bg")).state).toBe("running");
    q.emit(wakeInit());
    await flush();
    expect((await controlsNow()).working).toBe(true);
  });

  test("a model change Claude Code's query closed under is refused in plain words", async () => {
    await start();
    await send("Go");
    queries[0]!.setModel = async () => {
      throw new Error("Query closed before response received");
    };
    expect(await handle({ type: "session_set", sessionId: ASK, patch: { model: "opus" } })).toEqual([
      { type: "error", message: "Claude Code did not take the change: Claude Code stopped before it answered. Try again.", about: { kind: "set", sessionId: ASK } },
    ]);
  });

  test("a shell is paired with a command only when it runs exactly that command, so a near twin never takes another's end", async () => {
    const a = backgroundCommand("not-a");
    const b = backgroundCommand("not-b");
    try {
      const evalOf = (cmd: string) => `/bin/zsh -c source snap.sh && eval '${cmd}' < /dev/null && pwd -P >| /tmp/cwd`;
      leaders = async () => [
        { group: a.pid, command: evalOf("exec >/dev/null 2>&1;  sleep 3431") },
        { group: b.pid, command: evalOf("exec >/dev/null 2>&1; sleep 34312") },
      ];
      await start();
      await send("Start them");
      const q = queries[0]!;
      const cmds = { ba: "exec >/dev/null 2>&1;  sleep 3431", bb: "exec >/dev/null 2>&1; sleep 34312" };
      await transcribe(...Object.entries(cmds).flatMap(([id, command]) => [calledEntry(`toolu_${id}`, "Bash", { command, run_in_background: true }), resultEntry(`toolu_${id}`, `Command running in background with ID: ${id}.`)]));
      const listed = Object.keys(cmds).map((id) => shellTask(id, `toolu_${id}`, "Sleep"));
      q.emit(...Object.entries(cmds).map(([id, command]) => toolCall(`toolu_${id}`, "Bash", { command })), ...listed.map(taskStarted), level(...listed), result());
      await flush();
      await flush();
      await restart();
      await until(async () => (await restartLines()).length === 1);
      await b.end();
      for (const gap of [40_000, 40_000]) {
        clock += gap;
        sessions.tick(new Date(clock));
        await until(async () => (await noticesNow()).some((n) => n.text.includes("ended.")));
      }
      expect((await noticesNow()).filter((n) => n.text.includes("ended.")).map((n) => n.text)).toEqual([
        'Command "exec >/dev/null 2>&1; sleep 34312" ended. Claude Code no longer followed it, so how it ended is not known.',
      ]);
      expect([(await stepOf("toolu_ba")).state, (await stepOf("toolu_bb")).state, alive(a.pid)]).toEqual(["unsure", "ended", true]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("work the bridge cannot check stays so across another restart: until a new run, Stop says it cannot tell", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    const listed = [shellTask("bu", "toolu_bu", "Sleep")];
    q.emit(toolCall("toolu_bu", "Bash", { command: "exec >/dev/null 2>&1; sleep 3641 # café" }), taskStarted(listed[0]!), level(...listed), result());
    await flush();
    await flush();
    const stopAll = async () => handle({ type: "session_stop", sessionId: ASK, target: "all" });
    const cantTell: ServerMessage[] = [{ type: "error", message: "The bridge can't tell whether its background work still runs on your Mac, so it has nothing it can stop.", about: { kind: "stop", sessionId: ASK } }];
    await restart();
    await until(async () => (await restartLines()).length === 1);
    expect(await stopAll()).toEqual(cantTell);
    await restart();
    expect(await stopAll()).toEqual(cantTell);
    await send("Say hi");
    queries.at(-1)!.emit(result());
    await flush();
    expect(await stopAll()).toEqual([{ type: "error", message: "Nothing is running.", about: { kind: "stop", sessionId: ASK } }]);
  });

  test("a look at what became of a crashed Claude Code's work that never answers is given up on: the work may still run", async () => {
    const running = backgroundCommand("bk");
    try {
      const q = await startedInBackground({ bk: running.pid });
      taskRunOf = () => new Promise<TaskRun>(() => {});
      jest.useFakeTimers();
      try {
        q.crash("Claude Code process terminated by signal SIGKILL");
        for (let i = 0; i < 20; i++) await Promise.resolve();
        jest.advanceTimersByTime(EXIT_SETTLE_MS);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        jest.advanceTimersByTime(GONE_LOOK_MAX_MS - 1);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect([(await stepOf("toolu_bk")).state, (await noticesNow()).some((n) => n.text.includes("may still run"))]).toEqual(["running", false]);
        jest.advanceTimersByTime(1);
      } finally {
        jest.useRealTimers();
      }
      await until(async () => (await noticesNow()).some((n) => n.text.includes("may still run")));
      expect([(await stepOf("toolu_bk")).state, (await controlsNow()).working]).toEqual(["unsure", false]);
    } finally {
      await running.end();
    }
  });

  test("two shells running the same command are paired with neither", async () => {
    const a = backgroundCommand("not-a");
    const b = backgroundCommand("not-b");
    try {
      const line = "/bin/zsh -c source snap.sh && eval 'sleep twin' < /dev/null";
      leaders = async () => [
        { group: a.pid, command: line },
        { group: b.pid, command: line },
      ];
      await start();
      await send("Start them");
      const q = queries[0]!;
      const ids = ["ba", "bb"];
      const listed = ids.map((id) => shellTask(id, `toolu_${id}`, "Sleep"));
      q.emit(...ids.map((id) => toolCall(`toolu_${id}`, "Bash", { command: "sleep twin" })), ...listed.map(taskStarted), level(...listed), result());
      await flush();
      await flush();
      await a.end();
      await restart();
      await until(async () => (await restartLines()).length === 1);
      expect(await restartLines()).toEqual(["The bridge restarted, and Claude Code's background work may still run on this Mac: Sleep; Sleep."]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("each background command gets its own lookups, so a fourth one started later is still followed", async () => {
    const cmds = ["b1", "b2", "b3", "b4"].map((id) => [id, backgroundCommand(id)] as const);
    try {
      shells = async () => new Map(cmds.map(([id, c]) => [id, c.pid]));
      await start();
      await send("Start them");
      const q = queries[0]!;
      for (const [id] of cmds) {
        q.emit(taskStarted(shellTask(id, `toolu_${id}`, `sleep ${id}`)), level(...cmds.slice(0, cmds.findIndex(([x]) => x === id) + 1).map(([x]) => shellTask(x, `toolu_${x}`, `sleep ${x}`))));
        await flush();
        await flush();
      }
      q.emit(result());
      await flush();
      await restart();
      await until(async () => (await restartLines()).length === 1);
      expect((await controlsNow()).tasks?.map((t) => t.id)).toEqual(["b1", "b2", "b3", "b4"] as TaskId[]);
    } finally {
      for (const [, c] of cmds) await c.end();
    }
  });

  test("while what became of a crashed Claude Code's background work is looked up, its step is not cut off as ended", async () => {
    const running = backgroundCommand("bk");
    try {
      const q = await startedInBackground({ bk: running.pid });
      q.crash("Claude Code process terminated by signal SIGKILL");
      await flush();
      await flush();
      expect([(await stepOf("toolu_bk")).state, (await rowOf(ASK)).status]).toEqual(["running", "idle"]);
      await until(async () => (await noticesNow()).some((n) => n.text.includes("still runs")));
      expect([(await stepOf("toolu_bk")).state, (await controlsNow()).working]).toEqual(["running", true]);
    } finally {
      await running.end();
    }
  });

  test("two Stops of one outlived command at once name it once", async () => {
    const running = backgroundCommand("bk");
    try {
      await startedInBackground({ bk: running.pid });
      await restart();
      await until(async () => (await controlsNow()).working === true);
      const stops = [0, 1].map(() => handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } }));
      expect(await Promise.all(stops)).toEqual([[], []]);
      expect((await stopLines()).filter((t) => t.startsWith("Stopped by you"))).toEqual(['Stopped by you: command "sleep bk".']);
    } finally {
      await running.end();
    }
  });

  test("a Stop sent before an announced wake turn begins keeps it from running and claims nothing", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bp", "toolu_bg", "Sleep")), level(shellTask("bp", "toolu_bg", "Sleep")), result());
    await flush();
    q.emit(completed("bp"), notifiedOf("bp", "toolu_bg"), level());
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([]);
    q.emit(wakeInit());
    await flush();
    expect(q.interrupts).toBe(2);
    q.emit(interrupted());
    await flush();
    expect(await stopLines()).toEqual([]);
    expect((await controlsNow()).working).toBe(false);
  });

  test("a single task's Stop with nothing else running leaves the session at rest while Claude Code only queues the notification", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bk", "toolu_k", "sleep 305")), level(shellTask("bk", "toolu_k", "sleep 305")), result());
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } })).toEqual([]);
    q.emit(sys("task_updated", { task_id: "bk", patch: { status: "killed" } }), notifiedOf("bk", "toolu_k", "stopped"), level());
    await flush();
    clock += 25_000;
    sessions.tick(new Date(clock));
    await flush();
    expect([(await controlsNow()).working, (await controlsNow()).turn, (await rowOf(ASK)).status]).toEqual([false, undefined, "idle"]);
  });

  test("Stop of everything during a wake turn says the tasks it stopped at once, whether or not the turn ends", async () => {
    await start();
    await send("Start them");
    const q = queries[0]!;
    const shells2 = [shellTask("b2", "toolu_2", "sleep 302"), shellTask("b3", "toolu_3", "sleep 303")];
    q.emit(...shells2.map(taskStarted), level(...shells2), result());
    await flush();
    q.emit(wakeInit());
    await flush();
    expect(await handle({ type: "session_stop", sessionId: ASK })).toEqual([]);
    expect(await stopLines()).toEqual(['Stopped by you: command "sleep 302" and command "sleep 303".']);
    expect((await rowOf(ASK)).outcome?.kind).toBe("stopped");
  });

  test("a wake turn that finishes before the Stop reaches it reads finished", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bp", "toolu_bg", "Sleep")), level(shellTask("bp", "toolu_bg", "Sleep")), result());
    await flush();
    q.emit(completed("bp"), notifiedOf("bp", "toolu_bg"), level(), wakeInit());
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    q.emit(result(0.01));
    await flush();
    expect(await stopLines()).toEqual(["Claude finished this turn before your stop reached it."]);
    expect((await rowOf(ASK)).outcome?.kind).toBe("finished");
  });

  test("a wake turn's Stop is not said when the user sends while that turn still runs", async () => {
    await start();
    await send("Start it");
    const q = queries[0]!;
    q.emit(taskStarted(shellTask("bp", "toolu_bg", "Sleep")), level(shellTask("bp", "toolu_bg", "Sleep")), result());
    await flush();
    q.emit(completed("bp"), notifiedOf("bp", "toolu_bg"), level(), wakeInit());
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    await send("Next");
    expect(await stopLines()).toEqual([]);
  });

  test("a foreground subagent is not said to be stopped when its turn finishes before the Stop reaches it", async () => {
    await start();
    await send("Fan out");
    const q = queries[0]!;
    q.emit(sys("init", { user_message_uuids: [q.uuids[0]] }), taskStarted({ ...agentTask("af", "toolu_af", "long sleeper"), is_backgrounded: false }));
    await flush();
    await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
    q.emit(notifiedOf("af", "toolu_af", "completed"), result(0.01, { session_id: ASK }));
    await flush();
    expect(await stopLines()).toEqual(["Claude finished this turn before your stop reached it."]);
    expect((await rowOf(ASK)).outcome?.kind).toBe("finished");
  });

  test("a late task stop is not confirmed by Claude Code exiting: what the Mac still runs is said instead", async () => {
    const running = backgroundCommand("bk");
    try {
      const q = await startedInBackground({ bk: running.pid });
      q.holdStop = new Promise<void>(() => {});
      await handle({ type: "session_stop", sessionId: ASK, target: { task: "bk" as TaskId } });
      q.crash("Claude Code process exited with code 1");
      await until(async () => (await noticesNow()).some((n) => n.text.includes("still runs")));
      const said = (await noticesNow()).map((n) => n.text);
      expect(said.filter((t) => t.startsWith("Stopped by you"))).toEqual([]);
      expect(said.at(-1)).toBe('Claude Code is no longer running, but command "sleep bk" still runs on this Mac. Stop ends it.');
    } finally {
      await running.end();
    }
  }, 15_000);

  /** A turn runs `perl -e 'sleep bf'` in the foreground; Claude Code has made it a task and the bridge found its shell. */
  const runningInForeground = async (pids: Record<string, number>) => {
    shells = async () => new Map(Object.entries(pids));
    await start();
    await send("Run it");
    const q = queries[0]!;
    await transcribe(calledEntry("toolu_bf", "Bash", { command: "perl -e 'sleep bf'" }));
    q.emit(toolCall("toolu_bf", "Bash", { command: "perl -e 'sleep bf'" }), taskStarted({ ...shellTask("bf", "toolu_bf", "Sleep"), is_backgrounded: false }));
    await flush();
    await flush();
    return q;
  };

  test("after a restart, a foreground command still running on the Mac is said to run, stays a task Stop can end, and its step is never cut off", async () => {
    const running = backgroundCommand("bf");
    try {
      await runningInForeground({ bf: running.pid });
      await restart();
      await until(async () => (await restartLines()).length === 2);
      expect(await restartLines()).toEqual([
        "The bridge restarted during this turn.",
        `The bridge restarted, and Claude Code no longer follows command "perl -e 'sleep bf'", which still runs on this Mac. Stop ends it.`,
      ]);
      expect((await controlsNow()).tasks?.map((t) => [t.id, t.label, t.stepId])).toEqual([["bf", "perl -e 'sleep bf'", "toolu_bf"]]);
      expect([(await stepOf("toolu_bf")).state, (await controlsNow()).working, (await rowOf(ASK)).outcome?.kind]).toEqual(["running", true, "lost"]);
      // A later Claude Code writes off the call it never saw end; the command still runs.
      const interrupted = "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown.]";
      await transcribe({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bf", content: interrupted, is_error: true }] } });
      expect((await stepOf("toolu_bf")).state).toBe("running");

      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bf" as TaskId } })).toEqual([]);
      expect(alive(running.pid)).toBe(false);
      expect((await stopLines()).at(-1)).toBe(`Stopped by you: command "perl -e 'sleep bf'".`);
      expect(await stepOf("toolu_bf")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
    } finally {
      await running.end();
    }
  });

  test("when Claude Code dies under a foreground command that still runs, the run fails but the command is said to run and Stop can end it", async () => {
    const running = backgroundCommand("bf");
    try {
      const q = await runningInForeground({ bf: running.pid });
      q.crash("Claude Code process terminated by signal SIGKILL");
      await until(async () => (await noticesNow()).some((n) => n.text.includes("still runs")));
      expect((await noticesNow()).map((n) => n.text.split("\n")[0])).toEqual([
        "Claude Code stopped unexpectedly. Send a message to start it again.",
        `Claude Code is no longer running, but command "perl -e 'sleep bf'" still runs on this Mac. Stop ends it.`,
      ]);
      expect([(await stepOf("toolu_bf")).state, (await controlsNow()).tasks?.map((t) => t.id as string)]).toEqual(["running", ["bf"]]);
      expect((await rowOf(ASK)).outcome).toMatchObject({ kind: "failed", text: "Claude Code stopped unexpectedly (terminated by signal SIGKILL)" });
      expect(await handle({ type: "session_stop", sessionId: ASK, target: { task: "bf" as TaskId } })).toEqual([]);
      expect(alive(running.pid)).toBe(false);
    } finally {
      await running.end();
    }
  }, 15_000);

  test("a foreground command gone with its Claude Code reads cut off, with no notice of its own", async () => {
    const gone = backgroundCommand("bf");
    await gone.end();
    await runningInForeground({ bf: gone.pid });
    await restart();
    await until(async () => (await stepOf("toolu_bf")).state !== "running");
    expect(await restartLines()).toEqual(["The bridge restarted during this turn."]);
    expect(await stepOf("toolu_bf")).toMatchObject({ state: "stopped", cause: "The bridge restarted" });
  });

  test("while the bridge looks up what a restart left of a turn, a background step it may still run is not cut off as stopped", async () => {
    const running = backgroundCommand("bk");
    let answer: (r: TaskRun) => void = () => {};
    try {
      shells = async () => new Map([["bk", running.pid]]);
      await start();
      await send("Start it and carry on");
      const q = queries[0]!;
      await transcribe(calledEntry("toolu_bk", "Bash", { command: "sleep bk", run_in_background: true }), resultEntry("toolu_bk", "Command running in background with ID: bk."), calledEntry("toolu_r", "Read", { file_path: "/x" }));
      q.emit(taskStarted(shellTask("bk", "toolu_bk", "sleep bk")), level(shellTask("bk", "toolu_bk", "sleep bk")), toolCall("toolu_r", "Read", { file_path: "/x" }));
      await flush();
      await flush();
      taskRunOf = () => new Promise<TaskRun>((r) => (answer = r));
      await restart();
      expect([(await stepOf("toolu_bk")).state, (await stepOf("toolu_r")).state]).toEqual(["running", "running"]);
      answer("runs");
      await until(async () => (await restartLines()).length === 2);
      expect([(await stepOf("toolu_bk")).state, (await stepOf("toolu_r")).state]).toEqual(["running", "stopped"]);
    } finally {
      answer("gone");
      await running.end();
    }
  });

  test("when Claude Code dies during a turn, a background command it left running never reads failed, not even before the bridge looks", async () => {
    const running = backgroundCommand("bk");
    try {
      const q = await startedInBackground({ bk: running.pid });
      await send("Carry on", "c_on");
      q.emit(toolCall("toolu_r", "Read", { file_path: "/x" }));
      await flush();
      q.crash("Claude Code process terminated by signal SIGKILL");
      await flush();
      await flush();
      expect((await stepOf("toolu_bk")).state).toBe("running");
      await until(async () => (await noticesNow()).some((n) => n.text.includes("still runs")));
      expect((await stepOf("toolu_bk")).state).toBe("running");
    } finally {
      await running.end();
    }
  }, 15_000);

  test("a stop Claude Code never confirms ends with Claude Code closed, and work it left running is said to run, never to have stopped", async () => {
    const bg = backgroundCommand("bk");
    const fg = backgroundCommand("bf");
    try {
      shells = async () => new Map([["bk", bg.pid], ["bf", fg.pid]]);
      await start();
      await send("Run it");
      const q = queries[0]!;
      await transcribe(calledEntry("toolu_bk", "Bash", { command: "sleep bk", run_in_background: true }), resultEntry("toolu_bk", "Command running in background with ID: bk."), calledEntry("toolu_bf", "Bash", { command: "perl -e 'sleep bf'" }));
      q.emit(
        taskStarted(shellTask("bk", "toolu_bk", "sleep bk")),
        level(shellTask("bk", "toolu_bk", "sleep bk")),
        toolCall("toolu_bf", "Bash", { command: "perl -e 'sleep bf'" }),
        taskStarted({ ...shellTask("bf", "toolu_bf", "Sleep"), is_backgrounded: false }),
      );
      await flush();
      await flush();
      q.holdStop = new Promise<void>(() => {});
      await handle({ type: "session_stop", sessionId: ASK });
      clock += 15_000;
      sessions.tick(new Date(clock));
      await until(async () => (await noticesNow()).some((n) => n.text.includes("still run")));
      const said = (await noticesNow()).map((n) => n.text);
      expect(said.filter((t) => /stopped: |work stopped/.test(t) && /sleep b/.test(t))).toEqual([]);
      expect(said.at(-1)).toBe(`Claude Code is no longer running, but command "sleep bk" and command "perl -e 'sleep bf'" still run on this Mac. Stop ends them.`);
      expect([(await stepOf("toolu_bk")).state, (await stepOf("toolu_bf")).state, alive(bg.pid), alive(fg.pid)]).toEqual(["running", "running", true, true]);
    } finally {
      await bg.end();
      await fg.end();
    }
  }, 15_000);

  test("a foreground command gone once the bridge closed a Claude Code that never confirmed a stop is said stopped by the user", async () => {
    const fg = backgroundCommand("bf");
    try {
      const q = await runningInForeground({ bf: fg.pid });
      q.holdStop = new Promise<void>(() => {});
      await handle({ type: "session_stop", sessionId: ASK, target: "turn" });
      await fg.end();
      clock += 15_000;
      sessions.tick(new Date(clock));
      await until(async () => (await stopLines()).some((t) => t.includes("sleep bf")));
      expect(await stopLines()).toEqual(["Stopped by you: the turn.", `Stopped by you: command "perl -e 'sleep bf'".`]);
      expect(await stepOf("toolu_bf")).toMatchObject({ state: "stopped", cause: "Stopped by you" });
    } finally {
      await fg.end();
    }
  }, 15_000);

  test("a command whose command line ps writes in its own escapes, or that reads its own input, is still followed to its end after a restart", async () => {
    const shells_ = { "bé": backgroundCommand("not-its-output"), "bl": backgroundCommand("not-its-output-either") };
    const cmds = { "bé": "exec >/dev/null 2>&1; sleep 3661 # café\tx", "bl": "exec >/dev/null 2>&1; sleep 3663 < /dev/null" };
    try {
      leaders = async () => [
        { group: shells_["bé"].pid, command: "/bin/zsh -c source snap.sh && eval 'exec >/dev/null 2>&1; sleep 3661 # cafM-CM-)\\011x' < /dev/null && pwd -P >| /tmp/claude-1-cwd" },
        { group: shells_["bl"].pid, command: "/bin/zsh -c source snap.sh && eval 'exec >/dev/null 2>&1; sleep 3663 < /dev/null' && pwd -P >| /tmp/claude-2-cwd" },
      ];
      await start();
      await send("Start them");
      const q = queries[0]!;
      await transcribe(...Object.entries(cmds).flatMap(([id, command]) => [calledEntry(`toolu_${id}`, "Bash", { command, run_in_background: true }), resultEntry(`toolu_${id}`, `Command running in background with ID: ${id}.`)]));
      const listed = Object.keys(cmds).map((id) => shellTask(id, `toolu_${id}`, "Sleep"));
      q.emit(...Object.entries(cmds).map(([id, command]) => toolCall(`toolu_${id}`, "Bash", { command })), ...listed.map(taskStarted), level(...listed), result());
      await flush();
      await flush();
      await restart();
      await until(async () => (await restartLines()).length === 1);
      for (const s of Object.values(shells_)) await s.end();
      for (const gap of [40_000, 40_000]) {
        clock += gap;
        sessions.tick(new Date(clock));
        await until(async () => (await stepOf("toolu_bl")).state === "ended");
      }
      expect([(await stepOf("toolu_bé")).state, (await stepOf("toolu_bl")).state]).toEqual(["ended", "ended"]);
    } finally {
      for (const s of Object.values(shells_)) await s.end();
    }
  });
});

describe("the thread's order and how soon it shows", () => {
  const reply = (text: string) => ({ type: "assistant", message: { role: "assistant", id: `msg_${crypto.randomUUID()}`, content: [{ type: "text", text }] } });
  const prompted = (text: string) => ({ type: "user", message: { role: "user", content: text } });
  const shown = async (n: number) => (await snapshot(ASK)).items.slice(-n).map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind));
  const created = async (ref: string, text: string) => {
    const project = ((await handle({ type: "watch_sessions" }))[0] as Extract<ServerMessage, { type: "sessions" }>).projects.find((p) => p.path === repo)!;
    const [made] = await handle({ type: "session_create", ref, projectId: project.id, text, model: null, mode: "default", isolate: "none" });
    await flush();
    return (made as Extract<ServerMessage, { type: "session_created" }>).sessionId;
  };

  test("an answered card stays where it was raised, above the reply that came after it, also after a restart", async () => {
    await start();
    await send("List it");
    const q = queries[0]!;
    clock += 1_000;
    const allowed = asked(q, "Bash", { command: "ls" }, { toolUseID: "toolu_ls" });
    await flush();
    const card = (await snapshot(ASK)).items.find((i) => i.kind === "permission") as Extract<SessionItem, { kind: "permission" }>;
    clock += 1_000;
    await handle({ type: "session_decide", sessionId: ASK, cardId: card.card.id, choice: "once" });
    await allowed;
    clock += 1_000;
    await transcribe(resultEntry("toolu_ls", "a.txt"), reply("Listed."));
    expect(await shown(3)).toEqual(["work", "permission", "Listed."]);
    q.emit(result(0.01, { session_id: ASK }));
    await flush();
    sessions.stop();
    await start();
    expect(await shown(3)).toEqual(["work", "permission", "Listed."]);
  });

  test("a message queued behind a turn shows after everything, then where its turn starts once Claude Code takes it", async () => {
    await start();
    await send("First");
    clock += 10_000;
    await send("Second", "c_2");
    clock += 10_000;
    await transcribe(prompted("First"), reply("One."));
    expect(await shown(3)).toEqual(["First", "One.", "Second"]);
    clock += 10_000;
    queries[0]!.emit(result(0.01, { session_id: ASK }));
    await flush();
    expect((await snapshot(ASK)).items.at(-1)).toMatchObject({ id: "c_2", queued: false, at: new Date(clock).toISOString() });
    expect(await shown(3)).toEqual(["First", "One.", "Second"]);
  });

  test("a session the phone started shows what Claude Code writes before the index has read it, and its prompt leaves only with Claude Code's copy", async () => {
    await start({ folders: () => [repo] });
    const id = await created("r1", "Run ls");
    await snapshot(id);
    thread.length = 0;
    const user = crypto.randomUUID();
    const lines = [
      { parentUuid: null, type: "user", uuid: user, message: { role: "user", content: "Run ls" } },
      { parentUuid: user, type: "assistant", uuid: crypto.randomUUID(), message: { role: "assistant", id: "msg_ls", content: [{ type: "tool_use", id: "toolu_new", name: "Bash", input: { command: "ls" } }] } },
    ];
    writeFileSync(join(folder, `${id}.jsonl`), lines.map((l) => `${JSON.stringify({ isSidechain: false, cwd: repo, sessionId: id, timestamp: new Date(clock).toISOString(), ...l })}\n`).join(""));
    queries[0]!.emit(result(0.01, { session_id: id }));
    const frames = () => thread.flatMap(({ frame }) => (frame.type === "session_items" ? [frame] : []));
    for (let i = 0; i < 200 && !frames().some((f) => f.removed.includes("r1" as never)); i++) await Bun.sleep(5);
    expect(frames().find((f) => f.removed.includes("r1" as never))?.items).toContainEqual(expect.objectContaining({ kind: "user", id: user, text: "Run ls" }));
    expect(frames().flatMap((f) => f.items).flatMap((i) => (i.kind === "work" ? i.steps : []))).toContainEqual(expect.objectContaining({ id: "toolu_new" }));
  });

  test("a new session's row cuts a long prompt on a whole character, so its frame is always readable", async () => {
    await start({ folders: () => [repo] });
    const id = await created("r2", `${"x".repeat(79)}\u{1F600} then reply ok`);
    const title = (await rowOf(id)).title;
    expect([title.isWellFormed(), Array.from(title).length, title.at(-1)]).toEqual([true, 80, "…"]);
  });
});
