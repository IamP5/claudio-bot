// The whole tool policy, pure: no SDK types, no IO, no clock. gate.ts parses the hook input into a ToolCall at the
// boundary, gathers the context (including the filesystem's realpath), and calls decide(). Owner: U1.
import { createHash } from "node:crypto";
import { basename, resolve, sep } from "node:path";
import type { Headroom } from "./ledger";
import type { MessageId } from "./protocol";
import { actorKey, attended, type Actor, type Fingerprint, type Grant, type Initiator, type Signature, type StandingRule } from "./world";

/** A tool call as the policy sees it. Nothing in here is `unknown`. */
export type ToolCall = {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  toolUseId: string;
  /** Set when a Task subagent made the call (hook input agent_id / agent_type). Same gate, same rules. */
  subagent: { id: string; type: string | null } | null;
  /** The MCP server behind an mcp__ tool (hook input mcp_server). source "sdk" is the bridge's own claudio server. */
  mcpServer: { name: string; source: string } | null;
};

/** Realpaths, resolved once per actor. own: the bot's home, or the agent's project. userMd: null for agents. */
export type Scope = { bridgeHome: string; own: string; userMd: string | null; homedir: string };

export type PolicyContext = {
  actor: Actor;
  initiator: Initiator;
  scope: Scope;
  rules: readonly StandingRule[];
  grants: readonly Grant[];
  /** ledger.headroom(actor, initiator) at the time of the call. */
  headroom: Headroom;
  /** This bot's allowed calls today, by tool name, for the daily caps on create_bot and start_agent. */
  callsToday: Readonly<Record<string, number>>;
  now: string;
  /** Resolves symlinks in the longest existing prefix of an absolute path. Floors match on what a path really is. */
  realpath: (path: string) => string;
};

/**
 * pass: no opinion, the auto classifier decides as it would without the bridge (the hook returns {}).
 * allow: only a user's grant or Always does this; it skips the classifier. rule: the grant's fingerprint or the
 *   Always rule's signature.
 * ask: the call is denied with a "held for approval" reason and a permission card opens. Never SDK "ask" or "defer".
 * deny: blocked. handOff asks the bot to hand the step back to the user (passwords, payments, 2FA).
 */
export type Decision =
  | { kind: "pass" }
  | { kind: "allow"; via: "grant" | "always"; rule: string; cardId: MessageId }
  | { kind: "deny"; via: DenyVia; rule: string; reason: string; handOff: boolean }
  | { kind: "ask"; rule: string; label: string; signature: Signature; always: string };

export type DenyVia = "floor" | "initiator" | "limit" | "never" | "rule" | "malformed";

/** Allowed calls per bot per local day. Past these, a runaway chain stops making bots and agents. */
export const DAILY_CAPS: Readonly<Record<string, number>> = { mcp__claudio__create_bot: 5, mcp__claudio__start_agent: 20 };
const MAX_BOT_HOPS = 2;

/** The SDK's own plumbing. A subagent's tool calls are gated one by one; the spawn and the hand-back are not effects. */
const SDK_INTERNAL = new Set(["Agent", "SubagentHandback"]);

const PASS: Decision = { kind: "pass" };

/** One simple command of a Bash line, wrappers stripped, with the directory it runs in. A non-Bash call is one part. */
type Part = { kind: "bash"; words: string[]; text: string; cwd: string } | { kind: "call"; call: ToolCall };

/** A path the call touches: as written (resolved against cwd and ~) and as it really is. */
type Touch = { lexical: string; real: string };

type View = { parts: Part[]; touches: Touch[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const claudio = (name: string) => `mcp__claudio__${name}`;
const isClaudio = (call: ToolCall) => call.tool.startsWith("mcp__claudio__") && (call.mcpServer?.source ?? "sdk") === "sdk";
const isConnector = (call: ToolCall) => call.tool.startsWith("mcp__") && !isClaudio(call);

/** snake_case, kebab-case and camelCase split into lowercase words. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const mcpName = (tool: string) => tool.split("__").slice(1).join(" ");

function expandHome(word: string, home: string): string {
  if (word === "~") return home;
  if (word.startsWith("~/")) return home + word.slice(1);
  return word.replace(/\$\{HOME\}|\$HOME\b/g, home);
}

const pathish = (w: string) => /^[~./]/.test(w) || w.includes("/") || /\$\{?HOME\b/.test(w);

/** A word, the value after its first "=", and the target of a leading redirection: every way a word names a path. */
function pathWords(word: string): string[] {
  const out = [word];
  const eq = word.indexOf("=");
  if (eq !== -1) out.push(word.slice(eq + 1));
  const redirect = word.match(/^\d*[<>]+&?(.+)$/);
  if (redirect) out.push(redirect[1]!);
  return out.filter((w) => w !== "" && pathish(w));
}

/** Keys whose string values are paths, in any tool's input (built-in file tools and MCP filesystem servers alike). */
const PATH_KEY = /path|file|dir|folder|^(cwd|src|source|dest|destination|target)$/i;

function inputPaths(value: unknown, key: string | null, out: string[]) {
  if (typeof value === "string") {
    if (key !== null && PATH_KEY.test(key) && value !== "") out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) inputPaths(v, key, out);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) inputPaths(v, k, out);
  }
}

/** Index of the ")" closing the "(" at `open`, or the end of the string. */
function closing(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j === -1 ? src.length : j;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

/**
 * Splits a command line into simple commands as word lists: on ; & | && || newlines and parentheses outside quotes,
 * with quotes and backslashes removed. Command substitutions ($(…), `…`, <(…)) become commands of their own,
 * listed before the command that contains them. Best effort: the auto classifier still screens what passes.
 */
function segments(src: string, out: string[][] = []): string[][] {
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  const substitute = (start: number, bodyStart: number, end: number) => {
    segments(src.slice(bodyStart, end), out);
    word += src.slice(start, end + 1);
    inWord = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      if (src[i + 1] !== "\n" && i + 1 < src.length) {
        word += src[i + 1];
        inWord = true;
      }
      i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\" && i + 1 < src.length) word += src[++i];
        else if (src[i] === "$" && src[i + 1] === "(") {
          const end = closing(src, i + 1);
          substitute(i, i + 2, end);
          i = end;
        } else if (src[i] === "`") {
          const j = src.indexOf("`", i + 1);
          const end = j === -1 ? src.length : j;
          substitute(i, i + 1, end);
          i = end;
        } else word += src[i];
      }
    } else if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(") {
      const end = closing(src, i + 1);
      substitute(i, i + 2, end);
      i = end;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j === -1 ? src.length : j;
      substitute(i, i + 1, end);
      i = end;
    } else if (c === "#" && !inWord) {
      const j = src.indexOf("\n", i);
      i = j === -1 ? src.length : j - 1;
    } else if (/[;&|\n()]/.test(c)) {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return out;
}

/** Prefix words that run the command after them. Each lists its options that take a value. */
const WRAPPERS: Record<string, readonly string[]> = {
  env: ["-u", "-C", "-S"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: [],
  nice: ["-n"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"],
  doas: ["-u", "-C"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"],
  timeout: ["-s", "-k"],
  caffeinate: ["-t", "-w"],
  if: [],
  then: [],
  else: [],
  elif: [],
  do: [],
  while: [],
  until: [],
  "!": [],
  "{": [],
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The command a segment really runs, or a script it hands to a shell (bash -c, eval). */
function unwrap(raw: string[]): { words: string[] } | { script: string } {
  let words = raw;
  for (;;) {
    while (words.length > 0 && ASSIGNMENT.test(words[0]!)) words = words.slice(1);
    const head = words[0] === undefined ? "" : basename(words[0]);
    const valued = WRAPPERS[head];
    if (valued !== undefined) {
      let i = 1;
      while (i < words.length && (words[i]!.startsWith("-") || ASSIGNMENT.test(words[i]!))) i += valued.includes(words[i]!) ? 2 : 1;
      if (head === "timeout" && i < words.length) i++;
      words = words.slice(i);
      continue;
    }
    if (SHELLS.has(head)) {
      const flag = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (flag !== -1 && words[flag + 1] !== undefined) return { script: words[flag + 1]! };
    }
    if (head === "eval") return { script: words.slice(1).join(" ") };
    return { words: head === "" ? [] : [head, ...words.slice(1)] };
  }
}

/** The simple commands of a Bash line in order, each with its working directory as `cd` leaves it. */
function bashParts(command: string, cwd: string, home: string): { parts: Part[]; raw: { words: string[]; cwd: string }[] } {
  const parts: Part[] = [];
  const raw: { words: string[]; cwd: string }[] = [];
  let dir = cwd;
  const walk = (script: string, depth: number) => {
    for (const seg of segments(script)) {
      raw.push({ words: seg, cwd: dir });
      const u = unwrap(seg);
      if ("script" in u) {
        if (depth >= 4) throw new Error("shell scripts nested too deep to read");
        walk(u.script, depth + 1);
        continue;
      }
      if (u.words.length === 0) continue;
      parts.push({ kind: "bash", words: u.words, text: u.words.join(" "), cwd: dir });
      if ((u.words[0] === "cd" || u.words[0] === "pushd") && u.words[1] !== "-") {
        dir = u.words[1] === undefined ? home : resolve(dir, expandHome(u.words[1], home));
      }
    }
  };
  walk(command, 0);
  return { parts, raw };
}

function viewOf(call: ToolCall, ctx: PolicyContext): View {
  const home = ctx.scope.homedir;
  const lexical: string[] = [];
  let parts: Part[];
  if (call.tool === "Bash") {
    const read = bashParts(String(call.input.command), call.cwd, home);
    parts = read.parts;
    for (const seg of read.raw) for (const w of seg.words) for (const p of pathWords(w)) lexical.push(resolve(seg.cwd, expandHome(p, home)));
  } else {
    parts = [{ kind: "call", call }];
    const found: string[] = [];
    inputPaths(call.input, null, found);
    if (call.tool === "Glob" && typeof call.input.pattern === "string" && /^[~/$]/.test(call.input.pattern)) found.push(call.input.pattern);
    for (const p of found) lexical.push(resolve(call.cwd, expandHome(p, home)));
  }
  const touches = [...new Set(lexical)].map((p) => ({ lexical: p, real: ctx.realpath(p) }));
  return { parts, touches };
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

type Floor = {
  id: string;
  label: string;
  /** Protected roots, as written; their realpaths are protected too. */
  roots: (ctx: PolicyContext) => string[];
  /** Realpaths inside the roots that stay allowed. */
  except?: (ctx: PolicyContext) => string[];
  bash?: RegExp;
  connector?: (call: ToolCall) => boolean;
  handOff?: boolean;
};

const inHome = (...rels: string[]) => (ctx: PolicyContext) => rels.map((r) => resolve(ctx.scope.homedir, r));

const HANDOFF_WORDS = new Set(["pay", "payment", "payments", "purchase", "checkout", "password", "passwords", "passcode", "otp", "totp", "2fa", "mfa", "cvv", "cvc"]);

function keyWords(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) for (const v of value) keyWords(v, out);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) {
      for (const w of wordsOf(k)) out.add(w);
      if (/card_?number|credit_?card/i.test(k)) out.add("payment");
      keyWords(v, out);
    }
}

/** A connector tool that pays, buys, or takes a password or a one-time code, by its name or its input's field names. */
function handsOff(call: ToolCall): boolean {
  const words = new Set(wordsOf(call.tool.split("__").slice(2).join("_")));
  keyWords(call.input, words);
  return [...words].some((w) => HANDOFF_WORDS.has(w));
}

/** Always denied, checked first, never liftable: no card is ever posted for these, so no rule or grant can name them. */
const FLOORS: readonly Floor[] = [
  {
    id: "floor.bridge",
    label: "ClaudioBot's own state, tokens and other bots' homes",
    roots: (ctx) => [ctx.scope.bridgeHome, ...inHome(".claudiobot", ".claudebot")(ctx)],
    except: (ctx) => (ctx.actor.kind === "bot" ? [ctx.scope.own, ...(ctx.scope.userMd === null ? [] : [ctx.scope.userMd])] : []),
  },
  {
    id: "floor.keys",
    label: "SSH, GPG and cloud keys or the Keychain",
    roots: inHome(".ssh", ".gnupg", ".aws", ".config/gcloud", "Library/Keychains"),
    bash: /^security (find-\S+|dump-\S+|export)\b/,
  },
  {
    id: "floor.browser",
    label: "browser profiles and cookies",
    roots: inHome(
      "Library/Application Support/Google/Chrome",
      "Library/Application Support/BraveSoftware",
      "Library/Application Support/Firefox",
      "Library/Application Support/Arc",
      "Library/Application Support/Microsoft Edge",
      "Library/Safari",
      "Library/Containers/com.apple.Safari",
      "Library/Cookies",
    ),
  },
  { id: "floor.claude", label: "the Claude login", roots: inHome(".claude/.credentials.json") },
  { id: "floor.payment", label: "a password, a payment or a 2FA code", roots: () => [], connector: handsOff, handOff: true },
];

function floorHit(floor: Floor, call: ToolCall, view: View, ctx: PolicyContext): boolean {
  if (floor.connector && isConnector(call) && floor.connector(call)) return true;
  if (floor.bash && view.parts.some((p) => p.kind === "bash" && floor.bash!.test(p.text))) return true;
  const roots = floor.roots(ctx);
  if (roots.length === 0) return false;
  const realRoots = roots.map(ctx.realpath);
  const except = floor.except?.(ctx) ?? [];
  return view.touches.some(
    (t) => (roots.some((r) => under(t.lexical, r)) || realRoots.some((r) => under(t.real, r))) && !except.some((e) => under(t.real, e)),
  );
}

const floorReason = (f: Floor) =>
  f.handOff
    ? `This step needs ${f.label}, which only the user may enter. It did not run. Ask the user to do this step themselves, then carry on.`
    : `This touches ${f.label}, which the bridge never allows. It did not run. Do not retry it or reach it another way.`;

/**
 * Where the work came from, for the initiator bans: whether a routine started it, and how many bot-to-bot hops led
 * here. The only place the bans read the initiator, so lineage through agents can be added in one spot.
 */
const chainOf = (i: Initiator) => ({ routine: i.kind === "routine", hops: i.kind === "bot" ? i.hops : 0 });

const BANS: readonly { id: string; tools: readonly string[]; applies: (c: ReturnType<typeof chainOf>) => boolean; reason: string }[] = [
  {
    id: "ban.routine_admin",
    tools: [claudio("set_routine"), claudio("delete_routine")],
    applies: (c) => c.routine,
    reason: "Routines cannot create, change or delete routines, even when run by hand. It did not run. Tell the user what you wanted to change.",
  },
  {
    id: "ban.hops",
    tools: [claudio("message_bot"), claudio("create_bot")],
    applies: (c) => c.hops >= MAX_BOT_HOPS,
    reason: `This work came through ${MAX_BOT_HOPS} or more bot-to-bot messages, so it cannot message or create bots. It did not run. Finish with what you have.`,
  },
];

function limitOf(call: ToolCall, ctx: PolicyContext): Decision | null {
  const h = ctx.headroom;
  if (!h.ok)
    return h.reason === "daily_cap"
      ? deny("limit", "limit.daily_cap", `This bot's daily spending cap is reached, so nothing more runs until ${h.until}. It did not run. End your turn.`)
      : deny("limit", "limit.agent_budget", "This agent's budget is used up. It did not run. End your turn and report what you have.");
  const cap = DAILY_CAPS[call.tool];
  if (cap !== undefined && (ctx.callsToday[call.tool] ?? 0) >= cap) {
    const name = call.tool.replace("mcp__claudio__", "");
    return deny("limit", `limit.${name}`, `This bot already used ${name} ${cap} times today, the daily limit. It did not run. Tell the user instead.`);
  }
  return null;
}

type Cell = "pass" | "ask";
type Row = { id: string; label: string; match: (part: Part, ctx: PolicyContext) => boolean; attended: Cell; unattended: Cell };

const bash = (test: (words: string[], text: string, part: Extract<Part, { kind: "bash" }>, ctx: PolicyContext) => boolean) => (p: Part, ctx: PolicyContext) =>
  p.kind === "bash" && test(p.words, p.text, p, ctx);
const re = (pattern: RegExp) => bash((_, text) => pattern.test(text));
const tool = (test: (call: ToolCall, ctx: PolicyContext) => boolean) => (p: Part, ctx: PolicyContext) => p.kind === "call" && test(p.call, ctx);

/** git's subcommand and the words after it, past global options such as -C <dir>. */
function gitArgs(words: string[]): { sub: string; args: string[] } | null {
  if (words[0] !== "git") return null;
  let i = 1;
  while (i < words.length && words[i]!.startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(words[i]!) ? 2 : 1;
  return i < words.length ? { sub: words[i]!, args: words.slice(i + 1) } : null;
}
const git = (sub: string, test: (args: string[]) => boolean = () => true) =>
  bash((words) => {
    const g = gitArgs(words);
    return g !== null && g.sub === sub && test(g.args);
  });

const inScope = (real: string, ctx: PolicyContext) => under(real, ctx.scope.own) || (ctx.scope.userMd !== null && real === ctx.scope.userMd);
const outside = (path: string, cwd: string, ctx: PolicyContext) => !inScope(ctx.realpath(resolve(cwd, expandHome(path, ctx.scope.homedir))), ctx);

const FILE_WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_VERBS = new Set([
  "send", "post", "create", "update", "delete", "remove", "merge", "publish", "comment", "reply", "invite", "transfer",
  "push", "upload", "share", "archive", "close", "approve", "submit", "cancel", "write", "edit", "move",
]);

/** First matching row wins per part; the strictest part wins per call. The only list of risky commands in the bridge. */
const TABLE: readonly Row[] = [
  {
    id: "git.rewrite",
    label: "Force-push or rewrite history",
    match: bash((words) => {
      const g = gitArgs(words);
      if (g === null) return false;
      if (g.sub === "push") return g.args.some((a) => a === "-f" || a.startsWith("--force") || (a.startsWith("+") && a.length > 1));
      if (g.sub === "reset") return g.args.includes("--hard") && g.args.some((a) => a.includes("/"));
      return g.sub === "branch" && g.args.includes("-D");
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "git.push.default",
    label: "Push to the default branch",
    match: git("push", (args) => args.some((a) => /^(?:[^:]*:)?(?:refs\/heads\/)?(?:main|master)$/.test(a) || a === "HEAD")),
    attended: "ask",
    unattended: "ask",
  },
  { id: "git.push", label: "Push a branch", match: git("push"), attended: "pass", unattended: "ask" },
  { id: "gh.merge", label: "Merge a pull request", match: re(/^gh pr merge\b/), attended: "ask", unattended: "ask" },
  {
    id: "gh.post",
    label: "Post on GitHub",
    match: re(
      /^gh (?:(?:issue|pr) (?:comment|create|close|edit|review|reopen|ready|lock)|repo (?:create|delete|edit|archive|rename)|gist create)\b|^gh api\b.*\s(?:(?:-X|--method)\s?(?:POST|PATCH|PUT|DELETE)|-f|-F|--field|--raw-field|--input)\b/,
    ),
    attended: "pass",
    unattended: "ask",
  },
  {
    id: "publish",
    label: "Publish a package or a release",
    match: re(/^(?:npm|pnpm|yarn|bun) publish\b|^cargo publish\b|^twine upload\b|^gem push\b|^poetry publish\b|^gh release create\b/),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "deploy",
    label: "Deploy to production",
    match: re(/^vercel\b.*\s--prod\b|^netlify deploy\b.*\s--prod\b|^(?:fly|flyctl) deploy\b|^firebase deploy\b|^terraform (?:apply|destroy)\b|^kubectl (?:apply|delete)\b/),
    attended: "ask",
    unattended: "ask",
  },
  { id: "secrets", label: "Set a secret", match: re(/^gh secret set\b|^vercel env add\b|^security add-/), attended: "ask", unattended: "ask" },
  {
    id: "http.send",
    label: "Send data to a web service",
    match: re(/^curl\b.*\s(?:(?:-X|--request)\s?(?:POST|PUT|PATCH|DELETE)\b|-d|--data\S*|-F|--form\S*|--json|-T|--upload-file)|^wget\b.*\s--post-(?:data|file)\b/),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "rm.outside",
    label: "Delete files outside its folder",
    match: bash((words, _, part, ctx) => {
      if (words[0] !== "rm") return false;
      const flags = words.slice(1).filter((w) => w.startsWith("-") && w !== "--");
      if (!flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR]/.test(f))) return false;
      return words.slice(1).some((w) => !w.startsWith("-") && outside(w, part.cwd, ctx));
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "fs.outside",
    label: "Change files outside its folder",
    match: tool((call, ctx) => {
      if (!FILE_WRITES.has(call.tool)) return false;
      const path = call.input.file_path ?? call.input.notebook_path;
      return typeof path === "string" && outside(path, call.cwd, ctx);
    }),
    attended: "pass",
    unattended: "ask",
  },
  {
    id: "connector.act",
    label: "Act through a connector",
    match: tool((call) => isConnector(call) && wordsOf(call.tool.split("__").slice(2).join("_")).some((w) => WRITE_VERBS.has(w))),
    attended: "ask",
    unattended: "ask",
  },
  { id: "claudio.create_bot", label: "Create a bot", match: tool((c) => isClaudio(c) && c.tool === claudio("create_bot")), attended: "pass", unattended: "ask" },
  { id: "claudio.start_agent", label: "Start a coding agent", match: tool((c) => isClaudio(c) && c.tool === claudio("start_agent")), attended: "pass", unattended: "ask" },
  {
    id: "claudio.routines",
    label: "Change routines",
    match: tool((c) => isClaudio(c) && (c.tool === claudio("set_routine") || c.tool === claudio("delete_routine"))),
    attended: "pass",
    unattended: "ask",
  },
];

/** A part's row: the cell for this initiator and the signature Always and Never cover. */
type Ruled = { row: Row; cell: Cell; signature: Signature; label: string };

const alwaysText = (label: string, isAttended: boolean) =>
  isAttended ? `${label}, without asking, in turns you start` : `${label}, without asking, in any turn, routines included`;

const deny = (via: DenyVia, rule: string, reason: string, handOff = false): Decision => ({ kind: "deny", via, rule, reason, handOff });

/**
 * Checks in this order, and fails closed: a matcher that throws is a deny naming its rule.
 *   1. floors: the bridge home (except the acting bot's own bots/<id>/ and USER.md; agents get no exception),
 *      SSH/GPG/cloud keys and the Keychain, browser profiles and cookies, the Claude login, password/payment/2FA
 *      entry (handOff). Paths match as written and on realpath; the bot's own absolute home path never matches.
 *   2. initiator bans, by initiator kind: no set_routine / delete_routine in a routine run (Run now included);
 *      message_bot and create_bot at 2 or more bot hops.
 *   3. limits: headroom not ok (budget used up or, for unattended work, the daily cap); daily caps on create_bot
 *      and start_agent per bot.
 *   4. Never rules, on any part's signature.
 *   5. a one-shot grant with this actor and fingerprint (the gate consumes it).
 *   6. Always rules, by signature and attendance. A covered part needs no asking; only a call whose every part is
 *      covered is allowed outright, so an Always never lets an unrelated segment skip the classifier.
 *   7. the rule table, by attended(initiator). Bash is split into segments and the strictest segment wins.
 *   8. pass. The SDK's own Agent and SubagentHandback calls always pass.
 */
export function decide(call: ToolCall, ctx: PolicyContext): Decision {
  if (SDK_INTERNAL.has(call.tool)) return PASS;
  const at: { via: DenyVia; rule: string } = { via: "floor", rule: "floor.paths" };
  try {
    const view = viewOf(call, ctx);
    for (const floor of FLOORS) {
      at.rule = floor.id;
      if (floorHit(floor, call, view, ctx)) return deny("floor", floor.id, floorReason(floor), floor.handOff ?? false);
    }

    at.via = "initiator";
    const chain = chainOf(ctx.initiator);
    for (const ban of BANS) {
      at.rule = ban.id;
      if (ban.tools.includes(call.tool) && ban.applies(chain)) return deny("initiator", ban.id, ban.reason);
    }

    at.via = "limit";
    at.rule = "limit";
    const limited = limitOf(call, ctx);
    if (limited) return limited;

    at.via = "rule";
    const isAttended = attended(ctx.initiator);
    const ruled = view.parts.map((part): Ruled | null => {
      for (const row of TABLE) {
        at.rule = row.id;
        if (row.match(part, ctx)) {
          const subject = part.kind === "call" && isConnector(part.call) ? `${row.label}: ${mcpName(part.call.tool)}` : row.label;
          const toolName = part.kind === "bash" ? "Bash" : part.call.tool;
          return { row, cell: isAttended ? row.attended : row.unattended, signature: `${toolName}:${row.id}` as Signature, label: subject };
        }
      }
      return null;
    });

    at.via = "never";
    at.rule = "rules";
    for (const r of ruled) {
      const never = r && ctx.rules.find((s) => s.decision === "deny" && s.signature === r.signature);
      if (never) return deny("never", never.signature, `The user said never to this (${never.label}). It did not run. Do not try it or anything equivalent, now or later.`);
    }

    const print = fingerprint(call);
    const key = actorKey(ctx.actor);
    const grant = ctx.grants.find((g) => g.actor === key && g.fingerprint === print && g.expiresAt > ctx.now);
    if (grant) return { kind: "allow", via: "grant", rule: print, cardId: grant.cardId };

    const covering = (r: Ruled | null) =>
      r === null ? undefined : ctx.rules.find((s) => s.decision === "allow" && s.signature === r.signature && (s.appliesTo === "all" || isAttended));
    const covers = ruled.map(covering);
    const first = covers[0];
    if (first && covers.every((c) => c !== undefined)) return { kind: "allow", via: "always", rule: first.signature, cardId: first.cardId };

    const held = ruled.find((r, i) => r !== null && r.cell === "ask" && covers[i] === undefined);
    if (held) return { kind: "ask", rule: held.row.id, label: held.label, signature: held.signature, always: alwaysText(held.label, isAttended) };
    return PASS;
  } catch {
    return deny(at.via, at.rule, `The bridge could not check this call against ${at.rule}, so it was blocked and did not run. Do not retry it this turn.`);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

/** Tool plus a hash of the meaningful input. Bash: the command only. Write: path and content. MCP: the whole input. */
export function fingerprint(call: ToolCall): Fingerprint {
  const meaningful = call.tool === "Bash" ? String(call.input.command).trim() : JSON.stringify(sorted(call.input));
  return `${call.tool}:${sha256(meaningful).slice(0, 32)}` as Fingerprint;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const KEYED_SECRET = /(\b(?:Bearer|Basic)\s+|\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*["']?)([^\s"'&,;]{4,})/gi;
/** A long run mixing upper case, lower case and digits looks like a key. Commit SHAs (lower-case hex) do not. */
const LONG_RUN = /[A-Za-z0-9+_=-]{32,}/g;

const masked = (n: number) => `«redacted:${n} chars»`;

/** Secret-shaped substrings become «redacted:N chars». */
function mask(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m) => masked(m.length));
  out = out.replace(KEYED_SECRET, (_, lead: string, value: string) => lead + masked(value.length));
  return out.replace(LONG_RUN, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? masked(m.length) : m));
}

const lines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more chars)`);

/** The card's detail line: the exact command, "Write <path> (N lines)", or an MCP tool with compact JSON. Secrets masked. */
export function detailOf(call: ToolCall): string {
  const i = call.input;
  switch (call.tool) {
    case "Bash":
      return mask(String(i.command).trim());
    case "Write":
      return mask(`Write ${String(i.file_path)} (${lines(String(i.content))} lines)`);
    case "Edit":
    case "MultiEdit":
      return mask(`${call.tool} ${String(i.file_path)}`);
    case "NotebookEdit":
      return mask(`NotebookEdit ${String(i.notebook_path)}`);
    default:
      return clip(mask(`${call.tool} ${JSON.stringify(i)}`), 500);
  }
}

const BODY_KEYS = new Set(["content", "old_string", "new_string", "new_source"]);
const SECRET_KEYS = new Set([
  "password", "passwd", "passcode", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "apikey",
  "authorization", "otp", "totp", "cvv", "cvc", "cardnumber", "privatekey",
]);

function redactAt(value: unknown, key: string | null): unknown {
  if (typeof value === "string") {
    if (key !== null && BODY_KEYS.has(key)) return { bytes: Buffer.byteLength(value, "utf8"), sha256: sha256(value) };
    if (key !== null && SECRET_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""))) return masked(value.length);
    return mask(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactAt(v, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAt(v, k)]));
  return value;
}

/** For audit rows. Secret-shaped strings become «redacted:N chars» and file bodies {bytes, sha256}, never the content. */
export function redact(input: unknown): unknown {
  return redactAt(input, null);
}
