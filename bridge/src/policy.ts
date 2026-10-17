// The whole tool policy, pure: no SDK types, no IO, no clock. gate.ts parses the hook input into a ToolCall at the
// boundary, gathers the context, and calls decide(). Owner: U1.
import type { Headroom } from "./ledger";
import type { MessageId } from "./protocol";
import type { Actor, Fingerprint, Grant, Initiator, Signature, StandingRule } from "./world";

const notImplemented = (): never => {
  throw new Error("not implemented");
};

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
};

/**
 * pass: no opinion, the auto classifier decides as it would without the bridge (the hook returns {}).
 * allow: only a user's grant or Always does this; it skips the classifier.
 * ask: the call is denied with a "held for approval" reason and a permission card opens. Never SDK "ask" or "defer".
 * deny: blocked. handOff asks the bot to hand the step back to the user (passwords, payments, 2FA).
 */
export type Decision =
  | { kind: "pass" }
  | { kind: "allow"; via: "grant" | "always"; cardId: MessageId }
  | { kind: "deny"; via: "floor" | "initiator" | "limit" | "never" | "rule" | "malformed"; rule: string; reason: string; handOff: boolean }
  | { kind: "ask"; rule: string; label: string; signature: Signature; always: string };

/**
 * Checks in this order, and fails closed: a matcher that throws is a deny naming its rule.
 *   1. floors: the bridge home (except the acting bot's own bots/<id>/ and USER.md; agents get no exception),
 *      SSH/GPG/cloud keys and the Keychain, browser profiles and cookies, the Claude login, password/payment/2FA
 *      entry (handOff). File tools match on realpath; the bot's own absolute home path must never match the floor.
 *   2. initiator bans, by initiator kind: no set_routine / delete_routine in a routine run (Run now included);
 *      message_bot and create_bot at 2 or more bot hops.
 *   3. limits: headroom not ok (budget used up or, for unattended work, the daily cap); daily caps on create_bot
 *      and start_agent per bot.
 *   4. Never rules.
 *   5. a one-shot grant with this actor and fingerprint (the gate consumes it).
 *   6. Always rules, by signature and attendance.
 *   7. the rule table, by attended(initiator). Bash is split into segments and the strictest segment wins.
 *   8. pass. The SDK's own Agent and SubagentHandback calls always reach here.
 */
export function decide(call: ToolCall, ctx: PolicyContext): Decision {
  return notImplemented();
}

/** Tool plus a hash of the meaningful input. Bash: the command only. Write: path and content hash. MCP: the whole input. */
export function fingerprint(call: ToolCall): Fingerprint {
  return notImplemented();
}

/** The card's detail line: the exact command, "Write <path> (N lines)", or an MCP tool with compact JSON. Secrets masked. */
export function detailOf(call: ToolCall): string {
  return notImplemented();
}

/** For audit rows. Secret-shaped strings become «redacted:N chars» and file bodies «N chars sha256:…», never the content. */
export function redact(input: unknown): unknown {
  return notImplemented();
}
