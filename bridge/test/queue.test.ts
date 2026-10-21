import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, Sent } from "../src/machine/machines";
import { createDispatch, due, expiryOf, fileQueue, type Queued, type QueuedIntent } from "../src/machine/queue";
import { newIntentId, type Applied, type MachineId } from "../src/machine/wire";
import type { AgentId, BotId, MessageId } from "../src/protocol";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAC = "m_mac" as MachineId;
const PI = "m_pi" as MachineId;
const B1 = "b1" as BotId;
const A1 = "a1" as AgentId;
const T0 = new Date("2026-10-21T12:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const stop = (): QueuedIntent => ({ kind: "agent.stop", intentId: newIntentId(), agentId: A1 });
const message = (text: string): QueuedIntent => ({ kind: "agent.message", intentId: newIntentId(), agentId: A1, text, initiator: { kind: "user" } });
const answer = (): QueuedIntent => ({ kind: "card.answer", intentId: newIntentId(), botId: B1, cardId: "c1" as MessageId, reply: { kind: "permission", choice: "once" }, signed: null });

test.each<[string, QueuedIntent, string | null, string]>([
  ["a start waits 24 h", { ...message("x"), kind: "agent.start" } as unknown as QueuedIntent, null, plus(DAY)],
  ["a message waits 24 h", message("x"), null, plus(DAY)],
  ["a stop waits 10 min", stop(), null, plus(10 * MIN)],
  ["a worktree removal waits 24 h", { kind: "agent.removeWorktree", intentId: newIntentId(), agentId: A1 }, null, plus(DAY)],
  ["a card answer waits until its card expires", answer(), plus(2 * 60 * MIN), plus(2 * 60 * MIN)],
])("%s", (_, intent, cardExpiresAt, expiresAt) => {
  expect(expiryOf(intent, T0, cardExpiresAt)).toBe(expiresAt);
});

const entry = (machine: MachineId, intent: QueuedIntent, expiresAt: string): Queued => ({ machine, intent, botId: B1, what: intent.kind, at: T0.toISOString(), expiresAt });

test("due: the machine's oldest live intent is next; anything past its TTL, on any machine, is expired", () => {
  const old = entry(MAC, stop(), plus(MIN));
  const first = entry(MAC, message("first"), plus(DAY));
  const other = entry(PI, message("pi"), plus(DAY));
  const second = entry(MAC, message("second"), plus(DAY));
  const queue = [old, other, first, second];
  expect(due(queue, MAC, T0.toISOString())).toEqual({ next: old, expired: [] });
  expect(due(queue, MAC, plus(2 * MIN))).toEqual({ next: first, expired: [old] });
  expect(due(queue, PI, plus(2 * MIN)).next).toBe(other);
  expect(due(queue, MAC, plus(DAY)).next).toBeNull();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-queue-"));
  dirs.push(dir);
  const path = join(dir, "machine", "queue.json");
  let online = false;
  let now = T0;
  const sent: string[] = [];
  /** Each send waits for the test to answer it. */
  const answers: ((s: Sent) => void)[] = [];
  const mac: Machine = {
    id: MAC,
    name: "MacBook",
    profile: () => null,
    status: () => ({ online, since: null }),
    send: (intent) => {
      sent.push(intent.kind === "agent.message" ? intent.text : intent.kind);
      return new Promise<Sent>((resolve) => answers.push(resolve));
    },
  };
  const expired: Queued[] = [];
  const late: [Queued, Applied][] = [];
  const open = () =>
    createDispatch({
      queue: fileQueue(path, () => {}),
      machine: (id) => (id === MAC ? mac : null),
      now: () => now,
      log: () => {},
      expired: (q) => expired.push(q),
      applied: (q, a) => late.push([q, a]),
      retry: { firstMs: 5, maxMs: 10 },
    });
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  async function reply(s: Sent) {
    await tick();
    answers.shift()!(s);
    await tick();
  }
  return { path, open, sent, expired, late, reply, tick, set: (to: boolean) => (online = to), at: (d: Date) => (now = d) };
}

const meta = (what: string) => ({ botId: B1, what });

test("an online machine gets the intent at once and the caller its answer", async () => {
  const h = harness();
  h.set(true);
  const d = h.open();
  const answered = d.send(MAC, message("hi"), meta("A message"));
  await h.reply({ ok: true, reply: "Sent." });
  expect(await answered).toEqual({ kind: "applied", applied: { ok: true, reply: "Sent." } });
  expect(h.sent).toEqual(["hi"]);
});

test("an offline machine's intents wait on disk, survive a home restart, and go in order when it links", async () => {
  const h = harness();
  const d = h.open();
  expect(await d.send(MAC, message("first"), meta("A message"))).toEqual({ kind: "queued", machine: "MacBook" });
  await d.send(MAC, message("second"), meta("A message"));
  expect(statSync(h.path).mode & 0o777).toBe(0o600);

  const restarted = h.open();
  h.set(true);
  restarted.drain(MAC);
  await h.reply({ ok: true, reply: "Sent." });
  await h.reply({ ok: false, reason: "Unknown agent" });
  expect(h.sent).toEqual(["first", "second"]);
  expect(h.late.map(([q, a]) => [q.intent.kind, a.ok])).toEqual([
    ["agent.message", true],
    ["agent.message", false],
  ]);
  expect(h.open().nextDeadline()).toBeNull();
});

test("a machine that goes offline before applying keeps the intent queued, and it goes again under the same id", async () => {
  const h = harness();
  h.set(true);
  const d = h.open();
  const intent = message("hi");
  const answered = d.send(MAC, intent, meta("A message"));
  h.set(false);
  await h.reply({ ok: false, reason: "MacBook went offline", undelivered: true });
  expect(await answered).toEqual({ kind: "queued", machine: "MacBook" });

  h.set(true);
  d.drain(MAC);
  await h.reply({ ok: true });
  expect(h.sent).toEqual(["hi", "hi"]);
  expect(h.late).toHaveLength(1);
  expect(h.late[0]![0].intent.intentId).toBe(intent.intentId);
});

test("an intent past its TTL is dropped at the tick with its expiry, and never sent", async () => {
  const h = harness();
  const d = h.open();
  await d.send(MAC, stop(), meta("Stopping Fix"));
  await d.send(MAC, message("later"), meta("A message"));
  expect(d.nextDeadline()).toBe(plus(10 * MIN));
  h.at(new Date(plus(11 * MIN)));
  d.tick(new Date(plus(11 * MIN)));
  expect(h.expired.map((q) => q.what)).toEqual(["Stopping Fix"]);

  h.set(true);
  d.drain(MAC);
  await h.reply({ ok: true });
  expect(h.sent).toEqual(["later"]);
});

test("forgetting a bot drops what waits on its behalf, with no expiry, and leaves the rest", async () => {
  const h = harness();
  const d = h.open();
  await d.send(MAC, message("for b1"), meta("A message"));
  await d.send(MAC, stop(), { botId: null, what: "Stopping Fix" });
  d.forget(B1);
  expect(h.open().nextDeadline()).toBe(plus(10 * MIN));

  h.at(new Date(plus(DAY + MIN)));
  d.tick(new Date(plus(DAY + MIN)));
  expect(h.expired.map((q) => q.what)).toEqual(["Stopping Fix"]);
  h.set(true);
  d.drain(MAC);
  await h.tick();
  expect(h.sent).toEqual([]);
});

test.each([
  ["its link was replaced mid-send", "MacBook went offline"],
  ["it did not apply in time", "MacBook did not answer"],
])("an intent that did not reach a machine still online because %s goes again on its own, with no link change", async (_, reason) => {
  const h = harness();
  h.set(true);
  const d = h.open();
  const intent = message("hi");
  const answered = d.send(MAC, intent, meta("A message"));
  d.drain(MAC);
  await h.reply({ ok: false, reason, undelivered: true });
  expect(await answered).toEqual({ kind: "queued", machine: "MacBook" });
  for (let i = 0; i < 50 && h.sent.length < 2; i++) await Bun.sleep(5);
  expect(h.sent).toEqual(["hi", "hi"]);
  await h.reply({ ok: true });
  expect(h.late.map(([q, a]) => [q.intent.intentId, a.ok])).toEqual([[intent.intentId, true]]);
  expect(d.nextDeadline()).toBeNull();
});
