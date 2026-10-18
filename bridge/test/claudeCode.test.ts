import { expect, test } from "bun:test";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, loginOf, olderThan, readAccount, strictMcp } from "../src/claudeCode";

test("versions compare by number, not as text", () => {
  expect(olderThan("2.1.0 (Claude Code)", "2.1.301")).toBe(true);
  expect(olderThan("2.1.99", "2.1.301")).toBe(true);
  expect(olderThan("2.1.301 (Claude Code)", "2.1.301")).toBe(false);
  expect(olderThan("2.10.0", "2.9.400")).toBe(false);
  expect(olderThan("3.0.0", "2.1.301")).toBe(false);
  expect(olderThan("not a version", "2.1.301")).toBeNull();
});

test("the config dir is CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/c/work" }, "/Users/me")).toBe("/c/work");
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" }, "/Users/me")).toBe("/Users/me/.claude");
  expect(claudeConfigDir({}, "/Users/me")).toBe("/Users/me/.claude");
});

test("strict MCP config is asked for only when no managed MCP config exists", () => {
  const managed = join(mkdtempSync(join(tmpdir(), "managed-mcp-")), "managed-mcp.json");
  expect(strictMcp(managed)).toEqual({ strictMcpConfig: true });
  writeFileSync(managed, "{}");
  expect(strictMcp(managed)).toEqual({});
});

test("the login as Claude Code 2.1.301 reports it, logged in or not", () => {
  expect(loginOf({ email: "me@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" })).toEqual({ kind: "in", how: "me@example.com (Claude Max)" });
  expect(loginOf({ tokenSource: "none", apiProvider: "firstParty" })).toEqual({ kind: "out" });
  expect(loginOf({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toEqual({ kind: "in", how: "API key from ANTHROPIC_API_KEY" });
  expect(loginOf({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" })).toEqual({ kind: "in", how: "token from CLAUDE_CODE_OAUTH_TOKEN" });
  expect(loginOf({ apiProvider: "bedrock" })).toEqual({ kind: "in", how: "bedrock credentials" });
});

test("reading the login sends no message, so no turn runs, and closes the query", async () => {
  let yielded = 0;
  let closed = false;
  let seen: Options | undefined;
  const query = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    seen = options;
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) yielded++;
    })();
    return {
      initializationResult: async () => ({ account: { tokenSource: "none", apiProvider: "firstParty" } }),
      close: () => void (closed = true),
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as Query;
  };
  expect(await readAccount(query, { pathToClaudeCodeExecutable: "/x/claude" })).toEqual({ tokenSource: "none", apiProvider: "firstParty" });
  await Bun.sleep(0);
  expect([yielded, closed, seen?.persistSession, seen?.pathToClaudeCodeExecutable]).toEqual([0, true, false, "/x/claude"]);
});

test("a login read that never answers gives up", async () => {
  const query = () => ({ initializationResult: () => new Promise(() => {}), close: () => {}, [Symbol.asyncIterator]: async function* () {} }) as unknown as Query;
  await expect(readAccount(query, {}, 10)).rejects.toThrow("Reading the Claude login took over");
});
