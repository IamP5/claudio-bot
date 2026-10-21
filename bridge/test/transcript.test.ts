import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, SessionItem } from "../src/protocol";
import { createHeads, emptyTail, pageOf, extend, follow, parseEntry, project, readThread, sdkReaders, toolOutput, type Entry, type ProjectContext, type SdkReaders } from "../src/transcript";

// Claude Code transcripts recorded by scripts/record-transcript.ts (own-permission, own-ask, own-plan) and imported from
// scenario runs by scripts/import-transcript.ts (subagents and background commands), read through the SDK's real
// readers pointed at a temp CLAUDE_CONFIG_DIR, plus lines crafted from real ones for the rarer shapes.

const FIXTURES = join(import.meta.dir, "transcripts", "jsonl");
const IDS = {
  "own-permission": "11111111-1111-4111-8111-111111111111",
  "own-ask": "22222222-2222-4222-8222-222222222222",
  "own-plan": "33333333-3333-4333-8333-333333333333",
  "agents-foreground": "44444444-4444-4444-8444-444444444444",
  "agents-background": "55555555-5555-4555-8555-555555555555",
  "bash-background": "66666666-6666-4666-8666-666666666666",
  "agent-stopped": "77777777-7777-4777-8777-777777777777",
  "agent-killed": "88888888-8888-4888-8888-888888888888",
  "agent-own-work": "99999999-9999-4999-8999-999999999999",
} as const;
type Name = keyof typeof IDS;
const ctx: ProjectContext = { cwd: "<cwd>", userName: "Alex", agent: false };

let config: string;
let projects: string;
let previous: string | undefined;
const fileOf = (name: Name) => join(projects, "-cwd", `${IDS[name]}.jsonl`);
const fixture = (name: Name) => readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");

beforeAll(() => {
  config = mkdtempSync(join(tmpdir(), "transcript-"));
  projects = join(config, "projects");
  mkdirSync(join(projects, "-cwd"), { recursive: true });
  for (const name of Object.keys(IDS) as Name[]) writeFileSync(fileOf(name), fixture(name));
  previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
});
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(config, { recursive: true, force: true });
});

const itemsOf = async (name: Name, sdk: SdkReaders = sdkReaders) => {
  const thread = await readThread(IDS[name] as SessionId, fileOf(name), "<cwd>", sdk);
  return project(thread.entries, ctx).items;
};
const kinds = (items: SessionItem[]) => items.map((i) => i.kind);

describe("heads", () => {
  test("each transcript is listed with the facts a row needs", async () => {
    const heads = await createHeads({ projectsDir: projects }).scan();
    const permission = heads.find((h) => h.id === IDS["own-permission"])!;
    expect(heads).toHaveLength(Object.keys(IDS).length);
    expect(permission).toMatchObject({ cwd: "<cwd>", firstEntry: "sdk-ts", lastEntry: "sdk-ts", model: "claude-haiku-5-5", mode: "default", lastRole: "assistant", pr: null });
    const aiTitle = fixture("own-permission").split("\n").flatMap((l) => (l.includes('"ai-title"') ? [JSON.parse(l).aiTitle as string] : [])).at(-1);
    expect(permission.title).toBe(aiTitle!);
    expect(heads.find((h) => h.id === IDS["own-plan"])!.mode).toBe("plan");
  });

  test("a session whose cwd is excluded (a bot's home) has no head, and is not read again while unchanged", async () => {
    let asked = 0;
    const counting: SdkReaders = { ...sdkReaders, listSessions: async (o) => (asked++, sdkReaders.listSessions(o)), getSessionInfo: async (id, o) => (asked++, sdkReaders.getSessionInfo(id, o)) };
    const heads = createHeads({ projectsDir: projects, sdk: counting, exclude: (cwd) => cwd === "<cwd>" });
    expect(await heads.scan()).toEqual([]);
    await heads.scan();
    expect(await heads.refresh(fileOf("own-ask"))).toBeNull();
    expect(asked).toBe(1);
  });

  test("a head read that fails keeps what was known", async () => {
    const heads = createHeads({ projectsDir: projects, sdk: { ...sdkReaders, getSessionInfo: async () => { throw new Error("busy"); } } });
    const known = (await heads.scan()).find((h) => h.id === IDS["own-ask"])!;
    const file = fileOf("own-ask");
    const before = readFileSync(file, "utf8");
    try {
      appendFileSync(file, `${JSON.stringify({ type: "custom-title", customTitle: "x", sessionId: IDS["own-ask"] })}\n`);
      expect(await heads.refresh(file)).toEqual(known);
    } finally {
      writeFileSync(file, before);
    }
  });

  test("a rename and a PR appended later reach the head, and an unchanged file is not read again", async () => {
    const heads = createHeads({ projectsDir: projects });
    await heads.scan();
    const file = fileOf("own-ask");
    const before = readFileSync(file, "utf8");
    try {
      appendFileSync(file, `${JSON.stringify({ type: "custom-title", customTitle: "Color picker", sessionId: IDS["own-ask"] })}\n`);
      appendFileSync(file, `${JSON.stringify({ type: "pr-link", sessionId: IDS["own-ask"], prNumber: 7, prUrl: "https://github.com/a/b/pull/7", prRepository: "a/b" })}\n`);
      const head = await heads.refresh(file);
      expect(head).toMatchObject({ title: "Color picker", pr: { number: 7, url: "https://github.com/a/b/pull/7", state: null } });
      const counted: string[] = [];
      const spy = createHeads({ projectsDir: projects, sdk: { ...sdkReaders, listSessions: async (o) => (counted.push("list"), sdkReaders.listSessions(o)) }, seed: await heads.scan() });
      await spy.scan();
      expect(counted).toEqual([]);
    } finally {
      writeFileSync(file, before);
    }
  });
});

describe("threads", () => {
  test("a turn of Write, Edit and Bash is one work item between the prompt and the answer", async () => {
    const items = await itemsOf("own-permission");
    expect(kinds(items)).toEqual(["user", "work", "assistant"]);
    const [prompt, work, done] = items as [Extract<SessionItem, { kind: "user" }>, Extract<SessionItem, { kind: "work" }>, Extract<SessionItem, { kind: "assistant" }>];
    expect(prompt).toMatchObject({ from: "user", queued: false });
    expect(work.steps.map((s) => [s.tool, s.label, s.state, s.diff])).toEqual([
      ["Write", "Write a.txt", "ok", { path: "a.txt", added: 3, removed: 0 }],
      ["Edit", "Edit a.txt", "ok", { path: "a.txt", added: 1, removed: 1 }],
      ["Bash", "Print contents of a.txt", "ok", null],
    ]);
    expect(work.id).toBe(work.steps[0]!.id as never);
    expect(work.steps[2]!.output).toContain("TWO");
    expect(done).toMatchObject({ text: "DONE" });
    expect(done.id).toMatch(/^msg_[\w]+:0$/);
  });

  test("an AskUserQuestion answered from the phone shows its answer", async () => {
    const items = await itemsOf("own-ask");
    const ask = items.find((i) => i.kind === "ask")!;
    expect(ask).toMatchObject({ questions: [{ question: "Pick a color", header: "Color", multiSelect: false }], answers: { "Pick a color": "Blue" }, cardId: null });
    expect(ask.id).toStartWith("toolu_");
  });

  test("an approved ExitPlanMode is an approved plan, and the work after it follows", async () => {
    const items = await itemsOf("own-plan");
    const plan = items.find((i) => i.kind === "plan")!;
    expect(kinds(items)).toEqual(["user", "work", "plan", "work", "assistant"]);
    expect(plan).toMatchObject({ state: "approved", cardId: null });
    expect((plan as Extract<SessionItem, { kind: "plan" }>).text).toStartWith("# Plan");
  });

  test("the file's own order gives the same items when the SDK finds nothing", async () => {
    const none: SdkReaders = { ...sdkReaders, getSessionMessages: async () => [] };
    for (const name of Object.keys(IDS) as Name[]) expect(await itemsOf(name, none)).toEqual(await itemsOf(name));
  });

  test("a tool's full output is read on demand", async () => {
    const items = await itemsOf("own-permission");
    const bash = (items[1] as Extract<SessionItem, { kind: "work" }>).steps[2]!;
    expect(toolOutput(fileOf("own-permission"), bash.id)).toContain("one\nTWO\nthree");
    expect(toolOutput(fileOf("own-permission"), "toolu_nope")).toBeNull();
  });
});

describe("live tail", () => {
  test("a line Claude Code was still writing when the thread was read is read whole once it ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "torn-"));
    try {
      const path = join(dir, `${IDS["own-ask"]}.jsonl`);
      const text = fixture("own-ask");
      const lines = text.trim().split("\n");
      const lastAssistant = lines.findLastIndex((l) => l.includes('"type":"assistant"'));
      const before = `${lines.slice(0, lastAssistant).join("\n")}\n`;
      const torn = lines[lastAssistant]!;
      writeFileSync(path, before + torn.slice(0, 40));
      const none: SdkReaders = { ...sdkReaders, getSessionMessages: async () => [] };
      const thread = await readThread(IDS["own-ask"] as SessionId, path, "<cwd>", none);
      expect(thread.size).toBe(Buffer.byteLength(before));
      appendFileSync(path, `${torn.slice(40)}\n`);
      const read = follow(path, thread.size);
      expect(extend(thread.chain, read.entries).appended.map((e) => e.uuid)).toEqual([JSON.parse(torn).uuid]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(Object.keys(IDS) as Name[])("%s appended in pieces, a torn line included, projects to the same items as the whole file", async (name) => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    try {
      const path = join(dir, `${IDS[name]}.jsonl`);
      const text = fixture(name);
      const cuts = Array.from({ length: 12 }, (_, i) => Math.floor((text.length * (i + 1)) / 12));
      writeFileSync(path, text.slice(0, cuts[0]));
      const none: SdkReaders = { ...sdkReaders, getSessionMessages: async () => [] };
      const thread = await readThread(IDS[name] as SessionId, path, "<cwd>", none);
      const seen = new Map<string, SessionItem>();
      let { items, tail } = project(thread.entries, ctx);
      for (const i of items) seen.set(i.id, i);
      let offset = Buffer.byteLength(text.slice(0, text.lastIndexOf("\n", cuts[0]!) + 1));
      for (let i = 1; i < cuts.length; i++) {
        appendFileSync(path, text.slice(cuts[i - 1], cuts[i]));
        const read = follow(path, offset);
        offset = read.offset;
        const { appended, forked } = extend(thread.chain, read.entries);
        expect(forked).toBe(false);
        ({ items, tail } = project(appended, ctx, tail));
        for (const item of items) seen.set(item.id, item);
      }
      expect([...seen.values()]).toEqual(await itemsOf(name));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prompt on an older entry is a fork, and so is a second writer's stale leaf", async () => {
    const thread = await readThread(IDS["own-ask"] as SessionId, fileOf("own-ask"), "<cwd>");
    const first = thread.entries[0]!;
    const rewind = entry({ uuid: "u-rewind", parent: first.uuid, type: "user", message: { content: "try again" } });
    expect(extend({ uuids: new Set(thread.chain.uuids), leaf: thread.chain.leaf }, [rewind]).forked).toBe(true);
    const next = entry({ uuid: "u-next", parent: thread.chain.leaf, type: "user", message: { content: "and then?" } });
    expect(extend({ uuids: new Set(thread.chain.uuids), leaf: thread.chain.leaf }, [next])).toEqual({ appended: [next], forked: false });
  });
});

let n = 0;
function entry(over: Partial<Entry>): Entry {
  return {
    uuid: `e${++n}`,
    parent: null,
    logicalParent: null,
    at: "2026-10-18T12:00:00.000Z",
    type: "user",
    subtype: null,
    message: null,
    blockIndex: null,
    meta: false,
    compactSummary: false,
    sidechain: false,
    apiError: false,
    toolResult: undefined,
    thinkingMs: null,
    ...over,
  };
}
const prompt = (content: string) => entry({ type: "user", message: { content } });
const call = (id: string, name: string, input: object, mid = `msg_${id}`) => entry({ type: "assistant", message: { id: mid, content: [{ type: "tool_use", id, name, input }] }, blockIndex: 0 });
const answer = (id: string, text: string, isError = false) => entry({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
const said = (mid: string, text: string, index = 0) => entry({ type: "assistant", message: { id: mid, content: [{ type: "text", text }] }, blockIndex: index });

describe("pages", () => {
  const thread = (n: number): SessionItem[] =>
    Array.from({ length: n }, (_, i) => (i % 3 === 0 ? { kind: "user", id: `u${i}`, at: "", text: "q", from: "user", queued: false } : { kind: "assistant", id: `a${i}`, at: "", text: "x".repeat(100) }) as SessionItem);

  test("the newest page stops at 10 prompts, then the cursor walks back to the start", () => {
    const items = thread(60);
    const first = pageOf(items, null)!;
    expect(first.items.filter((i) => i.kind === "user")).toHaveLength(10);
    expect(first.items.at(-1)!.id).toBe("a59" as never);
    let before = first.before;
    const seen = [...first.items];
    while (before !== null) {
      const page = pageOf(items, before)!;
      seen.unshift(...page.items);
      before = page.before;
    }
    expect(seen).toEqual(items);
  });

  test("the item and byte limits hold, a single huge item still comes, and a stale cursor is null", () => {
    expect(pageOf(thread(300), null, { turns: 1000, items: 120, bytes: 1e9 })!.items).toHaveLength(120);
    expect(pageOf(thread(300), null, { turns: 1000, items: 1000, bytes: 1000 })!.items.length).toBeLessThan(10);
    const huge = [{ kind: "assistant", id: "big", at: "", text: "x".repeat(10_000) } as SessionItem];
    expect(pageOf(huge, null, { turns: 10, items: 10, bytes: 100 })!.items).toHaveLength(1);
    expect(pageOf(thread(5), "nope" as never)).toBeNull();
  });
});

describe("projection rules", () => {
  test("parallel calls share one work item and settle in any order; a denial is not an error", () => {
    const { items } = project([prompt("go"), call("t1", "Bash", { command: "ls" }, "m1"), call("t2", "Read", { file_path: "<cwd>/x.ts" }, "m1"), answer("t2", "file"), answer("t1", "Permission to use Bash has been denied.", true), said("m2", "ok")], ctx);
    const work = items.find((i) => i.kind === "work") as Extract<SessionItem, { kind: "work" }>;
    expect(work.id).toBe("t1" as never);
    expect(work.steps.map((s) => [s.label, s.state])).toEqual([["Run ls", "denied"], ["Read x.ts", "ok"]]);
    expect(kinds(items)).toEqual(["user", "work", "assistant"]);
  });

  test("a compaction, an interruption, a command and machine prompts", () => {
    const { items } = project(
      [
        prompt("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src/a.ts</command-args>"),
        prompt("<local-command-stdout>done</local-command-stdout>"),
        entry({ type: "user", meta: true, message: { content: "Caveat: ignore" } }),
        entry({ type: "system", subtype: "compact_boundary", logicalParent: "x" }),
        entry({ type: "user", compactSummary: true, message: { content: "Summary of before" } }),
        prompt("[Request interrupted by user]"),
        entry({ type: "assistant", apiError: true, message: { id: "m9", content: [{ type: "text", text: "API Error: 500" }] } }),
      ],
      ctx,
    );
    expect(items.map((i) => [i.kind, "text" in i ? i.text : null])).toEqual([
      ["user", "/review src/a.ts"],
      ["compaction", null],
      ["notice", "Interrupted"],
      ["notice", "API Error: 500"],
    ]);
  });

  test("in an agent's session the bot writes prompts, the user's direct ones carry a header, the bridge's are system", () => {
    const agent = { ...ctx, agent: true };
    const { items } = project([prompt("Fix the fade."), prompt("[Alex messaged this agent directly]\nUse Web Audio."), prompt("[Alex allowed once: Bash rm x. Run exactly that call again now.]"), prompt("[Your request expired unanswered.]\nAlso add a test.")], agent);
    expect(items.map((i) => (i.kind === "user" ? [i.from, i.text] : null))).toEqual([
      ["bot", "Fix the fade."],
      ["user", "Use Web Audio."],
      ["system", "[Alex allowed once: Bash rm x. Run exactly that call again now.]"],
      ["bot", "Also add a test."],
    ]);
  });

  test("TodoWrite replaces one todo per turn; the next prompt starts another", () => {
    const todo = (id: string, status: string) => call(id, "TodoWrite", { todos: [{ content: "Ship", status, activeForm: "Shipping" }] });
    const { items } = project([prompt("a"), todo("w1", "pending"), todo("w2", "in_progress"), prompt("b"), todo("w3", "completed")], ctx);
    expect(items.filter((i) => i.kind === "todo").map((i) => [i.id as string, (i as Extract<SessionItem, { kind: "todo" }>).todos[0]!.state])).toEqual([
      ["w1", "in_progress"],
      ["w3", "done"],
    ]);
  });

  test("a continued projection changes an open item in place: a result after a text block still settles its step", () => {
    const first = project([prompt("go"), call("t1", "Bash", { command: "sleep 1", description: "Wait" }, "m1"), said("m1", "Waiting on it.", 1)], ctx);
    const next = project([answer("t1", "slept")], ctx, first.tail);
    expect(next.items).toEqual([expect.objectContaining({ id: "t1", kind: "work", steps: [expect.objectContaining({ state: "ok", output: "slept" })] })]);
    expect(project([answer("t1", "again")], ctx, next.tail).items).toEqual([]);
    expect(emptyTail().open.size).toBe(0);
  });

  test("a line that is not JSON, or not a conversation entry, is no entry", () => {
    expect(parseEntry("{not json")).toBeNull();
    expect(parseEntry(JSON.stringify({ type: "custom-title", customTitle: "x" }))).toBeNull();
    expect(parseEntry(JSON.stringify({ type: "user", uuid: "u", parentUuid: null, message: { content: "hi" } }))?.uuid).toBe("u");
  });
});

const stepsOf = (items: SessionItem[]) => items.flatMap((i) => (i.kind === "work" ? i.steps : []));
const stepNamed = (items: SessionItem[], label: string) => stepsOf(items).find((s) => s.label === label)!;
/** The thread's items as they stood right before the first entry whose content holds `text`. */
const itemsBefore = async (name: Name, text: string) => {
  const { entries } = await readThread(IDS[name] as SessionId, fileOf(name), "<cwd>");
  return project(entries.slice(0, entries.findIndex((e) => JSON.stringify(e.message?.content ?? "").includes(text))), ctx).items;
};
const notices = (items: SessionItem[]) => items.flatMap((i) => (i.kind === "notice" ? [{ text: i.text, tone: i.tone, reason: i.reason, at: i.at }] : []));

describe("subagents and background work", () => {
  test("async Agents run in the background from their launch until each one's notification", async () => {
    const launched = await itemsBefore("agents-background", "<task-notification>");
    expect(stepsOf(launched).map((s) => [s.label, s.state, s.background, s.output, s.detail, s.startedAt])).toEqual([
      ["Agent: sleeper one", "running", true, null, "general-purpose", "2026-10-21T03:30:22.838Z"],
      ["Agent: sleeper two", "running", true, null, "general-purpose", "2026-10-21T03:30:23.238Z"],
      ["Agent: sleeper three", "running", true, null, "general-purpose", "2026-10-21T03:30:23.731Z"],
    ]);
    const items = await itemsOf("agents-background");
    expect(stepsOf(items).map((s) => [s.state, s.output, s.endedAt, s.usage])).toEqual([
      ["ok", "done", "2026-10-21T03:30:56.575Z", { tools: 1, ms: 33674 }],
      ["ok", "done", "2026-10-21T03:30:56.690Z", { tools: 1, ms: 33216 }],
      ["ok", "done", "2026-10-21T03:30:58.294Z", { tools: 1, ms: 32974 }],
    ]);
  });

  test("each notification is a task notice, before the turn it wakes, and the work item keeps its place", async () => {
    const items = await itemsOf("agents-background");
    expect(items.map((i) => (i.kind === "notice" || i.kind === "assistant" ? `${i.kind}: ${i.text}` : i.kind))).toEqual([
      "user",
      "work",
      "assistant: The three sleeper agents are running in the background. I'll reply \"all done\" once all three have returned.",
      'notice: Agent "sleeper one" finished',
      'notice: Agent "sleeper two" finished',
      'assistant: Two of three sleeper agents have finished, both reporting "done". Still waiting on "sleeper three".',
      'notice: Agent "sleeper three" finished',
      "assistant: all done",
    ]);
    expect(notices(items).every((n) => n.reason === "task" && n.tone === "info")).toBe(true);
  });

  test("foreground Agents show their report, subagent type, usage and times, not the hand-back frame", async () => {
    const items = await itemsOf("agents-foreground");
    expect(stepsOf(items).map((s) => [s.label, s.state, s.output, s.detail, s.usage, s.startedAt, s.endedAt, s.background])).toEqual([
      ["Agent: sleeper one", "ok", "done", "general-purpose", { tools: 1, ms: 42899 }, "2026-10-21T04:19:58.697Z", "2026-10-21T04:20:43.015Z", undefined],
      ["Agent: sleeper two", "ok", "done", "general-purpose", { tools: 1, ms: 42952 }, "2026-10-21T04:19:59.596Z", "2026-10-21T04:20:43.071Z", undefined],
      ["Agent: sleeper three", "ok", "done", "general-purpose", { tools: 1, ms: 42896 }, "2026-10-21T04:19:59.645Z", "2026-10-21T04:20:43.017Z", undefined],
    ]);
  });

  test("a background command reads as one, runs until its notification, then is ok", async () => {
    const label = "Run in background: delayed background write of bg.txt";
    const running = stepNamed(await itemsBefore("bash-background", "<task-notification>"), label);
    expect(running).toMatchObject({ state: "running", background: true, output: null, detail: "sleep 75 && echo bg-done > bg.txt", startedAt: "2026-10-21T03:53:05.263Z" });
    expect(running.endedAt).toBeUndefined();
    const items = await itemsOf("bash-background");
    expect(stepNamed(items, label)).toMatchObject({ state: "ok", output: null, endedAt: "2026-10-21T03:54:25.268Z" });
    expect(notices(items)).toEqual([{ text: 'Background command "Run delayed background write of bg.txt" completed (exit code 0)', tone: "info", reason: "task", at: "2026-10-21T03:54:25.268Z" }]);
  });

  test("an unknown agent type fails with its cause; a rejected Agent the user then interrupted is stopped", async () => {
    const denied = stepNamed(await itemsBefore("agent-stopped", "[Request interrupted by user"), "Agent: long sleeper");
    expect(denied).toMatchObject({ state: "denied", cause: "Denied by you", output: null });
    const items = await itemsOf("agent-stopped");
    const broken = stepNamed(items, "Agent: broken helper");
    expect(broken).toMatchObject({ state: "error", detail: "no-such-agent-type", endedAt: "2026-10-21T04:19:59.078Z" });
    expect(broken.cause).toStartWith("Agent type 'no-such-agent-type' not found. Available agents: ");
    expect(broken.cause!.length).toBeLessThanOrEqual(200);
    expect(stepNamed(items, "Agent: long sleeper")).toMatchObject({ state: "stopped", cause: "Stopped by you", output: null, endedAt: "2026-10-21T04:20:10.564Z" });
    expect(notices(items).map((n) => n.text)).toEqual(["Interrupted"]);
  });

  test("an Agent killed in the background is stopped by its notification; the wake turn's failed command shows its exit", async () => {
    const items = await itemsOf("agent-killed");
    expect(stepNamed(items, "Agent: long sleeper")).toMatchObject({ state: "stopped", cause: "Stopped by you", background: true, output: null, endedAt: "2026-10-21T03:53:02.940Z" });
    expect(notices(items)).toEqual([{ text: 'Agent "long sleeper" was stopped by user', tone: "info", reason: "task", at: "2026-10-21T03:53:02.940Z" }]);
    const check = stepNamed(items, "Check whether late.txt was written");
    expect(check).toMatchObject({ state: "error", cause: "Exit code 1: ls: late.txt: No such file or directory", output: "Exit code 1\nls: late.txt: No such file or directory", detail: "ls -la late.txt 2>&1" });
    const works = items.filter((i) => i.kind === "work");
    expect(works).toHaveLength(2);
    expect(items.findIndex((i) => i.kind === "notice")).toBeLessThan(items.indexOf(works[1]!));
  });

  test("an interim notification keeps the Agent running; the final one, named by task id only, settles it", async () => {
    const final = "<task-id>a889ddb94a6f914b7</task-id>\n<output-file>";
    const interim = await itemsBefore("agent-own-work", JSON.stringify(final).slice(1, -1));
    expect(stepNamed(interim, "Agent: starter")).toMatchObject({ state: "running", background: true, output: "started" });
    expect(notices(interim).map((n) => n.text)).toEqual(['Agent "starter" is waiting on its own background work']);
    const items = await itemsOf("agent-own-work");
    expect(stepNamed(items, "Agent: starter")).toMatchObject({
      state: "ok",
      output: "The background command finished with exit code 0, so `nested.txt` should now contain `nested-done`. I did not verify the file contents.",
      endedAt: "2026-10-21T04:21:15.381Z",
      usage: { tools: 1, ms: 65904 },
    });
  });

  test("no step anywhere shows Claude Code's launch acknowledgement, hand-back frame or reject text", async () => {
    for (const name of Object.keys(IDS) as Name[]) {
      for (const s of stepsOf(await itemsOf(name))) expect(s.output ?? "").not.toMatch(/Async agent launched|Command running in background|Subagent hand-back|doesn't want to proceed|agentId:/);
    }
  });

  test("a step's full output is what the call returned: the report, the last notification's result, or nothing", async () => {
    const outputOf = async (name: Name, label: string) => toolOutput(fileOf(name), stepNamed(await itemsOf(name), label).id);
    expect(await outputOf("agents-foreground", "Agent: sleeper one")).toBe("done");
    expect(await outputOf("agents-background", "Agent: sleeper two")).toBe("done");
    expect(await outputOf("agent-own-work", "Agent: starter")).toStartWith("The background command finished");
    expect(await outputOf("bash-background", "Run in background: delayed background write of bg.txt")).toBeNull();
    expect(await outputOf("agent-stopped", "Agent: long sleeper")).toBeNull();
    expect(await outputOf("agent-killed", "Check whether late.txt was written")).toBe("Exit code 1\nls: late.txt: No such file or directory");
  });
});

describe("step labels", () => {
  const stepOf = (name: string, input: object) => stepsOf(project([call("l1", name, input)], ctx).items)[0]!;

  test('a command reads as its description, never "Run Run", and says when it runs in the background', () => {
    expect(stepOf("Bash", { command: "bun test", description: "Run the tests" }).label).toBe("Run the tests");
    expect(stepOf("Bash", { command: "bun test" }).label).toBe("Run bun test");
    expect(stepOf("Bash", { command: "bun test", description: "Run the tests", run_in_background: true })).toMatchObject({ label: "Run in background: the tests", background: true });
    expect(stepOf("Bash", { command: "sleep 5", run_in_background: true }).label).toBe("Run in background: sleep 5");
  });

  test("a description is masked as prose, a command as a secret", () => {
    expect(stepOf("Bash", { command: "ls", description: "Check token refresh handling" }).label).toBe("Check token refresh handling");
    const step = stepOf("Bash", { command: "curl -H 'Authorization: Bearer tok123456' x\nline 2\nline 3\nline 4" });
    expect(step.detail).toBe("curl -H 'Authorization: Bearer «redacted:9 chars»' x\nline 2\nline 3");
    expect(step.label).not.toContain("tok123456");
  });

  test("a long Agent description is cut in the middle, so two that differ at the end still differ", () => {
    const shared = "Investigate why the session list shows the wrong title after a rename in ".repeat(3);
    const [a, b] = ["the iOS app", "the bridge"].map((end) => stepOf("Agent", { description: shared + end }).label);
    expect(a!.length).toBeLessThanOrEqual(120);
    expect(a).toStartWith("Agent: Investigate why");
    expect(a).toEndWith("in the iOS app");
    expect(b).toEndWith("in the bridge");
  });

  test("background-control tools name the task they point at", () => {
    const launch = (id: string, name: string, input: object, ack: string) => [call(id, name, input), answer(id, ack)];
    const { items } = project(
      [
        prompt("go"),
        ...launch("b", "Bash", { command: "sleep 5\necho hi", run_in_background: true }, "Command running in background with ID: bg1. Output is being written to: x"),
        ...launch("a", "Agent", { description: "helper", prompt: "p" }, "Async agent launched successfully.\nagentId: ag1 (internal ID)"),
        call("c1", "BashOutput", { bash_id: "bg1" }),
        call("c2", "KillShell", { shell_id: "bg1" }),
        call("c3", "TaskOutput", { task_id: "ag1" }),
        call("c4", "TaskStop", { task_id: "nope" }),
        call("c5", "Monitor", {}),
        call("c6", "ScheduleWakeup", {}),
      ],
      ctx,
    );
    expect(stepsOf(items).slice(2).map((s) => s.label)).toEqual([
      "Check background command: sleep 5",
      "Stop background command: sleep 5",
      "Check agent: helper",
      "Stop a background task",
      "Watch background output",
      "Schedule a wake-up",
    ]);
  });
});

describe("step outcomes", () => {
  const settled = (result: string, isError: boolean) => stepsOf(project([prompt("go"), call("t1", "Bash", { command: "make" }), answer("t1", result, isError)], ctx).items)[0]!;

  test("a long error keeps its head, so the exit status survives, and its tail", () => {
    const step = settled(`Exit code 2\n${"x".repeat(5000)}\nmake: *** [all] Error 2`, true);
    expect(step.output).toStartWith("Exit code 2\nxxx");
    expect(step.output).toEndWith("make: *** [all] Error 2");
    expect(step.output!.length).toBeLessThanOrEqual(2048 + 3);
    expect(step.cause).toBe(`Exit code 2: ${"x".repeat(186)}…`);
  });

  test("the bridge's Stop is a stop, and a permission denial keeps its first line as its cause", () => {
    expect(settled("Alex pressed Stop. This call did not run, and nothing more runs this turn. End your turn now.", true)).toMatchObject({ state: "stopped", cause: "Stopped by you", output: null });
    expect(settled("Permission to use Bash has been denied.", true)).toMatchObject({ state: "denied", cause: "Permission to use Bash has been denied.", output: null });
  });

  test("parallel calls rejected one result at a time are all stopped by the interrupt after them; a reject alone stays denied", () => {
    const reject = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
    const calls = [prompt("go"), call("t1", "Bash", { command: "a" }, "m1"), call("t2", "Bash", { command: "b" }, "m1"), answer("t1", reject, true), answer("t2", reject, true)];
    expect(stepsOf(project([...calls, prompt("[Request interrupted by user for tool use]")], ctx).items).map((s) => [s.state, s.cause])).toEqual([
      ["stopped", "Stopped by you"],
      ["stopped", "Stopped by you"],
    ]);
    expect(stepsOf(project([...calls, said("m2", "Understood.")], ctx).items).map((s) => s.state)).toEqual(["denied", "denied"]);
  });

  test("a background command that exits non-zero is an error with its exit code; a note for an unknown task is still a notice", () => {
    const note = (id: string, summary: string) => prompt(`<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`);
    const { items } = project(
      [
        prompt("go"),
        call("t1", "Bash", { command: "false", run_in_background: true }),
        answer("t1", "Command running in background with ID: bg9. Output is being written to: x"),
        note("bg9", 'Background command "false" completed (exit code 1)'),
        note("other", "Task &quot;x&quot; was stopped by main session"),
      ],
      ctx,
    );
    expect(stepsOf(items)[0]).toMatchObject({ state: "error", cause: "Exit code 1", background: true });
    expect(notices(items).map((n) => [n.text, n.tone])).toEqual([
      ['Background command "false" completed (exit code 1)', "error"],
      ['Task "x" was stopped by main session', "info"],
    ]);
  });
});
