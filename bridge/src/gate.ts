import type { CanUseTool, HookCallback, HookCallbackMatcher, HookEvent, PermissionResult, PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Tickable } from "./clock";
import type { Headroom } from "./ledger";
import { DAILY_CAPS, decide, detailOf, fingerprint, type Decision, type PolicyContext, type Scope, type ToolCall } from "./policy";
import type { AgentId, BotId, Message, MessageId, PermissionChoice } from "./protocol";
import { notices, type Envelope } from "./prompts";
import type { Persist } from "./store";
import { errorText, redact } from "./text";
import {
  actorKey,
  agentPeer,
  attended,
  botActor,
  cardMessageKind,
  isOpenCard,
  newMessageId,
  own,
  repoTrust,
  settleCard,
  type Actor,
  type ActorKey,
  type AgentActor,
  type BotRecord,
  type Card,
  type DailyCount,
  type GateState,
  type Initiator,
  type OpenCard,
  type RepoTrust,
  type Signature,
  type StandingRule,
  type World,
} from "./world";

// Everything that waits on the human: the PreToolUse gate, every card kind (TTL, reminder, dedupe, settle), standing
// rules, one-shot grants, repo trust, and the audit log at <bridge home>/audit/YYYY-MM.jsonl (0600, append-only).
// The only writer of World.gate and BotRecord.rules.
//
// Mechanism: deny-and-regrant. An "ask" decision posts a permission card and denies the call with a "held for
// approval" reason. Allow once installs an exact-input grant for 10 minutes and delivers a decision envelope that runs
// ahead of other queued work; the model re-issues the call and the grant allows it. SDK "ask" and "defer" are never
// returned. Durability order: a transition that opens a card, consumes a grant or adds a rule calls persist("now")
// before the audit append and before the hook returns. A repeated hook call for the same tool_use_id returns the
// recorded verdict and opens no second card (an in-memory, bounded cache).
//
// A card's Message.answer is the truth about whether it is open; GateState.open only carries its deadlines and the held
// call, and is reconciled against the messages at boot and on every tick.

/** A hook that times out fails closed. The gate never awaits I/O, so this is only a backstop. */
const HOOK_TIMEOUT_S = 30;

/**
 * Cards remind once at half their life, then expire. A grant lets the exact call run once within grantMs of the
 * continuation turn starting, but never later than grantCeilingMs after the tap (the device may sleep between the two).
 */
const TTL = { permissionMs: 2 * 3600_000, questionMs: 24 * 3600_000, grantMs: 10 * 60_000, grantCeilingMs: 24 * 3600_000 } as const;

const VERDICTS_KEPT = 1000;

/** What each choice on a trust card decides. Nothing is decided by a card that expires. */
const TRUST_ANSWERS: Record<PermissionChoice, { trusted: boolean; everyAgent: boolean }> = {
  once: { trusted: true, everyAgent: false },
  always: { trusted: true, everyAgent: true },
  deny: { trusted: false, everyAgent: false },
  never: { trusted: false, everyAgent: true },
};

/** Per bot, how many permission cards, and separately question cards, may be open at once, so a runaway turn cannot flood the phone. */
const MAX_OPEN_CARDS = 10;

export type CardReply = { kind: "option"; index: number } | { kind: "dismiss" } | { kind: "permission"; choice: PermissionChoice };

export type AuditRow = {
  at: string;
  actor: ActorKey;
  botId: BotId;
  initiator: Initiator;
  tool: string;
  toolUseId: string;
  subagent: string | null;
  /** Redacted (policy.redact): never a secret, never file contents. */
  input: unknown;
  decision: Decision["kind"];
  via: string | null;
  rule: string | null;
  cardId: MessageId | null;
};

export type Gate = Tickable & {
  /** At start: open cards get back the time since the bridge last ran with them open, as after a sleep. */
  resume(now: Date): void;
  /** The SDK adapter for one actor: a PreToolUse matcher on every tool. Bots and mac agents both get it. */
  hooks(actor: Actor): Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /**
   * The SDK's canUseTool for one actor, for what Claude Code asks about on its own: auto mode could not decide, a
   * permissions.ask rule, a protected path. The call is held on the same permission card as an ask decision, so the
   * grant lets the retry through the hook. A tool_use_id already decided, by the hook or a prompt, gets that verdict.
   */
  canUseTool(actor: Actor): CanUseTool;
  /** The bot's ask tool. Returns the tool's reply. An identical open question gets "Already waiting" instead of a second card. */
  ask(botId: BotId, a: { question: string; options: string[] }): string;
  /**
   * Settles either card kind, first wins; a late or second answer gets the error. Questions deliver the answer or
   * dismiss envelope. Permissions apply the choice and deliver a decision envelope to the actor that asked:
   * once → grant; always → allow rule (attendance from the held call's initiator) plus a grant for the held call;
   * deny; never → deny rule. Only a card tap reaches this; chat text never approves.
   */
  answer(botId: BotId, messageId: MessageId, reply: CardReply): { ok: true } | { ok: false; error: string };
  /** delete_bot: drops the bot's open cards, its and its agents' grants and trust answers, its rules and its daily counts. */
  forgetBot(botId: BotId): void;
  /**
   * The agent's repo carries Claude Code config of its own (`found`, relative paths) and nobody has answered for it:
   * posts "Trust <name>'s Claude settings" in the bot's chat, one open card per repo. Allow once trusts it for this
   * agent, Always for every agent in the repo, Deny keeps this agent on the bridge's empty config, Never every agent.
   * An unanswered card expires and decides nothing.
   */
  trustCard(actor: AgentActor, repo: { root: string; name: string; found: readonly string[] }): void;
  /**
   * The session/hub calls this at the start of a turn that carries a decision envelope (a continuation), so a grant's
   * 10-minute TTL counts from now rather than from the tap, capped at the 24 h ceiling set when the card was answered.
   */
  beginTurn(actor: Actor): void;
  // tick(now): expire overdue cards (level-triggered) with a notice to the asker, never a turn and never a "no";
  //   remind once at remindAt; drop expired grants and cards whose actor or message is gone. nextDeadline(): the
  //   earliest of those.
};

export type GateDeps = {
  world: World;
  scopeOf: (actor: Actor) => Scope;
  /** The actor's turn in flight; null between turns, which the gate treats as initiator system. */
  turnOf: (actor: Actor) => { initiator: Initiator; stopping: boolean } | null;
  headroom: (actor: Actor, initiator: Initiator) => Headroom;
  /** The hub's single conversation writer. */
  say: (bot: BotRecord, message: Message) => void;
  deliver: (actor: Actor, e: Envelope) => void;
  notice: (actor: Actor, text: string) => void;
  /** Counts toward the session's 3-denials breaker. */
  denied: (actor: Actor) => void;
  notify: (bot: BotRecord, reason: "card" | "reminder", messageId: MessageId) => void;
  /** A trust card was answered Allow once or Always: the repo's agents load its config from their next query. */
  trusted: (root: string) => void;
  persist: Persist;
  auditDir: string;
  userName: string;
  now: () => Date;
  log: (line: string) => void;
};

const COULD_NOT_CHECK = "The bridge could not check this call, so it was blocked and did not run. Do not retry it this turn.";

const denyOutput = (reason: string): SyncHookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});
const allowOutput = (reason: string): SyncHookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason },
});

/** Only {} (no opinion), allow or deny may leave the gate. Anything else, an async result included, would fail open. */
function checked(out: SyncHookJSONOutput): SyncHookJSONOutput {
  const keys = Object.keys(out);
  if (keys.length === 0) return out;
  const specific = out.hookSpecificOutput;
  if (keys.length === 1 && specific?.hookEventName === "PreToolUse" && (specific.permissionDecision === "allow" || specific.permissionDecision === "deny")) return out;
  throw new Error(`unexpected hook output ${JSON.stringify(out)}`);
}

/**
 * A PreToolUse callback that throws fails OPEN and the tool runs, so every exception, including one from
 * reading the input or from the error report itself, becomes an explicit deny. The body is synchronous.
 */
export function failClosed(body: (input: PreToolUseHookInput) => SyncHookJSONOutput, onError: (input: unknown, error: string) => void): HookCallback {
  return async (input) => {
    try {
      if (input.hook_event_name !== "PreToolUse") return {};
      return checked(body(input));
    } catch (e) {
      try {
        onError(input, errorText(e));
      } catch {}
      return denyOutput(COULD_NOT_CHECK);
    }
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** Built-in tools' fields the policy reads. A call without them is malformed, never a shrug. */
const REQUIRED: Record<string, Record<string, (v: unknown) => boolean>> = {
  Bash: { command: nonEmpty },
  Write: { file_path: nonEmpty, content: (v) => typeof v === "string" },
  Edit: { file_path: nonEmpty, old_string: (v) => typeof v === "string", new_string: (v) => typeof v === "string" },
  MultiEdit: { file_path: nonEmpty, edits: Array.isArray },
  NotebookEdit: { notebook_path: nonEmpty },
  Read: { file_path: nonEmpty },
  Glob: { pattern: nonEmpty },
  Grep: { pattern: nonEmpty },
};

/** Boundary parse of the hook input. Malformed tool input is an error, which the gate denies; it never becomes {}. */
export function toCall(input: PreToolUseHookInput): { ok: true; call: ToolCall } | { ok: false; error: string } {
  const { tool_name: tool, tool_input: raw, tool_use_id: toolUseId, cwd, agent_id, agent_type, mcp_server } = input;
  if (!nonEmpty(tool)) return { ok: false, error: "tool_name is missing" };
  if (!nonEmpty(toolUseId)) return { ok: false, error: "tool_use_id is missing" };
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return { ok: false, error: "cwd is not an absolute path" };
  if (!isRecord(raw)) return { ok: false, error: `${tool} input is not an object` };
  for (const [field, valid] of Object.entries(REQUIRED[tool] ?? {})) if (!valid(raw[field])) return { ok: false, error: `${tool} input has no valid ${field}` };
  if (agent_id !== undefined && !nonEmpty(agent_id)) return { ok: false, error: "agent_id is not a string" };
  if (mcp_server !== undefined && !(isRecord(mcp_server) && typeof mcp_server.name === "string" && typeof mcp_server.source === "string"))
    return { ok: false, error: "mcp_server is malformed" };
  return {
    ok: true,
    call: {
      tool,
      input: raw,
      cwd,
      toolUseId,
      subagent: agent_id === undefined ? null : { id: agent_id, type: typeof agent_type === "string" ? agent_type : null },
      mcpServer: mcp_server === undefined ? null : { name: mcp_server.name, source: mcp_server.source },
    },
  };
}

const heldReason = (userName: string, cardId: MessageId) =>
  `Held for ${userName}'s approval (card ${cardId}). It has not run. Do not retry it, and do not reach the same result another way. ` +
  `End your turn now. If ${userName} allows it, a message will tell you to run exactly this call again.`;
const waitingReason = (userName: string, cardId: MessageId) =>
  `This exact call is already waiting for ${userName}'s approval (card ${cardId}). It has not run. Do not retry it or work around it. ` +
  `End your turn now; a message will tell you to run exactly this call if ${userName} allows it.`;
const neverReason = (label: string) => `The user said never to this (${label}). It did not run. Do not try it or anything equivalent, now or later.`;
const stoppingReason = (userName: string) => `${userName} pressed Stop. This call did not run, and nothing more runs this turn. End your turn now.`;

/** pass → {} so the classifier decides; allow → "allow"; ask → "deny" with the held reason naming the card; deny → "deny". */
export function toHookOutput(decision: Decision, cardId: MessageId | null, userName = "the user"): SyncHookJSONOutput {
  switch (decision.kind) {
    case "pass":
      return {};
    case "allow":
      return allowOutput(decision.via === "grant" ? `Allowed once by ${userName} (card ${decision.cardId}).` : `Allowed by ${userName}'s standing rule (card ${decision.cardId}).`);
    case "ask":
      if (cardId === null) throw new Error("A held call needs its card");
      return denyOutput(heldReason(userName, cardId));
    case "deny":
      return denyOutput(decision.reason);
  }
}

/** Only an allow or a deny answers a prompt: {} would leave Claude Code asking nobody. */
function toPermission(out: SyncHookJSONOutput, input: Record<string, unknown>): PermissionResult {
  const s = checked(out).hookSpecificOutput;
  if (s?.hookEventName !== "PreToolUse") throw new Error("A prompt needs a decision");
  return s.permissionDecision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: s.permissionDecisionReason ?? COULD_NOT_CHECK };
}

/**
 * The rule id of a call Claude Code asked about. No policy row covers it, so its signature names the exact call: Never
 * refuses only that call, and the card offers no Always.
 */
const PROMPTED = "claude.ask";

/** realpath of the longest existing prefix, so a file about to be created resolves through any symlinked folder above it. */
export function resolveReal(path: string): string {
  const rest: string[] = [];
  for (let head = path; ; head = dirname(head)) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {}
    if (dirname(head) === head) return path;
    rest.unshift(basename(head));
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const SYSTEM: Initiator = { kind: "system" };

/** How often the gate notes it is alive while a card is open; a restart counts downtime from the last note. */
const ALIVE_EVERY_MS = 60_000;

export function createGate(deps: GateDeps): Gate {
  const { world, userName } = deps;
  const state = own<GateState>(world.gate);
  const rulesOf = (bot: BotRecord) => own<StandingRule[]>(bot.rules);
  // A recorded verdict is keyed by tool_use_id but only replayed for the same call fingerprint, so a reused id with a
  // different input is decided afresh. fp null marks a verdict that does not depend on the input (stopping).
  const verdicts = new Map<string, { fp: string | null; out: SyncHookJSONOutput }>();
  const at = (date: Date, plusMs = 0) => new Date(date.getTime() + plusMs).toISOString();

  const botOf = (actor: Actor): BotRecord => {
    const bot = world.bots.get(actor.botId);
    if (!bot) throw new Error(`Unknown bot ${actor.botId}`);
    return bot;
  };
  const actorExists = (actor: Actor) => world.bots.has(actor.botId) && (actor.kind === "bot" || world.agents.has(actor.agentId));
  const keyExists = (key: ActorKey) =>
    key.startsWith("bot:") ? world.bots.has(key.slice(4) as BotId) : world.agents.has(key.slice(6) as AgentId);
  const messageOf = (card: OpenCard): Card | undefined => {
    const m = world.bots.get(card.actor.botId)?.messages.find((m) => m.id === card.cardId);
    return m?.kind === cardMessageKind(card) ? (m as Card) : undefined;
  };
  const dropCard = (cardId: MessageId) => {
    const i = state.open.findIndex((c) => c.cardId === cardId);
    if (i !== -1) state.open.splice(i, 1);
  };

  function remember(toolUseId: string, fp: string | null, out: SyncHookJSONOutput): SyncHookJSONOutput {
    verdicts.set(toolUseId, { fp, out });
    if (verdicts.size > VERDICTS_KEPT) verdicts.delete(verdicts.keys().next().value!);
    return out;
  }

  function audit(row: AuditRow) {
    mkdirSync(deps.auditDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(deps.auditDir, `${localMonth(new Date(row.at))}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  function auditCall(actor: Actor, initiator: Initiator, call: ToolCall, d: Pick<AuditRow, "decision" | "via" | "rule" | "cardId">) {
    audit({
      at: deps.now().toISOString(),
      actor: actorKey(actor),
      botId: actor.botId,
      initiator,
      tool: call.tool,
      toolUseId: call.toolUseId,
      subagent: call.subagent?.id ?? null,
      input: redact(call.input),
      ...d,
    });
  }

  function auditRaw(actor: Actor, initiator: Initiator, input: unknown, d: Pick<AuditRow, "decision" | "via" | "rule" | "cardId">) {
    const raw = isRecord(input) ? input : {};
    audit({
      at: deps.now().toISOString(),
      actor: actorKey(actor),
      botId: actor.botId,
      initiator,
      tool: String(raw.tool_name),
      toolUseId: String(raw.tool_use_id),
      subagent: typeof raw.agent_id === "string" ? raw.agent_id : null,
      input: redact(raw.tool_input),
      ...d,
    });
  }

  const todayCounts = (botId: BotId, now: Date): Record<string, number> => {
    const day = localDay(now);
    return Object.fromEntries(state.daily.filter((c) => c.botId === botId && c.day === day).map((c) => [c.tool, c.count]));
  };

  function count(actor: Actor, call: ToolCall, now: Date): boolean {
    if (DAILY_CAPS[call.tool] === undefined) return false;
    const day = localDay(now);
    const row = state.daily.find((c) => c.botId === actor.botId && c.tool === call.tool && c.day === day);
    if (row) row.count++;
    else state.daily.push({ botId: actor.botId, tool: call.tool, day, count: 1 } satisfies DailyCount);
    return true;
  }

  function openPermission(actor: Actor, initiator: Initiator, call: ToolCall, d: Extract<Decision, { kind: "ask" }>, now: Date): MessageId {
    const bot = botOf(actor);
    const id = newMessageId();
    const expiresAt = at(now, TTL.permissionMs);
    const detail = detailOf(call);
    const agent = actor.kind === "agent" ? world.agents.get(actor.agentId)?.agent : undefined;
    // offerAlways is false for rows too broad or too risky to carry an Always button; the card then shows Once/Deny/Never.
    const always = d.offerAlways ? d.always : "";
    deps.say(bot, { kind: "permission", id, at: now.toISOString(), from: agent ? agentPeer(agent) : null, tool: call.tool, label: d.label, detail, always, answer: null, expiresAt });
    state.open.push({
      kind: "permission",
      cardId: id,
      actor,
      remindAt: at(now, TTL.permissionMs / 2),
      expiresAt,
      call: { initiator, tool: call.tool, signature: d.signature, fingerprint: fingerprint(call), label: d.label, detail, always },
    });
    return id;
  }

  function onCall(actor: Actor, input: PreToolUseHookInput): SyncHookJSONOutput {
    const turn = deps.turnOf(actor);
    const initiator = turn?.initiator ?? SYSTEM;
    // While stopping the session is already ending the turn, so these denials do not feed its breaker.
    if (turn?.stopping) {
      auditRaw(actor, initiator, input, { decision: "deny", via: "stopping", rule: null, cardId: null });
      return remember(input.tool_use_id, null, denyOutput(stoppingReason(userName)));
    }

    const parsed = toCall(input);
    if (!parsed.ok) {
      auditRaw(actor, initiator, input, { decision: "deny", via: "malformed", rule: "input", cardId: null });
      deps.denied(actor);
      return remember(input.tool_use_id, null, denyOutput(`This call's input is malformed (${parsed.error}), so it was blocked and did not run.`));
    }
    const call = parsed.call;
    const fp = fingerprint(call);
    const seen = verdicts.get(call.toolUseId);
    if (seen && (seen.fp === null || seen.fp === fp)) return seen.out;

    const now = deps.now();
    const isAttended = attended(initiator);
    const ctx: PolicyContext = {
      actor,
      initiator,
      scope: deps.scopeOf(actor),
      rules: botOf(actor).rules,
      grants: state.grants.filter((g) => g.appliesTo === (isAttended ? "attended" : "unattended")),
      headroom: deps.headroom(actor, initiator),
      callsToday: todayCounts(actor.botId, now),
      connectorsOff: botOf(actor).connectorsOff,
      now: now.toISOString(),
      realpath: resolveReal,
    };
    const decision = decide(call, ctx);
    return remember(call.toolUseId, fp, apply(actor, initiator, call, decision, now));
  }

  function onPrompt(actor: Actor, tool: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): PermissionResult {
    const turn = deps.turnOf(actor);
    const initiator = turn?.initiator ?? SYSTEM;
    const call: ToolCall = {
      tool,
      input,
      cwd: deps.scopeOf(actor).own,
      toolUseId: o.toolUseID,
      subagent: o.agentID === undefined ? null : { id: o.agentID, type: null },
      mcpServer: o.mcpServer ?? null,
    };
    if (turn?.stopping) {
      auditCall(actor, initiator, call, { decision: "deny", via: "stopping", rule: null, cardId: null });
      return toPermission(remember(call.toolUseId, null, denyOutput(stoppingReason(userName))), input);
    }
    const fp = fingerprint(call);
    const seen = verdicts.get(call.toolUseId);
    if (seen && (seen.fp === null || seen.fp === fp) && Object.keys(seen.out).length > 0) return toPermission(seen.out, input);
    const signature = `${tool}:${PROMPTED}:${fp}` as Signature;
    const never = botOf(actor).rules.find((r) => r.decision === "deny" && r.signature === signature);
    const d: Decision = never
      ? { kind: "deny", via: "never", rule: signature, reason: neverReason(never.label), handOff: false }
      : { kind: "ask", rule: PROMPTED, label: o.title?.trim() || `${o.displayName?.trim() || tool}: your Claude Code settings ask first`, signature, always: "", offerAlways: false };
    return toPermission(remember(call.toolUseId, fp, apply(actor, initiator, call, d, deps.now())), input);
  }

  function apply(actor: Actor, initiator: Initiator, call: ToolCall, d: Decision, now: Date): SyncHookJSONOutput {
    switch (d.kind) {
      case "pass": {
        if (count(actor, call, now)) deps.persist();
        auditCall(actor, initiator, call, { decision: "pass", via: null, rule: null, cardId: null });
        return {};
      }
      case "allow": {
        const counted = count(actor, call, now);
        if (d.via === "grant") {
          const i = state.grants.findIndex((g) => g.cardId === d.cardId && g.fingerprint === d.rule && g.actor === actorKey(actor));
          if (i !== -1) state.grants.splice(i, 1);
          deps.persist("now");
        } else if (counted) deps.persist();
        auditCall(actor, initiator, call, { decision: "allow", via: d.via, rule: d.rule, cardId: d.cardId });
        return toHookOutput(d, null, userName);
      }
      case "deny": {
        auditCall(actor, initiator, call, { decision: "deny", via: d.via, rule: d.rule, cardId: null });
        deps.denied(actor);
        return toHookOutput(d, null, userName);
      }
      case "ask": {
        const print = fingerprint(call);
        const key = actorKey(actor);
        const waiting = state.open.find((c) => c.kind === "permission" && actorKey(c.actor) === key && c.call.fingerprint === print && messageOf(c)?.answer === null);
        if (waiting) {
          auditCall(actor, initiator, call, { decision: "ask", via: "waiting", rule: d.rule, cardId: waiting.cardId });
          deps.denied(actor);
          return denyOutput(waitingReason(userName, waiting.cardId));
        }
        const open = state.open.filter((c) => c.kind === "permission" && c.actor.botId === actor.botId && messageOf(c)?.answer === null).length;
        if (open >= MAX_OPEN_CARDS) {
          auditCall(actor, initiator, call, { decision: "deny", via: "limit", rule: "limit.open_cards", cardId: null });
          deps.denied(actor);
          return denyOutput(`${userName} already has ${MAX_OPEN_CARDS} requests waiting from this bot, so this one was not posted and did not run. End your turn and wait for ${userName}.`);
        }
        const cardId = openPermission(actor, initiator, call, d, now);
        deps.persist("now");
        auditCall(actor, initiator, call, { decision: "ask", via: null, rule: d.rule, cardId });
        deps.notify(botOf(actor), "card", cardId);
        deps.denied(actor);
        return toHookOutput(d, cardId, userName);
      }
    }
  }

  function onError(actor: Actor, input: unknown, error: string) {
    const name = isRecord(input) ? `${String(input.tool_name)} ${String(input.tool_use_id)}` : "unknown call";
    const attempt = (f: () => void) => {
      try {
        f();
      } catch {}
    };
    attempt(() => deps.log(`gate error on ${name}: ${error}`));
    attempt(() => auditRaw(actor, deps.turnOf(actor)?.initiator ?? SYSTEM, input, { decision: "deny", via: "error", rule: null, cardId: null }));
    attempt(() => deps.denied(actor));
  }

  /** Brings GateState in line with the messages: the card's answer is the truth. Returns whether anything changed. */
  function reconcile(now: Date): boolean {
    const before = JSON.stringify(state);
    const day = localDay(now);
    const iso = now.toISOString();
    for (const card of [...state.open]) if (messageOf(card)?.answer !== null || !world.bots.has(card.actor.botId)) dropCard(card.cardId);
    for (const bot of world.bots.values())
      for (const m of bot.messages)
        if (m.kind === "question" && m.answer === null && m.expiresAt !== null && !state.open.some((c) => c.cardId === m.id))
          state.open.push({ kind: "question", cardId: m.id, actor: botActor(bot.id), remindAt: null, expiresAt: m.expiresAt });
    state.grants.splice(0, state.grants.length, ...state.grants.filter((g) => g.expiresAt > iso && keyExists(g.actor)));
    state.repos.splice(0, state.repos.length, ...state.repos.filter((r) => r.agentId === null || world.agents.has(r.agentId)));
    state.daily.splice(0, state.daily.length, ...state.daily.filter((c) => c.day === day && world.bots.has(c.botId)));
    return JSON.stringify(state) !== before;
  }

  function expire(card: OpenCard) {
    dropCard(card.cardId);
    const bot = world.bots.get(card.actor.botId);
    const settled = settleCard(messageOf(card), { kind: cardMessageKind(card), answer: "expired" });
    if (!bot || !settled.ok) return;
    deps.say(bot, settled.card);
    // The agent never waited on a trust card: it runs on the bridge's empty config until someone answers.
    if (card.kind === "trust" || !actorExists(card.actor)) return;
    const text =
      card.kind === "permission"
        ? notices.expiredPermission(userName, card.call.tool, card.call.detail)
        : notices.expiredQuestion(userName, settled.card.kind === "question" ? settled.card.question : "");
    deps.notice(card.actor, text);
  }

  function setRule(bot: BotRecord, rule: StandingRule) {
    const rules = rulesOf(bot);
    rules.splice(0, rules.length, ...rules.filter((r) => r.signature !== rule.signature), rule);
  }

  function decidePermission(bot: BotRecord, message: Message | undefined, choice: PermissionChoice): { ok: true } | { ok: false; error: string } {
    const settled = settleCard(message, { kind: "permission", answer: choice });
    if (!settled.ok) return settled;
    const open = state.open.find((c) => c.kind !== "question" && c.cardId === settled.card.id);
    if (open?.kind === "trust") return decideTrust(bot, settled.card, open, choice);
    const card = open?.kind === "permission" ? open : undefined;
    if (!card) {
      deps.say(bot, { ...settled.card, answer: "expired" });
      deps.persist("now");
      return { ok: false, error: "That request is no longer held" };
    }
    const now = deps.now();
    const held = card.call;
    dropCard(card.cardId);
    if (choice === "once" || choice === "always") {
      const key = actorKey(card.actor);
      // The grant's short TTL does not start at the tap: park or backoff may delay the continuation turn, and the device
      // may sleep. It is created at the hard ceiling and armed to grantMs when the continuation turn begins (beginTurn).
      state.grants.splice(0, state.grants.length, ...state.grants.filter((g) => !(g.actor === key && g.fingerprint === held.fingerprint)), {
        actor: key,
        fingerprint: held.fingerprint,
        cardId: card.cardId,
        appliesTo: attended(held.initiator) ? "attended" : "unattended",
        expiresAt: at(now, TTL.grantCeilingMs),
      });
    }
    const ruleBase = { signature: held.signature, label: held.label, cardId: card.cardId, at: now.toISOString() };
    // A row that offered no Always button (held.always === "") grants once but never writes the broad allow rule.
    if (choice === "always" && held.always !== "") setRule(bot, { decision: "allow", appliesTo: attended(held.initiator) ? "attended" : "all", ...ruleBase });
    if (choice === "never") setRule(bot, { decision: "deny", ...ruleBase });
    deps.say(bot, settled.card);
    deps.persist("now");
    deps.deliver(card.actor, { from: "decision", choice, tool: held.tool, detail: held.detail, initiator: held.initiator });
    return { ok: true };
  }

  function decideTrust(bot: BotRecord, settled: Card, card: Extract<OpenCard, { kind: "trust" }>, choice: PermissionChoice): { ok: true } {
    dropCard(card.cardId);
    const answer = TRUST_ANSWERS[choice];
    const agentId = answer.everyAgent ? null : card.actor.agentId;
    // A repo-wide answer replaces every earlier one for the repo, so the newest answer is the one that holds.
    const kept = state.repos.filter((r) => r.root !== card.root || (agentId !== null && r.agentId !== agentId));
    const row: RepoTrust = { root: card.root, agentId, trusted: answer.trusted, cardId: card.cardId, at: deps.now().toISOString() };
    state.repos.splice(0, state.repos.length, ...kept, row);
    deps.say(bot, settled);
    deps.persist("now");
    if (answer.trusted) deps.trusted(card.root);
    return { ok: true };
  }

  reconcile(deps.now());

  return {
    hooks: (actor) => ({ PreToolUse: [{ hooks: [failClosed((input) => onCall(actor, input), (input, error) => onError(actor, input, error))], timeout: HOOK_TIMEOUT_S }] }),

    canUseTool: (actor) => async (tool, input, o) => {
      try {
        return onPrompt(actor, tool, input, o);
      } catch (e) {
        try {
          onError(actor, { tool_name: tool, tool_use_id: o.toolUseID, tool_input: input }, errorText(e));
        } catch {}
        return { behavior: "deny", message: COULD_NOT_CHECK };
      }
    },

    ask(botId, a) {
      const bot = world.bots.get(botId);
      if (!bot) throw new Error("This bot no longer exists.");
      const question = a.question.trim();
      if (bot.messages.some((m) => m.kind === "question" && m.answer === null && m.question.trim() === question))
        return "Already waiting on that question. End your turn; the answer arrives as a new message.";
      const open = state.open.filter((c) => c.kind === "question" && c.actor.botId === botId && messageOf(c)?.answer === null).length;
      if (open >= MAX_OPEN_CARDS)
        return `${userName} already has ${MAX_OPEN_CARDS} questions waiting from this bot, so this one was not posted. End your turn and wait for ${userName}.`;
      const now = deps.now();
      const id = newMessageId();
      const expiresAt = at(now, TTL.questionMs);
      const initiator = deps.turnOf(botActor(botId))?.initiator ?? SYSTEM;
      deps.say(bot, { kind: "question", id, at: now.toISOString(), question: a.question, options: a.options, answer: null, expiresAt });
      state.open.push({ kind: "question", cardId: id, actor: botActor(botId), remindAt: at(now, TTL.questionMs / 2), expiresAt, initiator });
      deps.persist("now");
      deps.notify(bot, "card", id);
      return "Card posted. End your turn; the answer arrives as a new message.";
    },

    answer(botId, messageId, reply) {
      const bot = world.bots.get(botId);
      if (!bot) return { ok: false, error: "Unknown bot" };
      // A card past its deadline is expired, never granted, even before the tick that would have retired it.
      const held = state.open.find((c) => c.cardId === messageId);
      if (held && held.expiresAt <= deps.now().toISOString()) {
        expire(held);
        return { ok: false, error: held.kind === "permission" ? "That request expired" : "That question expired" };
      }
      const message = bot.messages.find((m) => m.id === messageId);
      if (reply.kind === "permission") return decidePermission(bot, message, reply.choice);
      const settled = settleCard(message, { kind: "question", answer: reply.kind === "option" ? reply.index : "dismissed" });
      if (!settled.ok) return settled;
      const q = settled.card;
      // A card from before the initiator was recorded, or one rebuilt from its message, is answered as system work.
      const initiator = (held?.kind === "question" && held.initiator) || SYSTEM;
      deps.say(bot, q);
      dropCard(q.id);
      deps.persist("now");
      deps.deliver(
        botActor(bot.id),
        typeof q.answer === "number" ? { from: "answer", question: q.question, option: q.options[q.answer]!, initiator } : { from: "dismiss", question: q.question, initiator },
      );
      return { ok: true };
    },

    forgetBot(botId) {
      // The only caller, hub.delete_bot, persists right after; it owns the durability of the whole deletion.
      const keys = new Set<string>([`bot:${botId}`, ...[...world.agents.values()].filter((r) => r.agent.botId === botId).map((r) => `agent:${r.agent.id}`)]);
      state.open.splice(0, state.open.length, ...state.open.filter((c) => c.actor.botId !== botId));
      state.grants.splice(0, state.grants.length, ...state.grants.filter((g) => !keys.has(g.actor)));
      state.repos.splice(0, state.repos.length, ...state.repos.filter((r) => r.agentId === null || !keys.has(`agent:${r.agentId}`)));
      state.daily.splice(0, state.daily.length, ...state.daily.filter((c) => c.botId !== botId));
      const bot = world.bots.get(botId);
      if (bot) rulesOf(bot).splice(0);
    },

    trustCard(actor, repo) {
      if (repoTrust(state, repo.root, actor.agentId) !== null) return;
      if (state.open.some((c) => c.kind === "trust" && c.root === repo.root && messageOf(c)?.answer === null)) return;
      const bot = botOf(actor);
      const agent = world.agents.get(actor.agentId)?.agent;
      const now = deps.now();
      const id = newMessageId();
      const expiresAt = at(now, TTL.questionMs);
      deps.say(bot, {
        kind: "permission",
        id,
        at: now.toISOString(),
        from: agent ? agentPeer(agent) : null,
        tool: "Claude Code settings",
        label: `Trust ${repo.name}'s Claude settings`,
        detail: `${repo.found.join(", ")} in ${repo.root}`,
        always: `Agents in ${repo.name} load its own Claude Code settings, hooks and MCP servers, from now on`,
        answer: null,
        expiresAt,
      });
      state.open.push({ kind: "trust", cardId: id, actor, remindAt: null, expiresAt, root: repo.root });
      deps.persist("now");
      deps.notify(bot, "card", id);
    },

    beginTurn(actor) {
      const key = actorKey(actor);
      const armed = at(deps.now(), TTL.grantMs);
      let changed = false;
      for (const g of state.grants)
        if (g.actor === key && armed < g.expiresAt) {
          g.expiresAt = armed; // only ever shortens: the first continuation sets the window, later turns leave it
          changed = true;
        }
      if (changed) deps.persist("now");
    },

    wake(gapMs) {
      // The machine slept for gapMs; an open card was never seen, so push its deadlines forward to give back that time.
      if (gapMs <= 0) return;
      const shift = (iso: string) => new Date(Date.parse(iso) + gapMs).toISOString();
      let changed = false;
      for (const card of state.open) {
        const message = messageOf(card);
        if (!message || message.answer !== null) continue;
        card.expiresAt = shift(card.expiresAt);
        if (card.remindAt !== null) card.remindAt = shift(card.remindAt);
        const bot = world.bots.get(card.actor.botId);
        if (bot && message.expiresAt !== null) deps.say(bot, { ...message, expiresAt: shift(message.expiresAt) });
        changed = true;
      }
      if (changed) deps.persist("now");
    },

    resume(now) {
      if (state.aliveAt === undefined || state.open.length === 0) return;
      this.wake!(now.getTime() - Date.parse(state.aliveAt) - ALIVE_EVERY_MS);
    },

    tick(now) {
      const iso = now.toISOString();
      let changed = reconcile(now);
      if (state.open.length > 0 && (state.aliveAt === undefined || Date.parse(state.aliveAt) + ALIVE_EVERY_MS <= now.getTime())) {
        state.aliveAt = iso;
        deps.persist();
      }
      for (const bot of world.bots.values())
        for (const m of bot.messages)
          if (m.kind === "permission" && isOpenCard(m) && !state.open.some((c) => c.cardId === m.id)) {
            deps.say(bot, { ...m, answer: "expired" });
            changed = true;
          }
      for (const card of [...state.open]) {
        if (card.expiresAt <= iso || !actorExists(card.actor)) {
          expire(card);
          changed = true;
        } else if (card.remindAt !== null && card.remindAt <= iso) {
          card.remindAt = null;
          const bot = world.bots.get(card.actor.botId);
          if (bot) deps.notify(bot, "reminder", card.cardId);
          changed = true;
        }
      }
      if (changed) deps.persist("now");
    },

    nextDeadline() {
      const alive = state.open.length > 0 && state.aliveAt !== undefined ? [new Date(Date.parse(state.aliveAt) + ALIVE_EVERY_MS).toISOString()] : [];
      const deadlines = [...state.open.flatMap((c) => (c.remindAt === null ? [c.expiresAt] : [c.remindAt, c.expiresAt])), ...state.grants.map((g) => g.expiresAt), ...alive];
      return deadlines.reduce<string | null>((min, d) => (min === null || d < min ? d : min), null);
    },
  };
}
