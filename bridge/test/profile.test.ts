import { describe, expect, test } from "bun:test";
import { platformOf, profileOf, scopeFor, type MachineProfile, type Platform } from "../src/machine/profile";
import { PRIVATE } from "../src/private";
import { decide, type PolicyContext, type Scope, type ToolCall } from "../src/policy";
import type { AgentId, BotId } from "../src/protocol";
import type { Actor } from "../src/world";

const FULL_NO_SANDBOX = { CLAUDIOBOT_ACCESS: "full", CLAUDIOBOT_SANDBOX: "off" };

const mac = (env: Record<string, string> = {}) => profileOf({ env, platform: "darwin", name: "Studio", homedir: "/Users/alex", username: "alex" });
const linux = (env: Record<string, string> = {}) => profileOf({ env, platform: "linux", name: "omarchy", homedir: "/home/alex", username: "alex" });

describe("scopeFor", () => {
  test("darwin: the bridge home under /Users, root at /var/root, guarded by default", () => {
    expect(scopeFor(mac())).toEqual({
      bridgeHome: "/Users/alex/.claudiobot",
      homedir: "/Users/alex",
      users: { alex: "/Users/alex", root: "/var/root" },
      full: false,
      private: PRIVATE.darwin,
    });
  });

  test("linux: the bridge home under /home, root at /root, full when the env says so", () => {
    expect(scopeFor(linux(FULL_NO_SANDBOX))).toEqual({
      bridgeHome: "/home/alex/.claudiobot",
      homedir: "/home/alex",
      users: { alex: "/home/alex", root: "/root" },
      full: true,
      private: PRIVATE.linux,
    });
  });

  test("CLAUDIOBOT_HOME moves the bridge home", () => {
    expect(scopeFor(linux({ CLAUDIOBOT_HOME: "/srv/claudio" })).bridgeHome).toBe("/srv/claudio");
  });
});

test("each machine reads its access from its own env", () => {
  expect(linux(FULL_NO_SANDBOX).access).toEqual({ full: true, sandbox: false });
  expect(linux().access).toEqual({ full: false, sandbox: true });
});

test("only darwin and linux are platforms", () => {
  expect(["darwin", "linux"].map(platformOf)).toEqual(["darwin", "linux"] satisfies Platform[]);
  expect(() => platformOf("win32")).toThrow("macOS and Linux");
});

describe("a full, sandbox-off agent on Linux", () => {
  const agent: Actor = { kind: "agent", botId: "b_1" as BotId, agentId: "a_1" as AgentId };
  const project = "/home/alex/code/app";
  const ctx = (p: MachineProfile): PolicyContext => {
    const scope: Scope = { ...scopeFor(p), own: project, userMd: null };
    return {
      actor: agent,
      initiator: { kind: "user" },
      scope,
      rules: [],
      grants: [],
      headroom: { ok: true, capReached: false },
      callsToday: {},
      connectorsOff: [],
      now: "2026-10-20T12:00:00.000Z",
      realpath: (path) => path,
    };
  };
  const read = (file_path: string): ToolCall => ({ tool: "Read", input: { file_path }, cwd: project, toolUseId: "toolu_1", subagent: null, mcpServer: null });
  const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command, description: "x" }, cwd: project, toolUseId: "toolu_2", subagent: null, mcpServer: null });
  const verdict = (c: ToolCall) => {
    const d = decide(c, ctx(linux(FULL_NO_SANDBOX)));
    return d.kind === "deny" ? `deny:${d.rule}` : d.kind;
  };

  test("is refused the bridge's state.json, by path and through ~", () => {
    expect(verdict(read("/home/alex/.claudiobot/state.json"))).toBe("deny:floor.bridge");
    expect(verdict(bash("cat ~/.claudiobot/state.json"))).toBe("deny:floor.bridge");
  });

  test("still reads the rest of the home, as full access promises", () => {
    expect(verdict(read("/home/alex/.ssh/config"))).toBe("pass");
  });
});
