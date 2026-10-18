import { expect, test } from "bun:test";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, loginOf, olderThan, readAccount, readPlanUsage, strictMcp, usageOf } from "../src/claudeCode";

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

const MAX = { email: "me@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" } as const;
const named = (utilization: number | null, resets_at: string | null = "2026-10-23T03:00:00+00:00") => ({ utilization, resets_at });

// The answer Claude Code 2.1.301 gave on a Max login, trimmed to what the parse reads.
const LIVE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: named(13, "2026-10-18T21:00:00.478480+00:00"),
    seven_day: named(13, "2026-10-23T03:00:00.478501+00:00"),
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: "session", group: "session", percent: 13, severity: "normal", resets_at: "2026-10-18T21:00:00.478480+00:00", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 13, severity: "normal", resets_at: "2026-10-23T03:00:00.478501+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: "2026-10-23T03:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
  },
};

test("usage comes from the server's limits rows: one window each, as a share of 1, with the server's severity", () => {
  expect(usageOf(MAX, LIVE)).toEqual({
    state: "ok",
    plan: "max",
    windows: [
      { id: "session", kind: "session", label: "Current session", utilization: 0.13, resetsAt: "2026-10-18T21:00:00.478Z", severity: "normal" },
      { id: "weekly", kind: "weekly", label: "Weekly · all models", utilization: 0.13, resetsAt: "2026-10-23T03:00:00.478Z", severity: "normal" },
      { id: "weekly:fable", kind: "weekly_model", label: "Weekly · Fable", utilization: 0, resetsAt: "2026-10-23T03:00:00.000Z", severity: "normal" },
    ],
  });
});

test("a limits row of an unknown kind or severity, or with no percent, does not break the read", () => {
  const rows = [
    { kind: "monthly", percent: 50, severity: "normal", resets_at: null },
    { kind: "session", percent: 92, severity: "exceeded", resets_at: "soon" },
    { kind: "weekly_all", percent: null, severity: "normal", resets_at: null },
    { kind: "weekly_scoped", percent: 10, severity: "warning", resets_at: null, scope: { model: null } },
  ];
  const read = usageOf(MAX, { ...LIVE, rate_limits: { limits: rows } });
  expect(read).toEqual({ state: "ok", plan: "max", windows: [{ id: "session", kind: "session", label: "Current session", utilization: 0.92, resetsAt: null, severity: "critical" }] });
});

test("without limits rows the named windows are read, model windows included, rated by how full they are", () => {
  const read = usageOf(MAX, {
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: {
      five_hour: named(80, "2026-10-18T21:00:00Z"),
      seven_day: named(40),
      seven_day_opus: named(95),
      seven_day_sonnet: named(null),
      model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: null }, { display_name: "Opus", utilization: 1, resets_at: null }],
    },
  });
  expect(read.state === "ok" && read.windows.map((w) => [w.id, w.label, w.utilization, w.severity])).toEqual([
    ["session", "Current session", 0.8, "warning"],
    ["weekly", "Weekly · all models", 0.4, "normal"],
    ["weekly:opus", "Weekly · Opus", 0.95, "critical"],
    ["weekly:fable", "Weekly · Fable", 0.05, "normal"],
  ]);
});

test("a login without plan limits says why", () => {
  const off = { subscription_type: null, rate_limits_available: false, rate_limits: null };
  expect(usageOf({ apiProvider: "bedrock" }, off)).toEqual({ state: "unavailable", reason: "third_party" });
  expect(usageOf({ tokenSource: "none", apiProvider: "firstParty" }, off)).toEqual({ state: "unavailable", reason: "logged_out" });
  expect(usageOf({ apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }, off)).toEqual({ state: "unavailable", reason: "api_key" });
  expect(usageOf({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }, off)).toEqual({ state: "unavailable", reason: "no_scope" });
  expect(() => usageOf(MAX, "nope")).toThrow("not an object");
});

test("reading the plan usage sends no message, asks Claude Code without the transcript scan, and closes the query", async () => {
  let yielded = 0;
  let closed = false;
  const asked: unknown[] = [];
  const query = ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) yielded++;
    })();
    return {
      initializationResult: async () => ({ account: MAX }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts: unknown) => (asked.push(opts), LIVE),
      close: () => void (closed = true),
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as Query;
  };
  const read = await readPlanUsage(query, { pathToClaudeCodeExecutable: "/x/claude" });
  await Bun.sleep(0);
  expect([read.state, yielded, closed, asked]).toEqual(["ok", 0, true, [{ skipBehaviors: true }]]);
});
