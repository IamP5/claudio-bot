import type { AccountInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UsageSeverity, UsageUnavailable, UsageWindow } from "./protocol";

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

/** The plan's limits as one read found them, before the usage monitor stamps when and how fresh. */
export type UsageRead =
  | { state: "ok"; plan: string | null; windows: UsageWindow[] }
  | { state: "unavailable"; reason: Exclude<UsageUnavailable, "failed"> };

/**
 * The plan's usage limits, read the way Claude Code's /usage reads them, from a query that runs no turn. The SDK's call
 * is experimental and its answer carries more than its types say, so this is the only caller and the answer is parsed
 * here. It never touches the Keychain or the usage endpoint itself: Claude Code holds and refreshes the login.
 */
export const readPlanUsage = (query: ClaudeQuery, options: Options, ms?: number): Promise<UsageRead> =>
  readSilently(
    query,
    options,
    async (q) => {
      const { account } = await q.initializationResult();
      return usageOf(account, await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    },
    "Reading the plan usage",
    ms,
  );

type Raw = Record<string, unknown>;
const record = (v: unknown): Raw | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
/** The answer's times carry microseconds and an offset; the wire's carry milliseconds in UTC. */
const instant = (v: unknown): string | null => {
  const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
/** The answer gives percentages, 0 to 100. */
const share = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) / 100 : null);
const SEVERITIES: readonly string[] = ["normal", "warning", "critical"] satisfies UsageSeverity[];

/** Only for a window the server did not rate. A guess at where Claude Code starts to warn. */
const severityAt = (utilization: number): UsageSeverity => (utilization >= 0.9 ? "critical" : utilization >= 0.75 ? "warning" : "normal");

function windowOf(id: string, kind: UsageWindow["kind"], label: string, utilization: number | null, resetsAt: unknown, severity?: unknown): UsageWindow | null {
  if (utilization === null) return null;
  const rated = typeof severity === "string" && SEVERITIES.includes(severity) ? (severity as UsageSeverity) : severityAt(utilization);
  return { id, kind, label, utilization, resetsAt: instant(resetsAt), severity: rated };
}

const modelWindow = (name: string, utilization: number | null, resetsAt: unknown, severity?: unknown) =>
  windowOf(`weekly:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, "weekly_model", `Weekly · ${name}`, utilization, resetsAt, severity);

/** A row of the server's limits[]. A kind this bridge does not know is left out: it has no label for it. */
function limitWindow(row: Raw): UsageWindow | null {
  const percent = share(row.percent);
  switch (row.kind) {
    case "session":
      return windowOf("session", "session", "Current session", percent, row.resets_at, row.severity);
    case "weekly_all":
      return windowOf("weekly", "weekly", "Weekly · all models", percent, row.resets_at, row.severity);
    case "weekly_scoped": {
      const name = text(record(record(record(row.scope)?.model))?.display_name);
      return name === null ? null : modelWindow(name, percent, row.resets_at, row.severity);
    }
    default:
      return null;
  }
}

/** The named windows, for an answer without limits[]. */
function namedWindows(limits: Raw): (UsageWindow | null)[] {
  const named = (key: string) => record(limits[key]);
  const model = (key: string, name: string) => modelWindow(name, share(named(key)?.utilization), named(key)?.resets_at);
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped.map(record) : [];
  return [
    windowOf("session", "session", "Current session", share(named("five_hour")?.utilization), named("five_hour")?.resets_at),
    windowOf("weekly", "weekly", "Weekly · all models", share(named("seven_day")?.utilization), named("seven_day")?.resets_at),
    model("seven_day_opus", "Opus"),
    model("seven_day_sonnet", "Sonnet"),
    ...scoped.map((m) => (m && text(m.display_name) ? modelWindow(text(m.display_name)!, share(m.utilization), m.resets_at) : null)),
  ];
}

/** Why a login has no plan limits to read. */
function unavailable(a: AccountInfo): Exclude<UsageUnavailable, "failed"> {
  if (a.apiProvider && a.apiProvider !== "firstParty") return "third_party";
  if (loginOf(a).kind === "out") return "logged_out";
  return !a.email && named(a.apiKeySource) ? "api_key" : "no_scope";
}

/**
 * The read, from the account and the answer as Claude Code 2.1.301 gave them. The server's limits[] rows come first:
 * they carry the server's own severity and its per-model windows. An answer without them falls back to the named
 * windows. Throws on an answer that is not an object, which the monitor counts as a failed read.
 */
export function usageOf(account: AccountInfo, answer: unknown): UsageRead {
  const a = record(answer);
  if (!a) throw new Error("The usage answer was not an object");
  if (a.rate_limits_available !== true) return { state: "unavailable", reason: unavailable(account) };
  const limits = record(a.rate_limits) ?? {};
  const known = (ws: (UsageWindow | null)[]) => ws.filter((w): w is UsageWindow => w !== null);
  const rows = known(Array.isArray(limits.limits) ? limits.limits.map((r) => (record(r) ? limitWindow(record(r)!) : null)) : []);
  const found = rows.length > 0 ? rows : known(namedWindows(limits));
  const windows = found.filter((w, i) => found.findIndex((o) => o.id === w.id) === i);
  return { state: "ok", plan: text(a.subscription_type), windows };
}

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
