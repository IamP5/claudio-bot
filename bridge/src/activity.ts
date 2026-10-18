import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Signal } from "./protocol";
import { displayName, redact } from "./text";
import { actorKey, type Actor, type ActorKey } from "./world";

// The activity line under a bot ("Reading hub.ts", "Running tests"): read from the live query's
// messages, throttled, redacted with text.ts, sent as an unsequenced signal to live sockets only. Never stored,
// replayed or pushed.

/** At most one frame per actor in this window; the last line seen inside it goes out when it closes. */
export const ACTIVITY_THROTTLE_MS = 1500;
const LINE_MAX = 80;

type Input = Record<string, unknown>;

const str = (input: Input, key: string): string | null => {
  const v = input[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

const basename = (p: string | null): string | null => p?.split("/").filter(Boolean).pop() ?? null;

function host(u: string | null): string | null {
  if (u === null) return null;
  try {
    return new URL(u).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A model-written description with every URL cut to its host and every command-line option dropped with its value,
 * so a query string or a "--password x" never reaches the phone. redact then masks what still looks like a secret.
 */
function scrub(line: string): string {
  return line
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (u) => host(u) ?? "a web address")
    .replace(/(^|\s)--?[A-Za-z][\w-]*(?:=\S*|\s+(?!-)\S+)?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const file = (verb: string, input: Input, key = "file_path") => `${verb} ${basename(str(input, key)) ?? "a file"}`;

/** The program a command runs, never its arguments: env assignments skipped, a path cut to its last part. */
function program(command: string | null): string | null {
  for (const word of command?.split(/\s+/) ?? []) {
    if (word === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "sudo") continue;
    const name = basename(word);
    return name !== null && /^[\w.+-]+$/.test(name) ? name : null;
  }
  return null;
}

const words = (s: string) => s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();

const LINES: Record<string, (input: Input) => string> = {
  Read: (i) => file("Reading", i),
  Edit: (i) => file("Editing", i),
  MultiEdit: (i) => file("Editing", i),
  Write: (i) => file("Writing", i),
  NotebookEdit: (i) => file("Editing", i, "notebook_path"),
  Bash: (i) => {
    const run = program(str(i, "command"));
    return str(i, "description") ?? (run ? `Running ${run}` : "Running a command");
  },
  BashOutput: () => "Checking a command",
  KillShell: () => "Stopping a command",
  Grep: () => "Searching the code",
  Glob: () => "Finding files",
  WebFetch: (i) => `Reading ${host(str(i, "url")) ?? "a web page"}`,
  WebSearch: () => "Searching the web",
  Task: (i) => str(i, "description") ?? "Starting a helper",
  Agent: (i) => str(i, "description") ?? "Starting a helper",
  TodoWrite: () => "Updating its plan",
  Skill: (i) => (str(i, "skill") ? `Using the ${words(str(i, "skill")!)} skill` : "Using a skill"),
};

function lineOf(name: string, input: Input): string | null {
  const known = LINES[name];
  if (known) return known(input);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}: ${words(mcp[2]!)}`;
  return /^[A-Za-z][\w-]*$/.test(name) ? `Using ${words(name)}` : null;
}

/** The line one SDK message shows, or null when it changes nothing. Pure. */
export function activityOf(m: SDKMessage): string | null {
  if (m.type === "system" && m.subtype === "status" && m.status === "compacting") return "Compacting the conversation";
  if (m.type !== "assistant") return null;
  const content: unknown = m.message?.content;
  if (!Array.isArray(content)) return null;
  let line: string | null = null;
  for (const block of content) {
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = typeof block.input === "object" && block.input !== null ? (block.input as Input) : {};
    line = lineOf(block.name, input) ?? line;
  }
  if (line === null) return null;
  const shown = displayName(String(redact(scrub(line))), LINE_MAX);
  return shown === "" ? null : shown;
}

export type Activity = {
  /** Every SDK message of a bot's or mac agent's live query. Must not throw: it runs inside the session's onMessage. */
  observe(actor: Actor, m: SDKMessage): void;
  /** The actor's turn ended or it went away: its line clears. */
  clear(actor: Actor): void;
};

/** One actor's line: what the phone shows, when it was sent, and the newer line waiting out the throttle. */
type Line = { shown: string | null; sentAt: number; waiting: string | null; timer: ReturnType<typeof setTimeout> | null };

export function createActivity(deps: { signal: (s: Signal) => void; now: () => Date }): Activity {
  const lines = new Map<ActorKey, Line>();

  function send(actor: Actor, line: Line, text: string | null) {
    const at = deps.now();
    line.shown = text;
    line.sentAt = at.getTime();
    deps.signal({ type: "activity", botId: actor.botId, agentId: actor.kind === "agent" ? actor.agentId : null, text, at: at.toISOString() });
  }

  function flush(actor: Actor, line: Line) {
    line.timer = null;
    const text = line.waiting;
    line.waiting = null;
    if (text !== null && text !== line.shown) send(actor, line, text);
  }

  return {
    observe(actor, m) {
      try {
        const text = activityOf(m);
        if (text === null) return;
        const key = actorKey(actor);
        let line = lines.get(key);
        if (!line) lines.set(key, (line = { shown: null, sentAt: -Infinity, waiting: null, timer: null }));
        if (line.timer !== null) {
          line.waiting = text;
          return;
        }
        if (text === line.shown) return;
        // Clamped, so a clock set back cannot hold a line for longer than one window.
        const wait = Math.min(line.sentAt + ACTIVITY_THROTTLE_MS - deps.now().getTime(), ACTIVITY_THROTTLE_MS);
        if (wait <= 0) return send(actor, line, text);
        line.waiting = text;
        const held = line;
        line.timer = setTimeout(() => {
          try {
            flush(actor, held);
          } catch {}
        }, wait);
        line.timer.unref?.();
      } catch {}
    },
    clear(actor) {
      const key = actorKey(actor);
      const line = lines.get(key);
      if (!line) return;
      lines.delete(key);
      if (line.timer !== null) clearTimeout(line.timer);
      if (line.shown !== null) send(actor, line, null);
    },
  };
}
