import type { Options, Query, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { BotId, Command } from "./protocol";
import { claudeExecutable, type SessionSpec } from "./session";
import { errorText } from "./text";

// The phone's "/" menu: what the bot's Claude Code session can run, as supportedCommands() reports it. A user message
// whose text is exactly "/name args" runs that command or skill when it reaches Claude Code as the bare string, so
// session.ts sends such a turn without the envelope (Pending kind "command").
//
// Proven against Claude Code 2.1.301 (scratchpad slash/run.ts, run2.ts): supportedCommands() lists project, user,
// plugin and bundled skills and the CLI's built-ins, and it answers from a query whose input never yields, so reading
// it runs no model turn. The same text inside a multi-block content array, or after anything prepended, is not run.

/**
 * The built-ins the menu offers. Every other built-in stays hidden, including ones a newer Claude Code adds: most of
 * them change or end the bot's long-lived session (clear, resume, model, config), act on a terminal nobody watches, or
 * start work the bot does not supervise.
 */
export const BUILTINS_SHOWN: ReadonlySet<string> = new Set([
  "compact",
  "code-review",
  "security-review",
  "simplify",
  "init",
  "verify",
  "dataviz",
  "deep-research",
  "claude-api",
]);

/** Where a skill came from, as Claude Code appends it to the description: "… (project)". */
const LOCATION = /\s*\((?:user|project|local|managed|plugin|bundled|claude\.ai sync)\)$/;
const DESCRIPTION_MAX = 200;

function describe(description: string): string {
  const line = (description.split(/\r?\n/)[0] ?? "").replace(LOCATION, "").trim();
  return line.length <= DESCRIPTION_MAX ? line : `${line.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/**
 * The menu over what Claude Code reported, in its order. A built-in owns its name: /name runs it even when a skill
 * shares the name, so a hidden built-in hides that skill too. A name with a space cannot be typed as one word, so it
 * is left out.
 */
export function menuOf(rows: readonly SlashCommand[]): Command[] {
  const builtins = new Set(rows.filter((r) => r.builtin).map((r) => r.name));
  const seen = new Set<string>();
  const menu: Command[] = [];
  for (const r of rows) {
    if (r.name === "" || /\s/.test(r.name) || seen.has(r.name) || (builtins.has(r.name) && !r.builtin)) continue;
    seen.add(r.name);
    if (r.builtin && !BUILTINS_SHOWN.has(r.name)) continue;
    menu.push({ name: r.name, description: describe(r.description), argumentHint: r.argumentHint ?? "", source: r.builtin ? "builtin" : "skill" });
  }
  return menu;
}

/** The name in "/name" or "/name args", or null. */
export const slashName = (text: string): string | null => /^\/([^\s/]\S*)(?:\s|$)/.exec(text.trim())?.[1] ?? null;

/** The command the user's text runs from the menu, or null when it is an ordinary message. */
export function commandOf(text: string, menu: readonly Command[]): string | null {
  const name = slashName(text);
  return name !== null && menu.some((c) => c.name === name) ? name : null;
}

const READ_TIMEOUT_MS = 30_000;

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * The commands a query over `options` would offer, read from a query that is sent no message, so no turn runs and
 * nothing is spent. Claude Code still starts and runs the user's SessionStart hooks, as any query of the bot does.
 */
export async function probeCommands(claude: Pick<SessionSpec, "query" | "executable">, options: Options): Promise<SlashCommand[]> {
  const path = (claude.executable ?? claudeExecutable)();
  if (!path) throw new Error("claude was not found on PATH, or CLAUDIOBOT_CLAUDE does not name an executable");
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  async function* silent(): AsyncGenerator<SDKUserMessage> {
    await held;
  }
  const q = claude.query({ prompt: silent(), options: { ...options, persistSession: false, pathToClaudeCodeExecutable: path } });
  void (async () => {
    try {
      for await (const _ of q);
    } catch {}
  })();
  try {
    return await within(q.supportedCommands(), READ_TIMEOUT_MS, "Reading the commands");
  } finally {
    release();
    q.close();
  }
}

export type Commands = {
  /** The bot's menu, read now unless the list last read describes the query open now (or, with none open, the next). [] when it cannot be read. */
  list(botId: BotId): Promise<Command[]>;
  /** Reads the list again: the bot's query opened, or its skills changed. Phones get the menu when it changed. */
  refresh(botId: BotId): void;
  /** The live query pushed its new list (system commands_changed). */
  seen(botId: BotId, rows: readonly SlashCommand[]): void;
  /** A built-in the menu hides, by the list last read; false when none was read. */
  hidden(botId: BotId, name: string): boolean;
  forget(botId: BotId): void;
};

export type CommandsDeps = {
  /** The bot's open query, when it has one. */
  live: (botId: BotId) => Pick<Query, "supportedCommands"> | null;
  /** A query that runs no turn, for a bot with none open (probeCommands over the bot's options). */
  probe: (botId: BotId) => Promise<SlashCommand[]>;
  changed: (botId: BotId, menu: Command[]) => void;
  log: (line: string) => void;
};

type Live = Pick<Query, "supportedCommands">;

/**
 * A list and the query it describes: an open query's, or (source null) what the next query would load, from a probe.
 * A list from a query that has since closed describes nothing that runs, so it is read again.
 */
type Read = { rows: readonly SlashCommand[]; source: Live | null };

export function createCommands(deps: CommandsDeps): Commands {
  const reads = new Map<BotId, Read>();
  const reading = new Map<BotId, Promise<void>>();

  function keep(botId: BotId, rows: readonly SlashCommand[], source: Live | null) {
    const before = reads.get(botId);
    reads.set(botId, { rows, source });
    const menu = menuOf(rows);
    if (before === undefined || JSON.stringify(menuOf(before.rows)) !== JSON.stringify(menu)) deps.changed(botId, menu);
  }

  function read(botId: BotId): Promise<void> {
    const running = reading.get(botId);
    if (running) return running;
    const live = deps.live(botId);
    const next = (live ? live.supportedCommands() : deps.probe(botId))
      .then((rows) => keep(botId, rows, live))
      .catch((e) => deps.log(`commands: could not read ${botId}'s: ${errorText(e)}`))
      .finally(() => reading.delete(botId));
    reading.set(botId, next);
    return next;
  }

  return {
    async list(botId) {
      if (reads.get(botId)?.source !== deps.live(botId)) await read(botId);
      return menuOf(reads.get(botId)?.rows ?? []);
    },
    refresh(botId) {
      void read(botId);
    },
    seen: (botId, rows) => keep(botId, rows, deps.live(botId)),
    hidden(botId, name) {
      return (reads.get(botId)?.rows ?? []).some((r) => r.builtin && r.name === name && !BUILTINS_SHOWN.has(name));
    },
    forget(botId) {
      reads.delete(botId);
    },
  };
}
