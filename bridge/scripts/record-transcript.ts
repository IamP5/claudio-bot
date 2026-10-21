import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import bridgePackage from "../package.json";
import { spawnGroup } from "../src/session";
import { maskSecrets } from "../src/text";

// Records a real Claude Code session as a replay fixture: bun scripts/record-transcript.ts <scenario>...
// Each scenario runs on haiku in a fresh temp folder, with no settings files and no saved session, and is written to
// test/transcripts/<scenario>.ndjson: a meta line, then every message sent ("out"), received ("in") and every
// canUseTool call ("prompt"), in order, scrubbed of paths, ids and anything secret-shaped. A scenario that keeps its
// transcript also writes Claude Code's own jsonl of the session, scrubbed the same way, to test/transcripts/jsonl/.

const MODEL = "haiku";
const QUERY_BUDGET_USD = 0.25;
const RUN_BUDGET_USD = 1;
const OUT_DIR = join(import.meta.dir, "..", "test", "transcripts");
const JSONL_DIR = join(OUT_DIR, "jsonl");
/** Transcript lines that hold whole API requests or file backups: large, and nothing a thread shows. */
const DROPPED_LINES: ReadonlySet<string> = new Set(["api-request", "api-request-blob", "api-request-shape", "file-history-snapshot", "file-history-delta"]);

export type Prompted = { tool: string; input: Record<string, unknown>; options: Record<string, unknown>; reply: PermissionResult };
/** `ms`: since the recording started; recordings before it have none. */
export type Line =
  | { meta: Record<string, unknown> }
  | { dir: "out"; ms?: number; message: SDKUserMessage }
  | { dir: "in"; ms?: number; message: SDKMessage }
  /** The query was closed, its process exited, and a new query resumed the same session. */
  | { dir: "reopen"; ms?: number }
  | { dir: "prompt"; call: Prompted };

type Io = {
  /** Sends one user turn with a fresh uuid and returns the uuid. */
  send(text: string): string;
  /** Closes the query, waits for its process to exit, and resumes the session on a new one. */
  reopen(): Promise<void>;
  /** Resolves true once `done` holds over everything received so far, false after `ms`. */
  until(done: (inbound: readonly SDKMessage[]) => boolean, ms: number): Promise<boolean>;
};

type Scenario = {
  options?: Partial<Options>;
  /** Also save the session's jsonl transcript (the scenario must persist its session). */
  keepTranscript?: boolean;
  /** canUseTool's answer; every call is recorded either way. */
  reply: PermissionResult | ((input: Record<string, unknown>) => PermissionResult);
  run(io: Io): Promise<string[]>;
};

/**
 * The recorder's environment without the variables of the Claude Code it may itself run inside (the desktop app sets
 * CLAUDE_CODE_ENTRYPOINT, a session id and a messaging socket), so a recording is of a plain SDK session.
 */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|CLAUDECODE$|AI_AGENT$)/.test(k)));

const echoes = (m: SDKMessage): string[] => {
  if (m.type !== "assistant" && m.type !== "result") return [];
  return m.user_message_uuids ?? (m.user_message_uuid === undefined ? [] : [m.user_message_uuid]);
};
const resultFor = (uuid: string) => (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "result" && echoes(m).includes(uuid));

const taskDone = (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "system" && m.subtype === "task_notification");

const allowAll: Scenario["reply"] = (input) => ({ behavior: "allow", updatedInput: input });
const backgroundPrompt = (seconds: number) =>
  `Use the Bash tool with run_in_background set to true to run exactly this command: sleep ${seconds}; echo BG-DONE\n` +
  "Then end your turn immediately with the single word STARTED. Do not wait for it or check on it.";
const ARITHMETIC = "What is 2+2? Answer with just the number.";
const woke = (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "result" && m.origin?.kind === "task-notification");

/** Turn 1 starts `sleep <seconds>` in the background and ends; turn 2 is sent once `ready` holds and `delayMs` passed. */
function wakeScenario(seconds: number, ready: (first: string) => (ms: readonly SDKMessage[]) => boolean, delayMs: number): Scenario {
  return {
    reply: allowAll,
    async run(io) {
      const first = io.send(backgroundPrompt(seconds));
      if (!(await io.until(ready(first), 60_000))) return ["turn 2 was never sent: turn 1 or its task did not finish"];
      await Bun.sleep(delayMs);
      const second = io.send(ARITHMETIC);
      const wake = (ms: readonly SDKMessage[]) => ms.some((m) => m.type === "result" && !echoes(m).includes(first) && !echoes(m).includes(second));
      return (await io.until((ms) => resultFor(second)(ms) && wake(ms), 60_000)) ? [] : ["timed out before both the wake turn and turn 2 had results"];
    },
  };
}

/** A phone-driven session: the user's own Claude Code settings regime, every prompt answered by the canUseTool reply. */
const OWN: Partial<Options> = { persistSession: true, permissionMode: "default", includePartialMessages: true, maxBudgetUsd: 0.15 };

/** AskUserQuestion is answered the way the phone does: allowed, with the answers in updatedInput. */
const answerAsk = (answer: string): Scenario["reply"] => (input) =>
  Array.isArray(input.questions)
    ? { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries((input.questions as { question: string }[]).map((q) => [q.question, answer])) } }
    : { behavior: "allow", updatedInput: input };

const oneTurn = (prompt: string): Scenario["run"] => async (io) => {
  const turn = io.send(prompt);
  return (await io.until(resultFor(turn), 120_000)) ? [] : ["the turn never got a result"];
};

const SCENARIOS: Record<string, Scenario> = {
  "own-permission": {
    options: OWN,
    keepTranscript: true,
    reply: allowAll,
    run: oneTurn(
      "Do exactly these steps with tools, nothing else: 1. Write the file a.txt with the three lines one, two, three. " +
        "2. Edit a.txt to replace the line two with TWO. 3. Run this Bash command: cat a.txt\nThen reply with the single word DONE.",
    ),
  },
  "own-ask": {
    options: OWN,
    keepTranscript: true,
    reply: answerAsk("Blue"),
    run: oneTurn(
      "Do exactly these steps with tools: 1. Call TodoWrite with two todos: Ask for a color, Write color.txt. " +
        "2. Call AskUserQuestion with one question \"Pick a color\" (header \"Color\") and the options Red and Blue. " +
        "3. Write the chosen color to color.txt. Then reply with the single word DONE.",
    ),
  },
  "own-plan": {
    options: { ...OWN, permissionMode: "plan" },
    keepTranscript: true,
    reply: allowAll,
    run: oneTurn("Plan how to create hello.txt containing the word hi, then call ExitPlanMode with that plan. Once it is approved, create the file and reply DONE."),
  },
  // Turn 2 is sent 2 s after turn 1's result, while the 8 s command still runs, so it ends before the wake turn starts.
  "background-wake-after-prompt": wakeScenario(8, resultFor, 2_000),
  // Turn 2 is sent the moment the command's task notification arrives, so it lands while the wake turn runs.
  "background-wake-before-prompt": wakeScenario(3, (first) => (ms) => resultFor(first)(ms) && taskDone(ms), 0),
  // Turn 1's command ends while no turn runs, so Claude Code wakes on its own. Once that wake turn has its result the
  // query is closed, its process exits, and turn 2 resumes the session on a new query: the hand-over a routine makes.
  "background-wake-handoff": {
    options: { persistSession: true, maxBudgetUsd: 0.1 },
    reply: allowAll,
    async run(io) {
      const first = io.send(backgroundPrompt(8));
      if (!(await io.until((ms) => resultFor(first)(ms) && woke(ms), 60_000))) return ["the wake turn never ended"];
      // Every wake turn Claude Code starts on its own comes before the hand-over: wait for 10 s with no frame.
      let seen = 0;
      while (await io.until((ms) => ms.length > seen && (seen = ms.length) > 0, 10_000));
      await io.reopen();
      const second = io.send(ARITHMETIC);
      return (await io.until(resultFor(second), 60_000)) ? [] : ["turn 2 on the resumed query never got a result"];
    },
  },
  "background-folded-into-turn": {
    options: { persistSession: true, maxBudgetUsd: 0.1 },
    reply: allowAll,
    async run(io) {
      const first = io.send(
        "Use the Bash tool with run_in_background set to true to run exactly this command: sleep 8; echo BG-DONE\n" +
          "Then, without waiting for it, use the Bash tool in the foreground to run exactly: perl -e 'sleep 25'\nThen reply with one word: waited.",
      );
      if (!(await io.until(resultFor(first), 90_000))) return ["the turn never ended"];
      // The background task ended inside the turn; listen 40 s for a wake turn that should not come.
      await io.until(woke, 40_000);
      return [];
    },
  },
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
    // A tool input streams in fragments that can split a path, so no fragment is kept.
    if (key === "partial_json" && typeof v === "string") return "";
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
    json: (v: unknown): unknown => walk(v, ""),
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
  /** Where Claude Code keeps the transcript of a scenario that persists its session. */
  const sessions = join(homedir(), ".claude", "projects", realpathSync(cwd).replace(/[/.]/g, "-"));
  const lines: Line[] = [];
  const inbound: SDKMessage[] = [];
  const outbox: SDKUserMessage[] = [];
  const wake: { input: (() => void) | null; waiter: (() => void) | null } = { input: null, waiter: null };
  const startedAt = Date.now();
  const ms = () => Date.now() - startedAt;

  const canUseTool: CanUseTool = async (tool, toolInput, o) => {
    const { signal: _, ...options } = o;
    const reply = typeof scenario.reply === "function" ? scenario.reply(toolInput) : scenario.reply;
    lines.push({ dir: "prompt", call: { tool, input: toolInput, options, reply } });
    return reply;
  };

  /** A query on the scenario's session, through the bridge's spawner so its process's exit is seen. */
  function start(resume: string | undefined) {
    const self = { open: true };
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (self.open) {
        const next = outbox.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => (wake.input = r));
      }
    }
    let exit = () => {};
    const exited = new Promise<void>((r) => (exit = r));
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
        env: cleanEnv(),
        ...scenario.options,
        ...(resume !== undefined && { resume }),
        spawnClaudeCodeProcess: (o) => spawnGroup(o, () => {}, exit),
      },
    });
    const reading = (async () => {
      for await (const m of q) {
        scrub.see(m);
        lines.push({ dir: "in", ms: ms(), message: m });
        inbound.push(m);
        wake.waiter?.();
      }
    })();
    return { q, self, reading, exited };
  }

  /** Closes the query and waits for its process to exit, or 15 s. */
  async function stop(c: ReturnType<typeof start>) {
    c.self.open = false;
    wake.input?.();
    c.q.close();
    await c.reading.catch(() => {});
    await Promise.race([c.exited, Bun.sleep(15_000)]);
  }

  let current = start(undefined);

  const io: Io = {
    send(text) {
      const uuid = crypto.randomUUID();
      const m: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid };
      lines.push({ dir: "out", ms: ms(), message: m });
      outbox.push(m);
      wake.input?.();
      return uuid;
    },
    async reopen() {
      const id = inbound.findLast((m) => m.session_id)?.session_id;
      await stop(current);
      lines.push({ dir: "reopen", ms: ms() });
      current = start(id);
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

  let notes: string[];
  let transcript: string[] = [];
  try {
    notes = await scenario.run(io);
  } finally {
    await stop(current);
    const id = inbound.findLast((m) => m.session_id)?.session_id;
    const file = id && join(sessions, `${id}.jsonl`);
    if (scenario.keepTranscript && file && existsSync(file)) transcript = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
  if (scenario.keepTranscript) {
    if (transcript.length === 0) notes.push("no transcript was found to keep");
    mkdirSync(JSONL_DIR, { recursive: true });
    const kept = transcript.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => !DROPPED_LINES.has(String(o.type)));
    // An attachment stays a link in the chain; what it attached (skill lists, environment) is not test material.
    const slim = kept.map((o) => (o.type === "attachment" && typeof o.attachment === "object" && o.attachment !== null ? { ...o, attachment: { type: (o.attachment as { type?: unknown }).type } } : o));
    writeFileSync(join(JSONL_DIR, `${name}.jsonl`), slim.map((o) => JSON.stringify(scrub.json(o))).join("\n") + "\n");
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
