import type { HookCallback, HookCallbackMatcher, HookEvent, PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Tickable } from "./clock";
import type { Headroom } from "./ledger";
import { DAILY_CAPS, decide, detailOf, fingerprint, redact, type Decision, type PolicyContext, type Scope, type ToolCall } from "./policy";
import type { AgentId, BotId, Message, MessageId, PermissionChoice } from "./protocol";
import { notices, type Envelope } from "./prompts";
import type { Persist } from "./store";
import {
  actorKey,
  agentPeer,
  attended,
  botActor,
  newMessageId,
  settleCard,
  type Actor,
  type ActorKey,
  type BotRecord,
  type Card,
  type DailyCount,
  type GateState,
  type Initiator,
  type OpenCard,
  type Owned,
  type StandingRule,
  type World,
} from "./world";

// Everything that waits on the human: the PreToolUse gate, both card kinds (TTL, reminder, dedupe, settle),
// standing rules, one-shot grants, and the audit log at <bridge home>/audit/YYYY-MM.jsonl (0600, append-only).
// The only writer of World.gate and BotRecord.rules. Owner: U1.
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

/** A hook that times out fails closed (probe Q6). The gate never awaits I/O, so this is only a backstop. */
export const HOOK_TIMEOUT_S = 30;

/** Cards remind once at half their life, then expire. A grant lets the exact call run once within grantMs. */
const TTL = { permissionMs: 2 * 3600_000, questionMs: 24 * 3600_000, grantMs: 10 * 60_000 } as const;

const VERDICTS_KEPT = 1000;

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
  /** The SDK adapter for one actor: a PreToolUse matcher on every tool. Bots and mac agents both get it. */
  hooks(actor: Actor): Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** The bot's ask tool. Returns the tool's reply. An identical open question gets "Already waiting" instead of a second card. */
  ask(botId: BotId, a: { question: string; options: string[] }): string;
  /**
   * Settles either card kind, first wins; a late or second answer gets the error. Questions deliver the answer or
   * dismiss envelope. Permissions apply the choice and deliver a decision envelope to the actor that asked:
   * once → grant; always → allow rule (attendance from the held call's initiator) plus a grant for the held call;
   * deny; never → deny rule. Only a card tap reaches this; chat text never approves.
   */
  answer(botId: BotId, messageId: MessageId, reply: CardReply): { ok: true } | { ok: false; error: string };
  /** delete_bot: drops the bot's open cards, its and its agents' grants, its rules and its daily counts. */
  forgetBot(botId: BotId): void;
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
  persist: Persist;
  auditDir: string;
  userName: string;
  now: () => Date;
  log: (line: string) => void;
};

const COULD_NOT_CHECK = "The bridge could not check this call, so it was blocked and did not run. Do not retry it this turn.";

export const denyOutput = (reason: string): SyncHookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});
const allowOutput = (reason: string): SyncHookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason },
});

const describe = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unprintable error";
  }
};

/** Only {} (no opinion), allow or deny may leave the gate. Anything else, an async result included, would fail open. */
function checked(out: SyncHookJSONOutput): SyncHookJSONOutput {
  const keys = Object.keys(out);
  if (keys.length === 0) return out;
  const specific = out.hookSpecificOutput;
  if (keys.length === 1 && specific?.hookEventName === "PreToolUse" && (specific.permissionDecision === "allow" || specific.permissionDecision === "deny")) return out;
  throw new Error(`unexpected hook output ${JSON.stringify(out)}`);
}

/**
 * A PreToolUse callback that throws fails OPEN and the tool runs (probe Q6), so every exception, including one from
 * reading the input or from the error report itself, becomes an explicit deny. The body is synchronous.
 */
export function failClosed(body: (input: PreToolUseHookInput) => SyncHookJSONOutput, onError: (input: unknown, error: string) => void): HookCallback {
  return async (input) => {
    try {
      if (input.hook_event_name !== "PreToolUse") return {};
      return checked(body(input));
    } catch (e) {
      try {
        onError(input, describe(e));
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

/** realpath of the longest existing prefix, so a file about to be created resolves through any symlinked folder above it. */
function resolveReal(path: string): string {
  const rest: string[] = [];
  for (let head = path; ; head = dirname(head)) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {}
    if (dirname(head) === head) return path;
    rest.unshift(basename(head));
  }
}

const own = <T>(slice: Owned<T>): T => slice as unknown as T;
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const SYSTEM: Initiator = { kind: "system" };
const isOpenCard = (m: Message): m is Card => (m.kind === "question" || m.kind === "permission") && m.answer === null;

export function createGate(deps: GateDeps): Gate {
  const { world, userName } = deps;
  const state = own<GateState>(world.gate);
  const rulesOf = (bot: BotRecord) => own<StandingRule[]>(bot.rules);
  const verdicts = new Map<string, SyncHookJSONOutput>();
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
    return m?.kind === card.kind ? (m as Card) : undefined;
  };
  const dropCard = (cardId: MessageId) => {
    const i = state.open.findIndex((c) => c.cardId === cardId);
    if (i !== -1) state.open.splice(i, 1);
  };

  function remember(toolUseId: string, out: SyncHookJSONOutput): SyncHookJSONOutput {
    if (verdicts.has(toolUseId)) return out;
    verdicts.set(toolUseId, out);
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
    deps.say(bot, { kind: "permission", id, at: now.toISOString(), from: agent ? agentPeer(agent) : null, tool: call.tool, label: d.label, detail, always: d.always, answer: null, expiresAt });
    state.open.push({
      kind: "permission",
      cardId: id,
      actor,
      remindAt: at(now, TTL.permissionMs / 2),
      expiresAt,
      call: { initiator, tool: call.tool, signature: d.signature, fingerprint: fingerprint(call), label: d.label, detail, always: d.always },
    });
    return id;
  }

  function onCall(actor: Actor, input: PreToolUseHookInput): SyncHookJSONOutput {
    const turn = deps.turnOf(actor);
    const initiator = turn?.initiator ?? SYSTEM;
    // While stopping the session is already ending the turn, so these denials do not feed its breaker.
    if (turn?.stopping) {
      auditRaw(actor, initiator, input, { decision: "deny", via: "stopping", rule: null, cardId: null });
      return remember(input.tool_use_id, denyOutput(stoppingReason(userName)));
    }
    const seen = verdicts.get(input.tool_use_id);
    if (seen) return seen;

    const parsed = toCall(input);
    if (!parsed.ok) {
      auditRaw(actor, initiator, input, { decision: "deny", via: "malformed", rule: "input", cardId: null });
      deps.denied(actor);
      return remember(input.tool_use_id, denyOutput(`This call's input is malformed (${parsed.error}), so it was blocked and did not run.`));
    }
    const call = parsed.call;
    const now = deps.now();
    const ctx: PolicyContext = {
      actor,
      initiator,
      scope: deps.scopeOf(actor),
      rules: botOf(actor).rules,
      grants: state.grants,
      headroom: deps.headroom(actor, initiator),
      callsToday: todayCounts(actor.botId, now),
      now: now.toISOString(),
      realpath: resolveReal,
    };
    const decision = decide(call, ctx);
    return remember(call.toolUseId, apply(actor, initiator, call, decision, now));
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
    state.daily.splice(0, state.daily.length, ...state.daily.filter((c) => c.day === day && world.bots.has(c.botId)));
    return JSON.stringify(state) !== before;
  }

  function expire(card: OpenCard) {
    dropCard(card.cardId);
    const bot = world.bots.get(card.actor.botId);
    const settled = settleCard(messageOf(card), { kind: card.kind, answer: "expired" });
    if (!bot || !settled.ok) return;
    deps.say(bot, settled.card);
    if (!actorExists(card.actor)) return;
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
    const card = state.open.find((c): c is Extract<OpenCard, { kind: "permission" }> => c.kind === "permission" && c.cardId === settled.card.id);
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
      state.grants.splice(0, state.grants.length, ...state.grants.filter((g) => !(g.actor === key && g.fingerprint === held.fingerprint)), {
        actor: key,
        fingerprint: held.fingerprint,
        cardId: card.cardId,
        expiresAt: at(now, TTL.grantMs),
      });
    }
    const ruleBase = { signature: held.signature, label: held.label, cardId: card.cardId, at: now.toISOString() };
    if (choice === "always") setRule(bot, { decision: "allow", appliesTo: attended(held.initiator) ? "attended" : "all", ...ruleBase });
    if (choice === "never") setRule(bot, { decision: "deny", ...ruleBase });
    deps.say(bot, settled.card);
    deps.persist("now");
    deps.deliver(card.actor, { from: "decision", choice, tool: held.tool, detail: held.detail, initiator: held.initiator });
    return { ok: true };
  }

  reconcile(deps.now());

  return {
    hooks: (actor) => ({ PreToolUse: [{ hooks: [failClosed((input) => onCall(actor, input), (input, error) => onError(actor, input, error))], timeout: HOOK_TIMEOUT_S }] }),

    ask(botId, a) {
      const bot = world.bots.get(botId);
      if (!bot) throw new Error("This bot no longer exists.");
      const question = a.question.trim();
      if (bot.messages.some((m) => m.kind === "question" && m.answer === null && m.question.trim() === question))
        return "Already waiting on that question. End your turn; the answer arrives as a new message.";
      const now = deps.now();
      const id = newMessageId();
      const expiresAt = at(now, TTL.questionMs);
      deps.say(bot, { kind: "question", id, at: now.toISOString(), question: a.question, options: a.options, answer: null, expiresAt });
      state.open.push({ kind: "question", cardId: id, actor: botActor(botId), remindAt: at(now, TTL.questionMs / 2), expiresAt });
      deps.persist("now");
      deps.notify(bot, "card", id);
      return "Card posted. End your turn; the answer arrives as a new message.";
    },

    answer(botId, messageId, reply) {
      const bot = world.bots.get(botId);
      if (!bot) return { ok: false, error: "Unknown bot" };
      const message = bot.messages.find((m) => m.id === messageId);
      if (reply.kind === "permission") return decidePermission(bot, message, reply.choice);
      const settled = settleCard(message, { kind: "question", answer: reply.kind === "option" ? reply.index : "dismissed" });
      if (!settled.ok) return settled;
      const q = settled.card;
      deps.say(bot, q);
      dropCard(q.id);
      deps.persist("now");
      deps.deliver(
        botActor(bot.id),
        typeof q.answer === "number" ? { from: "answer", question: q.question, option: q.options[q.answer]! } : { from: "dismiss", question: q.question },
      );
      return { ok: true };
    },

    forgetBot(botId) {
      const keys = new Set<string>([`bot:${botId}`, ...[...world.agents.values()].filter((r) => r.agent.botId === botId).map((r) => `agent:${r.agent.id}`)]);
      state.open.splice(0, state.open.length, ...state.open.filter((c) => c.actor.botId !== botId));
      state.grants.splice(0, state.grants.length, ...state.grants.filter((g) => !keys.has(g.actor)));
      state.daily.splice(0, state.daily.length, ...state.daily.filter((c) => c.botId !== botId));
      const bot = world.bots.get(botId);
      if (bot) rulesOf(bot).splice(0);
      deps.persist("now");
    },

    tick(now) {
      const iso = now.toISOString();
      let changed = reconcile(now);
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
      const deadlines = [...state.open.flatMap((c) => (c.remindAt === null ? [c.expiresAt] : [c.remindAt, c.expiresAt])), ...state.grants.map((g) => g.expiresAt)];
      return deadlines.reduce<string | null>((min, d) => (min === null || d < min ? d : min), null);
    },
  };
}
