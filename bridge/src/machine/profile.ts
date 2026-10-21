import { join } from "node:path";
import { accessOf, type Access } from "../access";
import type { Scope } from "../policy";

export type Platform = "darwin" | "linux";

/** What differs between the platforms the bridge runs on. Every per-platform fact lives in this one table. */
type PlatformFacts = {
  rootHome: "/var/root" | "/root";
  /** An admin's MCP config. While it exists Claude Code refuses --strict-mcp-config. */
  managedMcpPath: string;
};

const PLATFORM: Readonly<Record<Platform, PlatformFacts>> = {
  darwin: {
    rootHome: "/var/root",
    managedMcpPath: "/Library/Application Support/ClaudeCode/managed-mcp.json",
  },
  linux: {
    rootHome: "/root",
    managedMcpPath: "/etc/claude-code/managed-mcp.json",
  },
};

/** Facts about the machine this process runs on, read once at boot. Never sent to or taken from another machine. */
export type MachineProfile = Readonly<
  PlatformFacts & {
    name: string;
    platform: Platform;
    homedir: string;
    username: string;
    bridgeHome: string;
    access: Access;
  }
>;

export const platformOf = (p: string): Platform => {
  if (p === "darwin" || p === "linux") return p;
  throw new Error(`ClaudioBot runs on macOS and Linux, not ${p}`);
};

/**
 * Pure, so a test builds a Linux profile on a Mac. The caller passes real paths: the floors compare realpaths, and
 * after a migration ~/.claudiobot can be a link to ~/.claudebot.
 */
export function profileOf(m: {
  env: Readonly<Record<string, string | undefined>>;
  platform: Platform;
  name: string;
  homedir: string;
  username: string;
  bridgeHome?: string;
}): MachineProfile {
  return {
    ...PLATFORM[m.platform],
    name: m.name,
    platform: m.platform,
    homedir: m.homedir,
    username: m.username,
    bridgeHome: m.bridgeHome ?? m.env.CLAUDIOBOT_HOME ?? join(m.homedir, ".claudiobot"),
    access: accessOf(m.env),
  };
}

/** The part of a policy scope that is the machine's, the same for every actor on it. */
export type MachineScope = Pick<Scope, "bridgeHome" | "homedir" | "users" | "full">;

export const scopeFor = (p: MachineProfile): MachineScope => ({
  bridgeHome: p.bridgeHome,
  homedir: p.homedir,
  // So ~name in a command resolves for the user and for root.
  users: { [p.username]: p.homedir, root: p.rootHome },
  full: p.access.full,
});
