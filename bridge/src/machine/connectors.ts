import type { McpServerStatus, Options } from "@anthropic-ai/claude-agent-sdk";
import { readSilently } from "../claudeCode";
import type { Tickable } from "../clock";
import { claudeExecutable, type SessionSpec } from "../session";
import { errorText } from "../text";
import type { MachineConnector } from "../protocol";

// The MCP servers this machine's agents can use, as the phone's chips and the bots' Machines block name them, so a bot
// told "check it in Chrome on my Mac" picks the machine that has Chrome. Read from a query that sends no message, so no
// model turn runs: Claude Code starts the user's servers at init and mcpServerStatus() reports them.
//
// Measured against Claude Code 2.1.301 on a Mac: a stdio server started through npx (chrome-devtools) reports pending
// for about 5 s before connected, so the probe asks again until none is pending.

export const CONNECTOR_PROBE_MS = 30 * 60_000;
const SETTLE_MS = 20_000;

/** The one table: a server whose name holds the needle is that kind. Every other server is "other". */
const KINDS: readonly (readonly [needle: string, kind: Exclude<MachineConnector["kind"], "other">])[] = [
  ["chrome", "chrome"],
  ["computer-use", "computer-use"],
];

export const kindOf = (name: string): MachineConnector["kind"] => KINDS.find(([needle]) => name.toLowerCase().includes(needle))?.[1] ?? "other";

/** An in-process (sdk) server is the host's own, such as a bot's claudio server, not the machine's. */
export function connectorsOf(statuses: readonly McpServerStatus[]): MachineConnector[] {
  return statuses
    .filter((s) => s.status === "connected" && s.source !== "sdk")
    .map((s) => ({ name: s.name, kind: kindOf(s.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The connected servers a query over `options` loads, once none is still connecting or SETTLE_MS passed. */
export async function probeConnectors(claude: Pick<SessionSpec, "query" | "executable">, options: Options, { pollMs = 1_000 } = {}): Promise<MachineConnector[]> {
  const path = (claude.executable ?? claudeExecutable)();
  if (!path) throw new Error("claude was not found on PATH, or CLAUDIOBOT_CLAUDE does not name an executable");
  return readSilently(
    claude.query,
    { ...options, pathToClaudeCodeExecutable: path },
    async (q) => {
      const until = Date.now() + SETTLE_MS;
      let statuses = await q.mcpServerStatus();
      while (statuses.some((s) => s.status === "pending") && Date.now() < until) {
        await Bun.sleep(pollMs);
        statuses = await q.mcpServerStatus();
      }
      return connectorsOf(statuses);
    },
    "Reading the connectors",
  );
}

export type ConnectorWatch = Tickable & { list(): readonly MachineConnector[] };

/** Probes on the first tick and every CONNECTOR_PROBE_MS after. changed hears a list only when it differs from the last. */
export function watchConnectors(deps: {
  probe: () => Promise<MachineConnector[]>;
  changed: (list: readonly MachineConnector[]) => void;
  log: (line: string) => void;
}): ConnectorWatch {
  let list: readonly MachineConnector[] = [];
  let dueAt: number | null = null;
  let running = false;
  let failing = false;

  return {
    tick(now) {
      if (running || (dueAt !== null && now.getTime() < dueAt)) return;
      running = true;
      dueAt = now.getTime() + CONNECTOR_PROBE_MS;
      deps
        .probe()
        .then(
          (found) => {
            failing = false;
            if (JSON.stringify(found) === JSON.stringify(list)) return;
            list = found;
            deps.changed(found);
          },
          (e: unknown) => {
            if (!failing) deps.log(`connectors: could not read this machine's, so it keeps the last list: ${errorText(e)}`);
            failing = true;
          },
        )
        .finally(() => (running = false));
    },
    nextDeadline: () => (dueAt === null ? null : new Date(dueAt).toISOString()),
    list: () => list,
  };
}
