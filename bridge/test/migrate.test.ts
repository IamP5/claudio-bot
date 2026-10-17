import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomes } from "../src/home";
import { migrateHome, type MigrationFs } from "../src/migrate";
import { botMemory } from "../src/prompts";
import type { BotId, MessageId } from "../src/protocol";
import { flushNow, loadWorld, upgradeV2, type StateFileV2 } from "../src/store";
import { emptyWorld, newBot } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const token of [join(root, ".claudebot", "token"), join(root, ".claudiobot", "token")]) {
      if (existsSync(token)) chmodSync(token, 0o600);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const now = () => new Date("2026-10-17T05:12:30.250Z");
const ASIDE = ".claudiobot.pre-migrate-2026-10-17T05-12-30-250Z";

function freshUserHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-migrate-")));
  roots.push(home);
  return { home, old: join(home, ".claudebot"), new: join(home, ".claudiobot") };
}

const run = (home: string, env: Record<string, string | undefined> = {}, fs?: MigrationFs) => migrateHome({ env, home, now, fs });

const at = "2026-10-12T14:00:00.000Z";

// A protocol-2 state.json as the old bridge wrote it, with neutral sample data.
const userV2: StateFileV2 = {
  version: 2,
  bots: [
    {
      id: "b_claude" as never,
      name: "Claude Bot",
      title: "General assistant",
      avatar: { shape: "circle", color: "white" },
      pinned: true,
      hidden: false,
      createdAt: "2026-10-01T08:00:00.000Z",
      routines: [
        { id: "r_digest" as never, name: "morning-digest", schedule: "0 8 * * 1-5", describe: "Weekdays at 8:00 AM", prompt: "Post the news digest.", enabled: true, lastRunAt: "2026-10-12T08:00:00.120Z" },
      ],
      messages: [
        { kind: "user", id: "m_1" as never, at, text: "Summarize the sample report in library/", attachments: [] },
        { kind: "bot", id: "m_2" as never, at, text: "Done. It is in library/summary.md." },
        { kind: "question", id: "m_3" as never, at, question: "Email it to the team?", options: ["Yes", "No"], answer: 1 },
      ],
      unread: 0,
      sessionId: "11111111-2222-3333-4444-555555555555",
    },
    {
      id: "b_garden" as never,
      name: "Garden Planner",
      title: null,
      avatar: { shape: "flower", color: "green" },
      pinned: false,
      hidden: false,
      createdAt: "2026-10-05T10:00:00.000Z",
      routines: [],
      messages: [{ kind: "user", id: "m_4" as never, at, text: "When do I plant tulips?", attachments: [] }],
      unread: 1,
      sessionId: null,
    },
  ],
  agents: [],
};

/** A bot home with user data, as the old bridge left it. The token is mode 000, so reading it throws and fails the test. */
function writeUserHome(dir: string, userMd = "# About Sam\n\n") {
  mkdirSync(join(dir, "bots", "b_claude", "library"), { recursive: true });
  writeFileSync(join(dir, "bots", "b_claude", "CLAUDE.md"), "# memory\n");
  writeFileSync(join(dir, "USER.md"), userMd);
  writeFileSync(join(dir, "state.json"), JSON.stringify(userV2));
  writeToken(dir);
}

function writeToken(dir: string) {
  writeFileSync(join(dir, "token"), "0123abcd\n");
  chmodSync(join(dir, "token"), 0o000);
}

// The state file as JSON, so a case can make one change the typed world would refuse.
type StateJson = Record<string, any>;
type FreshEdit = { state?: (s: StateJson) => void; disk?: (dir: string, botHome: string) => void };

const DEFAULT_ID = "b_default" as BotId;

/**
 * What the v3 bridge leaves after first run, written by the bridge's own writers: the default bot with its home and
 * memory, USER.md, the token, and the greeting. Each edit is one thing the user did since.
 */
function writeFreshHome(dir: string, edit: FreshEdit = {}) {
  const world = emptyWorld();
  const bot = newBot({ id: DEFAULT_ID, name: "Claudio Bot", avatar: { shape: "circle", color: "white" }, at });
  bot.messages.push({ kind: "bot", id: "m_hi" as MessageId, at, text: "Hi! What can I take off your plate?" });
  world.bots.set(bot.id, bot);
  mkdirSync(dir, { recursive: true });
  flushNow(world, dir);
  if (edit.state) {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StateJson;
    edit.state(state);
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  }
  const homes = createHomes(dir);
  homes.ensureUserMd("Sam");
  homes.create(DEFAULT_ID, botMemory({ name: "Claudio Bot", job: "General assistant. Take real work off Sam's plate." }));
  writeToken(dir);
  edit.disk?.(dir, homes.homeOf(DEFAULT_ID));
}

const firstBot = (s: StateJson) => s.bots[0];
const isLink = (path: string) => lstatSync(path).isSymbolicLink();

test("CLAUDIOBOT_HOME set: nothing happens, even with the old home present", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  expect(run(u.home, { CLAUDIOBOT_HOME: join(u.home, "elsewhere") })).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(u.home)).toEqual([".claudebot"]);
});

test("CLAUDEBOT_HOME, protocol 2's override, is reported and does not change what happens", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  expect(run(u.home, { CLAUDEBOT_HOME: "/Volumes/bots" })).toEqual({ kind: "linked", from: u.old, to: u.new, legacyEnv: "/Volumes/bots" });
  expect(realpathSync(u.new)).toBe(u.old);
  expect(run(u.home, { CLAUDEBOT_HOME: "/Volumes/bots", CLAUDIOBOT_HOME: "/x" })).toEqual({ kind: "none", legacyEnv: "/Volumes/bots" });
});

test("no old home: nothing happens, whether or not the new home exists", () => {
  const u = freshUserHome();
  expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(u.home)).toEqual([]);
  writeFreshHome(u.new);
  expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(u.home)).toEqual([".claudiobot"]);
  expect(isLink(u.new)).toBe(false);
});

test("old home only: links the new path to it without moving a byte, then reruns are no-ops", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  const before = readFileSync(join(u.old, "state.json"), "utf8");

  expect(run(u.home)).toEqual({ kind: "linked", from: u.old, to: u.new, legacyEnv: null });
  expect(readlinkSync(u.new)).toBe(".claudebot");
  expect(realpathSync(u.new)).toBe(u.old);
  expect(readFileSync(join(u.new, "state.json"), "utf8")).toBe(before);
  expect(readFileSync(join(u.new, "bots", "b_claude", "CLAUDE.md"), "utf8")).toBe("# memory\n");
  expect(isLink(u.old)).toBe(false);

  for (let i = 0; i < 3; i++) expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(before);
});

test("HOME reached through a symlink: links relative to it, and reruns are no-ops", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-migrate-real-")));
  roots.push(real);
  const linkParent = mkdtempSync(join(tmpdir(), "claudiobot-migrate-via-"));
  roots.push(linkParent);
  const home = join(linkParent, "home");
  symlinkSync(real, home);
  writeUserHome(join(home, ".claudebot"));

  expect(run(home)).toEqual({ kind: "linked", from: join(home, ".claudebot"), to: join(home, ".claudiobot"), legacyEnv: null });
  expect(readlinkSync(join(real, ".claudiobot"))).toBe(".claudebot");
  expect(realpathSync(join(home, ".claudiobot"))).toBe(join(real, ".claudebot"));
  expect(run(home)).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(real).sort()).toEqual([".claudebot", ".claudiobot"]);
});

test("after linking, the store loads through the new path and bot cwds keep their old real path", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  run(u.home);
  const { world, firstRun } = loadWorld(u.new);
  expect(firstRun).toBe(false);
  expect([...world.bots.values()].map((b) => [b.name, b.session.id])).toEqual([
    ["Claude Bot", "11111111-2222-3333-4444-555555555555"],
    ["Garden Planner", null],
  ]);
  expect(readFileSync(join(u.old, "state.v2.json.bak"), "utf8")).toBe(JSON.stringify(userV2));
  expect(JSON.parse(readFileSync(join(u.old, "state.json"), "utf8")).version).toBe(3);
  expect(isLink(u.new)).toBe(true);
  expect(realpathSync(join(u.new, "bots", "b_claude"))).toBe(join(u.old, "bots", "b_claude"));
});

const freshV2Bot = {
  id: DEFAULT_ID,
  name: "Claudio Bot",
  title: null,
  avatar: { shape: "circle", color: "white" },
  pinned: false,
  hidden: false,
  createdAt: at,
  routines: [],
  messages: [{ kind: "bot", id: "m_hi", at, text: "Hi! What can I take off your plate?" }],
  unread: 1,
  sessionId: null,
};

const freshShapes: [string, (dir: string) => void][] = [
  ["an empty directory", (dir) => mkdirSync(dir)],
  ["only a token and USER.md", (dir) => {
    mkdirSync(dir);
    writeFileSync(join(dir, "USER.md"), "# About Sam (new)\n\n");
    writeToken(dir);
  }],
  ["what first run leaves: the default bot that only greeted", (dir) => writeFreshHome(dir)],
  ["the default bot in a v2 state file", (dir) => writeFreshHome(dir, { disk: (d) => writeFileSync(join(d, "state.json"), JSON.stringify({ version: 2, bots: [freshV2Bot], agents: [] })) })],
  ["a state with no bots and no bot homes", (dir) => writeFreshHome(dir, { state: (s) => (s.bots = []), disk: (d) => rmSync(join(d, "bots"), { recursive: true }) })],
  ["a default CLAUDE.md with trailing blank lines", (dir) => writeFreshHome(dir, { disk: (_, bot) => writeFileSync(join(bot, "CLAUDE.md"), `${readFileSync(join(bot, "CLAUDE.md"), "utf8")}\n\n  \n`) })],
  ["empty folders inside library", (dir) => writeFreshHome(dir, { disk: (_, bot) => mkdirSync(join(bot, "library", "drafts")) })],
];

test.each(freshShapes)("both homes, new one holds %s: moved aside, then linked", (_, setup) => {
  const u = freshUserHome();
  writeUserHome(u.old, "# About Sam (old)\n\n");
  setup(u.new);
  const newEntries = readdirSync(u.new).sort();

  expect(run(u.home)).toEqual({ kind: "moved_aside", from: u.old, to: u.new, aside: join(u.home, ASIDE), legacyEnv: null });
  expect(realpathSync(u.new)).toBe(u.old);
  expect(readFileSync(join(u.new, "USER.md"), "utf8")).toBe("# About Sam (old)\n\n");
  expect(readdirSync(join(u.home, ASIDE)).sort()).toEqual(newEntries);

  expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot", ASIDE]);
});

const card = { id: "m_card", at, question: "Draft the reply?", options: ["Yes", "No"], expiresAt: null };
const writeIn = (sub: string, name: string) => (_: string, bot: string) => {
  mkdirSync(join(bot, sub), { recursive: true });
  writeFileSync(join(bot, sub, name), "notes");
};

// Each is the first-run home plus one thing the user did. The first-run home alone is moved aside (above).
const userEdits: [string, FreshEdit][] = [
  ["a message the user typed", { state: (s) => firstBot(s).messages.push({ kind: "user", id: "m_u", at, text: "hello", attachments: [] }) }],
  ["an answered question card", { state: (s) => firstBot(s).messages.push({ kind: "question", ...card, answer: 0 }) }],
  ["an open question card", { state: (s) => firstBot(s).messages.push({ kind: "question", ...card, answer: null }) }],
  ["a second bot", { state: (s) => s.bots.push({ ...firstBot(s), id: "b_two" }) }],
  ["an agent", { state: (s) => s.agents.push({ agent: { id: "a_1", title: "Fix tests", where: "mac", status: "working" }, cwd: "/tmp", messages: [] }) }],
  ["a paired device", { state: (s) => s.devices.push({ id: "d_1", name: "Phone", tokenHash: "ab", createdAt: at, lastSeenAt: null, legacy: false }) }],
  ["an open card in the gate (v3)", { state: (s) => s.gate.open.push({ kind: "question", cardId: "m_card" }) }],
  ["a grant in the gate (v3)", { state: (s) => s.gate.grants.push({ actor: "bot:b_default", fingerprint: "f", cardId: "m_card", expiresAt: at }) }],
  ["a capped-tool count in the gate (v3)", { state: (s) => s.gate.daily.push({ botId: DEFAULT_ID, tool: "create_bot", day: "2026-10-12", count: 1 }) }],
  ["a push already sent", { state: (s) => s.push.sent.push({ key: "m_card|card", at }) }],
  ["a parked account", { state: (s) => (s.account.parkedUntil = at) }],
  ["the default bot renamed", { state: (s) => (firstBot(s).name = "Sam's Helper") }],
  ["the default bot pinned", { state: (s) => (firstBot(s).pinned = true) }],
  ["the default bot hidden", { state: (s) => (firstBot(s).hidden = true) }],
  ["the default bot given a title", { state: (s) => (firstBot(s).title = "Inbox triage") }],
  ["the default bot given a new avatar", { state: (s) => (firstBot(s).avatar = { shape: "flower", color: "green" }) }],
  ["the default bot given a daily cap", { state: (s) => (firstBot(s).dailyCapUsd = 2) }],
  ["the default bot with a routine", { state: (s) => firstBot(s).routines.push(upgradeV2(userV2).bots[0]!.routines[0]) }],
  ["the default bot with a standing rule", { state: (s) => firstBot(s).rules.push({ effect: "allow" }) }],
  ["a state.json that is not JSON", { disk: (d) => writeFileSync(join(d, "state.json"), "{ \"version\": 3, \"bots\": [") }],
  ["a state.json from an unknown version", { disk: (d) => writeFileSync(join(d, "state.json"), JSON.stringify({ version: 9, bots: [], agents: [] })) }],
  ["a v2 state.json missing bots", { disk: (d) => writeFileSync(join(d, "state.json"), JSON.stringify({ version: 2, agents: [] })) }],
  ["two bots in a v2 state.json", { disk: (d) => writeFileSync(join(d, "state.json"), JSON.stringify(userV2)) }],
  ["an edited CLAUDE.md", { disk: (_, bot) => writeFileSync(join(bot, "CLAUDE.md"), `${readFileSync(join(bot, "CLAUDE.md"), "utf8")}- Sam takes tea, no sugar.\n`) }],
  ["a CLAUDE.md that is not a file", { disk: (_, bot) => {
    rmSync(join(bot, "CLAUDE.md"));
    mkdirSync(join(bot, "CLAUDE.md"));
  } }],
  ["a file in library", { disk: writeIn("library", "plan.md") }],
  ["a file deep in library", { disk: writeIn(join("library", "a", "b"), "plan.md") }],
  ["a file in inbox", { disk: writeIn("inbox", "photo.jpg") }],
  ["USER.md with content beyond its heading", { disk: (d) => writeFileSync(join(d, "USER.md"), "# About Sam\n\nLives in Lisbon.\n") }],
  ["bot homes without a state.json", { disk: (d) => rmSync(join(d, "state.json")) }],
  ["a bot home the state does not list", { disk: (d) => mkdirSync(join(d, "bots", "b_other")) }],
  ["a deleted bot in trash", { disk: (d) => {
    mkdirSync(join(d, "trash", "b_old-1"), { recursive: true });
    writeFileSync(join(d, "trash", "b_old-1", "CLAUDE.md"), "# Old\n");
  } }],
];

test.each(userEdits)("both homes hold user data, new one has %s: nothing is touched, and reruns say the same", (_, edit) => {
  const u = freshUserHome();
  writeUserHome(u.old);
  writeFreshHome(u.new, edit);
  const oldState = readFileSync(join(u.old, "state.json"), "utf8");
  const newEntries = readdirSync(u.new).sort();

  for (let i = 0; i < 2; i++) {
    const result = run(u.home);
    expect(result).toMatchObject({ kind: "conflict", from: u.old, to: u.new, legacyEnv: null });
    expect(result.kind === "conflict" && result.message).toContain(`found data in both ${u.old} and ${u.new}`);
  }
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
  expect(isLink(u.new)).toBe(false);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(oldState);
  expect(readdirSync(u.new).sort()).toEqual(newEntries);
});

test("the conflict message's recipe works: move the new home away, rerun, and it links", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  writeFreshHome(u.new, { disk: writeIn("library", "plan.md") });
  const result = run(u.home);
  expect(result.kind === "conflict" && result.message).toBe(
    `ClaudioBot found data in both ${u.old} and ${u.new}. It is using ${u.new} and has not touched ${u.old}. ` +
      `To use the data in ${u.old} instead, stop the bridge, move ${u.new} somewhere else, and start the bridge again: ` +
      `it will link ${u.new} to ${u.old}.`,
  );

  renameSync(u.new, join(u.home, "claudiobot-kept"));
  expect(run(u.home)).toEqual({ kind: "linked", from: u.old, to: u.new, legacyEnv: null });
  expect(realpathSync(u.new)).toBe(u.old);
  expect(readFileSync(join(u.home, "claudiobot-kept", "bots", DEFAULT_ID, "library", "plan.md"), "utf8")).toBe("notes");
});

test.each([
  ["user data", writeUserHome],
  ["only the default bot", writeFreshHome],
] as const)("a plain file at the new path is a conflict when the old home holds %s", (_, writeOld) => {
  const u = freshUserHome();
  writeOld(u.old);
  writeFileSync(u.new, "not a directory");
  expect(run(u.home)).toMatchObject({ kind: "conflict", from: u.old, to: u.new, legacyEnv: null });
  expect(readFileSync(u.new, "utf8")).toBe("not a directory");
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
});

test("new home holds the user's bots and the old one only the default bot: the new home is kept as is", () => {
  const u = freshUserHome();
  writeFreshHome(u.old);
  writeUserHome(u.new);
  expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(isLink(u.new)).toBe(false);
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
});

test.each(["EXDEV", "EBUSY"])("a move-aside that fails with %s throws and leaves both homes as they were", (code) => {
  const u = freshUserHome();
  writeUserHome(u.old);
  writeFreshHome(u.new);
  const newEntries = readdirSync(u.new).sort();
  const failing: MigrationFs = {
    renameSync: () => {
      throw Object.assign(new Error(`${code}: rename failed`), { code });
    },
    symlinkSync,
  };

  expect(() => run(u.home, {}, failing)).toThrow(`${code}: rename failed`);
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
  expect(isLink(u.new)).toBe(false);
  expect(readdirSync(u.new).sort()).toEqual(newEntries);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(JSON.stringify(userV2));
});

test("a crash between move-aside and link leaves the old home resolving, and the next run links", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  writeFreshHome(u.new);
  const freshState = readFileSync(join(u.new, "state.json"), "utf8");
  const crashing: MigrationFs = { renameSync, symlinkSync: () => { throw new Error("power cut"); } };

  expect(() => run(u.home, {}, crashing)).toThrow("power cut");
  expect(existsSync(u.new)).toBe(false);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(JSON.stringify(userV2));
  expect(readFileSync(join(u.home, ASIDE, "state.json"), "utf8")).toBe(freshState);

  expect(run(u.home)).toEqual({ kind: "linked", from: u.old, to: u.new, legacyEnv: null });
  expect(realpathSync(u.new)).toBe(u.old);
  expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot", ASIDE]);
});

test("a dangling link at the new path is moved aside and replaced", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  symlinkSync(join(u.home, "gone"), u.new);
  expect(run(u.home)).toEqual({ kind: "moved_aside", from: u.old, to: u.new, aside: join(u.home, ASIDE), legacyEnv: null });
  expect(readlinkSync(join(u.home, ASIDE))).toBe(join(u.home, "gone"));
  expect(realpathSync(u.new)).toBe(u.old);
});

test("the link made in the other direction (old -> new) counts as done", () => {
  const u = freshUserHome();
  writeUserHome(u.new);
  symlinkSync(".claudiobot", u.old);
  expect(run(u.home)).toEqual({ kind: "none", legacyEnv: null });
  expect(isLink(u.new)).toBe(false);
  expect(readlinkSync(u.old)).toBe(".claudiobot");
});

test("an earlier backup with the same timestamp is kept, and the new one gets a suffix", () => {
  const u = freshUserHome();
  writeUserHome(u.old);
  writeFreshHome(u.new);
  const freshState = readFileSync(join(u.new, "state.json"), "utf8");
  mkdirSync(join(u.home, ASIDE));
  writeFileSync(join(u.home, ASIDE, "keep.txt"), "earlier");
  expect(run(u.home)).toEqual({ kind: "moved_aside", from: u.old, to: u.new, aside: join(u.home, `${ASIDE}-2`), legacyEnv: null });
  expect(readFileSync(join(u.home, ASIDE, "keep.txt"), "utf8")).toBe("earlier");
  expect(readFileSync(join(u.home, `${ASIDE}-2`, "state.json"), "utf8")).toBe(freshState);
});
