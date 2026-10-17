import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomes } from "../src/home";
import { createHub, tickEach } from "../src/hub";
import type { BotId, RoutineId, RunId, ServerMessage } from "../src/protocol";
import { emptySession, emptyWorld, newBot, type BotRecord, type EnvelopeId, type World } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const at = "2026-10-17T12:00:00.000Z";
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

function hubOver(world: World) {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-hub-"));
  roots.push(root);
  const homes = createHomes(root);
  const events: string[] = [];
  const frames: ServerMessage[] = [];
  const hub = createHub({
    machine: "Mac",
    userName: "Alex",
    world,
    homes: {
      ...homes,
      trash(id, when) {
        events.push(`trash ${id}`);
        homes.trash(id, when);
      },
    },
    model: undefined,
    scan: async () => [],
    broadcast: (m) => frames.push(m),
    persist: (urgency) => events.push(`persist ${urgency ?? "later"} with ${[...world.bots.keys()].join(",") || "no bots"}`),
    log: () => {},
  });
  return { hub, homes, events, frames };
}

const bot = (name: string, patch: Partial<BotRecord> = {}): BotRecord => ({ ...newBot({ id: `b_${name}` as BotId, name, avatar: { shape: "circle", color: "white" }, at }), ...patch });

test("a bot shows parked only while its queue head is held, not because another bot hit the usage limit", () => {
  const world: World = { ...emptyWorld(), account: { parkedUntil: inAnHour() } };
  const held = bot("held", {
    session: {
      ...emptySession(),
      pending: [{ id: "e1" as EnvelopeId, at, text: "[Routine digest fired]", initiator: { kind: "routine", run: { routineId: "r1" as RoutineId, runId: "run1" as RunId }, manual: false }, settles: null, attempts: 0 }],
      lifecycle: { kind: "parked", reason: "usage_limit", until: inAnHour() },
    },
  });
  const resting = bot("resting");
  world.bots.set(held.id, held);
  world.bots.set(resting.id, resting);

  const hello = hubOver(world).hub.hello();

  expect(hello.type === "hello" && Object.fromEntries(hello.bots.map((b) => [b.name, b.status]))).toEqual({ held: "parked", resting: "idle" });
});

test("delete_bot saves the world without the bot before its home is moved to the trash", async () => {
  const world = emptyWorld();
  const doomed = bot("doomed");
  world.bots.set(doomed.id, doomed);
  const { hub, homes, events, frames } = hubOver(world);
  homes.create(doomed.id, "# doomed\n");

  expect(await hub.handle({ type: "delete_bot", botId: doomed.id })).toEqual([]);

  expect(events).toEqual(["persist now with no bots", "trash b_doomed"]);
  expect(existsSync(homes.homeOf(doomed.id))).toBe(false);
  expect(frames.at(-1)).toEqual({ type: "bot_removed", botId: doomed.id });
});

test("one ticker throwing is logged, and the tickers after it still run", () => {
  const ticked: string[] = [];
  const logs: string[] = [];
  const now = new Date(at);

  tickEach(
    {
      scheduler: { tick: () => { throw new Error("bad routine"); }, nextDeadline: () => null },
      gate: { tick: (t) => ticked.push(`gate ${t.toISOString()}`), nextDeadline: () => null },
    },
    now,
    (line) => logs.push(line),
  );

  expect(ticked).toEqual([`gate ${at}`]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("scheduler");
  expect(logs[0]).toContain("bad routine");
});
