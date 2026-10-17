import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotId, MessageId, RoutineId, RunId } from "../src/protocol";
import { createSaver, flushNow, loadWorld, StateFileError } from "../src/store";
import { emptySession, newBot, type Signature } from "../src/world";

const homes: string[] = [];
const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), "claudiobot-store-"));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const at = "2026-10-15T09:00:00.000Z";

// Shaped exactly like a protocol-2 state.json written by the old saver: records as world.ts v2 declared them.
const V2 = {
  version: 2,
  bots: [
    {
      id: "b_claudio",
      name: "Claudio Bot",
      title: "General assistant",
      avatar: { shape: "circle", color: "white" },
      pinned: true,
      hidden: false,
      createdAt: "2026-10-01T08:00:00.000Z",
      routines: [
        { id: "r_digest", name: "morning-digest", schedule: "57 7 * * 1-5", describe: "Weekdays at 7:57 AM", prompt: "Post today's digest.", enabled: true, lastRunAt: "2026-10-15T07:57:00.050Z" },
        { id: "r_health", name: "healthcheck", schedule: "0 * * * *", describe: "Every hour at :00", prompt: "Check the site.", enabled: false, lastRunAt: null },
      ],
      messages: [
        { kind: "user", id: "m_1", at, text: "Merge the stack when green", attachments: [{ name: "plan.png", mime: "image/png", path: "inbox/plan.png" }] },
        { kind: "bot", id: "m_2", at, text: "On it." },
        { kind: "exchange", id: "m_3", at, peer: { kind: "agent", id: "a_mac", title: "Fix login" }, sent: 1, received: 2 },
        { kind: "note", id: "m_4", at, text: "Created routine {0}", refs: [{ kind: "routine", id: "r_digest", name: "morning-digest" }] },
        { kind: "question", id: "m_5", at, question: "Merge #142?", options: ["Yes", "No"], answer: 0 },
        { kind: "question", id: "m_6", at, question: "Add the secret?", options: ["Yes", "Not yet"], answer: "dismissed" },
        { kind: "question", id: "m_7", at, question: "Which first?", options: ["Login", "Search"], answer: null },
      ],
      unread: 2,
      sessionId: "5f0c1d2e-0000-4000-8000-000000000001",
    },
    {
      id: "b_news",
      name: "news digest",
      title: null,
      avatar: { shape: "pentagon", color: "teal" },
      pinned: false,
      hidden: true,
      createdAt: "2026-10-02T08:00:00.000Z",
      routines: [],
      messages: [],
      unread: 0,
      sessionId: null,
    },
  ],
  agents: [
    {
      agent: { id: "a_mac", botId: "b_claudio", title: "Fix login", where: "mac", projectName: "web", status: "waiting", url: null, createdAt: at, updatedAt: at },
      cwd: "/Users/alex/code/web",
      messages: [
        { id: "m_a1", at, from: "bot", text: "Fix the login bug." },
        { id: "m_a2", at, from: "agent", text: "PR #142 is open." },
      ],
      sessionId: "5f0c1d2e-0000-4000-8000-000000000002",
    },
    {
      agent: { id: "a_busy", botId: "b_claudio", title: "Add search", where: "mac", projectName: "web", status: "working", url: null, createdAt: at, updatedAt: at },
      cwd: "/Users/alex/code/web",
      messages: [{ id: "m_a3", at, from: "bot", text: "Add search." }],
      sessionId: null,
    },
    {
      agent: { id: "a_cloud", botId: "b_news", title: "Port docs", where: "cloud", projectName: "docs", status: "in_cloud", url: "https://claude.ai/code/session_abc", createdAt: at, updatedAt: at },
      cwd: "/Users/alex/code/docs",
      messages: [{ id: "m_a4", at, from: "bot", text: "Port the docs." }],
      sessionId: "session_abc",
    },
  ],
};

const writeState = (home: string, body: string) => writeFileSync(join(home, "state.json"), body);
const readState = (home: string) => readFileSync(join(home, "state.json"), "utf8");

test("a v2 state file is backed up byte for byte, then upgraded in place to v3", () => {
  const home = freshHome();
  const original = JSON.stringify(V2, null, 2);
  writeState(home, original);

  const { world, firstRun } = loadWorld(home);

  expect(firstRun).toBe(false);
  expect(readFileSync(join(home, "state.v2.json.bak"), "utf8")).toBe(original);
  expect(JSON.parse(readState(home)).version).toBe(3);

  const claudio = world.bots.get("b_claudio" as BotId)!;
  expect(claudio).toMatchObject({ name: "Claudio Bot", title: "General assistant", pinned: true, unread: 2, dailyCapUsd: null, rules: [] });
  expect(claudio.session).toEqual(emptySession("5f0c1d2e-0000-4000-8000-000000000001"));
  expect(claudio.routines).toEqual([
    {
      id: "r_digest" as RoutineId, name: "morning-digest", trigger: { kind: "cron", schedule: "57 7 * * 1-5" }, prompt: "Post today's digest.", enabled: true,
      nextRunAt: null, runs: [{ id: "run_v2_r_digest" as RunId, at: "2026-10-15T07:57:00.050Z", status: "ok", late: false, manual: false, note: null }], failStreak: 0,
    },
    { id: "r_health" as RoutineId, name: "healthcheck", trigger: { kind: "cron", schedule: "0 * * * *" }, prompt: "Check the site.", enabled: false, nextRunAt: null, runs: [], failStreak: 0 },
  ]);
  expect(claudio.messages.map((m) => m.kind)).toEqual(["user", "bot", "exchange", "note", "question", "question", "question"]);
  expect(claudio.messages.filter((m) => m.kind === "question").map((m) => [m.answer, m.expiresAt])).toEqual([[0, null], ["dismissed", null], [null, null]]);
  expect(claudio.messages[0]).toEqual(V2.bots[0]!.messages[0] as never);
  expect(world.bots.get("b_news" as BotId)!.session.id).toBeNull();

  const mac = world.agents.get("a_mac" as never)!;
  expect(mac).toMatchObject({ cwd: "/Users/alex/code/web", cloudSession: null, budgetUsd: null });
  expect(mac.session.id).toBe("5f0c1d2e-0000-4000-8000-000000000002");
  expect(mac.messages).toHaveLength(2);
  expect(world.agents.get("a_busy" as never)!.agent.status).toBe("working");
  const cloud = world.agents.get("a_cloud" as never)!;
  expect(cloud.cloudSession).toBe("session_abc");
  expect(cloud.session.id).toBeNull();

  expect(world.gate).toEqual({ open: [], grants: [], daily: [] });
  expect(world.devices).toEqual([]);
  expect(world.push).toEqual({ sent: [] });
  expect(world.account).toEqual({ parkedUntil: null });
});

test("loading the upgraded file again changes nothing", () => {
  const home = freshHome();
  writeState(home, JSON.stringify(V2));
  const first = loadWorld(home);
  const upgraded = readState(home);
  const backup = readFileSync(join(home, "state.v2.json.bak"), "utf8");

  const second = loadWorld(home);

  expect(second.firstRun).toBe(false);
  expect([...second.world.bots.values()]).toEqual([...first.world.bots.values()]);
  expect([...second.world.agents.values()]).toEqual([...first.world.agents.values()]);
  expect(readState(home)).toBe(upgraded);
  expect(readFileSync(join(home, "state.v2.json.bak"), "utf8")).toBe(backup);
});

test("a crash between the backup and the upgrade converges: the backup is rewritten from the v2 file that is there", () => {
  const home = freshHome();
  const current = JSON.stringify(V2);
  writeState(home, current);
  writeFileSync(join(home, "state.v2.json.bak"), "{\"version\":2,\"bots\":[],\"agents\":[]}");

  loadWorld(home);

  expect(readFileSync(join(home, "state.v2.json.bak"), "utf8")).toBe(current);
  expect(JSON.parse(readState(home)).version).toBe(3);
});

test.each([
  ["unreadable JSON", '{"version": 2, "bots": ['],
  ["a version from a newer bridge", JSON.stringify({ ...V2, version: 4 })],
  ["no version", JSON.stringify({ bots: [], agents: [] })],
  ["a non-object", "[]"],
  ["a v2 file with no bots array", JSON.stringify({ version: 2, agents: [] })],
  ["a v3 file with no gate", JSON.stringify({ version: 3, bots: [], agents: [], devices: [], push: { sent: [] }, account: { parkedUntil: null } })],
])("refuses to start on %s and leaves every file as it was", (_, body) => {
  const home = freshHome();
  writeState(home, body);

  expect(() => loadWorld(home)).toThrow(StateFileError);
  expect(readState(home)).toBe(body);
  expect(readdirSync(home)).toEqual(["state.json"]);
});

test("the refusal names the file and says it was not changed", () => {
  const home = freshHome();
  writeState(home, JSON.stringify({ version: 9 }));
  expect(() => loadWorld(home)).toThrow(/state\.json has version 9.*not changed/);
});

test("a v1 task file is kept as a backup and the bridge starts fresh, as before", () => {
  const home = freshHome();
  const v1 = JSON.stringify({ version: 1, tasks: [{ id: "t1", title: "Old task" }] });
  writeState(home, v1);

  const { world, firstRun } = loadWorld(home);

  expect(firstRun).toBe(true);
  expect(world.bots.size).toBe(0);
  expect(readFileSync(join(home, "state.v1.json.bak"), "utf8")).toBe(v1);
});

test("no state file is a first run that writes nothing", () => {
  const home = freshHome();
  expect(loadWorld(home).firstRun).toBe(true);
  expect(readdirSync(home)).toEqual([]);
});

test("flushNow writes a private v3 file that loads back to the same world", () => {
  const home = freshHome();
  const { world } = loadWorld(home);
  const bot = newBot({ id: "b_1" as BotId, name: "engineer", avatar: { shape: "hexagon", color: "orange" }, at });
  world.bots.set(bot.id, { ...bot, rules: [{ decision: "deny", signature: "Bash:git push --force" as Signature, label: "Force-push", cardId: "m_9" as MessageId, at }] });
  Object.assign(world.account, { parkedUntil: "2026-10-15T12:00:30.000Z" });

  flushNow(world, home);

  expect(statSync(join(home, "state.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(home)).toEqual(["state.json"]);
  const again = loadWorld(home).world;
  expect([...again.bots.values()]).toEqual([...world.bots.values()]);
  expect(again.account).toEqual({ parkedUntil: "2026-10-15T12:00:30.000Z" });
});

test("the saver debounces, and \"now\" writes before it returns", async () => {
  const home = freshHome();
  const { world } = loadWorld(home);
  const saver = createSaver(world, home, 20);

  saver.schedule();
  expect(existsSync(join(home, "state.json"))).toBe(false);
  await Bun.sleep(60);
  expect(existsSync(join(home, "state.json"))).toBe(true);

  const bot = newBot({ id: "b_2" as BotId, name: "news", avatar: { shape: "pentagon", color: "teal" }, at });
  world.bots.set(bot.id, bot);
  saver.schedule("now");
  expect(JSON.parse(readState(home)).bots.map((b: { id: string }) => b.id)).toEqual(["b_2"]);
});
