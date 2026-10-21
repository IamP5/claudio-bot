import { testProfile } from "./hub-kit";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomes } from "../src/home";
import { createHub } from "../src/hub";
import type { UsageRow } from "../src/ledger";
import type { AgentId, BotId, ServerMessage } from "../src/protocol";
import { emptySession, emptyWorld, newBot, type AgentRecord } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const at = "2026-10-17T12:00:00.000Z";
const B1 = "b_eng" as BotId;
const MAC = "a_mac" as AgentId;
const CLOUD = "a_cloud" as AgentId;

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function row(actor: UsageRow["actor"], deltaUsd: number, day = today()): UsageRow {
  return { at, actor, botId: B1, sessionId: `s_${actor}_${day}`, initiator: { kind: "user" }, cumulativeUsd: deltaUsd, deltaUsd, day, fresh: true };
}

const agentOf = (id: AgentId, where: "mac" | "cloud"): AgentRecord => ({
  agent: { id, botId: B1, title: "Fix", where, projectName: "app", status: "waiting", url: null, createdAt: at, updatedAt: at, evidence: null, worktree: null },
  cwd: "/code/app",
  messages: [],
  session: emptySession(),
  cloudSession: null,
  budgetUsd: null,
  startedBy: { kind: "user" },
});

/** A hub over a bridge home whose usage folder already holds `rows`, the way a restart finds it. */
function hubWith(rows: UsageRow[]) {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-spend-"));
  roots.push(root);
  mkdirSync(join(root, "usage"));
  writeFileSync(join(root, "usage", `${today().slice(0, 7)}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const world = emptyWorld();
  world.bots.set(B1, newBot({ id: B1, name: "eng", avatar: { shape: "circle", color: "white" }, at }));
  world.agents.set(MAC, agentOf(MAC, "mac"));
  world.agents.set(CLOUD, agentOf(CLOUD, "cloud"));
  const frames: ServerMessage[] = [];
  const hub = createHub({
    profile: testProfile(root),
    userName: "Alex",
    world,
    homes: createHomes(root),
    model: undefined,
    scan: async () => [],
    broadcast: (m) => frames.push(m),
    signal: () => {},
    webhookPort: null,
    persist: () => {},
    log: () => {},
    push: { notify: () => true, tick() {}, nextDeadline: () => null },
    claude: { query: (() => { throw new Error("no queries in spend tests"); }) as never, executable: () => null },
  });
  return { hub, frames };
}

const NO_RING = { epoch: "", seq: 0, resumed: false };

test("the bot frame carries today's spend by the bot and its agents, and no cap by default", () => {
  const { hub } = hubWith([row(`bot:${B1}`, 1.5), row(`agent:${MAC}`, 2), row(`bot:${B1}`, 4, "2026-01-01")]);
  const hello = hub.hello(NO_RING);
  expect(hello.type === "hello" && hello.bots[0]).toMatchObject({ dailyCapUsd: null, spentTodayUsd: 3.5, capUsd: null });
});

test("setting a daily cap from the phone sends a bot frame with the new cap in force, and clearing it removes the cap", async () => {
  const { hub, frames } = hubWith([row(`bot:${B1}`, 1.5)]);
  expect(await hub.handle({ type: "update_bot", botId: B1, patch: { dailyCapUsd: 2 } })).toEqual([]);
  expect(frames.findLast((f) => f.type === "bot")).toMatchObject({ bot: { dailyCapUsd: 2, spentTodayUsd: 1.5, capUsd: 2 } });
  expect(await hub.handle({ type: "update_bot", botId: B1, patch: { dailyCapUsd: null } })).toEqual([]);
  expect(frames.findLast((f) => f.type === "bot")).toMatchObject({ bot: { dailyCapUsd: null, spentTodayUsd: 1.5, capUsd: null } });
});

test("agent frames carry a mac agent's lifetime spend and no budget by default, and null spend for a cloud agent", async () => {
  const { hub } = hubWith([row(`agent:${MAC}`, 0.5, "2026-01-01"), row(`agent:${MAC}`, 0.25)]);
  expect(await hub.handle({ type: "agent", agentId: MAC })).toMatchObject([{ agent: { spentUsd: 0.75, budgetUsd: null } }]);
  const [details] = await hub.handle({ type: "details", botId: B1 });
  expect(details?.type === "details" && details.agents.map((a) => [a.id, a.spentUsd, a.budgetUsd])).toEqual(
    expect.arrayContaining([
      [MAC, 0.75, null],
      [CLOUD, null, null],
    ]),
  );
});
