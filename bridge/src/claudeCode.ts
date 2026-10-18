import type { AccountInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Facts about the Claude Code install the bridge drives, and queries that read from it without running a turn.

/** The oldest Claude Code the bridge is tested with. */
export const MIN_CLAUDE = "2.1.301";

/** Whether `version` ("2.1.0 (Claude Code)") is older than `floor`, by number; null when it names no version. */
export function olderThan(version: string, floor: string): boolean | null {
  const parse = (v: string) => /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const [have, need] = [parse(version), parse(floor)];
  if (!have || !need) return null;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! < need[i]!;
  return false;
}

/** Where Claude Code keeps its settings, skills and login: CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeConfigDir = (env: Record<string, string | undefined>, homeDir: string) => env.CLAUDE_CONFIG_DIR || join(homeDir, ".claude");

export const MANAGED_MCP = "/Library/Application Support/ClaudeCode/managed-mcp.json";

/**
 * Claude Code refuses --strict-mcp-config and exits while an admin's managed-mcp.json exists. That file already takes
 * exclusive control of MCP servers, so leaving the flag out loads nothing else.
 */
export const strictMcp = (managed = MANAGED_MCP): Pick<Options, "strictMcpConfig"> => (existsSync(managed) ? {} : { strictMcpConfig: true });

export type ClaudeQuery = (a: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const READ_TIMEOUT_MS = 30_000;

/**
 * Reads from a query that is sent no message, so no turn runs and nothing is spent. Claude Code still starts and runs
 * the user's SessionStart hooks, as any query does.
 */
export async function readSilently<T>(query: ClaudeQuery, options: Options, read: (q: Query) => Promise<T>, what: string, ms = READ_TIMEOUT_MS): Promise<T> {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  async function* silent(): AsyncGenerator<SDKUserMessage> {
    await held;
  }
  const q = query({ prompt: silent(), options: { ...options, persistSession: false } });
  void (async () => {
    try {
      for await (const _ of q);
    } catch {}
  })();
  try {
    return await within(read(q), ms, what);
  } finally {
    release();
    q.close();
  }
}

export const readAccount = (query: ClaudeQuery, options: Options, ms?: number): Promise<AccountInfo> =>
  readSilently(query, options, async (q) => (await q.initializationResult()).account, "Reading the Claude login", ms);

export type Login = { kind: "in"; how: string } | { kind: "out" };

const named = (source: string | undefined) => (source && source !== "none" ? source : null);

/** Measured on Claude Code 2.1.301: a claude.ai login reports its email, a logged-out one only tokenSource "none". */
export function loginOf(a: AccountInfo): Login {
  if (a.apiProvider && a.apiProvider !== "firstParty") return { kind: "in", how: `${a.apiProvider} credentials` };
  if (a.email) return { kind: "in", how: a.subscriptionType ? `${a.email} (${a.subscriptionType})` : a.email };
  const key = named(a.apiKeySource);
  if (key) return { kind: "in", how: `API key from ${key}` };
  const token = named(a.tokenSource);
  return token ? { kind: "in", how: `token from ${token}` } : { kind: "out" };
}
