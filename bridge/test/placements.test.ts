import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlacements, type AdmitContext } from "../src/machine/placements";
import type { Event, EventBody, MachineId } from "../src/machine/wire";
import type { Agent, AgentId, BotId, Message, MessageId } from "../src/protocol";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fileIn = () => {
  const d = mkdtempSync(join(tmpdir(), "claudiobot-placements-"));
  dirs.push(d);
  return join(d, "machine", "placements.json");
};

const MAC = "m_mac" as MachineId;
const PI = "m_pi" as MachineId;
const B1 = "b1" as BotId;
const A1 = "a1" as AgentId;
const A2 = "a2" as AgentId;
const at = "2026-10-21T12:00:00.000Z";
const ev = (body: EventBody): Event => ({ seq: 1, at, ...body });
const ctx: AdmitContext = { chatHas: () => false, sessionOwner: () => null, days: () => ({ today: "2026-10-21", yesterday: "2026-10-20" }) };
const agent = (id: AgentId, botId: BotId = B1): Agent => ({
  id,
  botId,
  title: "Fix",
  where: "mac",
  projectName: "shop",
  status: "working",
  url: null,
  createdAt: at,
  updatedAt: at,
  evidence: null,
  worktree: null,
});
const card = (id: string, from: AgentId | null = A1): Message => ({
  kind: "permission",
  id: id as MessageId,
  at,
  from: from && { kind: "agent", id: from, title: "Fix" },
  tool: "Bash",
  label: "Push",
  detail: "git push origin main",
  always: "",
  answer: null,
  expiresAt: at,
});

test("a snapshot keeps only the agents and open cards the home placed on that machine", () => {
  const p = createPlacements({ path: fileIn(), log: () => {} });
  p.place(A1, { machine: MAC, botId: B1, by: { kind: "user" } });
  p.place(A2, { machine: PI, botId: B1, by: { kind: "user" } });
  const admitted = p.admit(
    MAC,
    ev({
      kind: "snapshot",
      agents: [
        { agent: agent(A1), messages: [] },
        { agent: agent(A2), messages: [] },
      ],
      openCards: [
        { botId: B1, message: card("c1") },
        { botId: B1, message: card("c2", A2) },
        { botId: "b_other" as BotId, message: card("c3") },
      ],
    }),
    ctx,
  );
  expect(admitted.ok && admitted.event.kind === "snapshot" && [admitted.event.agents.map((a): string => a.agent.id), admitted.event.openCards.map((c): string => c.message.id)]).toEqual([[A1], ["c1"]]);
});

test("a card id is its first machine's for good: another machine's card or reminder under it is dropped, also after a restart", () => {
  const path = fileIn();
  const p = createPlacements({ path, log: () => {} });
  p.place(A1, { machine: MAC, botId: B1, by: { kind: "user" } });
  p.place(A2, { machine: PI, botId: B1, by: { kind: "user" } });
  expect(p.admit(MAC, ev({ kind: "card", botId: B1, message: card("c1") }), ctx).ok).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const again = createPlacements({ path, log: () => {} });
  expect(again.cardOn("c1" as MessageId)).toBe(MAC);
  expect(again.admit(PI, ev({ kind: "card", botId: B1, message: card("c1", A2) }), ctx)).toEqual({ ok: false, reason: "card c1 is another machine's" });
  expect(again.admit(PI, ev({ kind: "reminder", botId: B1, cardId: "c1" as MessageId }), ctx).ok).toBe(false);
  expect(again.admit(MAC, ev({ kind: "reminder", botId: B1, cardId: "c1" as MessageId }), ctx).ok).toBe(true);
});

test("a usage row is the machine's own when it is not an agent's: a bot row and a phone session's row are dropped", () => {
  const p = createPlacements({ path: fileIn(), log: () => {} });
  p.place(A1, { machine: MAC, botId: B1, by: { kind: "user" } });
  const row = { at, actor: `agent:${A1}` as const, botId: B1, sessionId: "s1", initiator: { kind: "user" as const }, cumulativeUsd: 1, deltaUsd: 1, day: "2020-01-01" };
  const kept = p.admit(MAC, ev({ kind: "usage", row }), ctx);
  expect(kept.ok && kept.event.kind === "usage" && kept.event.row).toMatchObject({ sessionId: `${MAC}/s1`, day: "2026-10-20" });
  expect(p.admit(MAC, ev({ kind: "usage", row: { ...row, actor: `bot:${B1}` } }), ctx).ok).toBe(false);
  expect(p.admit(MAC, ev({ kind: "usage", row: { ...row, actor: "own:s1", botId: null } }), ctx).ok).toBe(false);
});

test("a placements file that cannot be read is refused with a log line, and nothing is believed", () => {
  const path = fileIn();
  createPlacements({ path, log: () => {} }).place(A1, { machine: MAC, botId: B1, by: { kind: "user" } });
  writeFileSync(path, "{nope");
  const logs: string[] = [];
  const p = createPlacements({ path, log: (l) => logs.push(l) });
  expect(p.of(A1)).toBeNull();
  expect(logs[0]).toContain("no machine's agent is heard");
});
