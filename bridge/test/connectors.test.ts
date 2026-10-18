import { afterEach, expect, test } from "bun:test";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorSettings, createConnectors, type McpControl } from "../src/connectors";
import type { BotId } from "../src/protocol";
import { flushNow, loadWorld } from "../src/store";
import { emptyWorld, newBot, own } from "../src/world";

const B = "b_1" as BotId;

const STATUSES: McpServerStatus[] = [
  { name: "claudio", status: "connected", source: "sdk", config: { type: "sdk", name: "claudio" } as never },
  { name: "chrome-devtools", status: "connected", source: "user", config: { type: "stdio", command: "npx", args: ["secret-arg"], env: { TOKEN: "t0k" } } as never },
  { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai" },
  { name: "linear", status: "pending", source: "project" },
  { name: "broken", status: "failed", source: "user", error: "spawn ENOENT /usr/local/bin/thing" },
];

function setup(opts: { statuses?: McpServerStatus[]; live?: boolean } = {}) {
  const world = emptyWorld();
  world.bots.set(B, newBot({ id: B, name: "Claudio", avatar: { shape: "circle", color: "white" }, at: "2026-10-17T09:00:00.000Z" }));
  const events: string[] = [];
  let statuses = opts.statuses ?? STATUSES;
  const control: McpControl = {
    mcpServerStatus: async () => statuses,
    toggleMcpServer: async (name, enabled) => void events.push(`toggle ${name} ${enabled}`),
  };
  let live = opts.live ?? true;
  const connectors = createConnectors({
    world,
    live: (id) => (live && id === B ? control : null),
    reopen: (id, which) => void events.push(`reopen ${which} ${id}`),
    persist: (urgency) => void events.push(`persist ${urgency ?? "later"}`),
    log: () => {},
  });
  return {
    world,
    events,
    connectors,
    bot: world.bots.get(B)!,
    close: () => void (live = false),
    setStatuses: (next: McpServerStatus[]) => void (statuses = next),
  };
}

test("connectorSettings denies each off server by name and is empty when none are off", () => {
  expect(connectorSettings([])).toEqual({});
  expect(connectorSettings(["chrome-devtools", "claude.ai Gmail"])).toEqual({
    deniedMcpServers: [{ serverName: "chrome-devtools" }, { serverName: "claude.ai Gmail" }],
  });
});

test("list hides the bridge's own server, maps statuses and sends only name, status and enabled", async () => {
  const { connectors } = setup();
  const list = await connectors.list(B);
  expect(list).toEqual([
    { name: "broken", status: "failed", enabled: true },
    { name: "chrome-devtools", status: "connected", enabled: true },
    { name: "claude.ai Gmail", status: "needs_auth", enabled: true },
    { name: "linear", status: "pending", enabled: true },
  ]);
  for (const c of list) expect(Object.keys(c).sort()).toEqual(["enabled", "name", "status"]);
  expect(JSON.stringify(list)).not.toMatch(/secret-arg|t0k|ENOENT|npx/);
});

test("an off server shows off, including one the SDK did not load because it was denied", async () => {
  const { connectors, setStatuses } = setup();
  await connectors.set(B, "chrome-devtools", false);
  setStatuses(STATUSES.filter((s) => s.name !== "chrome-devtools"));
  expect((await connectors.list(B)).find((c) => c.name === "chrome-devtools")).toEqual({ name: "chrome-devtools", status: "unchecked", enabled: false });
});

test("with no live query, list shows the last list seen this run, else the off names unchecked", async () => {
  const fresh = setup({ live: false });
  own<string[]>(fresh.bot.connectorsOff).push("linear");
  expect(await fresh.connectors.list(B)).toEqual([{ name: "linear", status: "unchecked", enabled: false }]);

  const seen = setup();
  await seen.connectors.list(B);
  seen.close();
  await seen.connectors.set(B, "broken", false);
  expect(await seen.connectors.list(B)).toContainEqual({ name: "broken", status: "failed", enabled: false });
  expect(await seen.connectors.list(B)).toHaveLength(4);
});

test("set persists the choice before toggling the live query, which then stays open while the bot's agents reopen", async () => {
  const { connectors, events, bot } = setup();
  expect(await connectors.set(B, "chrome-devtools", false)).toEqual({ ok: true });
  expect(bot.connectorsOff).toEqual(["chrome-devtools"]);
  expect(events).toEqual(["persist now", "toggle chrome-devtools false", `reopen agents ${B}`]);

  events.length = 0;
  expect(await connectors.set(B, "chrome-devtools", true)).toEqual({ ok: true });
  expect(bot.connectorsOff).toEqual([]);
  expect(events).toEqual(["persist now", "toggle chrome-devtools true", `reopen agents ${B}`]);
});

test("a live toggle that fails reopens the bot's query too", async () => {
  const world = emptyWorld();
  world.bots.set(B, newBot({ id: B, name: "Claudio", avatar: { shape: "circle", color: "white" }, at: "2026-10-17T09:00:00.000Z" }));
  const reopened: string[] = [];
  const connectors = createConnectors({
    world,
    live: () => ({ mcpServerStatus: async () => STATUSES, toggleMcpServer: async () => { throw new Error("closed"); } }),
    reopen: (id, which) => void reopened.push(`${which} ${id}`),
    persist: () => {},
    log: () => {},
  });
  expect(await connectors.set(B, "linear", false)).toEqual({ ok: true });
  expect(reopened).toEqual([`all ${B}`]);
});

test("turning a server off twice keeps one entry", async () => {
  const { connectors, bot } = setup();
  await connectors.set(B, "linear", false);
  await connectors.set(B, "linear", false);
  expect(bot.connectorsOff).toEqual(["linear"]);
});

test("set without a live query still persists and reopens", async () => {
  const { connectors, events, bot, close } = setup();
  await connectors.list(B);
  close();
  expect(await connectors.set(B, "linear", false)).toEqual({ ok: true });
  expect(bot.connectorsOff).toEqual(["linear"]);
  expect(events).toEqual(["persist now", `reopen all ${B}`]);
});

test("only a server the bot has listed can be turned off, while any name can be turned back on", async () => {
  const { connectors, events, bot } = setup();
  expect((await connectors.set(B, "made-up", false)).ok).toBe(false);
  expect((await setup({ live: false }).connectors.set(B, "linear", false)).ok).toBe(false);
  expect(bot.connectorsOff).toEqual([]);
  expect(events).toEqual([]);

  own<string[]>(bot.connectorsOff).push("gone-server");
  expect(await connectors.set(B, "gone-server", true)).toEqual({ ok: true });
  expect(bot.connectorsOff).toEqual([]);
});

test("at most 64 servers can be off for one bot", async () => {
  const many = Array.from({ length: 64 }, (_, i) => `server-${i}`);
  const { connectors, bot } = setup({ statuses: [...many, "one-more"].map((name) => ({ name, status: "connected", source: "user" })) });
  for (const name of many) expect(await connectors.set(B, name, false)).toEqual({ ok: true });
  expect((await connectors.set(B, "one-more", false)).ok).toBe(false);
  expect(bot.connectorsOff).toHaveLength(64);
  expect(await connectors.set(B, "server-0", false)).toEqual({ ok: true });
});

test("set refuses an unknown bot, the claudio server and a malformed name, changing nothing", async () => {
  const { connectors, events, bot } = setup();
  for (const [id, name] of [["b_gone", "linear"], [B, "claudio"], [B, ""], [B, "x".repeat(201)], [B, "lin​ear"]] as const) {
    const result = await connectors.set(id as BotId, name, false);
    expect(result.ok).toBe(false);
  }
  expect(bot.connectorsOff).toEqual([]);
  expect(events).toEqual([]);
});

test("a failing live query does not fail list or set", async () => {
  const world = emptyWorld();
  world.bots.set(B, newBot({ id: B, name: "Claudio", avatar: { shape: "circle", color: "white" }, at: "2026-10-17T09:00:00.000Z" }));
  const logs: string[] = [];
  const connectors = createConnectors({
    world,
    live: () => ({ mcpServerStatus: async () => { throw new Error("closed"); }, toggleMcpServer: async () => { throw new Error("closed"); } }),
    reopen: () => {},
    persist: () => {},
    log: (line) => void logs.push(line),
  });
  own<string[]>(world.bots.get(B)!.connectorsOff).push("linear");
  expect(await connectors.set(B, "other", true)).toEqual({ ok: true });
  expect(await connectors.list(B)).toEqual([{ name: "linear", status: "unchecked", enabled: false }]);
  expect(logs).toHaveLength(2);
});

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("the off list survives a store round-trip and feeds the next query's settings", async () => {
  const { world, connectors } = setup();
  await connectors.set(B, "chrome-devtools", false);
  const home = mkdtempSync(join(tmpdir(), "claudiobot-connectors-"));
  homes.push(home);
  flushNow(world, home);
  const reloaded = loadWorld(home).world.bots.get(B)!;
  expect(reloaded.connectorsOff).toEqual(["chrome-devtools"]);
  expect(connectorSettings(reloaded.connectorsOff)).toEqual({ deniedMcpServers: [{ serverName: "chrome-devtools" }] });
});
