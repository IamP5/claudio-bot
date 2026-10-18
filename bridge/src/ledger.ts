// Usage. The truth is <bridge home>/usage/YYYY-MM.jsonl (mode 0600, append-only). An in-memory index (spend per local
// day per bot, lifetime spend per agent, last cumulative per session) is rebuilt from those files at start.
//
// Boot folds every month file, not only the last two. An agent's budget is lifetime, and a session idle for months
// still has a true baseline in an old file; a window would undercount the first and re-adopt the second. Rows are small
// (about 250 bytes), so a year of heavy use is tens of MB and folds in well under a second.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, BotId, BotSpend } from "./protocol";
import { errorText } from "./text";
import { attended, driverKey, type Driver, type DriverKey, type Initiator } from "./world";

// Spend limits are off unless set. CLAUDIOBOT_DAILY_USD sets a daily cap for every bot (per local day, its agents
// included), and a bot's own dailyCapUsd wins over it. CLAUDIOBOT_AGENT_USD sets a lifetime budget for every mac agent.
// With neither, spend is still recorded and shown, and the plan's own usage limits are the guard.

/** One row per turn result. Every value is the decided one, so the file sums without replaying any rule. */
export type UsageRow = {
  at: string;
  actor: DriverKey;
  /** The bot whose daily cap this counts against: the actor itself, or the agent's bot. null: a session the phone drives, which no cap holds. */
  botId: BotId | null;
  sessionId: string;
  initiator: Initiator;
  /** total_cost_usd as the SDK reported it: cumulative per query, continued across resume, an estimate. */
  cumulativeUsd: number;
  /** Charged for this turn, against this session's previous row. */
  deltaUsd: number;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** The query started this session, so its baseline is 0 even when this result is 0. */
  fresh?: true;
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
   * Records one result. Never throws: the index takes the row first and a failed append is only logged, so the cap
   * still sees the spend and the caller never mistakes a finished turn for a crash.
   *
   * The delta is against the session's baseline, its last positive cumulative.
   * - fresh: the query started a new session (no resume id). The baseline is 0 and the first result is charged in full.
   * - A resumed session with no row adopts its first result and charges nothing: that total carries history the
   *   ledger never saw.
   * - A cumulative of 0 or less (crash and startup results carry zeros) charges nothing and never lowers the baseline.
   * - A cumulative below the baseline charges nothing, becomes the baseline, and logs a warning. Fresh queries are
   *   handled by `fresh`, so this is an anomaly: a stale total, or two queries resuming one session id.
   */
  add(result: { actor: Driver; sessionId: string; initiator: Initiator; cumulativeUsd: number; fresh?: boolean }): void;
  /** A session the phone drives always has room: the plan's own usage limits are its guard. */
  headroom(actor: Driver, initiator: Initiator): Headroom;
  /**
   * What is left of a mac agent's lifetime budget, never below 0; null when it has none. Passed as Options.maxBudgetUsd
   * when its query starts so the SDK enforces it mid-turn (the SDK counts only spend since that query started). Check
   * headroom first: at 0 the agent is held, and a query must not start with maxBudgetUsd 0.
   */
  budgetLeft(agentId: AgentId): number | null;
  /**
   * What is left of a bot's daily cap on the current local day, its agents included, never below 0; null when it has
   * none. An unattended query passes it (or the smaller of it and budgetLeft, for an agent) as maxBudgetUsd. Check
   * headroom first, as above.
   */
  dailyLeft(botId: BotId): number | null;
};

/** What the phone reads. Apart from Ledger, so a session or agent fake need not implement it. */
export type SpendView = {
  /** For the bot frame: what the bot and its agents spent on the current local day, and the cap in force. */
  botSpend(botId: BotId): BotSpend;
  /** For the agent frame: a mac agent's lifetime spend and the budget in force. */
  agentSpend(agentId: AgentId): { spentUsd: number; budgetUsd: number | null };
};

type Index = {
  /** The baseline per session: its last positive cumulative, or 0 for a fresh session with no positive result yet. */
  baseline: Map<string, number>;
  /** Spend per local day per bot. Every day is kept, so a clock or time zone that moves back still finds its day. */
  spend: Map<string, Map<BotId, number>>;
  byAgent: Map<AgentId, number>;
};

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
const AGENT_PREFIX = "agent:";
const OWN_PREFIX = "own:";

const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextLocalMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
const monthFile = (day: string) => `${day.slice(0, 7)}.jsonl`;

function charge(baseline: number | undefined, cumulativeUsd: number): { deltaUsd: number; below: boolean } {
  if (cumulativeUsd <= 0 || baseline === undefined) return { deltaUsd: 0, below: false };
  if (cumulativeUsd < baseline) return { deltaUsd: 0, below: true };
  return { deltaUsd: cumulativeUsd - baseline, below: false };
}

function fold(ix: Index, row: UsageRow): void {
  if (row.cumulativeUsd > 0 || row.fresh) ix.baseline.set(row.sessionId, Math.max(0, row.cumulativeUsd));
  if (row.botId !== null) {
    let day = ix.spend.get(row.day);
    if (!day) ix.spend.set(row.day, (day = new Map()));
    day.set(row.botId, (day.get(row.botId) ?? 0) + row.deltaUsd);
  }
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
    (r.actor.startsWith("bot:") || r.actor.startsWith(AGENT_PREFIX) || r.actor.startsWith(OWN_PREFIX)) &&
    (typeof r.botId === "string" || (r.botId === null && r.actor.startsWith(OWN_PREFIX))) &&
    typeof r.sessionId === "string" &&
    typeof r.initiator === "object" &&
    r.initiator !== null &&
    Number.isFinite(r.cumulativeUsd) &&
    Number.isFinite(r.deltaUsd) &&
    typeof r.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.day) &&
    (r.fresh === undefined || r.fresh === true);
  return ok ? (v as UsageRow) : null;
}

/** A limit in US dollars, or null for anything but a finite non-negative number. */
const usdOrNull = (usd: number | null): number | null => (usd !== null && Number.isFinite(usd) && usd >= 0 ? usd : null);

function usdFromEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  return usdOrNull(raw ? Number(raw) : null);
}

export function createLedger(deps: {
  dir: string;
  /** The bot's own cap; null, or anything but a finite non-negative number, means the bridge default (none unless set). */
  capFor: (botId: BotId) => number | null;
  /** The agent's own budget; null, or anything but a finite non-negative number, means the bridge default, as above. */
  budgetFor: (agentId: AgentId) => number | null;
  now: () => Date;
  log: (line: string) => void;
}): Ledger & SpendView {
  const defaultCap = usdFromEnv("CLAUDIOBOT_DAILY_USD");
  const defaultBudget = usdFromEnv("CLAUDIOBOT_AGENT_USD");
  const ix: Index = { baseline: new Map(), spend: new Map(), byAgent: new Map() };
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

  const cap = (botId: BotId) => usdOrNull(deps.capFor(botId)) ?? defaultCap;
  const spentOn = (day: string, botId: BotId) => ix.spend.get(day)?.get(botId) ?? 0;
  const budget = (agentId: AgentId) => usdOrNull(deps.budgetFor(agentId)) ?? defaultBudget;
  const spentBy = (agentId: AgentId) => ix.byAgent.get(agentId) ?? 0;
  const left = (limit: number | null, spent: number) => (limit === null ? null : Math.max(0, limit - spent));
  const budgetLeft = (agentId: AgentId) => left(budget(agentId), spentBy(agentId));

  return {
    add({ actor, sessionId, initiator, cumulativeUsd, fresh }) {
      const now = deps.now();
      const cumulative = Number.isFinite(cumulativeUsd) ? cumulativeUsd : 0;
      const baseline = fresh ? 0 : ix.baseline.get(sessionId);
      const { deltaUsd, below } = charge(baseline, cumulative);
      const row: UsageRow = {
        at: now.toISOString(),
        actor: driverKey(actor),
        botId: actor.kind === "own" ? null : actor.botId,
        sessionId,
        initiator,
        cumulativeUsd: cumulative,
        deltaUsd,
        day: localDay(now),
        ...(fresh && { fresh: true as const }),
      };
      if (below) {
        deps.log(
          `usage: WARNING session=${sessionId} totalCostUsd=${cumulative} is below its baseline ${baseline}; charged 0 and rebaselined (a stale total, or two queries resuming one session)`,
        );
      }
      fold(ix, row);
      deps.log(`result ${row.actor.replace(":", " ")} session=${sessionId} totalCostUsd=${cumulative} deltaUsd=${deltaUsd}`);

      const name = monthFile(row.day);
      try {
        appendFileSync(join(deps.dir, name), `${torn.has(name) ? "\n" : ""}${JSON.stringify(row)}\n`, { mode: 0o600 });
        torn.delete(name);
      } catch (e) {
        deps.log(`usage: could not append to ${name}, the spend counts only until restart: ${errorText(e)}`);
      }
    },

    headroom(actor, initiator) {
      if (actor.kind === "own") return { ok: true, capReached: false };
      if (actor.kind === "agent" && budgetLeft(actor.agentId) === 0) return { ok: false, reason: "agent_budget" };
      const now = deps.now();
      const capReached = left(cap(actor.botId), spentOn(localDay(now), actor.botId)) === 0;
      if (capReached && !attended(initiator)) {
        return { ok: false, reason: "daily_cap", until: nextLocalMidnight(now).toISOString() };
      }
      return { ok: true, capReached };
    },

    budgetLeft,

    dailyLeft: (botId) => left(cap(botId), spentOn(localDay(deps.now()), botId)),

    botSpend: (botId) => ({ spentTodayUsd: spentOn(localDay(deps.now()), botId), capUsd: cap(botId) }),

    agentSpend: (agentId) => ({ spentUsd: spentBy(agentId), budgetUsd: budget(agentId) }),
  };
}
