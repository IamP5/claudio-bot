import { z } from "zod";
import type { Tickable } from "../clock";
import type { BotId } from "../protocol";
import { errorText } from "../text";
import { readPrivate, writePrivate } from "./files";
import type { Machine } from "./machines";
import { intentSchema, type Applied, type Intent, type IntentId, type MachineId } from "./wire";

// <bridgeHome>/machine/queue.json, 0600, on the home: intents for machines, in the order they were sent, until each
// machine applies them. One that waits past its kind's TTL is dropped with a note in its bot's chat. A machine applies
// an intentId once, so an intent sent again after a lost link or a home restart runs once.

/** What may wait for a machine. A snapshot and a projects listing are only worth having while it is online. */
export type QueuedIntent = Exclude<Intent, { kind: "snapshot" | "projects" }>;

/** what: the intent in words for the expiry note, such as `Starting "Fix tests"`. botId: whose chat hears of it. */
export type Queued = { machine: MachineId; intent: QueuedIntent; botId: BotId | null; what: string; at: string; expiresAt: string };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How long each kind waits for its machine. A card answer waits until its card expires, which it is told. */
export const QUEUE_TTL_MS: Record<Exclude<QueuedIntent["kind"], "card.answer">, number> = {
  "agent.start": DAY,
  "agent.message": DAY,
  "agent.direct": DAY,
  "agent.stop": 10 * MINUTE,
  "agent.removeWorktree": DAY,
};

/** cardExpiresAt: for a card answer, when its card expires. */
export function expiryOf(intent: QueuedIntent, at: Date, cardExpiresAt: string | null): string {
  if (intent.kind === "card.answer") return cardExpiresAt ?? at.toISOString();
  return new Date(at.getTime() + QUEUE_TTL_MS[intent.kind]).toISOString();
}

/** The machine's next intent to send, in queue order, and every queued intent (for any machine) past its TTL. */
export function due(queue: readonly Queued[], machine: MachineId | null, now: string): { next: Queued | null; expired: Queued[] } {
  const expired = queue.filter((q) => q.expiresAt <= now);
  const next = queue.find((q) => q.machine === machine && q.expiresAt > now) ?? null;
  return { next, expired };
}

const FILE = z.array(
  z.object({
    machine: z.string().min(1) as unknown as z.ZodType<MachineId>,
    intent: intentSchema.refine((i) => i.kind !== "snapshot" && i.kind !== "projects") as unknown as z.ZodType<QueuedIntent>,
    botId: (z.string().min(1) as unknown as z.ZodType<BotId>).nullable(),
    what: z.string(),
    at: z.string(),
    expiresAt: z.string(),
  }),
);

/** The queue as a file: read once, rewritten whole on each change. */
export function fileQueue(path: string, log: (line: string) => void) {
  let entries: Queued[] = [];
  try {
    const raw = readPrivate(path);
    if (raw !== null) {
      const parsed = FILE.safeParse(JSON.parse(raw));
      if (parsed.success) entries = parsed.data;
      else log(`queue: ${path} does not parse, so the intents in it are lost: ${z.prettifyError(parsed.error).split("\n")[0]}`);
    }
  } catch (e) {
    log(`queue: ${path} could not be read, so the intents in it are lost: ${errorText(e)}`);
  }
  const save = () => {
    try {
      writePrivate(path, `${JSON.stringify(entries)}\n`);
    } catch (e) {
      log(`queue: could not save ${path}, so what waits there lasts only until restart: ${errorText(e)}`);
    }
  };
  return {
    list: (): readonly Queued[] => entries,
    add(q: Queued) {
      if (entries.some((e) => e.intent.intentId === q.intent.intentId)) return;
      entries.push(q);
      save();
    },
    remove(id: IntentId) {
      const kept = entries.filter((e) => e.intent.intentId !== id);
      if (kept.length === entries.length) return;
      entries = kept;
      save();
    },
  };
}

export type Dispatched = { kind: "applied"; applied: Applied } | { kind: "queued"; machine: string };

export type Dispatch = Tickable & {
  /**
   * Sends an intent to a machine through its queue: behind anything already waiting for it. Resolves with the machine's
   * answer, or queued when the machine is offline or goes offline first.
   */
  send(machine: MachineId, intent: QueuedIntent, meta: { botId: BotId | null; what: string; cardExpiresAt?: string | null }): Promise<Dispatched>;
  /** Sends what waits for the machine, in order, while it stays online. Called when it links. */
  drain(machine: MachineId): void;
  /** The bot was deleted: what waits on its behalf is dropped, with no expiry note, since its chat is gone. */
  forget(botId: BotId): void;
};

export function createDispatch(deps: {
  queue: ReturnType<typeof fileQueue>;
  machine: (id: MachineId) => Machine | null;
  now: () => Date;
  log: (line: string) => void;
  /** A queued intent waited past its TTL and was dropped. */
  expired: (q: Queued) => void;
  /** A queued intent nobody waits on any more (sent before a restart, or after it was told queued) got its answer. */
  applied: (q: Queued, a: Applied) => void;
}): Dispatch {
  const { queue } = deps;
  const waiters = new Map<IntentId, (d: Dispatched) => void>();
  const draining = new Set<MachineId>();

  function settle(q: Queued, d: Dispatched) {
    const waiter = waiters.get(q.intent.intentId);
    waiters.delete(q.intent.intentId);
    if (waiter) waiter(d);
    else if (d.kind === "applied") deps.applied(q, d.applied);
  }

  function expire(now: string) {
    for (const q of due(queue.list(), null, now).expired) {
      queue.remove(q.intent.intentId);
      deps.log(`queue: ${q.what} expired while ${deps.machine(q.machine)?.name ?? q.machine} was offline`);
      settle(q, { kind: "applied", applied: { ok: false, reason: `${q.what} expired while ${deps.machine(q.machine)?.name ?? q.machine} was offline.` } });
      deps.expired(q);
    }
  }

  async function drain(id: MachineId) {
    if (draining.has(id)) return;
    draining.add(id);
    try {
      for (;;) {
        const m = deps.machine(id);
        if (!m?.status().online) break;
        expire(deps.now().toISOString());
        const { next } = due(queue.list(), id, deps.now().toISOString());
        if (!next) break;
        const sent = await m.send(next.intent);
        if (!sent.ok && "undelivered" in sent) {
          deps.log(`queue: ${next.what} waits for ${m.name}: ${sent.reason}`);
          break;
        }
        queue.remove(next.intent.intentId);
        settle(next, { kind: "applied", applied: sent });
      }
    } catch (e) {
      deps.log(`queue: sending to ${id} failed: ${errorText(e)}`);
    } finally {
      draining.delete(id);
    }
    const name = deps.machine(id)?.name ?? id;
    for (const q of queue.list()) if (q.machine === id && waiters.has(q.intent.intentId)) settle(q, { kind: "queued", machine: name });
  }

  return {
    send(id, intent, meta) {
      const m = deps.machine(id);
      if (!m) return Promise.resolve({ kind: "applied", applied: { ok: false, reason: "Unknown machine" } });
      const at = deps.now();
      queue.add({ machine: id, intent, botId: meta.botId, what: meta.what, at: at.toISOString(), expiresAt: expiryOf(intent, at, meta.cardExpiresAt ?? null) });
      if (!m.status().online) return Promise.resolve({ kind: "queued", machine: m.name });
      const answer = new Promise<Dispatched>((resolve) => waiters.set(intent.intentId, resolve));
      void drain(id);
      return answer;
    },
    drain: (id) => void drain(id),
    forget(botId) {
      for (const q of queue.list().filter((e) => e.botId === botId)) {
        queue.remove(q.intent.intentId);
        deps.log(`queue: ${q.what} dropped, since its bot was deleted`);
        const waiter = waiters.get(q.intent.intentId);
        waiters.delete(q.intent.intentId);
        waiter?.({ kind: "applied", applied: { ok: false, reason: "This bot no longer exists." } });
      }
    },
    tick: (now) => expire(now.toISOString()),
    nextDeadline: () => queue.list().reduce<string | null>((min, q) => (min === null || q.expiresAt < min ? q.expiresAt : min), null),
  };
}
