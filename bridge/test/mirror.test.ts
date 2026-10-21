import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirror, reduce, type MirrorState } from "../src/machine/mirror";
import type { Event, EventBody, MachineId } from "../src/machine/wire";
import type { Agent, AgentId, BotId, Message, MessageId } from "../src/protocol";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAC = "m_mac" as MachineId;
const PI = "m_pi" as MachineId;
const B1 = "b1" as BotId;
const at = "2026-10-21T12:00:00.000Z";
let seq = 0;
const ev = (body: EventBody): Event => ({ seq: ++seq, at, ...body });
const agent = (id: string, status: Agent["status"] = "working"): Agent => ({
  id: id as AgentId,
  botId: B1,
  title: "Fix",
  where: "mac",
  projectName: "shop",
  status,
  url: null,
  createdAt: at,
  updatedAt: at,
  evidence: null,
  worktree: null,
});
const card = (id: string, answer: "once" | null = null): Message => ({
  kind: "permission",
  id: id as MessageId,
  at,
  from: { kind: "agent", id: "a1" as AgentId, title: "Fix" },
  tool: "Bash",
  label: "Push to main",
  detail: "git push origin main",
  always: "",
  answer,
  expiresAt: "2026-10-21T14:00:00.000Z",
});

test("agent events keep each agent's latest record and thread, per machine", () => {
  const state: MirrorState = { machines: {} };
  reduce(state, MAC, ev({ kind: "agent", agent: agent("a1"), messages: [] }));
  const change = reduce(state, MAC, ev({ kind: "agent", agent: agent("a1", "waiting"), messages: [{ id: "m1" as MessageId, at, from: "agent", text: "Done." }] }));
  expect(change?.agents).toEqual([{ machine: MAC, agent: agent("a1", "waiting"), messages: [{ id: "m1" as MessageId, at, from: "agent", text: "Done." }] }]);
  expect(Object.keys(state.machines[MAC]!.agents)).toEqual(["a1"]);
});

test("a card event opens the card under its machine, and the same card answered closes it", () => {
  const state: MirrorState = { machines: {} };
  expect(reduce(state, MAC, ev({ kind: "card", botId: B1, message: card("c1") }))?.cards).toEqual([{ botId: B1, message: card("c1") as never }]);
  expect(state.machines[MAC]!.cards as Record<string, BotId>).toEqual({ c1: B1 });
  reduce(state, MAC, ev({ kind: "card", botId: B1, message: card("c1", "once") }));
  expect(state.machines[MAC]!.cards).toEqual({});
});

test("a snapshot replaces the machine's agents and open cards, and names the cards it no longer holds", () => {
  const state: MirrorState = { machines: {} };
  reduce(state, MAC, ev({ kind: "agent", agent: agent("gone"), messages: [] }));
  reduce(state, MAC, ev({ kind: "card", botId: B1, message: card("c1") }));
  reduce(state, PI, ev({ kind: "card", botId: B1, message: card("c9") }));
  const change = reduce(state, MAC, ev({ kind: "snapshot", agents: [{ agent: agent("a2"), messages: [] }], openCards: [{ botId: B1, message: card("c2") }] }));
  expect(change).toEqual({ agents: [{ machine: MAC, agent: agent("a2"), messages: [] }], cards: [{ botId: B1, message: card("c2") as never }], closed: [{ botId: B1, cardId: "c1" as MessageId }] });
  expect(Object.keys(state.machines[MAC]!.agents)).toEqual(["a2"]);
  expect(state.machines[PI]!.cards as Record<string, BotId>).toEqual({ c9: B1 });
});

test("events about neither agents nor cards change nothing", () => {
  const state: MirrorState = { machines: {} };
  expect(reduce(state, MAC, ev({ kind: "report", agentId: "a1" as AgentId, botId: B1, text: "x", by: { kind: "user" } }))).toBeNull();
  expect(reduce(state, MAC, ev({ kind: "card", botId: B1, message: { kind: "note", id: "n1" as MessageId, at, text: "x", refs: [] } }))).toBeNull();
});

test("the mirror is saved 0600 and read back; a file that does not parse starts empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-mirror-"));
  dirs.push(dir);
  const path = join(dir, "machine", "mirror.json");
  const owner = { agent: (id: AgentId) => (id === "a1" ? MAC : null), card: (id: MessageId) => (id === "c1" ? MAC : null) };
  const mirror = createMirror({ path, log: () => {}, owner });
  mirror.apply(MAC, ev({ kind: "agent", agent: agent("a1"), messages: [] }));
  mirror.apply(MAC, ev({ kind: "card", botId: B1, message: card("c1") }));
  expect(statSync(path).mode & 0o777).toBe(0o600);

  const again = createMirror({ path, log: () => {}, owner });
  expect(again.agent("a1" as AgentId)).toMatchObject({ machine: MAC, agent: { id: "a1" } });
  expect(again.cardOwner("c1" as MessageId)).toEqual({ machine: MAC, botId: B1 });
  expect(again.cardOwner("c2" as MessageId)).toBeNull();
  expect(again.openCards(B1)).toBe(1);
  expect(again.agents().map((a) => a.agent.id)).toEqual(["a1" as AgentId]);

  writeFileSync(path, "{nope");
  const logs: string[] = [];
  expect(createMirror({ path, log: (l) => logs.push(l), owner }).agents()).toEqual([]);
  expect(logs[0]).toContain("starts empty");
});

test("a snapshot's shortened thread keeps the older messages the mirror already had", () => {
  const state: MirrorState = { machines: {} };
  const m = (i: number) => ({ id: `m${i}` as MessageId, at: `2026-10-21T12:00:${String(i).padStart(2, "0")}.000Z`, from: "agent" as const, text: `${i}` });
  reduce(state, MAC, ev({ kind: "agent", agent: agent("a1"), messages: [m(1), m(2), m(3)] }));
  const change = reduce(state, MAC, ev({ kind: "snapshot", agents: [{ agent: agent("a1", "waiting"), messages: [m(3), m(4)] }], openCards: [] }));
  expect(change?.agents[0]!.messages.map((x) => x.text)).toEqual(["1", "2", "3", "4"]);
  expect(state.machines[MAC]!.agents["a1" as AgentId]!.messages.map((x) => x.text)).toEqual(["1", "2", "3", "4"]);
});

test("an agent or card is found only in the slice of the machine it was placed on, whatever another machine's slice holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-mirror-"));
  dirs.push(dir);
  const mirror = createMirror({ path: join(dir, "mirror.json"), log: () => {}, owner: { agent: () => MAC, card: () => MAC } });
  mirror.apply(PI, ev({ kind: "agent", agent: agent("a1", "failed"), messages: [] }));
  mirror.apply(PI, ev({ kind: "card", botId: B1, message: card("c1") }));
  expect(mirror.agent("a1" as AgentId)).toBeNull();
  expect(mirror.cardOwner("c1" as MessageId)).toBeNull();
  mirror.apply(MAC, ev({ kind: "agent", agent: agent("a1"), messages: [] }));
  expect(mirror.agent("a1" as AgentId)).toMatchObject({ machine: MAC, agent: { status: "working" } });
});
