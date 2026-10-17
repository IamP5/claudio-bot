import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "./clock";
import type { Headroom } from "./ledger";
import type { Decision, Scope, ToolCall } from "./policy";
import type { BotId, Message, MessageId, PermissionChoice } from "./protocol";
import type { Envelope } from "./prompts";
import type { Persist } from "./store";
import { botActor, newMessageId, settleCard, type Actor, type ActorKey, type BotRecord, type Initiator, type World } from "./world";

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
// The scaffold body passes every call to the classifier and keeps today's question cards.

/** A hook that times out fails closed (probe Q6). The gate never awaits I/O, so this is only a backstop. */
export const HOOK_TIMEOUT_S = 30;

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
   * once → grant; always → allow rule (attendance from the held call's initiator); deny; never → deny rule.
   * Only a card tap reaches this; chat text never approves.
   */
  answer(botId: BotId, messageId: MessageId, reply: CardReply): { ok: true } | { ok: false; error: string };
  // tick(now): expire overdue cards (level-triggered) with a notice to the asker, never a turn and never a "no";
  //   remind once at remindAt; drop expired grants and cards whose actor is gone. nextDeadline(): the earliest of those.
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

export const denyOutput = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** A PreToolUse callback that throws fails OPEN and the tool runs (probe Q6), so every exception becomes an explicit deny. */
export function failClosed(body: (input: PreToolUseHookInput) => HookJSONOutput, log: (line: string) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    try {
      return body(input);
    } catch (e) {
      log(`gate error on ${input.tool_name} ${input.tool_use_id}: ${(e as Error).message}`);
      return denyOutput("The bridge could not check this call, so it was blocked and did not run. Do not retry it this turn.");
    }
  };
}

/** Boundary parse of the hook input. Malformed tool input is an error, which the gate denies; it never becomes {}. */
export function toCall(input: PreToolUseHookInput): { ok: true; call: ToolCall } | { ok: false; error: string } {
  throw new Error("not implemented");
}

/** pass → {} so the classifier decides; allow → "allow"; ask → "deny" with the held reason naming the card; deny → "deny". */
export function toHookOutput(decision: Decision, cardId: MessageId | null): HookJSONOutput {
  throw new Error("not implemented");
}

export function createGate(deps: GateDeps): Gate {
  const { world } = deps;
  return {
    hooks: () => ({ PreToolUse: [{ hooks: [failClosed(() => ({}), deps.log)], timeout: HOOK_TIMEOUT_S }] }),

    ask(botId, a) {
      const bot = world.bots.get(botId);
      if (!bot) throw new Error("This bot no longer exists.");
      deps.say(bot, { kind: "question", id: newMessageId(), at: deps.now().toISOString(), question: a.question, options: a.options, answer: null, expiresAt: null });
      return "Card posted. End your turn; the answer arrives as a new message.";
    },

    answer(botId, messageId, reply) {
      if (reply.kind === "permission") throw new Error("not implemented");
      const bot = world.bots.get(botId);
      if (!bot) return { ok: false, error: "Unknown bot" };
      const settled = settleCard(bot.messages.find((m) => m.id === messageId), {
        kind: "question",
        answer: reply.kind === "option" ? reply.index : "dismissed",
      });
      if (!settled.ok) return settled;
      const q = settled.card;
      deps.say(bot, q);
      deps.deliver(
        botActor(bot.id),
        typeof q.answer === "number" ? { from: "answer", question: q.question, option: q.options[q.answer]! } : { from: "dismiss", question: q.question },
      );
      return { ok: true };
    },

    tick() {},
    nextDeadline: () => null,
  };
}
