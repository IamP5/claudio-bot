import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices } from "../src/devices";
import { newGroup } from "../src/groups";
import { lockPathOf } from "../src/lock";
import { mergeFacts } from "../src/memory";
import {
  arrive,
  exportWorld,
  finishMove,
  importWorld,
  mergeBot,
  mergeDevices,
  mergeExchanges,
  mergeMessages,
  parseBundle,
  unionLines,
  worldCommand,
  type MoveBundle,
  type MoveDeps,
} from "../src/move";
import type { Agent, BotId, DeviceId, Message, MessageId, RoutineId } from "../src/protocol";
import { createScheduler } from "../src/scheduler";
import { flushNow, loadWorld } from "../src/store";
import { emptySession, emptyWorld, newBot, own, type BotRecord, type DeviceRecord, type EnvelopeId, type Pending, type RoutineRecord, type SessionState, type World } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const freshHome = () => {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-move-"));
  roots.push(root);
  return join(root, "home");
};

const at = "2026-10-20T08:00:00.000Z";
const avatar = { shape: "circle" as const, color: "white" as const };
const msg = (id: string, when: string, text = id): Message => ({ kind: "bot", id: id as MessageId, at: when, text });
const pending = (id: string): Pending => ({ id: id as EnvelopeId, kind: "envelope", at, text: id, initiator: { kind: "user" }, settles: null, attempts: 0 });
const device = (id: string, legacy = false): DeviceRecord => ({ id: id as DeviceId, name: id, tokenHash: `hash-${id}`, createdAt: at, lastSeenAt: null, legacy });
const pendingOf = (bot: BotRecord) => own<SessionState>(bot.session).pending.map((p) => p.id);

describe("pure merges", () => {
  test.each([
    ["disjoint ids interleave by time", [msg("a", "1"), msg("c", "3")], [msg("b", "2")], ["a", "b", "c"]],
    ["a shared id keeps one copy, the incoming one", [msg("a", "1", "old")], [msg("a", "1", "new")], ["a:new"]],
    ["nothing incoming keeps every local message", [msg("a", "1"), msg("b", "2")], [], ["a", "b"]],
    ["nothing local takes every incoming message", [], [msg("a", "1")], ["a"]],
  ])("mergeMessages: %s", (_, local, incoming, expected) => {
    const out = mergeMessages(local, incoming).map((m) => (m.kind === "bot" && m.text !== m.id ? `${m.id}:${m.text}` : m.id));
    expect(out).toEqual(expected);
  });

  test.each([
    ["into an empty file", "", "a\nb\n", "a\nb\n"],
    ["only new lines are appended", "a\nb\n", "b\nc\n", "a\nb\nc\n"],
    ["a replay appends nothing", "a\nb\n", "a\nb\n", "a\nb\n"],
    ["a torn last line gets its newline first", "a", "b\n", "a\nb\n"],
    ["a line twice in the incoming file lands once", "", "a\na\n", "a\n"],
  ])("unionLines: %s", (_, local, incoming, expected) => {
    expect(unionLines(local, incoming)).toBe(expected);
    expect(unionLines(expected, incoming)).toBe(expected);
  });

  test("mergeDevices: union by id, the local record wins, the legacy shared-token device never moves", () => {
    const local = [device("d_phone"), device("d_ipad")];
    const incoming = [{ ...device("d_phone"), name: "renamed" }, device("d_mac_phone"), device("d_legacy", true)];
    expect(mergeDevices(local, incoming).map((d) => `${d.id}:${d.name}`)).toEqual(["d_phone:d_phone", "d_ipad:d_ipad", "d_mac_phone:d_mac_phone"]);
  });

  test("mergeBot: a bot only incoming lands as is; one on both sides takes the incoming record and keeps local messages and inbox", () => {
    const incoming = newBot({ id: "b_x" as BotId, name: "New", avatar, at });
    incoming.messages.push(msg("m_2", "2"));
    own<SessionState>(incoming.session).pending.push(pending("e_in"));
    expect(mergeBot(undefined, incoming)).toBe(incoming);

    const local = newBot({ id: "b_x" as BotId, name: "Old", avatar, at });
    local.messages.push(msg("m_1", "1"), msg("m_3", "3"));
    own<SessionState>(local.session).pending.push(pending("e_local"));
    const merged = mergeBot(local, incoming);
    expect(merged.name).toBe("New");
    expect(merged.messages.map((m) => m.id as string)).toEqual(["m_1", "m_2", "m_3"]);
    expect(pendingOf(merged) as string[]).toEqual(["e_local", "e_in"]);
  });

  test("mergeExchanges: logs union by pair and their messages by id", () => {
    const pair = ["b_a", "b_b"] as [BotId, BotId];
    const m = (id: string, when: string) => ({ id: id as MessageId, at: when, from: "b_a" as BotId, text: id });
    const out = mergeExchanges([{ bots: pair, messages: [m("x1", "1")] }], [{ bots: pair, messages: [m("x1", "1"), m("x2", "2")] }, { bots: ["b_a", "b_c"] as [BotId, BotId], messages: [] }]);
    expect(out.map((l) => [l.bots.join("+"), l.messages.map((x) => x.id as string)])).toEqual([
      ["b_a+b_b", ["x1", "x2"]],
      ["b_a+b_c", []],
    ]);
  });

  test("arrive: a fresh session told why, the inbox kept, held permission cards expired, open questions left open", () => {
    const bot = newBot({ id: "b_x" as BotId, name: "X", avatar, at });
    Object.assign(own<SessionState>(bot.session), { id: "sess-on-mac", lifecycle: { kind: "working", since: at }, sent: { context: "h" }, background: [{ id: "t1" }] });
    own<SessionState>(bot.session).pending.push(pending("e_1"));
    const permission = (id: string, from: null | { kind: "agent"; id: string; title: string }): Message =>
      ({ kind: "permission", id: id as MessageId, at, from, tool: "Bash", label: "Push", detail: "git push", always: "", answer: null, expiresAt: at }) as Message;
    const question: Message = { kind: "question", id: "m_q" as MessageId, at, question: "Ship it?", options: ["Yes"], answer: null, expiresAt: "2026-10-21T00:00:00.000Z" };
    bot.messages.push(permission("m_p", null), permission("m_ap", { kind: "agent", id: "a_1", title: "fix" }), question);

    const landed = arrive(bot, { from: "Mac", to: "omarchy", at });
    const session = own<SessionState>(landed.session);
    expect(session.id).toBeNull();
    expect(session.lifecycle).toEqual({ kind: "idle" });
    expect(session.sent).toBeUndefined();
    expect(session.background).toBeUndefined();
    expect(session.pending.map((p) => p.id)).toEqual(["e_1" as EnvelopeId]);
    expect(session.notices).toHaveLength(1);
    expect(session.notices[0]!.text).toContain("You moved from Mac to omarchy");
    expect(session.notices[0]!.text).toContain("Bash `git push`");
    expect(landed.messages.map((m) => (m.kind === "permission" || m.kind === "question" ? m.answer : null))).toEqual(["expired", "expired", null]);
    expect(own<SessionState>(bot.session).id).toBe("sess-on-mac");
  });

  test("mergeFacts: the local file gains the facts it lacks, by id or text, and a second merge changes nothing", () => {
    const local = "# About Tuba\n\n## Facts\n\n- Lives in Lisbon <!-- f_00000001 2026-10-01T00:00:00.000Z -->\n";
    const incoming = "# About Tuba\n\n## Facts\n\n- lives in lisbon\n- Drinks tea <!-- f_00000002 2026-10-02T00:00:00.000Z -->\n";
    const merged = mergeFacts(local, incoming);
    expect(merged).toBe(`${local.trimEnd()}\n- Drinks tea <!-- f_00000002 2026-10-02T00:00:00.000Z -->\n`);
    expect(mergeFacts(merged, incoming)).toBe(merged);
    expect(mergeFacts("", incoming)).toBe(incoming);
  });
});

// ---- Two homes on disk.

const MAC: Omit<MoveDeps, "home"> = { machine: "Tuba's Mac", now: () => new Date(at) };
const OMARCHY: Omit<MoveDeps, "home"> = { machine: "omarchy", now: () => new Date("2026-10-20T09:00:00.000Z") };
const DIGEST_AT = "2026-10-21T07:00:00.000Z";

function seedMac(home: string) {
  const world = emptyWorld();
  const bot = newBot({ id: "b_scout" as BotId, name: "Scout", avatar, at });
  bot.messages.push(msg("m_hello", at, "Hello from the Mac"));
  Object.assign(own<SessionState>(bot.session), { id: "mac-session" });
  const routine: RoutineRecord = {
    id: "r_digest" as RoutineId,
    name: "digest",
    trigger: { kind: "cron", schedule: "0 7 * * *" },
    prompt: "Post the digest.",
    enabled: true,
    nextRunAt: DIGEST_AT,
    runs: [],
    failStreak: 0,
  };
  own<RoutineRecord[]>(bot.routines).push(routine);
  world.bots.set(bot.id, bot);
  const other = newBot({ id: "b_mate" as BotId, name: "Mate", avatar, at });
  world.bots.set(other.id, other);
  world.groups.set("b_group" as BotId, newGroup({ id: "b_group" as BotId, name: "Team", members: [bot.id, other.id], avatar, at }));
  const devices = createDevices({ world, persist: () => {}, now: () => new Date(at), announce: () => {} });
  const paired = devices.pair(devices.newCode().code, "Tuba's iPhone");
  if ("error" in paired) throw new Error(paired.error);
  own<DeviceRecord[]>(world.devices).push(device("d_legacy", true));
  flushNow(world, home);

  const files: Record<string, string> = {
    "USER.md": "# About Tuba\n\n## Facts\n\n- Lives in Lisbon <!-- f_00000001 2026-10-01T00:00:00.000Z -->\n",
    "usage/2026-10.jsonl": '{"row":"mac-1"}\n{"row":"mac-2"}\n',
    "audit/2026-10.jsonl": '{"audit":"mac"}\n',
    "groups/b_group.jsonl": '{"id":"m_old"}\n',
    "bots/b_scout/CLAUDE.md": "# Scout\n",
    "bots/b_scout/library/notes.md": "notes",
    "bots/b_scout/.history/bot.jsonl": '{"id":"m_archived"}\n',
    "bots/b_scout/work/clone/README": "scratch",
    "bots/b_mate/CLAUDE.md": "# Mate\n",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), body);
  }
  return { token: paired.token, deviceId: paired.deviceId };
}

function seedOmarchy(home: string) {
  const world = emptyWorld();
  const bot = newBot({ id: "b_claudio" as BotId, name: "Claudio", avatar, at });
  world.bots.set(bot.id, bot);
  own<DeviceRecord[]>(world.devices).push(device("d_desk"));
  flushNow(world, home);
  mkdirSync(join(home, "usage"), { recursive: true });
  writeFileSync(join(home, "usage/2026-10.jsonl"), '{"row":"omarchy-1"}\n');
  writeFileSync(join(home, "USER.md"), "# About Tuba\n\n## Facts\n\n- Drinks tea <!-- f_00000002 2026-10-02T00:00:00.000Z -->\n");
}

/** Through JSON, as the bundle travels in a file. */
function exported(home: string): MoveBundle {
  const result = exportWorld({ home, ...MAC });
  if (result.kind !== "exported") throw new Error(`expected an export, got ${result.kind}`);
  return JSON.parse(JSON.stringify(result.bundle));
}

const read = (home: string, path: string) => readFileSync(join(home, path), "utf8");

/** Whatever the scheduler fires from this world at the digest's time, as the hub's clock would. */
function firesAt(world: World, when: string): string[] {
  const fired: string[] = [];
  const scheduler = createScheduler({
    world,
    deliver: (bot, e) => fired.push(`${bot.name}:${e.from === "routine" ? e.name : e.from}`),
    note: () => {},
    changed: () => {},
    log: () => {},
    parked: () => false,
    now: () => new Date(when),
  });
  scheduler.tick(new Date(when));
  return fired;
}

describe("export, import, finish", () => {
  test("export freezes every bot out of the Mac's world, once: a rerun packs the same move with the same bytes", () => {
    const mac = freshHome();
    seedMac(mac);
    const first = exportWorld({ home: mac, ...MAC });
    if (first.kind !== "exported") throw new Error(first.kind);
    expect(first.fresh).toBe(true);
    const again = exportWorld({ home: mac, ...MAC, now: () => new Date("2026-10-22T00:00:00.000Z") });
    if (again.kind !== "exported") throw new Error(again.kind);
    expect(again.fresh).toBe(false);
    expect(again.moveId).toBe(first.moveId);
    expect(JSON.stringify(again.bundle)).toBe(JSON.stringify(first.bundle));

    const world = loadWorld(mac).world;
    expect(world.bots.size).toBe(0);
    expect(world.groups.size).toBe(0);
    expect(world.moves).toMatchObject([{ kind: "out", moveId: first.moveId, phase: "frozen" }]);
    expect(firesAt(world, DIGEST_AT)).toEqual([]);

    const paths = first.bundle.files.map((f) => f.path);
    expect(paths).toContain("bots/b_scout/.history/bot.jsonl");
    expect(paths).toContain("bots/b_scout/library/notes.md");
    expect(paths.some((p) => p.includes("/work/"))).toBe(false);
    expect(first.bundle.world.devices.map((d) => d.legacy)).toEqual([false]);
  });

  test("a home with no bots has nothing to export", () => {
    const empty = freshHome();
    expect(exportWorld({ home: empty, ...MAC })).toEqual({ kind: "empty" });
    flushNow(emptyWorld(), empty);
    expect(exportWorld({ home: empty, ...MAC })).toEqual({ kind: "empty" });
  });

  test("import unions the two worlds on Omarchy, and the Mac's phone token authenticates there", () => {
    const mac = freshHome();
    const omarchy = freshHome();
    const phone = seedMac(mac);
    seedOmarchy(omarchy);
    const bundle = exported(mac);

    const result = importWorld({ home: omarchy, ...OMARCHY }, bundle);
    expect(result).toMatchObject({ kind: "imported", moveId: bundle.moveId, from: "Tuba's Mac", bots: ["Scout", "Mate"], routines: 1, devices: 1 });

    const world = loadWorld(omarchy).world;
    expect([...world.bots.keys()].sort() as string[]).toEqual(["b_claudio", "b_mate", "b_scout"]);
    expect(world.groups.get("b_group" as BotId)?.members).toEqual(["b_scout", "b_mate"] as BotId[]);
    const scout = world.bots.get("b_scout" as BotId)!;
    expect(own<SessionState>(scout.session).id).toBeNull();
    expect(own<SessionState>(scout.session).notices[0]!.text).toContain("You moved from Tuba's Mac to omarchy");
    expect(scout.messages.map((m) => m.id)).toEqual(["m_hello" as MessageId]);
    expect(world.moves).toEqual([{ kind: "in", moveId: bundle.moveId, at: "2026-10-20T09:00:00.000Z", from: "Tuba's Mac" }]);

    const devices = createDevices({ world, persist: () => {}, now: () => new Date(at), announce: () => {} });
    const req = new Request("http://omarchy/ws", { headers: { authorization: `Bearer ${phone.token}` } });
    expect(devices.authenticate(req)).toBe(phone.deviceId);
    expect(devices.list(null).map((d) => d.id as string).sort()).toEqual(["d_desk", phone.deviceId].sort());

    expect(read(omarchy, "usage/2026-10.jsonl")).toBe('{"row":"omarchy-1"}\n{"row":"mac-1"}\n{"row":"mac-2"}\n');
    expect(read(omarchy, "USER.md")).toContain("Drinks tea");
    expect(read(omarchy, "USER.md")).toContain("Lives in Lisbon");
    expect(read(omarchy, "bots/b_scout/.history/bot.jsonl")).toBe('{"id":"m_archived"}\n');
    expect(read(omarchy, "bots/b_scout/library/notes.md")).toBe("notes");
    expect(existsSync(join(omarchy, "bots/b_scout/work"))).toBe(false);
  });

  test("a repeat import answers already imported and changes no byte", () => {
    const mac = freshHome();
    const omarchy = freshHome();
    seedMac(mac);
    seedOmarchy(omarchy);
    const bundle = exported(mac);
    importWorld({ home: omarchy, ...OMARCHY }, bundle);
    const snapshot = () => ["state.json", "usage/2026-10.jsonl", "USER.md", "bots/b_scout/.history/bot.jsonl"].map((p) => read(omarchy, p));
    const before = snapshot();

    expect(importWorld({ home: omarchy, ...OMARCHY, now: () => new Date("2026-10-23T00:00:00.000Z") }, bundle)).toEqual({
      kind: "already",
      moveId: bundle.moveId,
      at: "2026-10-20T09:00:00.000Z",
    });
    expect(snapshot()).toEqual(before);
  });

  test("a crash after the files landed but before the state was saved converges on rerun, with no doubled rows", () => {
    const mac = freshHome();
    const omarchy = freshHome();
    seedMac(mac);
    seedOmarchy(omarchy);
    const bundle = exported(mac);
    const state = read(omarchy, "state.json");
    importWorld({ home: omarchy, ...OMARCHY }, bundle);
    writeFileSync(join(omarchy, "state.json"), state);

    expect(importWorld({ home: omarchy, ...OMARCHY }, bundle).kind).toBe("imported");
    expect(read(omarchy, "usage/2026-10.jsonl")).toBe('{"row":"omarchy-1"}\n{"row":"mac-1"}\n{"row":"mac-2"}\n');
    expect(loadWorld(omarchy).world.bots.size).toBe(3);
  });

  test("the bundle cannot land on the home that exported it", () => {
    const mac = freshHome();
    seedMac(mac);
    const bundle = exported(mac);
    expect(importWorld({ home: mac, ...MAC }, bundle)).toEqual({ kind: "own", moveId: bundle.moveId });
  });

  test("the routine fires only on the importing side", () => {
    const mac = freshHome();
    const omarchy = freshHome();
    seedMac(mac);
    seedOmarchy(omarchy);
    importWorld({ home: omarchy, ...OMARCHY }, exported(mac));

    expect(firesAt(loadWorld(omarchy).world, DIGEST_AT)).toEqual(["Scout:digest"]);
    expect(firesAt(loadWorld(mac).world, DIGEST_AT)).toEqual([]);
  });

  test("finish trashes the frozen bots' homes, keeps the Mac's agents, and is safe to rerun", () => {
    const mac = freshHome();
    seedMac(mac);
    const world = loadWorld(mac).world;
    const agent = { id: "a_1", botId: "b_scout", title: "fix", where: "mac", status: "idle", updatedAt: at, evidence: null, worktree: null } as unknown as Agent;
    world.agents.set(agent.id, { agent, cwd: "/tmp", messages: [], session: emptySession(), cloudSession: null, budgetUsd: null, startedBy: { kind: "system" } });
    flushNow(world, mac);
    const { moveId } = exported(mac);

    expect(finishMove({ home: mac, ...MAC }, moveId)).toEqual({ kind: "finished", bots: 2 });
    expect(existsSync(join(mac, "bots/b_scout"))).toBe(false);
    expect(readdirSync(join(mac, "trash")).sort()).toEqual([`b_mate-${Date.parse(at)}`, `b_scout-${Date.parse(at)}`]);
    const after = loadWorld(mac).world;
    expect(after.moves).toEqual([{ kind: "out", moveId, at, machine: "Tuba's Mac", phase: "done" }]);
    expect(after.agents.size).toBe(1);

    expect(finishMove({ home: mac, ...MAC }, moveId)).toEqual({ kind: "already" });
    expect(finishMove({ home: mac, ...MAC }, "mv_nope")).toEqual({ kind: "unknown" });
    expect(exportWorld({ home: mac, ...MAC })).toEqual({ kind: "empty" });
  });

  test.each([
    ["a path that climbs out of the home", "bots/b_scout/../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["a file under a bot the bundle does not bring", "bots/b_other/CLAUDE.md"],
    ["a file kind a move never carries", "state.json"],
  ])("parseBundle refuses %s", (_, path) => {
    const mac = freshHome();
    seedMac(mac);
    const bundle = exported(mac);
    const bad = { ...bundle, files: [...bundle.files, { path, data: "" }] };
    expect(parseBundle(bad)).toEqual({ error: `The bundle names a file outside what a move carries: ${path}` });
  });

  test("parseBundle refuses a record loadWorld would refuse", () => {
    const mac = freshHome();
    seedMac(mac);
    const bundle = exported(mac);
    const bad = { ...bundle, world: { ...bundle.world, bots: [{ ...bundle.world.bots[0], routines: "nope" }] } };
    expect(parseBundle(bad)).toMatchObject({ error: expect.stringContaining("bots[0].routines") });
    expect(parseBundle({ format: 2 })).toMatchObject({ error: expect.stringContaining("not a ClaudioBot world bundle") });
  });
});

describe("claudiobot world", () => {
  const run = (home: string, cwd: string, ...argv: string[]) => {
    let printed = "";
    const code = worldCommand(argv, { home, cwd, machine: "mac", now: () => new Date(at), out: (t) => (printed += t) });
    return { code, printed };
  };

  test("export, import twice and finish, each printing what it did and what comes next", () => {
    const mac = freshHome();
    const omarchy = freshHome();
    seedMac(mac);
    const cwd = join(mac, "..");

    const exported = run(mac, cwd, "export", "--out", "bundle.json");
    expect(exported.code).toBe(0);
    const moveId = /Move (mv_[\w-]+)/.exec(exported.printed)![1]!;
    expect(exported.printed).toContain("Froze 2 bots (Scout, Mate)");
    expect(exported.printed).toContain(`claudiobot world finish ${moveId}`);
    expect(statSync(join(cwd, "bundle.json")).mode & 0o777).toBe(0o600);

    const imported = run(omarchy, cwd, "import", "bundle.json");
    expect(imported).toEqual({
      code: 0,
      printed: `Imported move ${moveId} from mac: 2 bots (Scout, Mate), 1 routines, 1 paired devices.\nStart the bridge. Then, on mac, run claudiobot world finish ${moveId}\n`,
    });
    expect(run(omarchy, cwd, "import", "bundle.json").printed).toBe(`Move ${moveId} was already imported at ${at}. Nothing changed.\n`);
    expect(run(mac, cwd, "import", "bundle.json")).toMatchObject({ code: 1, printed: expect.stringContaining("This bridge exported") });

    expect(run(mac, cwd, "finish", moveId)).toMatchObject({ code: 0, printed: expect.stringContaining(`Finished move ${moveId}`) });
    expect(run(mac, cwd, "finish", moveId)).toMatchObject({ code: 0, printed: expect.stringContaining("already finished") });
  });

  test("every step refuses while a bridge holds the home, and changes nothing", async () => {
    const mac = freshHome();
    seedMac(mac);
    const bridge = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(lockPathOf(mac), `${bridge.pid}\n`);
      const state = read(mac, "state.json");
      for (const argv of [["export"], ["import", "x.json"], ["finish", "mv_x"]]) {
        expect(run(mac, mac, ...argv)).toEqual({
          code: 1,
          printed: `A bridge (pid ${bridge.pid}) is running on ${mac}. Stop it first, then run this again: a move rewrites state.json, and a running bridge would overwrite it.\n`,
        });
      }
      expect(read(mac, "state.json")).toBe(state);
    } finally {
      bridge.kill();
      await bridge.exited;
    }
  });

  test("a missing step or argument prints the usage", () => {
    const home = freshHome();
    expect(run(home, home).code).toBe(2);
    expect(run(home, home, "import").printed).toStartWith("usage: claudiobot world");
  });
});
