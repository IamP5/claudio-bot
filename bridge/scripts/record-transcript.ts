import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import bridgePackage from "../package.json";
import { maskSecrets } from "../src/text";

// Records a real Claude Code session as a replay fixture: bun scripts/record-transcript.ts <scenario>...
// Each scenario runs on haiku in a fresh temp folder, with no settings files and no saved session, and is written to
// test/transcripts/<scenario>.ndjson: a meta line, then every message sent ("out"), received ("in") and every
// canUseTool call ("prompt"), in order, scrubbed of paths, ids and anything secret-shaped.

const MODEL = "haiku";
const QUERY_BUDGET_USD = 0.25;
const RUN_BUDGET_USD = 1;
const OUT_DIR = join(import.meta.dir, "..", "test", "transcripts");

export type Prompted = { tool: string; input: Record<string, unknown>; options: Record<string, unknown>; reply: PermissionResult };
export type Line =
  | { meta: Record<string, unknown> }
  | { dir: "out"; message: SDKUserMessage }
  | { dir: "in"; message: SDKMessage }
  | { dir: "prompt"; call: Prompted };

type Io = {
  /** Sends one user turn with a fresh uuid and returns the uuid. */
  send(text: string): string;
  /** Resolves true once `done` holds over everything received so far, false after `ms`. */
  until(done: (inbound: readonly SDKMessage[]) => boolean, ms: number): Promise<boolean>;
};

type Scenario = {
  options?: Partial<Options>;
  /** canUseTool's answer; every call is recorded either way. */
  reply: PermissionResult | ((input: Record<string, unknown>) => PermissionResult);
  run(io: Io): Promise<string[]>;
};

const echoes = (m: SDKMessage): string[] => {
  if (m.type !== "assistant" && m.type !== "result") return [];
  return m.user_message_uuids ?? (m.user_message_uuid === undefined ? [] : [m.user_message_uuid]);
};
const resultFor = (uuid: string) => (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "result" && echoes(m).includes(uuid));

const taskDone = (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "system" && m.subtype === "task_notification");

/** Turn 1 starts `sleep <seconds>` in the background and ends; turn 2 is sent once `ready` holds and `delayMs` passed. */
function wakeScenario(seconds: number, ready: (first: string) => (ms: readonly SDKMessage[]) => boolean, delayMs: number): Scenario {
  return {
    reply: (input) => ({ behavior: "allow", updatedInput: input }),
    async run(io) {
      const first = io.send(
        `Use the Bash tool with run_in_background set to true to run exactly this command: sleep ${seconds}; echo BG-DONE\n` +
          "Then end your turn immediately with the single word STARTED. Do not wait for it or check on it.",
      );
      if (!(await io.until(ready(first), 60_000))) return ["turn 2 was never sent: turn 1 or its task did not finish"];
      await Bun.sleep(delayMs);
      const second = io.send("What is 2+2? Answer with just the number.");
      const wake = (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "result" && !echoes(m).includes(first) && !echoes(m).includes(second));
      return (await io.until((ms) => resultFor(second)(ms) && wake(ms), 60_000)) ? [] : ["timed out before both the wake turn and turn 2 had results"];
    },
  };
}

const SCENARIOS: Record<string, Scenario> = {
  // Turn 2 is sent 2 s after turn 1's result, while the 8 s command still runs, so it ends before the wake turn starts.
  "background-wake-after-prompt": wakeScenario(8, resultFor, 2_000),
  // Turn 2 is sent the moment the command's task notification arrives, so it lands while the wake turn runs.
  "background-wake-before-prompt": wakeScenario(3, (first) => (ms) => resultFor(first)(ms) && taskDone(ms), 0),
  "ask-rule-prompt": {
    options: { settings: { permissions: { ask: ["Bash(echo ASKME:*)"] } } },
    reply: { behavior: "deny", message: "held for approval" },
    async run(io) {
      const turn = io.send("Use the Bash tool to run exactly this command: echo ASKME hello\nThen reply with what it printed, or why it did not run.");
      return (await io.until(resultFor(turn), 90_000)) ? [] : ["the turn never got a result"];
    },
  },
};

function scrubber(cwd: string) {
  const home = homedir();
  const slug = (p: string) => p.replace(/[/.]/g, "-");
  const real = realpathSync(cwd);
  const paths = [
    [real, "<cwd>"],
    [cwd, "<cwd>"],
    [slug(real), "<cwd-slug>"],
    [slug(cwd), "<cwd-slug>"],
    [home, "<home>"],
    [slug(home), "<home-slug>"],
  ].sort((a, b) => b[0]!.length - a[0]!.length) as [string, string][];
  const sessions = new Map<string, string>();
  const ID_KEY = /(^|_)(id|uuid|uuids|ID)$|Id$|ID$/;
  const DROPPED = ["tools", "mcp_servers", "slash_commands", "skills", "plugins", "agents", "commands"];

  function text(s: string, key: string): string {
    let out = s;
    for (const [id, placeholder] of sessions) out = out.replaceAll(id, placeholder);
    for (const [from, to] of paths) out = out.replaceAll(from, to);
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>");
    return ID_KEY.test(key) ? out : maskSecrets(out);
  }

  function walk(v: unknown, key: string): unknown {
    if (key === "signature" && typeof v === "string") return "<signature>";
    if (typeof v === "string") return text(v, key);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
    return out;
  }

  return {
    /** Session ids seen anywhere become <session-N> everywhere, in order of first sight. */
    see(m: SDKMessage) {
      if (m.session_id && !sessions.has(m.session_id)) sessions.set(m.session_id, `<session-${sessions.size + 1}>`);
    },
    line(l: Line): Line {
      if ("dir" in l && l.dir === "in" && l.message.type === "system") {
        const system: Record<string, unknown> = { ...l.message };
        for (const k of DROPPED) if (Array.isArray(system[k])) system[k] = [];
        for (const k of ["memory_paths", "account"]) delete system[k];
        return walk({ ...l, message: system }, "") as Line;
      }
      return walk(l, "") as Line;
    },
  };
}

async function record(name: string, scenario: Scenario, claude: string, version: string): Promise<number> {
  const cwd = mkdtempSync(join(tmpdir(), "claudiobot-rec-"));
  const scrub = scrubber(cwd);
  const lines: Line[] = [];
  const inbound: SDKMessage[] = [];
  const outbox: SDKUserMessage[] = [];
  const wake: { input: (() => void) | null; waiter: (() => void) | null } = { input: null, waiter: null };
  let open = true;

  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (open) {
      const next = outbox.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (wake.input = r));
    }
  }

  const canUseTool: CanUseTool = async (tool, toolInput, o) => {
    const { signal: _, ...options } = o;
    const reply = typeof scenario.reply === "function" ? scenario.reply(toolInput) : scenario.reply;
    lines.push({ dir: "prompt", call: { tool, input: toolInput, options, reply } });
    return reply;
  };

  const q = query({
    prompt: input(),
    options: {
      cwd,
      model: MODEL,
      permissionMode: "auto",
      settingSources: [],
      persistSession: false,
      maxBudgetUsd: QUERY_BUDGET_USD,
      pathToClaudeCodeExecutable: claude,
      canUseTool,
      ...scenario.options,
    },
  });

  const reading = (async () => {
    for await (const m of q) {
      scrub.see(m);
      lines.push({ dir: "in", message: m });
      inbound.push(m);
      wake.waiter?.();
    }
  })();

  const io: Io = {
    send(text) {
      const uuid = crypto.randomUUID();
      const m: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid };
      lines.push({ dir: "out", message: m });
      outbox.push(m);
      wake.input?.();
      return uuid;
    },
    async until(done, ms) {
      const deadline = Date.now() + ms;
      while (!done(inbound)) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        let timer: Timer | undefined;
        await new Promise<void>((r) => {
          wake.waiter = r;
          timer = setTimeout(r, left);
        });
        clearTimeout(timer);
      }
      return true;
    },
  };

  const startedAt = Date.now();
  let notes: string[];
  try {
    notes = await scenario.run(io);
  } finally {
    open = false;
    wake.input?.();
    q.close();
    await reading.catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
  const cost = Math.max(0, ...inbound.flatMap((m) => (m.type === "result" ? [m.total_cost_usd] : [])));
  const meta = {
    scenario: name,
    sdk: bridgePackage.dependencies["@anthropic-ai/claude-agent-sdk"],
    claude: version,
    model: MODEL,
    recordedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - startedAt) / 1000),
    costUsd: cost,
    canUseToolCalls: lines.filter((l) => "dir" in l && l.dir === "prompt").length,
    notes,
  };
  const body = [{ meta }, ...lines].map((l) => JSON.stringify("meta" in l ? l : scrub.line(l))).join("\n");
  writeFileSync(join(OUT_DIR, `${name}.ndjson`), `${body}\n`);
  console.log(`${name}: $${cost.toFixed(4)} in ${meta.seconds}s, ${inbound.length} messages in, ${meta.canUseToolCalls} canUseTool calls${notes.length ? `; ${notes.join("; ")}` : ""}`);
  return cost;
}

const names = process.argv.slice(2);
const unknown = names.filter((n) => !(n in SCENARIOS));
if (names.length === 0 || unknown.length > 0) {
  console.error(`usage: bun scripts/record-transcript.ts <scenario>...\nscenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const claude = Bun.which("claude");
if (!claude) throw new Error("claude is not on PATH");
const version = (await Bun.$`${claude} --version`.text()).trim();
let spent = 0;
for (const name of names) {
  spent += await record(name, SCENARIOS[name]!, claude, version);
  if (spent > RUN_BUDGET_USD) {
    console.error(`spent $${spent.toFixed(4)}, over the $${RUN_BUDGET_USD} budget for one run; stopping`);
    process.exit(1);
  }
}
console.log(`total: $${spent.toFixed(4)}`);
