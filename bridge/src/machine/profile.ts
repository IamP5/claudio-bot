import { realpathSync } from "node:fs";
import { join } from "node:path";
import { accessOf, type Access } from "../access";
import type { Scope } from "../policy";
import { PRIVATE, type PrivatePaths } from "../private";

export type Platform = "darwin" | "linux";

type Env = Readonly<Record<string, string | undefined>>;

/** What differs between the platforms the bridge runs on. Every per-platform fact lives in this one table. */
const PLATFORM = {
  darwin: {
    rootHome: "/var/root",
    /** An admin's MCP config. While it exists Claude Code refuses --strict-mcp-config. */
    managedMcpPath: "/Library/Application Support/ClaudeCode/managed-mcp.json",
    private: PRIVATE.darwin,
    /** Under the user's home: build caches an agent's package managers and Xcode write. */
    caches: [".npm", ".bun/install/cache", ".cache", "Library/Caches", "Library/Developer/Xcode/DerivedData"],
    /**
     * Under the user's home: re-opened inside the private paths for a sandboxed agent, so it can commit and push. ssh
     * and `ssh-keygen -Y sign` load `<key>.pub` and sign through the agent socket, so private keys stay unreadable
     * whatever they are named. The keychain is what git's osxkeychain credential helper reads for an https push.
     */
    pushReadable: [".ssh/config", ".ssh/known_hosts", ".ssh/*.pub", "Library/Keychains"],
    /**
     * macOS gives each user a temp dir (T, the launchd TMPDIR) and a cache dir (C) under /var/folders. Xcode, clang
     * and swift find them through confstr rather than $TMPDIR, which the sandbox repoints at its own dir, so an
     * agent's builds need both writable.
     */
    tempDirs(env: Env): string[] {
      const m = (env.TMPDIR ?? "").match(/^(?:\/private)?(\/var\/folders\/[^/]+\/[^/]+)\/T\/?$/);
      return m ? [`/private${m[1]}/T`, `/private${m[1]}/C`] : [];
    },
    /** macOS reaches /tmp, /var and /etc through /private, and Seatbelt matches a socket by the path on disk. */
    onDisk: (p: string) => (/^\/(tmp|var|etc)(\/|$)/.test(p) ? `/private${p}` : p),
    /** Seatbelt ships with macOS. */
    sandboxNeeds: [],
  },
  linux: {
    rootHome: "/root",
    managedMcpPath: "/etc/claude-code/managed-mcp.json",
    private: PRIVATE.linux,
    caches: [".npm", ".bun/install/cache", ".cache"],
    pushReadable: [".ssh/config", ".ssh/known_hosts", ".ssh/*.pub"],
    // Tools that ignore $TMPDIR write /tmp. Not $XDG_RUNTIME_DIR: it holds the user's systemd and D-Bus sockets.
    tempDirs: (_env: Env): string[] => ["/tmp"],
    onDisk: (p: string) => p,
    /** Claude Code's Linux sandbox runs commands under bubblewrap and proxies their network through socat. */
    sandboxNeeds: ["bwrap", "socat"],
  },
} as const satisfies Record<Platform, unknown>;

/** Facts about the machine this process runs on, read once at boot. Never sent to or taken from another machine. */
export type MachineProfile = Readonly<{
  name: string;
  platform: Platform;
  homedir: string;
  username: string;
  rootHome: "/var/root" | "/root";
  bridgeHome: string;
  managedMcpPath: string;
  private: PrivatePaths;
  /** Under homedir. */
  caches: readonly string[];
  /** Under homedir. */
  pushReadable: readonly string[];
  /** Absolute, writable by a sandboxed agent. */
  tempDirs: readonly string[];
  /** SSH_AUTH_SOCK by the path on disk, which the sandbox matches; null: no agent socket. */
  sshAuthSock: string | null;
  /** Commands the OS sandbox needs on PATH; empty when the sandbox is off. */
  sandboxNeeds: readonly string[];
  access: Access;
}>;

export const platformOf = (p: string): Platform => {
  if (p === "darwin" || p === "linux") return p;
  throw new Error(`ClaudioBot runs on macOS and Linux, not ${p}`);
};

/**
 * Pure, so a test builds a Linux profile on a Mac. The caller passes real paths: the floors compare realpaths, and
 * after a migration ~/.claudiobot can be a link to ~/.claudebot.
 */
export function profileOf(m: { env: Env; platform: Platform; name: string; homedir: string; username: string; bridgeHome?: string }): MachineProfile {
  const facts = PLATFORM[m.platform];
  const access = accessOf(m.env);
  return {
    name: m.name,
    platform: m.platform,
    homedir: m.homedir,
    username: m.username,
    rootHome: facts.rootHome,
    bridgeHome: m.bridgeHome ?? m.env.CLAUDIOBOT_HOME ?? join(m.homedir, ".claudiobot"),
    managedMcpPath: facts.managedMcpPath,
    private: facts.private,
    caches: facts.caches,
    pushReadable: facts.pushReadable,
    tempDirs: facts.tempDirs(m.env),
    sshAuthSock: m.env.SSH_AUTH_SOCK ? facts.onDisk(m.env.SSH_AUTH_SOCK) : null,
    sandboxNeeds: access.sandbox ? facts.sandboxNeeds : [],
    access,
  };
}

/** The part of a policy scope that is the machine's, the same for every actor on it. */
export type MachineScope = Pick<Scope, "bridgeHome" | "homedir" | "users" | "full" | "private">;

export const scopeFor = (p: MachineProfile): MachineScope => ({
  bridgeHome: p.bridgeHome,
  homedir: p.homedir,
  private: p.private,
  // So ~name in a command resolves for the user and for root.
  users: { [p.username]: p.homedir, root: p.rootHome },
  full: p.access.full,
});

/** What the floors protect for a session the phone drives in cwd: the same private paths as for an agent. */
export function sessionScope(p: MachineProfile, cwd: string): Scope {
  let own = cwd;
  try {
    own = realpathSync(cwd);
  } catch {}
  return { ...scopeFor(p), own, userMd: null, full: false };
}
