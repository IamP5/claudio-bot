import type { CanUseTool, HookCallbackMatcher, Options, PermissionResult, PermissionUpdate, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Tickable } from "./clock";
import { failClosed, resolveReal, toCall, toHookOutput } from "./gate";
import type { Ledger } from "./ledger";
import { detailOf, floors, type Scope } from "./policy";
import {
  PHONE_MODES,
  type AskQuestion,
  type ItemId,
  type MessageId,
  type PermissionChoice,
  type PermissionMessage,
  type PermissionMode,
  type PhoneMode,
  type SessionControls,
  type SessionId,
  type SessionItem,
  type SessionStatus,
} from "./protocol";
import type { Result } from "./result";
import { refused } from "./result";
import { createSession, type Session, type SessionSpec, type TurnEnd } from "./session";
import type { Persist } from "./store";
import { errorText } from "./text";
import { emptySession, newMessageId, ownCardId, ownCardOpen, type OwnCard, type OwnDrive, type SessionRecord, type World } from "./world";

// The drivers of sessions the user drives from the phone: one session.ts Session per id, opened in the transcript's
// cwd with the user's own Claude Code settings. What Claude Code asks (a permission, AskUserQuestion, ExitPlanMode)
// waits as a card in the thread until the phone answers it; a PreToolUse hook adds only the policy's floors.

export type OwnDeps = {
  world: World;
  userName: string;
  ledger: Ledger;
  persist: Persist;
  claude: Pick<SessionSpec, "query" | "executable">;
  /** The mode and model the transcript last ran with, when it has them. */
  last(id: SessionId): { mode: PermissionMode | null; model: string | null };
  transcriptExists(id: SessionId, cwd: string): boolean;
  /** Why a turn must wait now: another live Claude Code is busy on the id. */
  blocked(id: SessionId): string | null;
  /** The user's settings.permissions.defaultMode, when it is one the phone may use. */
  defaultMode(): PhoneMode | null;
  scope(cwd: string): Scope;
  /** Something a row or a thread shows changed: status, cards, queue, controls. */
  changed(id: SessionId): void;
  done(id: SessionId): void;
  /** A card opened: the push says only that a session needs the user. */
  notify?(id: SessionId, cardId: MessageId): void;
  /** Every message of the live query, for the streaming text. */
  observe?(id: SessionId, m: Parameters<SessionSpec["onMessage"]>[0]): void;
  /** Extra query options (the streaming text needs partial messages). */
  options?: Partial<Options>;
  now(): Date;
  log(line: string): void;
};

export type Own = Tickable & {
  /** The phone sends to the session: queued, after a Stop when interrupt. */
  send(rec: SessionRecord, text: string, clientId: string, interrupt: boolean): Promise<Result>;
  stop(rec: SessionRecord): Promise<boolean>;
  decide(rec: SessionRecord, cardId: MessageId, choice: PermissionChoice): Result;
  answer(rec: SessionRecord, cardId: MessageId, answers: Record<string, string> | null): Result;
  set(rec: SessionRecord, patch: { model?: string | null; mode?: PhoneMode }): Promise<Result>;
  /** What the thread shows on top of the transcript: cards, the user's queued messages, notices. */
  overlay(rec: SessionRecord): SessionItem[];
  controls(rec: SessionRecord): SessionControls;
  status(rec: SessionRecord): { status: SessionStatus; working: boolean };
  /** The live query of a session that another process now works on closes, so the bridge yields. */
  yieldTo(id: SessionId): void;
  /** The other process let go: a turn that waited on it goes now. */
  unblock(id: SessionId): void;
  /** At start, before any phone connects: every open card is expired. */
  resume(): void;
  /** Once the index is read: sessions with queued input start. */
  restart(): void;
  close(): void;
};

/** A card left this long unanswered is denied, with a notice. The same as the gate's permission cards. */
export const OWN_CARD_TTL_MS = 2 * 3_600_000;
/** An own session's query with nothing to do closes after this; an agent's stays 15 minutes. */
export const OWN_IDLE_MS = 10 * 60_000;
const SETTLED_KEPT = 20;
const NOTICES_KEPT = 10;

/** What the model menu offers. Claude Code resolves these aliases to the newest model of each family. */
export const MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function questionsOf(input: Record<string, unknown>): AskQuestion[] {
  return (Array.isArray(input.questions) ? input.questions.filter(isRecord) : []).map((q) => ({
    question: str(q.question) ?? "",
    header: str(q.header) ?? "",
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options.filter(isRecord) : []).map((o) => ({ label: str(o.label) ?? "", description: str(o.description) ?? "" })),
  }));
}

const phoneMode = (m: PermissionMode | null | undefined): PhoneMode | null => (m && (PHONE_MODES as readonly string[]).includes(m) ? (m as PhoneMode) : null);

/** The floors run as for an agent: no home of its own inside the bridge's, no USER.md. */
const FLOOR_ACTOR = { kind: "agent", botId: "", agentId: "" } as const;

type Reply = { kind: "choice"; choice: PermissionChoice } | { kind: "answers"; answers: Record<string, string> } | { kind: "dismissed" } | { kind: "expired" };

const cardIdOf = ownCardId;
const isOpen = ownCardOpen;

export function createOwn(deps: OwnDeps): Own {
  const drivers = new Map<SessionId, Session>();
  /** The live query's wait on each open card. A card without one (after a restart) can only expire. */
  const waiting = new Map<MessageId, (r: Reply) => void>();
  const notices = new Map<SessionId, SessionItem[]>();
  const failed = new Set<SessionId>();
  /** Sessions whose last start waited on another Claude Code, so its letting go starts them at once. */
  const held = new Set<SessionId>();

  const now = () => deps.now().toISOString();
  const driveOf = (rec: SessionRecord): OwnDrive => {
    if (!rec.own) throw new Error(`${rec.id} is not driven from the phone`);
    return rec.own;
  };
  const cards = (rec: SessionRecord) => driveOf(rec).cards;

  function notice(id: SessionId, text: string, tone: "info" | "error" = "info") {
    const list = notices.get(id) ?? [];
    list.push({ kind: "notice", id: `n_${crypto.randomUUID()}` as ItemId, at: now(), text, tone });
    notices.set(id, list.slice(-NOTICES_KEPT));
    deps.changed(id);
  }

  /** Keeps the open cards and the newest settled ones. */
  function prune(rec: SessionRecord) {
    const list = cards(rec);
    const settled = list.filter((c) => !isOpen(c));
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT)));
    list.splice(0, list.length, ...list.filter((c) => !drop.has(c)));
  }

  /** Opens a card and waits for its answer, its expiry, or the query giving up on it. Saved before it shows. */
  function hold(rec: SessionRecord, card: OwnCard, signal: AbortSignal): Promise<Reply> {
    const id = cardIdOf(card);
    cards(rec).push(card);
    deps.persist("now");
    deps.changed(rec.id);
    deps.notify?.(rec.id, id);
    return new Promise<Reply>((resolve) => {
      const done = (r: Reply) => {
        waiting.delete(id);
        signal.removeEventListener("abort", aborted);
        resolve(r);
      };
      const aborted = () => {
        settle(rec, id, { kind: "expired" });
      };
      waiting.set(id, done);
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    });
  }

  /** First answer wins. The card records it, and the live query hears it. */
  function settle(rec: SessionRecord, cardId: MessageId, reply: Reply): Result {
    const card = rec.own?.cards.find((c) => cardIdOf(c) === cardId);
    if (!card) return refused("Unknown card");
    if (!isOpen(card)) return refused(card.kind === "permission" && card.card.answer === "expired" ? "That request expired" : "That card was already answered");
    switch (card.kind) {
      case "permission":
        if (reply.kind !== "choice" && reply.kind !== "expired") return refused("A permission card takes a choice");
        card.card = { ...card.card, answer: reply.kind === "choice" ? reply.choice : "expired" };
        break;
      case "ask":
        if (reply.kind === "choice") return refused("A question takes answers");
        card.answers = reply.kind === "answers" ? reply.answers : reply.kind;
        break;
      case "plan":
        if (reply.kind !== "choice" && reply.kind !== "expired") return refused("A plan takes a choice");
        card.state = reply.kind === "expired" ? "expired" : reply.choice === "once" || reply.choice === "always" ? "approved" : "rejected";
        break;
    }
    prune(rec);
    deps.persist();
    waiting.get(cardId)?.(reply);
    deps.changed(rec.id);
    return { ok: true };
  }

  const expiresAt = () => new Date(deps.now().getTime() + OWN_CARD_TTL_MS).toISOString();

  function canUseTool(rec: SessionRecord): CanUseTool {
    return async (tool, input, o): Promise<PermissionResult> => {
      try {
        if (tool === "AskUserQuestion") {
          const card: OwnCard = { kind: "ask", cardId: newMessageId(), toolUseId: o.toolUseID, at: now(), expiresAt: expiresAt(), questions: questionsOf(input), answers: null };
          const r = await hold(rec, card, o.signal);
          if (r.kind === "answers") return { behavior: "allow", updatedInput: { ...input, answers: r.answers } };
          return { behavior: "deny", message: r.kind === "dismissed" ? `${deps.userName} dismissed the question without answering.` : `The question expired unanswered; ${deps.userName} did not say no.` };
        }
        if (tool === "ExitPlanMode") {
          const drive = driveOf(rec);
          const before = phoneMode(drive.mode) ?? deps.defaultMode() ?? "default";
          const card: OwnCard = { kind: "plan", cardId: newMessageId(), toolUseId: o.toolUseID, at: now(), expiresAt: expiresAt(), text: str(input.plan) ?? "", state: "proposed", modeBefore: before === "plan" ? "default" : before };
          const r = await hold(rec, card, o.signal);
          if (r.kind === "choice" && (r.choice === "once" || r.choice === "always")) {
            drive.mode = card.modeBefore as PhoneMode;
            deps.persist();
            void drivers.get(rec.id)?.controls()?.setPermissionMode(card.modeBefore).catch((e) => deps.log(`own ${rec.id}: setPermissionMode failed: ${errorText(e)}`));
            return { behavior: "allow", updatedInput: input };
          }
          return { behavior: "deny", message: r.kind === "expired" ? `The plan expired unanswered; ${deps.userName} did not say no. Keep planning.` : `${deps.userName} wants you to keep planning. Revise the plan.` };
        }
        const suggestions = o.suggestions ?? [];
        const message: PermissionMessage = {
          kind: "permission",
          id: newMessageId(),
          at: now(),
          from: null,
          tool,
          label: o.title?.trim() || o.displayName?.trim() || tool,
          detail: detailOf({ tool, input, cwd: driveOf(rec).cwd, toolUseId: o.toolUseID, subagent: null, mcpServer: o.mcpServer ?? null }),
          always: suggestions.length > 0 && o.suppressAlwaysAllowRule !== true ? alwaysText(suggestions) : "",
          answer: null,
          expiresAt: expiresAt(),
        };
        const r = await hold(rec, { kind: "permission", card: message, toolUseId: o.toolUseID, suggestions }, o.signal);
        if (r.kind !== "choice") return { behavior: "deny", message: `The request expired unanswered; ${deps.userName} did not say no. It did not run.` };
        switch (r.choice) {
          case "once":
            return { behavior: "allow", updatedInput: input };
          case "always":
            return {
              behavior: "allow",
              updatedInput: input,
              ...(message.always !== "" && { updatedPermissions: suggestions.map((s): PermissionUpdate => ({ ...s, destination: "session" })) }),
            };
          case "deny":
            return { behavior: "deny", message: `${deps.userName} denied this. It did not run.` };
          case "never":
            return { behavior: "deny", message: `${deps.userName} denied this and stopped the turn. It did not run.`, interrupt: true };
        }
      } catch (e) {
        deps.log(`own ${rec.id}: canUseTool failed: ${errorText(e)}`);
        return { behavior: "deny", message: "The bridge could not ask about this call, so it did not run." };
      }
    };
  }

  function floorsHook(rec: SessionRecord): HookCallbackMatcher {
    return {
      hooks: [
        failClosed(
          (input: PreToolUseHookInput) => {
            const parsed = toCall(input);
            if (!parsed.ok) return {};
            const scope = deps.scope(driveOf(rec).cwd);
            const d = floors(parsed.call, {
              actor: FLOOR_ACTOR as never,
              initiator: { kind: "user" },
              scope,
              rules: [],
              grants: [],
              headroom: { ok: true, capReached: false },
              callsToday: {},
              connectorsOff: [],
              now: now(),
              realpath: resolveReal,
            });
            return d === null ? {} : toHookOutput(d, null, deps.userName);
          },
          (_, error) => deps.log(`own ${rec.id}: floors failed: ${error}`),
        ),
      ],
    };
  }

  const modeOf = (rec: SessionRecord): PhoneMode => phoneMode(rec.own?.mode) ?? phoneMode(deps.last(rec.id).mode) ?? deps.defaultMode() ?? "default";

  function driver(rec: SessionRecord): Session {
    const existing = drivers.get(rec.id);
    if (existing) return existing;
    const drive = driveOf(rec);
    const id = rec.id;
    const session = createSession({
      actor: { kind: "own", sessionId: id },
      state: drive.session,
      account: deps.world.account,
      ledger: deps.ledger,
      persist: deps.persist,
      userName: deps.userName,
      name: () => "Claude Code",
      log: deps.log,
      ...deps.claude,
      forgotten: "fail",
      notices: false,
      idleMs: OWN_IDLE_MS,
      now: deps.now,
      blocked: () => {
        const wait = deps.blocked(id);
        if (wait !== null) held.add(id);
        return wait;
      },
      options: (): Options => {
        const model = drive.model ?? deps.last(id).model ?? undefined;
        return {
          cwd: drive.cwd,
          // Only a session the phone made may be created under its id; one it took on resumes, and fails if Claude Code lost it.
          ...(!drive.created || deps.transcriptExists(id, drive.cwd) ? { resume: id } : { sessionId: id }),
          // The user's own regime, as in the Claude app: their settings, their prompts, no bridge sandbox.
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: modeOf(rec),
          ...(model !== undefined && { model }),
          canUseTool: canUseTool(rec),
          hooks: { PreToolUse: [floorsHook(rec)] },
          // The bridge's own settings (its push topic among them) stay out: these sessions run no sandbox to hide them.
          env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUD(IO|E)BOT_/.test(k))),
          ...deps.options,
        };
      },
      onMessage: (m) => deps.observe?.(id, m),
      onTurnEnd(pending, end: TurnEnd) {
        if (end.kind === "deferred") return;
        if (end.kind === "failed") {
          failed.add(id);
          notice(id, end.error, "error");
        } else if (end.kind === "done" && end.result.subtype !== "success") {
          failed.add(id);
          notice(id, `Claude Code stopped with an error: ${end.result.errors.join("; ") || end.result.subtype}`, "error");
        } else if (end.kind === "done") deps.done(id);
        deps.changed(id);
        void pending;
      },
      onChange: () => deps.changed(id),
      // A start held by another Claude Code is what the composer already says; the retry note would only repeat it.
      note: (text) => (deps.blocked(id) !== null && text.startsWith("Claude Code could not start") ? undefined : notice(id, text)),
      onDormant() {
        drivers.delete(id);
        session.close();
      },
    });
    drivers.set(id, session);
    return session;
  }

  return {
    async send(rec, text, clientId, interrupt) {
      const drive = driveOf(rec);
      if (drive.session.pending.some((p) => p.clientId === clientId)) return { ok: true };
      const s = driver(rec);
      if (interrupt) await s.interrupt();
      failed.delete(rec.id);
      s.push({ kind: "envelope", text, initiator: { kind: "user" }, settles: null, clientId });
      deps.changed(rec.id);
      return { ok: true };
    },

    async stop(rec) {
      const s = drivers.get(rec.id);
      return s ? s.interrupt() : false;
    },

    decide(rec, cardId, choice) {
      return settle(rec, cardId, { kind: "choice", choice });
    },

    answer(rec, cardId, answers) {
      return settle(rec, cardId, answers === null ? { kind: "dismissed" } : { kind: "answers", answers });
    },

    async set(rec, patch) {
      const drive = driveOf(rec);
      const live = drivers.get(rec.id)?.controls() ?? null;
      try {
        if (patch.model !== undefined) {
          drive.model = patch.model;
          await live?.setModel(patch.model ?? deps.last(rec.id).model ?? undefined);
        }
        if (patch.mode !== undefined) {
          drive.mode = patch.mode;
          await live?.setPermissionMode(patch.mode);
        }
      } catch (e) {
        return refused(`Claude Code did not take the change: ${errorText(e)}`);
      } finally {
        deps.persist();
        deps.changed(rec.id);
      }
      return { ok: true };
    },

    overlay(rec) {
      const drive = rec.own;
      if (!drive) return [];
      const items: SessionItem[] = [];
      for (const c of drive.cards) {
        switch (c.kind) {
          case "permission":
            items.push({ kind: "permission", id: c.card.id as string as ItemId, at: c.card.at, card: { ...c.card } });
            break;
          case "ask":
            items.push({ kind: "ask", id: c.toolUseId as ItemId, at: c.at, questions: c.questions.map((q) => ({ ...q })), answers: c.answers, cardId: c.answers === null ? c.cardId : null });
            break;
          case "plan":
            items.push({ kind: "plan", id: c.toolUseId as ItemId, at: c.at, text: c.text, state: c.state, cardId: c.state === "proposed" ? c.cardId : null });
            break;
        }
      }
      const life = drive.session.lifecycle;
      const inFlight = life.kind === "working" || life.kind === "stopping" ? life.turn.pending : null;
      for (const p of drive.session.pending) {
        if (p.clientId === undefined) continue;
        items.push({ kind: "user", id: p.clientId as ItemId, at: p.at, text: p.text, from: "user", queued: p.id !== inFlight });
      }
      return [...items, ...(notices.get(rec.id) ?? [])];
    },

    controls(rec) {
      const s = drivers.get(rec.id);
      const pending = rec.own?.session.pending ?? [];
      const life = rec.own?.session.lifecycle;
      const inFlight = life && (life.kind === "working" || life.kind === "stopping") ? 1 : 0;
      const wait = deps.blocked(rec.id);
      return {
        canSend: wait === null,
        reason: wait,
        working: wait === null && (s?.working ?? false),
        queued: Math.max(0, pending.length - inFlight),
        model: rec.own?.model ?? null,
        models: MODELS,
        mode: modeOf(rec),
        modes: [...PHONE_MODES],
      };
    },

    status(rec) {
      const s = drivers.get(rec.id);
      const open = rec.own?.cards.filter(isOpen) ?? [];
      const working = s?.working ?? false;
      if (s?.unavailable && deps.blocked(rec.id) === null) return { status: "unavailable", working };
      if (open.some((c) => c.kind !== "ask")) return { status: "awaiting_approval", working };
      if (open.length > 0) return { status: "awaiting_input", working };
      if ((rec.own?.session.pending.length ?? 0) > 0 && deps.blocked(rec.id) !== null) return { status: "parked", working: false };
      if (working) return { status: "working", working };
      if (s?.parkedFor) return { status: "parked", working };
      if (failed.has(rec.id)) return { status: "failed", working };
      return { status: "idle", working };
    },

    yieldTo(id) {
      const s = drivers.get(id);
      if (s && !s.working) s.reopen();
    },

    unblock(id) {
      if (!held.delete(id)) return;
      drivers.get(id)?.retry();
    },

    resume() {
      for (const rec of deps.world.sessions.values()) {
        if (!rec.own) continue;
        let expired = false;
        for (const c of rec.own.cards) {
          if (!isOpen(c)) continue;
          expired = true;
          if (c.kind === "permission") c.card = { ...c.card, answer: "expired" };
          else if (c.kind === "ask") c.answers = "expired";
          else c.state = "expired";
        }
        if (expired) {
          deps.persist();
          notice(rec.id, "The bridge restarted while Claude Code waited on you, so that question expired.");
        }
      }
    },

    restart() {
      for (const rec of deps.world.sessions.values()) if (rec.own && rec.own.session.pending.length > 0) driver(rec);
    },

    tick(at) {
      for (const rec of deps.world.sessions.values()) {
        for (const c of rec.own?.cards ?? []) {
          const until = c.kind === "permission" ? c.card.expiresAt : c.expiresAt;
          if (isOpen(c) && until <= at.toISOString()) {
            settle(rec, cardIdOf(c), { kind: "expired" });
            notice(rec.id, "A request waited two hours unanswered, so it was denied. You did not say no.");
          }
        }
      }
      for (const s of drivers.values()) s.tick(at);
    },

    nextDeadline() {
      let next: string | null = null;
      const consider = (d: string | null) => {
        if (d !== null && (next === null || d < next)) next = d;
      };
      for (const rec of deps.world.sessions.values())
        for (const c of rec.own?.cards ?? []) if (isOpen(c)) consider(c.kind === "permission" ? c.card.expiresAt : c.expiresAt);
      for (const s of drivers.values()) consider(s.nextDeadline());
      return next;
    },

    close() {
      for (const s of drivers.values()) s.close();
      drivers.clear();
    },
  };
}

export const newDrive = (fields: { cwd: string; created: boolean; at: string; model: string | null; mode: PhoneMode | null; id: SessionId; prompt?: string }): OwnDrive => ({
  cwd: fields.cwd,
  created: fields.created,
  at: fields.at,
  ...(fields.prompt !== undefined && { prompt: fields.prompt }),
  model: fields.model,
  mode: fields.mode,
  session: emptySession(fields.id),
  cards: [],
});

/** What Always allows, completing the card's "Always allows …": the rules Claude Code suggests, for this session. */
function alwaysText(suggestions: readonly PermissionUpdate[]): string {
  const rules = suggestions.flatMap((s) => (s.type === "addRules" && s.behavior === "allow" ? s.rules : []));
  const named = rules.map((r) => r.ruleContent?.trim() || r.toolName);
  return `${named.length > 0 ? [...new Set(named)].join(", ") : "this"}, for this session`;
}
