import { afterEach, expect, test } from "bun:test";
import type { Links } from "../src/machine/links";
import type { Machine } from "../src/machine/machines";
import { profileOf } from "../src/machine/profile";
import type { Event, MachineId } from "../src/machine/wire";
import type { AgentId, ServerMessage } from "../src/protocol";
import { emptySession, emptyWorld, type AgentRecord } from "../src/world";
import { NO_RING, at, bot, cleanup, hubOver } from "./hub-kit";

afterEach(cleanup);

const MAC = "m_mac" as MachineId;
const view = (() => {
  const { sshAuthSock: _, ...v } = profileOf({ env: { CLAUDIOBOT_ACCESS: "full" }, platform: "darwin", name: "MacBook", homedir: "/Users/alex", username: "alex" });
  return v;
})();

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
  const links: Pick<Links, "machines" | "onEvent" | "onChange"> = {
    machines: () => [mac],
    onChange: (f) => void change.push(f),
    onEvent: (f) => void events.push(f),
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
    { id: "m_test", name: "Mac", role: "home", online: true, since: null, platform: process.platform, access: expect.any(Object) },
    { id: MAC, name: "MacBook", role: "machine", online: false, since: "2026-10-21T09:00:00.000Z", platform: "darwin", access: { full: true, sandbox: false } },
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
