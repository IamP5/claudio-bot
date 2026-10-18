import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, SessionItem } from "../src/protocol";
import { createHeads, emptyTail, pageOf, extend, follow, parseEntry, project, readThread, sdkReaders, toolOutput, type Entry, type ProjectContext, type SdkReaders } from "../src/transcript";

// Claude Code transcripts recorded by scripts/record-transcript.ts (own-permission, own-ask, own-plan), read through the
// SDK's real readers pointed at a temp CLAUDE_CONFIG_DIR, plus lines crafted from real ones for the rarer shapes.

const FIXTURES = join(import.meta.dir, "transcripts", "jsonl");
const IDS = { "own-permission": "11111111-1111-4111-8111-111111111111", "own-ask": "22222222-2222-4222-8222-222222222222", "own-plan": "33333333-3333-4333-8333-333333333333" } as const;
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
    expect(heads).toHaveLength(3);
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
      ["Bash", "Run Print contents of a.txt", "ok", null],
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

  test("lines appended in pieces, a torn line included, project to the same items as the whole file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    try {
      const path = join(dir, `${IDS["own-permission"]}.jsonl`);
      const text = fixture("own-permission");
      const cuts = [Math.floor(text.length * 0.3), Math.floor(text.length * 0.55), Math.floor(text.length * 0.8), text.length];
      writeFileSync(path, text.slice(0, cuts[0]));
      const none: SdkReaders = { ...sdkReaders, getSessionMessages: async () => [] };
      const thread = await readThread(IDS["own-permission"] as SessionId, path, "<cwd>", none);
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
      expect([...seen.values()]).toEqual(await itemsOf("own-permission"));
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
