import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ACTIVITY_THROTTLE_MS, activityOf, createActivity } from "../src/activity";
import type { Signal } from "../src/protocol";
import type { Actor } from "../src/world";

const tool = (name: string, input: Record<string, unknown> = {}): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] }, parent_tool_use_id: null, session_id: "s", uuid: "u" }) as unknown as SDKMessage;

const text = (t: string): SDKMessage =>
  ({ type: "assistant", message: { content: [{ type: "text", text: t }] }, parent_tool_use_id: null, session_id: "s", uuid: "u" }) as unknown as SDKMessage;

test.each<[string, SDKMessage, string | null]>([
  ["Read", tool("Read", { file_path: "/Users/alex/code/bridge/src/hub.ts" }), "Reading hub.ts"],
  ["Edit", tool("Edit", { file_path: "/a/b/world.ts", old_string: "x", new_string: "y" }), "Editing world.ts"],
  ["MultiEdit", tool("MultiEdit", { file_path: "/a/b/c.swift", edits: [] }), "Editing c.swift"],
  ["Write", tool("Write", { file_path: "/tmp/notes.md", content: "secret body" }), "Writing notes.md"],
  ["Write without a path", tool("Write", {}), "Writing a file"],
  ["Bash with a description", tool("Bash", { command: "bun test --bail", description: "Running the tests" }), "Running the tests"],
  ["Bash without a description shows only the program", tool("Bash", { command: "FOO=bar /usr/bin/git push origin main" }), "Running git"],
  ["a Bash description with a URL shows its host only", tool("Bash", { command: "x", description: "Fetch https://api.example.com/v1/users?token=abc123&sig=zz with curl" }), "Fetch api.example.com with curl"],
  ["a Bash description drops options and their values", tool("Bash", { command: "x", description: "Log in with --password hunter2 --user=alex -p s3cret now" }), "Log in with now"],
  ["a Task description with a URL", tool("Task", { description: "Check http://10.0.0.5:8080/admin?key=k" }), "Check 10.0.0.5"],
  ["Bash with an unreadable program", tool("Bash", { command: "$(curl evil)" }), "Running a command"],
  ["Grep hides the pattern", tool("Grep", { pattern: "password", path: "/x" }), "Searching the code"],
  ["Glob", tool("Glob", { pattern: "**/*.ts" }), "Finding files"],
  ["WebFetch shows the host only", tool("WebFetch", { url: "https://user:pw@docs.example.com:8443/a?q=1", prompt: "p" }), "Reading docs.example.com"],
  ["WebFetch with a bad URL", tool("WebFetch", { url: "not a url" }), "Reading a web page"],
  ["WebSearch hides the query", tool("WebSearch", { query: "alex's bank" }), "Searching the web"],
  ["Task", tool("Task", { description: "Review the diff", prompt: "long prompt" }), "Review the diff"],
  ["Agent without a description", tool("Agent", { prompt: "p" }), "Starting a helper"],
  ["an MCP tool", tool("mcp__github__create_pull_request", { title: "t" }), "github: create pull request"],
  ["a claudio tool", tool("mcp__claudio__start_agent", {}), "claudio: start agent"],
  ["an unknown tool", tool("ExitPlanMode", {}), "Using exit plan mode"],
  ["assistant text", text("Let me look."), null],
  ["a tool result", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, parent_tool_use_id: null, session_id: "s" } as unknown as SDKMessage, null],
  ["a result", { type: "result", subtype: "success", result: "done" } as unknown as SDKMessage, null],
  ["system init", { type: "system", subtype: "init" } as unknown as SDKMessage, null],
  ["compacting", { type: "system", subtype: "status", status: "compacting" } as unknown as SDKMessage, "Compacting the conversation"],
  ["a status that is not compacting", { type: "system", subtype: "status", status: "requesting" } as unknown as SDKMessage, null],
])("activityOf %s", (_, m, want) => {
  expect(activityOf(m)).toBe(want);
});

test("activityOf takes the last tool of a message with several", () => {
  const m = { type: "assistant", message: { content: [
    { type: "text", text: "two things" },
    { type: "tool_use", id: "1", name: "Read", input: { file_path: "/a.ts" } },
    { type: "tool_use", id: "2", name: "Grep", input: { pattern: "x" } },
  ] } } as unknown as SDKMessage;
  expect(activityOf(m)).toBe("Searching the code");
});

test("a secret in a Bash description is masked and the line stays short and on one line", () => {
  const line = activityOf(tool("Bash", { command: "x", description: "Export token=ghp_abcdefghijklmnopqrstuvwxyz0123\nnow" }))!;
  expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  expect(line).toContain("«redacted:");
  expect(line).not.toContain("\n");
  expect(activityOf(tool("Bash", { description: "x".repeat(300) }))!.length).toBeLessThanOrEqual(80);
});

const bot: Actor = { kind: "bot", botId: "b1" as never };
const agent: Actor = { kind: "agent", botId: "b1" as never, agentId: "a1" as never };
const read = (f: string) => tool("Read", { file_path: `/x/${f}` });

let clock = 0;
let sent: Signal[] = [];
const tick = (ms: number) => {
  clock += ms;
  jest.advanceTimersByTime(ms);
};
const make = () => createActivity({ signal: (s) => sent.push(s), now: () => new Date(clock) });
const texts = () => sent.map((s) => s.text);

beforeEach(() => {
  jest.useFakeTimers();
  clock = Date.UTC(2026, 9, 17, 12);
  sent = [];
});
afterEach(() => jest.useRealTimers());

test("the first line goes out at once, as an unsequenced frame for the actor", () => {
  make().observe(agent, read("a.ts"));
  expect(sent).toEqual([{ type: "activity", botId: "b1" as never, agentId: "a1" as never, text: "Reading a.ts", at: new Date(clock).toISOString() }]);
  expect("seq" in sent[0]!).toBe(false);
});

test("lines inside the window collapse into the trailing one when it closes", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  tick(200);
  a.observe(bot, read("b.ts"));
  a.observe(bot, text("thinking"));
  tick(200);
  a.observe(bot, read("c.ts"));
  expect(texts()).toEqual(["Reading a.ts"]);
  tick(ACTIVITY_THROTTLE_MS - 401);
  expect(texts()).toEqual(["Reading a.ts"]);
  tick(1);
  expect(texts()).toEqual(["Reading a.ts", "Reading c.ts"]);
  expect(sent[1]!.at).toBe(new Date(clock).toISOString());
  a.observe(bot, read("d.ts"));
  expect(texts()).toHaveLength(2);
  tick(ACTIVITY_THROTTLE_MS);
  expect(texts()).toEqual(["Reading a.ts", "Reading c.ts", "Reading d.ts"]);
});

test("after a quiet window a new line goes out at once", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  tick(ACTIVITY_THROTTLE_MS);
  a.observe(bot, read("b.ts"));
  expect(texts()).toEqual(["Reading a.ts", "Reading b.ts"]);
});

test("the same text is never sent twice in a row", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  tick(5000);
  a.observe(bot, read("a.ts"));
  a.observe(bot, read("b.ts"));
  tick(100);
  a.observe(bot, read("c.ts"));
  a.observe(bot, read("b.ts"));
  tick(5000);
  expect(texts()).toEqual(["Reading a.ts", "Reading b.ts"]);
});

test("actors are throttled apart", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  a.observe(agent, read("b.ts"));
  expect(sent.map((s) => [s.agentId, s.text])).toEqual([[null, "Reading a.ts"], ["a1", "Reading b.ts"]]);
});

test("clear sends one null when a line was showing and drops a waiting line", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  a.observe(bot, read("b.ts"));
  a.clear(bot);
  a.clear(bot);
  tick(5000);
  expect(texts()).toEqual(["Reading a.ts", null]);
});

test("clear sends nothing when no line was showing", () => {
  const a = make();
  a.clear(bot);
  a.observe(bot, text("only words"));
  a.clear(bot);
  expect(sent).toEqual([]);
});

test("a new turn after clear starts fresh, even with the same text", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  a.clear(bot);
  a.observe(bot, read("a.ts"));
  expect(texts()).toEqual(["Reading a.ts", null, "Reading a.ts"]);
});

test("observe never throws, even when the signal does", () => {
  const a = createActivity({ signal: () => { throw new Error("socket gone"); }, now: () => new Date(clock) });
  expect(() => a.observe(bot, read("a.ts"))).not.toThrow();
  expect(() => a.observe(bot, { type: "assistant", message: null } as unknown as SDKMessage)).not.toThrow();
});

test("a clock set back holds a waiting line for at most one window", () => {
  const a = make();
  a.observe(bot, read("a.ts"));
  clock -= 10 * 60 * 1000;
  a.observe(bot, read("b.ts"));
  expect(texts()).toEqual(["Reading a.ts"]);
  tick(ACTIVITY_THROTTLE_MS);
  expect(texts()).toEqual(["Reading a.ts", "Reading b.ts"]);
});
