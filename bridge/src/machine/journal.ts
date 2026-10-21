import { join } from "node:path";
import { z } from "zod";
import { appendLine, readLines, writePrivate } from "./files";
import { appliedSchema, eventSchema, type Applied, type Event, type IntentId, type Seq } from "./wire";

/**
 * A runtime's memory of the link: the events it emitted, kept until the home acks them, and the intents it applied, so a
 * replayed intent gets its first answer. The in-process home machine keeps it in memory; a machine keeps it on disk,
 * so a restart replays exactly the events the home has not acked.
 */
export type Journal = {
  /** The newest seq handed out, 0 for none. Never goes back, also after every event is acked. */
  seq(): Seq;
  /** Recorded before anyone hears of the event. */
  append(e: Event): void;
  /** The kept events after seq, oldest first. */
  after(seq: Seq): Event[];
  /** The home handled and saved every event through seq. */
  ack(seq: Seq): void;
  applied(id: IntentId): Applied | undefined;
  remember(id: IntentId, applied: Applied): void;
};

/** How many applied intents are remembered. A replay comes within minutes, never a thousand intents later. */
export const APPLIED_KEPT = 1000;
/** The in-process machine's outbox is read only by tests and snapshots; nothing acks it. */
const MEMORY_OUTBOX = 1000;
/**
 * A machine's outbox while its home is away. Past it the oldest events go, with a log line: the home then sees a gap.
 * Agent events repeat the whole thread, so this is days of a busy machine.
 */
const DISK_OUTBOX = 10_000;
/** The outbox file is rewritten once this many acked events sit at its head. */
const COMPACT_AFTER = 200;

function bounded<K, V>(map: Map<K, V>, max: number) {
  while (map.size > max) map.delete(map.keys().next().value!);
}

export function memoryJournal(): Journal {
  const events: Event[] = [];
  let last: Seq = 0;
  const applied = new Map<IntentId, Applied>();
  return {
    seq: () => last,
    append(e) {
      last = e.seq;
      events.push(e);
      if (events.length > MEMORY_OUTBOX) events.shift();
    },
    after: (seq) => events.filter((e) => e.seq > seq),
    ack(seq) {
      while (events.length > 0 && events[0]!.seq <= seq) events.shift();
    },
    applied: (id) => applied.get(id),
    remember(id, a) {
      applied.set(id, a);
      bounded(applied, APPLIED_KEPT);
    },
  };
}

const ackedLine = z.object({ acked: z.number().int().nonnegative() });
const appliedLine = z.object({ intentId: z.string().min(1) as unknown as z.ZodType<IntentId>, applied: appliedSchema });

/**
 * <dir>/outbox.jsonl: one event a line, and an {"acked": n} line for each ack, which drops every event through n. A
 * rewrite keeps one acked line and the events after it.
 * <dir>/applied.jsonl: one {intentId, applied} a line, rewritten to the newest APPLIED_KEPT when it doubles.
 */
export function fileJournal(dir: string, log: (line: string) => void): Journal {
  const outboxPath = join(dir, "outbox.jsonl");
  const appliedPath = join(dir, "applied.jsonl");

  let acked: Seq = 0;
  let written: Event[] = [];
  for (const line of readLines(outboxPath)) {
    const mark = ackedLine.safeParse(line);
    if (mark.success) {
      acked = Math.max(acked, mark.data.acked);
      continue;
    }
    const e = eventSchema.safeParse(line);
    if (e.success && e.data.seq > (written.at(-1)?.seq ?? 0)) written.push(e.data);
  }
  const events = written.filter((e) => e.seq > acked);
  let last: Seq = Math.max(acked, written.at(-1)?.seq ?? 0);
  // Lines the next rewrite drops: acked events and acked marks.
  let stale = written.length - events.length;
  written = [];

  const applied = new Map<IntentId, Applied>();
  let appliedLines = 0;
  for (const line of readLines(appliedPath)) {
    const a = appliedLine.safeParse(line);
    if (!a.success) continue;
    applied.set(a.data.intentId, a.data.applied);
    appliedLines += 1;
  }
  bounded(applied, APPLIED_KEPT);

  function rewriteOutbox() {
    writePrivate(outboxPath, [JSON.stringify({ acked }), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
    stale = 0;
  }

  return {
    seq: () => last,
    append(e) {
      appendLine(outboxPath, JSON.stringify(e));
      last = e.seq;
      events.push(e);
      if (events.length > DISK_OUTBOX) {
        const dropped = events.shift()!;
        acked = dropped.seq;
        appendLine(outboxPath, JSON.stringify({ acked }));
        stale += 2;
        log(`machine: the outbox is full, so event ${dropped.seq} (${dropped.kind}) was dropped before the home acked it`);
      }
      if (stale >= COMPACT_AFTER) rewriteOutbox();
    },
    after: (seq) => events.filter((e) => e.seq > seq),
    ack(seq) {
      if (seq <= acked) return;
      while (events.length > 0 && events[0]!.seq <= seq) {
        events.shift();
        stale += 1;
      }
      acked = Math.min(seq, last);
      if (stale >= COMPACT_AFTER) return rewriteOutbox();
      appendLine(outboxPath, JSON.stringify({ acked }));
      stale += 1;
    },
    applied: (id) => applied.get(id),
    remember(id, a) {
      applied.set(id, a);
      bounded(applied, APPLIED_KEPT);
      appendLine(appliedPath, JSON.stringify({ intentId: id, applied: a }));
      appliedLines += 1;
      if (appliedLines > 2 * APPLIED_KEPT) {
        writePrivate(appliedPath, [...applied].map(([intentId, applied]) => JSON.stringify({ intentId, applied })).join("\n") + "\n");
        appliedLines = applied.size;
      }
    },
  };
}
