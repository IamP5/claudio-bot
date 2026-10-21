import { afterAll, describe, expect, test } from "bun:test";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type PolicyContext, type Scope, type ToolCall } from "../src/policy";
import { PRIVATE } from "../src/private";
import { profileOf, type Platform } from "../src/machine/profile";
import { AGENT_GIT_ENV, agentGitEnv, gitDirsOf, sandboxFor as sandboxOn, sandboxFailure } from "../src/sandbox";
import type { Actor } from "../src/world";

const HOME = "/Users/u";
/** The settings for a machine whose environment is `env`, as the bridge builds its profile at boot. */
const sandboxFor = (actor: Actor, scope: Scope, env: Record<string, string | undefined>, gitDirs: string[] = [], platform: Platform = "darwin") =>
  sandboxOn(actor, scope, profileOf({ env, platform, name: "test", homedir: scope.homedir, username: "u" }), env, gitDirs);
const BRIDGE = "/Users/u/.claudiobot";
const bot: Actor = { kind: "bot", botId: "b_alpha" as any };
const agent: Actor = { kind: "agent", botId: "b_alpha" as any, agentId: "a_1" as any };
const botScope: Scope = { bridgeHome: BRIDGE, own: `${BRIDGE}/bots/b_alpha`, userMd: `${BRIDGE}/USER.md`, homedir: HOME, private: PRIVATE.darwin };
const agentScope = (own = "/Users/u/Dev/app"): Scope => ({ bridgeHome: BRIDGE, own, userMd: null, homedir: HOME, private: PRIVATE.darwin });
const ENV = { TMPDIR: "/var/folders/ab/cdef/T/", SSH_AUTH_SOCK: "/var/run/com.apple.launchd.X/Listeners", HOME };

// Seatbelt's rules as the sandbox applies them: allowRead wins over denyRead, denyWrite wins over allowWrite. A glob
// becomes a regex the way Claude Code 2.1 builds it: `**/` is any run of folders, `*` stays inside one, and the match
// covers everything under what it names.
const globRegex = (g: string) =>
  new RegExp(
    "^" +
      g
        .replace(/[.^$+{}()|\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, "(.*/)?") +
      "(/.*)?$",
  );
const under = (p: string, root: string) => (/[*?[]/.test(root) ? globRegex(root).test(p) : p === root || p.startsWith(root + "/"));
const canRead = (s: SandboxSettings, p: string) =>
  !(s.filesystem?.denyRead ?? []).some((r) => under(p, r)) || (s.filesystem?.allowRead ?? []).some((r) => under(p, r));
const canWrite = (s: SandboxSettings, p: string) =>
  (s.filesystem?.allowWrite ?? []).some((r) => under(p, r)) && !(s.filesystem?.denyWrite ?? []).some((r) => under(p, r));
const floor = (s: SandboxSettings) => ({
  enabled: s.enabled,
  failIfUnavailable: s.failIfUnavailable,
  allowUnsandboxedCommands: s.allowUnsandboxedCommands,
  autoAllowBashIfSandboxed: s.autoAllowBashIfSandboxed,
});
const readsOf = (s: SandboxSettings, paths: string[]) => Object.fromEntries(paths.map((p) => [p, canRead(s, p)]));
const writesOf = (s: SandboxSettings, paths: string[]) => Object.fromEntries(paths.map((p) => [p, canWrite(s, p)]));

describe("a bot", () => {
  const s = sandboxFor(bot, botScope, ENV);

  test("is sandboxed with no way out and the classifier still on", () => {
    expect(floor(s)).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
  });

  test("reads its own home and USER.md, and nothing else of the bridge home or the user's secrets", () => {
    expect(
      readsOf(s, [
        "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.md",
        "/Users/u/.claudiobot/USER.md",
        "/Users/u/.claudiobot/bots/b_beta/CLAUDE.md",
        "/Users/u/.claudiobot/state.json",
        "/Users/u/.claudiobot/token",
        "/Users/u/.ssh/id_ed25519",
        "/Users/u/.ssh/known_hosts",
        "/Users/u/.config/gh/hosts.yml",
        "/Users/u/Library/Keychains/login.keychain-db",
        "/Users/u/Library/Application Support/Google/Chrome/Default/Cookies",
        "/Users/u/.claude/projects/x/s.jsonl",
        "/Users/u/Documents/notes.txt",
      ]),
    ).toEqual({
      "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.md": true,
      "/Users/u/.claudiobot/USER.md": true,
      "/Users/u/.claudiobot/bots/b_beta/CLAUDE.md": false,
      "/Users/u/.claudiobot/state.json": false,
      "/Users/u/.claudiobot/token": false,
      "/Users/u/.ssh/id_ed25519": false,
      "/Users/u/.ssh/known_hosts": false,
      "/Users/u/.config/gh/hosts.yml": false,
      "/Users/u/Library/Keychains/login.keychain-db": false,
      "/Users/u/Library/Application Support/Google/Chrome/Default/Cookies": false,
      "/Users/u/.claude/projects/x/s.jsonl": false,
      "/Users/u/Documents/notes.txt": true,
    });
  });

  test("writes only its own home, and never USER.md or the files Claude Code loads as its instructions and config", () => {
    expect(
      writesOf(s, [
        "/Users/u/.claudiobot/bots/b_alpha/library/n.md",
        "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.md",
        "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.local.md",
        "/Users/u/.claudiobot/bots/b_alpha/.claude/skills/x/SKILL.md",
        "/Users/u/.claudiobot/bots/b_alpha/.claude/settings.json",
        "/Users/u/.claudiobot/bots/b_alpha/.mcp.json",
        "/Users/u/.claudiobot/USER.md",
        "/Users/u/.claudiobot/bots/b_beta/x",
        "/Users/u/.claudiobot/state.json",
        "/Users/u/Dev/app/x",
        "/private/tmp/x",
        "/private/var/folders/ab/cdef/T/x",
      ]),
    ).toEqual({
      "/Users/u/.claudiobot/bots/b_alpha/library/n.md": true,
      "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.md": false,
      "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.local.md": false,
      "/Users/u/.claudiobot/bots/b_alpha/.claude/skills/x/SKILL.md": false,
      "/Users/u/.claudiobot/bots/b_alpha/.claude/settings.json": false,
      "/Users/u/.claudiobot/bots/b_alpha/.mcp.json": false,
      "/Users/u/.claudiobot/USER.md": false,
      "/Users/u/.claudiobot/bots/b_beta/x": false,
      "/Users/u/.claudiobot/state.json": false,
      "/Users/u/Dev/app/x": false,
      "/private/tmp/x": false,
      "/private/var/folders/ab/cdef/T/x": false,
    });
  });

  test("writes only its library, inbox and work folders, and no instruction file Claude Code would load from inside them", () => {
    const own = "/Users/u/.claudiobot/bots/b_alpha";
    expect(
      writesOf(s, [
        `${own}/library/report.md`,
        `${own}/inbox/upload.pdf`,
        `${own}/work/clone/src/main.py`,
        `${own}/notes.txt`,
        `${own}/.history/main.jsonl`,
        `${own}/library/x/CLAUDE.md`,
        `${own}/library/CLAUDE.local.md`,
        `${own}/work/repo/.claude/settings.json`,
        `${own}/work/repo/.claude/rules/r.md`,
        `${own}/inbox/a/b/.mcp.json`,
        `${own}/work/CLAUDE.md`,
      ]),
    ).toEqual({
      [`${own}/library/report.md`]: true,
      [`${own}/inbox/upload.pdf`]: true,
      [`${own}/work/clone/src/main.py`]: true,
      [`${own}/notes.txt`]: false,
      [`${own}/.history/main.jsonl`]: false,
      [`${own}/library/x/CLAUDE.md`]: false,
      [`${own}/library/CLAUDE.local.md`]: false,
      [`${own}/work/repo/.claude/settings.json`]: false,
      [`${own}/work/repo/.claude/rules/r.md`]: false,
      [`${own}/inbox/a/b/.mcp.json`]: false,
      [`${own}/work/CLAUDE.md`]: false,
    });
  });

  test("gets no ssh-agent socket and no gh, even when the env offers them", () => {
    const g = sandboxFor(bot, botScope, { ...ENV, CLAUDIOBOT_SANDBOX_GH: "1" });
    expect([g.network?.allowUnixSockets, g.enableWeakerNetworkIsolation, canRead(g, "/Users/u/.config/gh/hosts.yml")]).toEqual([undefined, undefined, false]);
  });
});

describe("a mac agent", () => {
  const s = sandboxFor(agent, agentScope(), ENV);

  test("is sandboxed with no way out and the classifier still on", () => {
    expect(floor(s)).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
  });

  test("reads what commit signing and push need, never a private key, nothing of the bridge home", () => {
    expect(
      readsOf(s, [
        "/Users/u/.ssh/id_ed25519",
        "/Users/u/.ssh/gitlab",
        "/Users/u/.ssh/id_ed25519.pub",
        "/Users/u/.ssh/config",
        "/Users/u/.ssh/known_hosts",
        "/Users/u/Library/Keychains/login.keychain-db",
        "/Users/u/.aws/credentials",
        "/Users/u/.config/gh/hosts.yml",
        "/Users/u/.netrc",
        "/Users/u/.claudiobot/USER.md",
        "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.md",
        "/Users/u/Dev/app/src/a.ts",
      ]),
    ).toEqual({
      "/Users/u/.ssh/id_ed25519": false,
      "/Users/u/.ssh/gitlab": false,
      "/Users/u/.ssh/id_ed25519.pub": true,
      "/Users/u/.ssh/config": true,
      "/Users/u/.ssh/known_hosts": true,
      "/Users/u/Library/Keychains/login.keychain-db": true,
      "/Users/u/.aws/credentials": false,
      "/Users/u/.config/gh/hosts.yml": false,
      "/Users/u/.netrc": false,
      "/Users/u/.claudiobot/USER.md": false,
      "/Users/u/.claudiobot/bots/b_alpha/CLAUDE.md": false,
      "/Users/u/Dev/app/src/a.ts": true,
    });
  });

  test("writes its project, the per-user temp and cache dirs and build caches, nothing else", () => {
    expect(
      writesOf(s, [
        "/Users/u/Dev/app/src/a.ts",
        "/Users/u/Dev/other/a.ts",
        "/private/var/folders/ab/cdef/T/x",
        "/private/var/folders/ab/cdef/C/clang/ModuleCache/x",
        "/private/var/folders/ab/zzzz/T/x",
        "/Users/u/.npm/_cacache/x",
        "/Users/u/.bun/install/cache/x",
        "/Users/u/Library/Developer/Xcode/DerivedData/App/x",
        "/Users/u/Documents/x",
        "/Users/u/.claudiobot/state.json",
        "/private/tmp/x",
      ]),
    ).toEqual({
      "/Users/u/Dev/app/src/a.ts": true,
      "/Users/u/Dev/other/a.ts": false,
      "/private/var/folders/ab/cdef/T/x": true,
      "/private/var/folders/ab/cdef/C/clang/ModuleCache/x": true,
      "/private/var/folders/ab/zzzz/T/x": false,
      "/Users/u/.npm/_cacache/x": true,
      "/Users/u/.bun/install/cache/x": true,
      "/Users/u/Library/Developer/Xcode/DerivedData/App/x": true,
      "/Users/u/Documents/x": false,
      "/Users/u/.claudiobot/state.json": false,
      "/private/tmp/x": false,
    });
  });

  test("does not write the project's Claude settings, skills, MCP servers or local instructions, but may edit CLAUDE.md", () => {
    expect(writesOf(s, ["/Users/u/Dev/app/.claude/settings.json", "/Users/u/Dev/app/.claude/skills/x/SKILL.md", "/Users/u/Dev/app/.mcp.json", "/Users/u/Dev/app/CLAUDE.local.md", "/Users/u/Dev/app/CLAUDE.md", "/Users/u/Dev/app/src/a.ts"])).toEqual({
      "/Users/u/Dev/app/.claude/settings.json": false,
      "/Users/u/Dev/app/.claude/skills/x/SKILL.md": false,
      "/Users/u/Dev/app/.mcp.json": false,
      "/Users/u/Dev/app/CLAUDE.local.md": false,
      "/Users/u/Dev/app/CLAUDE.md": true,
      "/Users/u/Dev/app/src/a.ts": true,
    });
  });

  test("in a worktree writes the common dir's objects and refs but not its hooks or config", () => {
    const s = sandboxFor(agent, agentScope("/Users/u/wt/feat"), ENV, ["/Users/u/Dev/app/.git", "/Users/u/Dev/app/.git/worktrees/feat"]);
    expect(
      writesOf(s, [
        "/Users/u/wt/feat/a.ts",
        "/Users/u/Dev/app/.git/objects/ab/cdef",
        "/Users/u/Dev/app/.git/refs/heads/feat",
        "/Users/u/Dev/app/.git/worktrees/feat/index",
        "/Users/u/Dev/app/.git/hooks/pre-commit",
        "/Users/u/Dev/app/.git/config",
        "/Users/u/Dev/app/.git/worktrees/feat/config.worktree",
        "/Users/u/Dev/app/src/a.ts",
      ]),
    ).toEqual({
      "/Users/u/wt/feat/a.ts": true,
      "/Users/u/Dev/app/.git/objects/ab/cdef": true,
      "/Users/u/Dev/app/.git/refs/heads/feat": true,
      "/Users/u/Dev/app/.git/worktrees/feat/index": true,
      "/Users/u/Dev/app/.git/hooks/pre-commit": false,
      "/Users/u/Dev/app/.git/config": false,
      "/Users/u/Dev/app/.git/worktrees/feat/config.worktree": false,
      "/Users/u/Dev/app/src/a.ts": false,
    });
  });

  test("reaches the ssh-agent socket by its path on disk", () => {
    const sock = (SSH_AUTH_SOCK?: string) => sandboxFor(agent, agentScope(), { ...ENV, SSH_AUTH_SOCK }).network?.allowUnixSockets;
    expect([sock("/var/run/com.apple.launchd.X/Listeners"), sock("/tmp/a.sock"), sock("/Users/u/.ssh/agent.sock"), sock(undefined)]).toEqual([
      ["/private/var/run/com.apple.launchd.X/Listeners"],
      ["/private/tmp/a.sock"],
      ["/Users/u/.ssh/agent.sock"],
      undefined,
    ]);
  });

  test("gets no per-user temp dirs when TMPDIR is not the launchd one", () => {
    const s = sandboxFor(agent, agentScope(), { TMPDIR: "/tmp/" });
    expect(writesOf(s, ["/private/var/folders/ab/cdef/T/x", "/tmp/x", "/Users/u/Dev/app/x"])).toEqual({
      "/private/var/folders/ab/cdef/T/x": false,
      "/tmp/x": false,
      "/Users/u/Dev/app/x": true,
    });
  });

  test("CLAUDIOBOT_SANDBOX_GH=1 opens gh's config and the trustd service, still no private key", () => {
    const g = sandboxFor(agent, agentScope(), { ...ENV, CLAUDIOBOT_SANDBOX_GH: "1" });
    expect([g.enableWeakerNetworkIsolation, canRead(g, "/Users/u/.config/gh/hosts.yml"), canRead(g, "/Users/u/.ssh/id_ed25519")]).toEqual([true, true, false]);
  });
});

test("an agent in a worktree under .claude/worktrees writes its worktree but not its .claude, nor the main checkout's", () => {
  const repo = "/Users/u/Dev/app";
  const wt = `${repo}/.claude/worktrees/claudio-1234abcd`;
  const s = sandboxFor(agent, agentScope(wt), ENV, [`${repo}/.git`, `${repo}/.git/worktrees/claudio-1234abcd`]);
  expect([canWrite(s, `${wt}/src/a.ts`), canWrite(s, `${wt}/src/hooks/useX.ts`), canWrite(s, `${repo}/.git/objects/ab`)]).toEqual([true, true, true]);
  expect([canWrite(s, `${wt}/.claude/settings.json`), canWrite(s, `${repo}/.claude/settings.json`), canWrite(s, `${repo}/src/a.ts`), canWrite(s, `${repo}/.git/hooks/pre-commit`)]).toEqual([false, false, false, false]);
});

describe("both actors", () => {
  const cases = [
    ["bot", sandboxFor(bot, botScope, ENV)],
    ["agent", sandboxFor(agent, agentScope(), ENV, ["/Users/u/Dev/app/.git"])],
  ] as const;

  test.each(cases)("%s can read every path it may write, so no write root is hidden behind a read deny", (_, s) => {
    const hidden = (s.filesystem?.allowWrite ?? []).filter((p) => !canRead(s, `${p}/x`) && !canRead(s, p));
    expect(hidden).toEqual([]);
  });

  test("the bridge's own variables are withheld from sandboxed commands, other variables are not", () => {
    const env = { ...ENV, CLAUDIOBOT_PUSH_URL: "https://push/secret", CLAUDEBOT_HOME: "/x", CLAUDIOBOT_HOME: "/y", PATH: "/usr/bin" };
    expect([sandboxFor(bot, botScope, env).credentials, sandboxFor(agent, agentScope(), env).credentials?.envVars?.map((v) => v.name)]).toEqual([
      {
        envVars: [
          { name: "CLAUDEBOT_HOME", mode: "deny" },
          { name: "CLAUDIOBOT_HOME", mode: "deny" },
          { name: "CLAUDIOBOT_PUSH_URL", mode: "deny" },
        ],
      },
      ["CLAUDEBOT_HOME", "CLAUDIOBOT_HOME", "CLAUDIOBOT_PUSH_URL"],
    ]);
  });

  test("CLAUDIOBOT_ALLOWED_DOMAINS adds trimmed hosts once, and only STRICT_NETWORK=1 locks the list", () => {
    const loose = sandboxFor(bot, botScope, { ...ENV, CLAUDIOBOT_ALLOWED_DOMAINS: " api.vercel.com, us.posthog.com ,api.vercel.com,," });
    const strict = sandboxFor(agent, agentScope(), { ...ENV, CLAUDIOBOT_SANDBOX_STRICT_NETWORK: "1" });
    const base = sandboxFor(agent, agentScope(), ENV).network?.allowedDomains ?? [];
    expect({
      added: loose.network?.allowedDomains?.filter((d) => !base.includes(d)),
      looseStrict: loose.network?.strictAllowlist,
      strict: strict.network?.strictAllowlist,
      github: base.includes("github.com"),
    }).toEqual({ added: ["api.vercel.com", "us.posthog.com"], looseStrict: undefined, strict: true, github: true });
  });
});

describe("gitDirsOf", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-sandbox-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const repo = join(root, "repo");
  mkdirSync(join(repo, "packages/app"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "feat", join(root, "wt-feat"));
  symlinkSync(join(root, "wt-feat"), join(root, "link-to-wt"));
  mkdirSync(join(root, "plain"));
  writeFileSync(join(root, "plain/f"), "x");

  test("finds the repo's .git for a subfolder, the common and worktree dirs for a worktree, nothing inside cwd", () => {
    expect({
      root: gitDirsOf(repo),
      sub: gitDirsOf(join(repo, "packages/app")),
      worktree: gitDirsOf(join(root, "wt-feat")),
      viaSymlink: gitDirsOf(join(root, "link-to-wt")),
      notRepo: gitDirsOf(join(root, "plain")),
    }).toEqual({
      root: [],
      sub: [join(repo, ".git")],
      worktree: [join(repo, ".git"), join(repo, ".git/worktrees/wt-feat")],
      viaSymlink: [join(repo, ".git"), join(repo, ".git/worktrees/wt-feat")],
      notRepo: [],
    });
  });

  test("a worktree agent built from it may commit but not touch the main repo's hooks or config", () => {
    const wt = join(root, "wt-feat");
    const s = sandboxFor(agent, agentScope(wt), ENV, gitDirsOf(wt));
    expect(writesOf(s, [join(repo, ".git/objects/x"), join(repo, ".git/hooks/post-checkout"), join(repo, ".git/config"), join(wt, "f")])).toEqual({
      [join(repo, ".git/objects/x")]: true,
      [join(repo, ".git/hooks/post-checkout")]: false,
      [join(repo, ".git/config")]: false,
      [join(wt, "f")]: true,
    });
  });
});

test("sandboxFailure reads the reason Claude Code gives, and nothing from other errors", () => {
  expect([
    sandboxFailure("Sandbox is required but failed to initialize: tlsTerminate.caCertPath: cannot read /x/ca.pem (ENOENT). Restart to retry."),
    sandboxFailure("Error: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed"),
    sandboxFailure("cat: /x: Operation not permitted"),
  ]).toEqual(["tlsTerminate.caCertPath: cannot read /x/ca.pem (ENOENT)", "bubblewrap (bwrap) not installed", null]);
});

test("the gate's floors and the sandbox cover the same private paths", () => {
  const ctx: PolicyContext = {
    actor: agent,
    initiator: { kind: "user" },
    scope: agentScope(),
    rules: [],
    grants: [],
    headroom: { ok: true, capReached: false },
    callsToday: {},
        connectorsOff: [],
    now: "2026-10-17T12:00:00.000Z",
    realpath: (p) => p,
  };
  const read = (path: string): ToolCall => ({ tool: "Read", input: { file_path: path }, cwd: "/Users/u/Dev/app", toolUseId: "t", subagent: null, mcpServer: null });
  const botBox = sandboxFor(bot, botScope, ENV);
  const agentBox = sandboxFor(agent, agentScope(), ENV);
  const open = Object.values(PRIVATE.darwin)
    .flat()
    .map((rel) => `${HOME}/${rel}/inner`)
    .filter((p) => decide(read(p), ctx).kind !== "deny" || canRead(botBox, p) || canRead(agentBox, p));
  expect(open).toEqual([`${HOME}/Library/Keychains/inner`]);
  expect([canRead(botBox, open[0]!), canRead(agentBox, open[0]!), decide(read(open[0]!), ctx).kind]).toEqual([false, true, "deny"]);
});

test("shell histories, CLI tokens and the Claude desktop and Cursor logins are private to bots, agents and the gate, but their projects are not", () => {
  const ctx: PolicyContext = {
    actor: bot,
    initiator: { kind: "user" },
    scope: botScope,
    rules: [],
    grants: [],
    headroom: { ok: true, capReached: false },
    callsToday: {},
    connectorsOff: [],
    now: "2026-10-17T12:00:00.000Z",
    realpath: (p) => p,
  };
  const read = (path: string): ToolCall => ({ tool: "Read", input: { file_path: path }, cwd: botScope.own, toolUseId: "t", subagent: null, mcpServer: null });
  const boxes = [sandboxFor(bot, botScope, ENV), sandboxFor(agent, agentScope(), ENV)];
  const reachable = (p: string) => boxes.some((b) => canRead(b, p)) || decide(read(p), ctx).kind !== "deny";
  const secret = [
    ".zsh_history",
    ".zsh_sessions/A.history",
    ".bash_history",
    ".local/share/fish/fish_history",
    ".python_history",
    ".node_repl_history",
    ".psql_history",
    ".mysql_history",
    ".cargo/credentials.toml",
    ".cargo/credentials",
    ".terraform.d/credentials.tfrc.json",
    ".gem/credentials",
    ".m2/settings-security.xml",
    ".config/stripe/config.toml",
    ".config/doctl/config.yaml",
    "Library/Application Support/doctl/config.yaml",
    "Library/Preferences/netlify/config.json",
    ".netlify/config.json",
    ".config/configstore/firebase-tools.json",
    ".local/share/com.vercel.cli/auth.json",
    ".oci/config",
    "Library/Application Support/Claude/claude_desktop_config.json",
    "Library/Application Support/Claude/config.json",
    "Library/Application Support/Claude/Cookies",
    "Library/Application Support/Claude/Local Storage/leveldb/1.ldb",
    "Library/Application Support/Claude/claude-code-sessions/s.json",
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    ".cursor/mcp.json",
    ".cursor/cli-config.json",
    ".cursor/projects/p/t.jsonl",
  ].map((rel) => `${HOME}/${rel}`);
  expect(secret.filter(reachable)).toEqual([]);
  const work = [".cargo/registry/index/x", ".m2/repository/x.jar", ".m2/settings.xml", ".terraformrc", "Library/Application Support/Claude/scratch-workspaces/w/a.ts", ".cursor/plugins/p/SKILL.md"].map(
    (rel) => `${HOME}/${rel}`,
  );
  expect(work.filter((p) => !canRead(boxes[1]!, p))).toEqual([]);
});

describe("CLAUDIOBOT_ACCESS and CLAUDIOBOT_SANDBOX", () => {
  test("full access turns the sandbox off for bots and agents", () => {
    expect(sandboxFor(bot, botScope, { ...ENV, CLAUDIOBOT_ACCESS: "full" })).toEqual({ enabled: false });
    expect(sandboxFor(agent, agentScope(), { ...ENV, CLAUDIOBOT_ACCESS: "full" })).toEqual({ enabled: false });
  });

  test("CLAUDIOBOT_SANDBOX=off turns it off while guarded", () => {
    expect(sandboxFor(agent, agentScope(), { ...ENV, CLAUDIOBOT_SANDBOX: "off" })).toEqual({ enabled: false });
  });

  test("full access with the sandbox on denies only the bridge home", () => {
    const s = sandboxFor(agent, agentScope(), { ...ENV, CLAUDIOBOT_ACCESS: "full", CLAUDIOBOT_SANDBOX: "on" });
    expect(floor(s).enabled).toBe(true);
    expect(readsOf(s, ["/Users/u/.ssh/id_ed25519", "/Users/u/.claude/projects/x/memory/MEMORY.md", "/Users/u/.claudiobot/state.json"])).toEqual({
      "/Users/u/.ssh/id_ed25519": true,
      "/Users/u/.claude/projects/x/memory/MEMORY.md": true,
      "/Users/u/.claudiobot/state.json": false,
    });
    expect(writesOf(s, ["/Users/u/Dev/app/a.ts", "/Users/u/Documents/x"])).toEqual({ "/Users/u/Dev/app/a.ts": true, "/Users/u/Documents/x": false });
  });

  test("the git ssh rewrite goes only to sandboxed agents", () => {
    expect(agentGitEnv(ENV)).toEqual(AGENT_GIT_ENV);
    expect(agentGitEnv({ ...ENV, CLAUDIOBOT_ACCESS: "full" })).toEqual({});
  });
});

describe("on Linux", () => {
  const LHOME = "/home/u";
  const scope = (own = `${LHOME}/code/app`): Scope => ({ bridgeHome: `${LHOME}/.claudiobot`, own, userMd: null, homedir: LHOME, private: PRIVATE.linux });
  const linuxBox = (env: Record<string, string | undefined> = { TMPDIR: "/tmp", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1" }) =>
    sandboxFor(agent, scope(), env, [], "linux");
  const ctx: PolicyContext = {
    actor: agent,
    initiator: { kind: "user" },
    scope: scope(),
    rules: [],
    grants: [],
    headroom: { ok: true, capReached: false },
    callsToday: {},
    connectorsOff: [],
    now: "2026-10-20T12:00:00.000Z",
    realpath: (p) => p,
  };
  const read = (path: string): ToolCall => ({ tool: "Read", input: { file_path: path }, cwd: `${LHOME}/code/app`, toolUseId: "t", subagent: null, mcpServer: null });

  test("browser profiles, keyrings and keys are refused by the gate and unreadable in the sandbox under guarded", () => {
    const secret = [
      ".config/google-chrome/Default/Cookies",
      ".config/chromium/Default/Login Data",
      ".mozilla/firefox/abc.default/logins.json",
      ".local/share/keyrings/login.keyring",
      ".gnupg/private-keys-v1.d/x.key",
      ".ssh/id_ed25519",
    ].map((rel) => `${LHOME}/${rel}`);
    const box = linuxBox();
    expect(secret.map((p) => [p, decide(read(p), ctx).kind, canRead(box, p)])).toEqual(secret.map((p) => [p, "deny", false]));
  });

  test("the agent pushes with its ssh config and public keys, and writes /tmp and its build caches", () => {
    const box = linuxBox();
    expect(readsOf(box, [`${LHOME}/.ssh/config`, `${LHOME}/.ssh/id_ed25519.pub`])).toEqual({ [`${LHOME}/.ssh/config`]: true, [`${LHOME}/.ssh/id_ed25519.pub`]: true });
    expect(writesOf(box, ["/tmp/build/x", `${LHOME}/.cache/go-build/x`, `${LHOME}/Documents/x`])).toEqual({
      "/tmp/build/x": true,
      [`${LHOME}/.cache/go-build/x`]: true,
      [`${LHOME}/Documents/x`]: false,
    });
    expect(box.network?.allowUnixSockets).toEqual(["/tmp/ssh-x/agent.1"]);
  });

  test("full with the sandbox off leaves Bash unsandboxed, so only the gate's floor keeps the bridge home", () => {
    expect(linuxBox({ CLAUDIOBOT_ACCESS: "full", CLAUDIOBOT_SANDBOX: "off" })).toEqual({ enabled: false });
  });
});
