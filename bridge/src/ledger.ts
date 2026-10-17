// Usage. The truth is <bridge home>/usage/YYYY-MM.jsonl (mode 0600, append-only). An in-memory index (today's spend
// per bot, lifetime spend per agent, last cumulative per session) is rebuilt from those files at start. Owner: U3.
//
// The scaffold body only logs each result, as the bridge always has, and never limits anything.
import type { AgentId, BotId } from "./protocol";
import { actorKey, type Actor, type ActorKey, type Initiator } from "./world";

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

export function createLedger(deps: {
  dir: string;
  /** The bot's own cap; null means the default. */
  capFor: (botId: BotId) => number | null;
  /** The agent's own budget; null means the default. */
  budgetFor: (agentId: AgentId) => number | null;
  now: () => Date;
  log: (line: string) => void;
}): Ledger {
  return {
    add({ actor, sessionId, cumulativeUsd }) {
      const label = actorKey(actor).replace(":", " ");
      deps.log(`result ${label} session=${sessionId} totalCostUsd=${cumulativeUsd}`);
    },
    headroom: () => ({ ok: true, capReached: false }),
    budgetLeft: () => null,
  };
}
