import { setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSdkServerConfigWithInstance, Options, query, SDKMessage, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHomes } from "../src/home";
import { createHub, type HubDeps } from "../src/hub";
import type { Project } from "../src/projects";
import type { BotId, MessageId, PlanUsage, ServerMessage, Signal, StreamPosition } from "../src/protocol";
import type { Push, PushReason } from "../src/push";
import { newBot, type BotRecord, type World } from "../src/world";

// A hub over a fake Claude Code: the queries it opens, the frames and signals it sends, the pushes it makes.

export const roots: string[] = [];
/** Clears the fake clock and the temp folders a test made. Each test file calls it from its own afterEach. */
export function cleanup() {
  setSystemTime();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
export const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

export const at = "2026-10-17T12:00:00.000Z";
export const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
export const NO_RING: StreamPosition = { epoch: "", seq: 0, resumed: false };
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What Claude Code reports a bot can run: a project skill, and two built-ins of which the menu shows one. */
export const COMMANDS: SlashCommand[] = [
  { name: "greet", description: "Greet someone by name (project)", argumentHint: "[name]" },
  { name: "clear", description: "Start a new session with empty context", argumentHint: "", builtin: true, aliases: ["reset", "new"] },
  { name: "compact", description: "Free up context", argumentHint: "<instructions>", builtin: true },
];

/** A live SDK query the test drives: what the session sent it, and what it answers. */
export class FakeQuery {
  /** Each message's content: a string, or the blocks of a /command sent after context. */
  readonly received: string[] = [];
  readonly toggles: string[] = [];
  interrupts = 0;
  private queue: SDKMessage[] = [];
  private done = false;
  private wake: (() => void) | null = null;

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const m of prompt) this.received.push(m.message.content as string);
    })();
  }
  emit(...ms: SDKMessage[]) {
    this.queue.push(...ms);
    this.wake?.();
  }
  async interrupt() {
    this.interrupts++;
  }
  async mcpServerStatus() {
    return [
      { name: "claudio", status: "connected", source: "sdk" },
      { name: "chrome-devtools", status: "connected", source: "user" },
    ];
  }
  async toggleMcpServer(name: string, enabled: boolean) {
    this.toggles.push(`${name} ${enabled}`);
  }
  commands: SlashCommand[] = COMMANDS;
  async supportedCommands() {
    return this.commands;
  }
  get closed() {
    return this.done;
  }
  close() {
    this.done = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

let uuid = 0;
export const assistant = (...content: object[]) =>
  ({ type: "assistant", uuid: `u${++uuid}`, session_id: "s_1", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
export const text = (t: string) => ({ type: "text", text: t });
export const toolUse = (name: string) => ({ type: "tool_use", id: `t${++uuid}`, name, input: {} });
export const result = (cost = 0.25, over: object = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: "ok", errors: [], session_id: "s_1", total_cost_usd: cost, ...over }) as unknown as SDKMessage;

export type PushCall = { botId: BotId; reason: PushReason; messageId: MessageId };

/** sends: whether the fake push goes out (default: always). push: a real push instead of the fake. */
export function hubOver(
  world: World,
  opts: {
    persist?: (urgency?: "now") => void;
    sends?: (call: PushCall, n: number) => boolean;
    push?: Push;
    scan?: () => Promise<Project[]>;
    executable?: string | null;
    usage?: HubDeps["usage"];
    sessions?: HubDeps["sessions"];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-hub-"));
  roots.push(root);
  const homes = createHomes(root);
  const events: string[] = [];
  const frames: ServerMessage[] = [];
  const signals: Extract<Signal, { type: "activity" }>[] = [];
  const usage: PlanUsage[] = [];
  const pushes: PushCall[] = [];
  const attempts: PushCall[] = [];
  const queries: FakeQuery[] = [];
  const hub = createHub({
    machine: "Mac",
    userName: "Alex",
    world,
    homes: {
      ...homes,
      trash(id, when) {
        events.push(`trash ${id}`);
        homes.trash(id, when);
      },
    },
    model: undefined,
    scan: opts.scan ?? (async () => []),
    broadcast: (m) => frames.push(m),
    signal: (s) => (s.type === "activity" ? signals.push(s) : usage.push(s.usage)),
    usage: opts.usage,
    ...(opts.sessions && { sessions: opts.sessions }),
    webhookPort: null,
    persist: (urgency) => {
      opts.persist?.(urgency);
      events.push(`persist ${urgency ?? "later"} with ${[...world.bots.keys()].join(",") || "no bots"}`);
    },
    log: () => {},
    push: opts.push ?? {
      notify(bot, reason, messageId) {
        const call = { botId: bot.id, reason, messageId };
        attempts.push(call);
        const sent = opts.sends?.(call, attempts.length) ?? true;
        if (sent) pushes.push(call);
        return sent;
      },
      tick() {},
      nextDeadline: () => null,
    },
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(prompt, options);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => (opts.executable === undefined ? "/fake/claude" : opts.executable),
    },
  });
  return { hub, homes, root, events, frames, signals, usage, pushes, attempts, queries, q: () => queries.at(-1)! };
}

/** The bridge's real gate, called the way Claude Code calls the PreToolUse hook the session was given. */
export function runBash(q: FakeQuery, command: string) {
  const id = `toolu_${++uuid}`;
  const input = { hook_event_name: "PreToolUse", session_id: "s_1", transcript_path: "/tmp/t.jsonl", cwd: q.options.cwd!, tool_name: "Bash", tool_input: { command, description: "run" }, tool_use_id: id };
  return q.options.hooks!.PreToolUse![0]!.hooks[0]!(input as never, id, { signal: new AbortController().signal });
}

/** One of the bot's own tools, called the way Claude Code calls it: over MCP. */
export async function callTool(q: FakeQuery, name: string, args: Record<string, unknown>) {
  const [server, client] = InMemoryTransport.createLinkedPair();
  await (q.options.mcpServers!.claudio as McpSdkServerConfigWithInstance).instance.connect(server);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(client);
  return mcp.callTool({ name, arguments: args });
}

export const bot = (name: string, patch: Partial<BotRecord> = {}): BotRecord => ({ ...newBot({ id: `b_${name}` as BotId, name, avatar: { shape: "circle", color: "white" }, at }), ...patch });
