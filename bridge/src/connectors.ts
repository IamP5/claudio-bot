import type { McpServerStatus, Query, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { BotId, Connector, ConnectorStatus } from "./protocol";
import { refused, type Result } from "./result";
import type { Persist } from "./store";
import { hasHiddenCharacters } from "./text";
import { own, type World } from "./world";

// Connectors are the MCP servers a bot's queries load (user, project, plugin and claude.ai servers; the
// bridge's own claudio server is never listed). The phone sees names and statuses only, never configuration. Turning
// one off is persisted in BotRecord.connectorsOff, covers the bot's agents, applies to the live query at once and to
// every later query through connectorSettings; the gate denies a call to an off server whatever the SDK loaded,
// including from an agent whose turn began before the toggle and keeps its query until that turn ends.
//
// Proven by isolated probes:
//  - research/pass3/probe-c: a resumed query given deniedMcpServers does not list or load the user server chrome-devtools.
//  - research/pass3/probe-c2: the plugin server plugin:vercel:vercel has that name in mcpServerStatus and in the
//    PreToolUse hook's mcp_server (source "plugin"), its tools are named mcp__plugin_vercel_vercel__*, and
//    deniedMcpServers [{ serverName: "plugin:vercel:vercel" }] keeps it out of the status list and the tool list.
// Not proven: claude.ai servers ("claude.ai Gmail"). Their hook name and whether the deny list matches their status name
// are untested; the gate also matches their tool prefix (mcp__claude_ai_Gmail__) as Claude Code's bundle normalizes it.

/** The live query's MCP controls. null while the bot has no query open. */
export type McpControl = Pick<Query, "mcpServerStatus" | "toggleMcpServer">;

const CLAUDIO = "claudio";
const NAME_MAX = 200;
const OFF_MAX = 64;

/**
 * Flag settings merged into every query of the bot and its agents so the off servers do not load. Pure.
 * The deny list matches the status name verbatim (proven for user and plugin servers, see the header).
 */
export function connectorSettings(off: readonly string[]): Settings {
  return off.length === 0 ? {} : { deniedMcpServers: off.map((serverName) => ({ serverName })) };
}

export type Connectors = {
  list(botId: BotId): Promise<Connector[]>;
  set(botId: BotId, name: string, enabled: boolean): Promise<Result>;
};

export type ConnectorsDeps = {
  world: World;
  /** The bot's live query, when one is open. */
  live: (botId: BotId) => McpControl | null;
  /** Close the bot's and its agents' live queries at their next chance, so the next opens with the new settings. */
  reopen: (botId: BotId) => void;
  persist: Persist;
  log: (line: string) => void;
};

type Seen = { name: string; status: ConnectorStatus };

const STATUS: Record<McpServerStatus["status"], ConnectorStatus> = {
  connected: "connected",
  pending: "pending",
  failed: "failed",
  "needs-auth": "needs_auth",
  disabled: "unchecked",
};

/** Only the name and a mapped status leave the SDK's entry: its config carries commands, URLs and env. */
function seenOf(statuses: readonly McpServerStatus[]): Seen[] {
  return statuses
    .filter((s) => s.name !== CLAUDIO && s.source !== "sdk")
    .map((s) => ({ name: s.name, status: STATUS[s.status] ?? "unchecked" }));
}

export function createConnectors(deps: ConnectorsDeps): Connectors {
  const lastSeen = new Map<BotId, Seen[]>();

  async function current(botId: BotId): Promise<Seen[]> {
    const live = deps.live(botId);
    if (live !== null) {
      try {
        const seen = seenOf(await live.mcpServerStatus());
        lastSeen.set(botId, seen);
        return seen;
      } catch (e) {
        deps.log(`connectors: status of ${botId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return lastSeen.get(botId) ?? [];
  }

  return {
    async list(botId) {
      const bot = deps.world.bots.get(botId);
      if (!bot) return [];
      const off = new Set(bot.connectorsOff);
      const seen = await current(botId);
      // A denied server is not loaded at all, so it is missing from the status list.
      const missing = [...off].filter((name) => !seen.some((s) => s.name === name)).map((name): Seen => ({ name, status: "unchecked" }));
      return [...seen, ...missing]
        .map(({ name, status }) => ({ name, status, enabled: !off.has(name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async set(botId, name, enabled) {
      const bot = deps.world.bots.get(botId);
      if (!bot) return refused("That bot no longer exists.");
      if (name === CLAUDIO) return refused("The claudio connector is the bridge's own and cannot be turned off.");
      if (name.length === 0 || name.length > NAME_MAX || hasHiddenCharacters(name)) return refused("That is not a connector name.");
      if (!enabled && !bot.connectorsOff.includes(name)) {
        if (bot.connectorsOff.length >= OFF_MAX) return refused(`At most ${OFF_MAX} connectors can be off for one bot.`);
        if (!(await current(botId)).some((s) => s.name === name)) return refused("That bot has no connector by that name.");
      }
      const off = own<string[]>(bot.connectorsOff);
      const at = off.indexOf(name);
      if (enabled && at >= 0) off.splice(at, 1);
      if (!enabled && at < 0) off.push(name);
      deps.persist("now");
      try {
        await deps.live(botId)?.toggleMcpServer(name, enabled);
      } catch (e) {
        deps.log(`connectors: live toggle of ${name} for ${botId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      deps.reopen(botId);
      return { ok: true };
    },
  };
}
