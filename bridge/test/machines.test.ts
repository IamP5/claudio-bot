import { afterEach, expect, test } from "bun:test";
import type { HubDeps } from "../src/hub";
import type { Machine } from "../src/machine/machines";
import { profileOf } from "../src/machine/profile";
import { profileView, type Event, type MachineId, type ProfileView } from "../src/machine/wire";
import type { AgentId, ServerMessage } from "../src/protocol";
import { flushNow, loadWorld } from "../src/store";
import { emptySession, emptyWorld, type AgentRecord } from "../src/world";
import { NO_RING, at, bot, cleanup, hubOver } from "./hub-kit";

afterEach(cleanup);

const MAC = "m_mac" as MachineId;
const view: ProfileView = {
  ...profileView(profileOf({ env: { CLAUDIOBOT_ACCESS: "full" }, platform: "darwin", name: "MacBook", homedir: "/Users/alex", username: "alex" })),
  connectors: [{ name: "claude-in-chrome", kind: "chrome" }],
};

function fakeLinks() {
  let online = false;
  let profile: typeof view | null = view;
  const change: (() => void)[] = [];
  const events: ((id: MachineId, e: Event) => void)[] = [];
  const mac: Machine = {
    id: MAC,
    name: "MacBook",
    profile: () => profile,
    status: () => (online ? { online: true, since: "2026-10-21T10:00:00.000Z" } : { online: false, since: "2026-10-21T09:00:00.000Z" }),
    send: async () => ({ ok: false, reason: "MacBook is offline" }),
  };
  const links: NonNullable<HubDeps["links"]> = {
    machines: () => [mac],
    onChange: (f) => void change.push(f),
    onEvent: (f) => void events.push(f),
    ask: async () => ({ ok: false, reason: "MacBook is offline" }),
    onSignal: () => {},
    remove: () => false,
  };
  return {
    links,
    flip(to: boolean) {
      online = to;
      change.forEach((f) => f());
    },
    neverLinked: () => (profile = null),
  };
}

const machinesOf = (m: ServerMessage) => (m.type === "hello" || m.type === "machines" ? m.machines : undefined);

test("a home that takes machines lists itself and each linked machine in hello, behind the machines feature", () => {
  const f = fakeLinks();
  const h = hubOver(emptyWorld(), { links: f.links });
  const hello = h.hub.hello(NO_RING);
  expect(hello.type === "hello" && hello.features).toContain("machines");
  expect(machinesOf(hello) as unknown[]).toEqual([
    { id: "m_test", name: "Mac", role: "home", online: true, since: null, platform: process.platform, access: expect.any(Object), connectors: [] },
    {
      id: MAC,
      name: "MacBook",
      role: "machine",
      online: false,
      since: "2026-10-21T09:00:00.000Z",
      platform: "darwin",
      access: { full: true, sandbox: false },
      connectors: [{ name: "claude-in-chrome", kind: "chrome" }],
    },
  ]);
});

test("a home that takes machines names its world in hello, from machine.json and the user's name", () => {
  const h = hubOver(emptyWorld(), { links: fakeLinks().links });
  const hello = h.hub.hello(NO_RING);
  expect(hello.type === "hello" && (hello.world as unknown)).toEqual({ id: "w_test", name: "Alex's bots" });
});

test("a machine coming online or going offline sends every phone a machines frame", () => {
  const f = fakeLinks();
  const h = hubOver(emptyWorld(), { links: f.links });
  f.flip(true);
  f.flip(false);
  expect(h.frames.filter((m) => m.type === "machines").map((m) => machinesOf(m)?.[1]?.online)).toEqual([true, false]);
});

test("a machine that never linked is not listed: the home knows neither its platform nor its access", () => {
  const f = fakeLinks();
  f.neverLinked();
  const h = hubOver(emptyWorld(), { links: f.links });
  expect(machinesOf(h.hub.hello(NO_RING))?.map((m) => m.role)).toEqual(["home"]);
});

test("a bridge without machines keeps hello as it was: no feature, no machines key", () => {
  const h = hubOver(emptyWorld());
  const hello = h.hub.hello(NO_RING);
  expect(hello.type === "hello" && hello.features).not.toContain("machines");
  expect("machines" in hello).toBe(false);
  expect("world" in hello).toBe(false);
});

test("agent frames name the machine the agent runs on: the home's own, a cloud agent's included", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  for (const where of ["mac", "cloud"] as const) {
    const id = `a_${where}` as AgentId;
    const rec: AgentRecord = {
      agent: { id, botId: b.id, title: "Fix", where, projectName: "app", status: "waiting", url: null, createdAt: at, updatedAt: at, evidence: null, worktree: null },
      cwd: "/code/app",
      messages: [],
      session: emptySession(),
      cloudSession: null,
      budgetUsd: null,
      startedBy: { kind: "user" },
    };
    world.agents.set(id, rec);
  }
  const h = hubOver(world, { links: fakeLinks().links });
  expect(await h.hub.handle({ type: "agent", agentId: "a_mac" as AgentId })).toMatchObject([{ type: "agent", agent: { machine: "m_test" } }]);
  const [details] = await h.hub.handle({ type: "details", botId: b.id });
  expect(details?.type === "details" && details.agents.map((a): string[] => [a.id, a.machine])).toEqual([
    ["a_mac", "m_test"],
    ["a_cloud", "m_test"],
  ]);
});

test("a bot's agentsOn is null until the phone names a machine of this home, which survives a reload; any other machine is refused", async () => {
  const world = emptyWorld();
  const b = bot("eng");
  world.bots.set(b.id, b);
  const h = hubOver(world, { links: fakeLinks().links });
  const botFrame = () => h.frames.findLast((f) => f.type === "bot");
  const hello = h.hub.hello(NO_RING);
  expect(hello.type === "hello" && hello.bots[0]?.agentsOn).toBeNull();

  expect(await h.hub.handle({ type: "update_bot", botId: b.id, patch: { agentsOn: MAC } })).toEqual([]);
  expect(botFrame()).toMatchObject({ bot: { id: b.id, agentsOn: MAC } });
  expect(await h.hub.handle({ type: "update_bot", botId: b.id, patch: { agentsOn: "m_unknown" as MachineId } })).toEqual([{ type: "error", message: "Unknown machine" }]);
  flushNow(world, h.root);
  expect(loadWorld(h.root).world.bots.get(b.id)?.agentsOn).toBe(MAC);

  expect(await h.hub.handle({ type: "update_bot", botId: b.id, patch: { agentsOn: "m_test" as MachineId } })).toEqual([]);
  expect(await h.hub.handle({ type: "update_bot", botId: b.id, patch: { agentsOn: null } })).toEqual([]);
  expect(botFrame()).toMatchObject({ bot: { agentsOn: null } });
});

test("a group has no agentsOn of its own: it is always null and the phone cannot set it", async () => {
  const world = emptyWorld();
  for (const name of ["ana", "bo"]) world.bots.set(bot(name).id, bot(name));
  const h = hubOver(world, { links: fakeLinks().links });
  const [created] = await h.hub.handle({ type: "create_group", ref: "c1", name: "crew", members: [...world.bots.keys()] });
  const groupId = created?.type === "created" ? created.botId : ("" as never);
  expect(h.frames.findLast((f) => f.type === "bot")).toMatchObject({ bot: { kind: "group", agentsOn: null } });
  expect(await h.hub.handle({ type: "update_bot", botId: groupId, patch: { agentsOn: MAC } })).toEqual([{ type: "error", message: "A group has no agents of its own: its bots do." }]);
});
