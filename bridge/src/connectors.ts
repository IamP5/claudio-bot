import type { Query, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { BotId, Connector } from "./protocol";
import { refused, type Result } from "./result";
import type { Persist } from "./store";
import type { World } from "./world";

// Connectors are the MCP servers a bot's queries load (user, project and claude.ai servers; the
// bridge's own claudio server is never listed). The phone sees names and statuses only, never configuration. Turning
// one off is persisted in BotRecord.connectorsOff, covers the bot's agents, applies to the live query at once and to
// every later query through connectorSettings; the gate denies a call to an off server whatever the SDK loaded.

/** The live query's MCP controls. null while the bot has no query open. */
export type McpControl = Pick<Query, "mcpServerStatus" | "toggleMcpServer">;

/** Flag settings merged into every query of the bot and its agents so the off servers do not load. Pure. */
export function connectorSettings(_off: readonly string[]): Settings {
  return {};
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

export function createConnectors(_deps: ConnectorsDeps): Connectors {
  return {
    list: async () => [],
    set: async () => refused("Connector toggles are not available on this bridge yet."),
  };
}
