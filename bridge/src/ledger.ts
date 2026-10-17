// Usage. The truth is <bridge home>/usage/YYYY-MM.jsonl (mode 0600, append-only). An in-memory index (today's spend
// per bot, lifetime spend per agent, last cumulative per session) is rebuilt from those files at start. Owner: U3.
//
// Boot folds every month file, not only the last two. An agent's budget is lifetime, and a session idle for months
// still has a true baseline in an old file; a window would undercount the first and re-adopt the second. Rows are small
// (about 250 bytes), so a year of heavy use is tens of MB and folds in well under a second.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, BotId } from "./protocol";
import { actorKey, attended, type Actor, type ActorKey, type Initiator } from "./world";

/** Per bot per local day, its agents included. Override: CLAUDIOBOT_DAILY_USD. A bot's own dailyCapUsd wins. */
export const DEFAULT_DAILY_CAP_USD = 10;
/** Per mac agent, lifetime. Override: CLAUDIOBOT_AGENT_USD. */
export const DEFAULT_AGENT_BUDGET_USD = 5;

/** One row per turn result. Every value is the decided one, so the file sums without replaying any rule. */
export type UsageRow = {
  at: string;
  actor: ActorKey;
  /** The bot whose daily cap this counts against: the actor itself, or the agent's bot. */
  botId: BotId;
  sessionId: string;
  initiator: Initiator;
  /** total_cost_usd as the SDK reported it: cumulative per query, continued across resume, an estimate. */
  cumulativeUsd: number;
  /** Charged for this turn, against this session's previous row. */
  deltaUsd: number;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
};

/**
 * Whether a turn may start now, for this actor and this initiator.
 * - Attended turns always run. capReached tells the caller to leave a note that the cap is reached.
 * - Unattended turns (routine, bot, agent, system) stop at the bot's daily cap until the next local midnight.
 * - A mac agent's turns also stop once its own budget is used up.
 */
export type Headroom =
  | { ok: true; capReached: boolean }
  | { ok: false; reason: "daily_cap"; until: string }
  | { ok: false; reason: "agent_budget" };

export type Ledger = {
  /**
   * Records one result and appends its row before returning. The cost baseline lives here: the delta is against this
   * session's last row. A session with no row adopts the first result and charges nothing. A cumulative of 0 or less
   * (crash and startup results carry zeros) charges nothing and never lowers the baseline. A cumulative below the
   * baseline means the running total restarted (/clear), so the delta is the cumulative itself.
   */
  add(result: { actor: Actor; sessionId: string; initiator: Initiator; cumulativeUsd: number }): void;
  headroom(actor: Actor, initiator: Initiator): Headroom;
  /**
   * What is left of a mac agent's budget, passed as Options.maxBudgetUsd when its query starts so the SDK enforces it
   * mid-turn (the SDK counts only spend since that query started). null: no limit to pass.
   */
  budgetLeft(agentId: AgentId): number | null;
};

type Index = {
  /** The last positive cumulative per session: its baseline. */
  baseline: Map<string, number>;
  /** Spend on the latest local day seen; a row from a later day starts a new bucket. */
  today: { day: string; byBot: Map<BotId, number> };
  byAgent: Map<AgentId, number>;
};

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
const AGENT_PREFIX = "agent:";

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextLocalMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
const monthFile = (day: string) => `${day.slice(0, 7)}.jsonl`;

function charge(baseline: number | undefined, cumulativeUsd: number): number {
  if (cumulativeUsd <= 0 || baseline === undefined) return 0;
  return cumulativeUsd >= baseline ? cumulativeUsd - baseline : cumulativeUsd;
}

function fold(ix: Index, row: UsageRow): void {
  if (row.cumulativeUsd > 0) ix.baseline.set(row.sessionId, row.cumulativeUsd);
  if (row.day > ix.today.day) ix.today = { day: row.day, byBot: new Map() };
  if (row.day === ix.today.day) ix.today.byBot.set(row.botId, (ix.today.byBot.get(row.botId) ?? 0) + row.deltaUsd);
  if (row.actor.startsWith(AGENT_PREFIX)) {
    const agentId = row.actor.slice(AGENT_PREFIX.length) as AgentId;
    ix.byAgent.set(agentId, (ix.byAgent.get(agentId) ?? 0) + row.deltaUsd);
  }
}

function parseRow(line: string): UsageRow | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const ok =
    typeof r.at === "string" &&
    typeof r.actor === "string" &&
    (r.actor.startsWith("bot:") || r.actor.startsWith(AGENT_PREFIX)) &&
    typeof r.botId === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.initiator === "object" &&
    r.initiator !== null &&
    Number.isFinite(r.cumulativeUsd) &&
    Number.isFinite(r.deltaUsd) &&
    typeof r.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.day);
  return ok ? (v as UsageRow) : null;
}

function usdFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function createLedger(deps: {
  dir: string;
  /** The bot's own cap; null means the default. */
  capFor: (botId: BotId) => number | null;
  /** The agent's own budget; null means the default. */
  budgetFor: (agentId: AgentId) => number | null;
  now: () => Date;
  log: (line: string) => void;
}): Ledger {
  const defaultCap = usdFromEnv("CLAUDIOBOT_DAILY_USD", DEFAULT_DAILY_CAP_USD);
  const defaultBudget = usdFromEnv("CLAUDIOBOT_AGENT_USD", DEFAULT_AGENT_BUDGET_USD);
  const ix: Index = { baseline: new Map(), today: { day: "", byBot: new Map() }, byAgent: new Map() };
  // A file whose last line was torn by a crash; the next append starts on a fresh line so it does not glue onto it.
  const torn = new Set<string>();

  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(deps.dir).filter((n) => MONTH_FILE.test(n)).sort()) {
    const text = readFileSync(join(deps.dir, name), "utf8");
    if (text.length > 0 && !text.endsWith("\n")) torn.add(name);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const row = parseRow(line);
      if (row) fold(ix, row);
      else deps.log(`usage: skipped an unreadable line in ${name}`);
    }
  }

  const spentToday = (botId: BotId, now: Date) =>
    ix.today.day === localDay(now) ? (ix.today.byBot.get(botId) ?? 0) : 0;

  const budgetLeft = (agentId: AgentId): number =>
    Math.max(0, (deps.budgetFor(agentId) ?? defaultBudget) - (ix.byAgent.get(agentId) ?? 0));

  return {
    add({ actor, sessionId, initiator, cumulativeUsd }) {
      const now = deps.now();
      const cumulative = Number.isFinite(cumulativeUsd) ? cumulativeUsd : 0;
      const row: UsageRow = {
        at: now.toISOString(),
        actor: actorKey(actor),
        botId: actor.botId,
        sessionId,
        initiator,
        cumulativeUsd: cumulative,
        deltaUsd: charge(ix.baseline.get(sessionId), cumulative),
        day: localDay(now),
      };
      const name = monthFile(row.day);
      const lead = torn.delete(name) ? "\n" : "";
      appendFileSync(join(deps.dir, name), `${lead}${JSON.stringify(row)}\n`, { mode: 0o600 });
      fold(ix, row);
      deps.log(`result ${row.actor.replace(":", " ")} session=${sessionId} totalCostUsd=${cumulative} deltaUsd=${row.deltaUsd}`);
    },

    headroom(actor, initiator) {
      if (actor.kind === "agent" && budgetLeft(actor.agentId) <= 0) return { ok: false, reason: "agent_budget" };
      const now = deps.now();
      const capReached = spentToday(actor.botId, now) >= (deps.capFor(actor.botId) ?? defaultCap);
      if (capReached && !attended(initiator)) {
        return { ok: false, reason: "daily_cap", until: nextLocalMidnight(now).toISOString() };
      }
      return { ok: true, capReached };
    },

    budgetLeft,
  };
}
