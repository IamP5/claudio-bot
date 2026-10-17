import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Scope } from "./policy";
import { PRIVATE } from "./private";
import type { Actor } from "./world";

type SandboxEnv = Readonly<Record<string, string | undefined>>;

/** Under the user's home: what no sandboxed command reads, the same paths the gate's floors refuse. */
const DENIED: readonly string[] = Object.values(PRIVATE).flat();

/**
 * Re-opened inside DENIED for a mac agent, so it can commit and push. ssh and `ssh-keygen -Y sign` load `<key>.pub`
 * and sign through the agent socket, so private keys stay unreadable whatever they are named. The keychain is what
 * git's osxkeychain credential helper reads for an https push; it also lets any sandboxed command of the agent fetch
 * the GitHub https token through that helper.
 */
const PUSH_READABLE: readonly string[] = [".ssh/config", ".ssh/known_hosts", ".ssh/*.pub", "Library/Keychains"];

/** Under the user's home: build caches a mac agent's package managers and Xcode write. */
const CACHES: readonly string[] = [".npm", ".bun/install/cache", ".cache", "Library/Caches", "Library/Developer/Xcode/DerivedData"];

/**
 * Under a bot's home: the only folders its Bash commands write. library/ holds what it makes for the user, inbox/ the
 * user's uploads, work/ scratch such as clones and scripts. The home's root, where CLAUDE.md and .claude/ live, and
 * .history/ are the bridge's.
 */
export const BOT_WRITABLE: readonly string[] = ["library", "inbox", "work"];

/**
 * What Claude Code loads as instructions, skills, settings and MCP servers, at any depth: it reads a nested CLAUDE.md
 * or .claude/rules when the bot opens a file below it. Only the bridge writes the home's own (remember, save_skill,
 * update_self), from its unsandboxed process, so no Bash command of the bot can rewrite what its later turns obey.
 */
const BOT_LOADED: readonly string[] = ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude", "**/.mcp.json"];

/**
 * Under a mac agent's cwd: what Claude Code loads as the project's settings, skills, MCP servers and local
 * instructions, which a later session of any agent there obeys. CLAUDE.md stays writable, since keeping it current is
 * ordinary repo work, and a Write or Edit of it still opens a card.
 */
const AGENT_LOADED: readonly string[] = [".claude", ".mcp.json", "CLAUDE.local.md"];

/**
 * Under a git dir outside the agent's cwd: what git loads and runs later, outside the sandbox. The sandbox already
 * denies these for the `.git` inside cwd, but not for a worktree's common dir or a parent repo added to allowWrite.
 */
const GIT_RUNS: readonly string[] = ["hooks", "config", "config.worktree"];

/**
 * Hosts sandboxed commands reach with no review. For any other host the model re-runs the command with that host in
 * the Bash tool's `allowed_domains`, which the gate's PreToolUse hook sees and the auto-mode classifier reviews (a
 * hook allow approves the command, not the hosts). CLAUDIOBOT_ALLOWED_DOMAINS (comma-separated) adds hosts, and
 * CLAUDIOBOT_SANDBOX_STRICT_NETWORK=1 makes this list the whole allowlist.
 */
const DEFAULT_DOMAINS: readonly string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "*.crates.io",
];

/**
 * For a mac agent's Claude Code process. The sandbox points git's ssh at a SOCKS proxy without credentials, which the
 * proxy refuses (Claude Code 2.1.301 on macOS), so GitHub ssh remotes go over https and the keychain helper instead.
 */
export const AGENT_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
  GIT_CONFIG_KEY_1: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_1: "ssh://git@github.com/",
};

/**
 * The OS-enforced floor (Seatbelt on macOS) for every Bash call of a bot or a mac agent, and every process it starts.
 * It does not cover Read/Write/Edit/Grep/Glob or WebFetch: the gate's floors cover those tool paths.
 * A bot writes the folders in BOT_WRITABLE but not the files in BOT_LOADED, and the sandbox's own TMPDIR; it reads its home and USER.md and
 * nothing else of the bridge home. USER.md changes only through the bridge (remember, the phone's Memory). A mac agent
 * writes its cwd (project or worktree), the git dirs a commit there needs, the per-user temp and cache dirs and build
 * caches, and reads nothing of the bridge home. `gitDirs` comes from `gitDirsOf(cwd)` and is ignored for a bot.
 * CLAUDIOBOT_SANDBOX_GH=1 lets a mac agent run gh, which needs its config and the trustd service for TLS.
 */
export function sandboxFor(actor: Actor, scope: Scope, env: SandboxEnv, gitDirs: readonly string[] = []): SandboxSettings {
  const home = (rel: string) => join(scope.homedir, rel);
  const denyRead = [scope.bridgeHome, ...DENIED.map(home)];
  const bridgeVars = Object.keys(env).filter((k) => /^CLAUD(IO|E)BOT_/.test(k)).sort();
  const common = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    // true would auto-approve sandboxed commands; false keeps the auto-mode classifier on every Bash call.
    autoAllowBashIfSandboxed: false,
    credentials: { envVars: bridgeVars.map((name) => ({ name, mode: "deny" as const })) },
  };
  const domains = {
    allowedDomains: [...new Set([...DEFAULT_DOMAINS, ...listOf(env.CLAUDIOBOT_ALLOWED_DOMAINS)])],
    ...(env.CLAUDIOBOT_SANDBOX_STRICT_NETWORK === "1" ? { strictAllowlist: true } : {}),
  };
  if (actor.kind === "bot") {
    const userMd = scope.userMd === null ? [] : [scope.userMd];
    return {
      ...common,
      filesystem: {
        allowWrite: BOT_WRITABLE.map((d) => join(scope.own, d)),
        denyWrite: [...BOT_LOADED.map((f) => `${scope.own}/${f}`), ...userMd],
        denyRead,
        allowRead: [scope.own, ...userMd],
      },
      network: domains,
    };
  }
  const gh = env.CLAUDIOBOT_SANDBOX_GH === "1";
  return {
    ...common,
    ...(gh ? { enableWeakerNetworkIsolation: true } : {}),
    filesystem: {
      allowWrite: [scope.own, ...gitDirs, ...userTempDirs(env), ...CACHES.map(home)],
      denyWrite: [...AGENT_LOADED.map((f) => join(scope.own, f)), ...gitDirs.flatMap((d) => GIT_RUNS.map((f) => join(d, f)))],
      denyRead,
      allowRead: [...PUSH_READABLE, ...(gh ? [".config/gh"] : [])].map(home),
    },
    network: { ...domains, ...(env.SSH_AUTH_SOCK ? { allowUnixSockets: [onDisk(env.SSH_AUTH_SOCK)] } : {}) },
  };
}

const listOf = (csv: string | undefined) => (csv ?? "").split(",").map((d) => d.trim()).filter((d) => d !== "");

/** macOS reaches /tmp, /var and /etc through /private, and the sandbox matches a socket by the path on disk. */
const onDisk = (p: string) => (/^\/(tmp|var|etc)(\/|$)/.test(p) ? `/private${p}` : p);

/**
 * macOS gives each user a temp dir (T, the launchd TMPDIR) and a cache dir (C) under /var/folders. Xcode, clang and
 * swift find them through confstr rather than $TMPDIR, which the sandbox repoints at its own dir, so an agent's builds
 * need both writable.
 */
function userTempDirs(env: SandboxEnv): string[] {
  const m = (env.TMPDIR ?? "").match(/^(?:\/private)?(\/var\/folders\/[^/]+\/[^/]+)\/T\/?$/);
  return m ? [`/private${m[1]}/T`, `/private${m[1]}/C`] : [];
}

/**
 * The git dirs a commit in `cwd` writes outside it: the repo's `.git` when cwd is a subfolder of the repo, and for a
 * linked worktree its own git dir plus the common dir that holds objects and refs. Reads `.git` files, never runs git.
 */
export function gitDirsOf(cwd: string): string[] {
  const root = realpathSync(cwd);
  const outside = (d: string) => d !== root && !d.startsWith(root + sep);
  for (let dir = root; ; dir = dirname(dir)) {
    const dot = join(dir, ".git");
    if (existsSync(dot)) {
      if (statSync(dot).isDirectory()) return outside(dot) ? [dot] : [];
      const m = readFileSync(dot, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return [];
      const gitDir = realpathSync(resolve(dir, m[1]!));
      const commonFile = join(gitDir, "commondir");
      const common = existsSync(commonFile) ? realpathSync(resolve(gitDir, readFileSync(commonFile, "utf8").trim())) : gitDir;
      return [...new Set([common, gitDir])].filter(outside);
    }
    if (dirname(dir) === dir) return [];
  }
}

/**
 * The reason, when Claude Code says the sandbox could not start. With failIfUnavailable a command never runs
 * unsandboxed: an init failure comes back as a tool error on every Bash call (observed), and missing sandbox
 * dependencies end the query with an error result (documented, not observed on macOS).
 */
export function sandboxFailure(text: string): string | null {
  const m = text.match(/(?:Sandbox is required but failed to initialize|sandbox is enabled but dependencies are missing): (.+)/i);
  return m ? m[1]!.replace(/\s*Restart to retry\.\s*$/, "").trim().replace(/\.$/, "") : null;
}
