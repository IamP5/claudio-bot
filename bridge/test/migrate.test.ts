import { afterEach, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateHome } from "../src/migrate";
import { loadWorld, upgradeV2, type StateFileV2 } from "../src/store";

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

const run = (home: string, env: Record<string, string | undefined> = {}) => migrateHome({ env, home, now });

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

// What first run leaves: the default bot, which greeted the user, and nothing the user typed.
const defaultBot = (name: string): StateFileV2["bots"][number] => ({
  ...userV2.bots[0]!,
  id: "b_default" as never,
  name,
  routines: [],
  messages: [{ kind: "bot", id: "m_hi" as never, at, text: "Hi! What can I take off your plate?" }],
  unread: 1,
  sessionId: "66666666-7777-8888-9999-000000000000",
});
const freshV2: StateFileV2 = { version: 2, bots: [defaultBot("Claude Bot")], agents: [] };
const freshV3 = upgradeV2({ version: 2, bots: [defaultBot("Claudio Bot")], agents: [] });

/** A bot home on disk. The token is mode 000, so any attempt to read it throws and fails the test. */
function writeHome(dir: string, state: unknown | string | null, opts: { token?: boolean; userMd?: string } = {}) {
  mkdirSync(join(dir, "bots", "b_claude", "library"), { recursive: true });
  writeFileSync(join(dir, "bots", "b_claude", "CLAUDE.md"), "# memory\n");
  writeFileSync(join(dir, "USER.md"), opts.userMd ?? "# About Sam\n\n");
  if (state !== null) writeFileSync(join(dir, "state.json"), typeof state === "string" ? state : JSON.stringify(state));
  if (opts.token !== false) {
    writeFileSync(join(dir, "token"), "0123abcd\n");
    chmodSync(join(dir, "token"), 0o000);
  }
}

const isLink = (path: string) => lstatSync(path).isSymbolicLink();

test("CLAUDIOBOT_HOME set: nothing happens, even with the old home present", () => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
  expect(run(u.home, { CLAUDIOBOT_HOME: join(u.home, "elsewhere") })).toEqual({ kind: "none" });
  expect(readdirSync(u.home)).toEqual([".claudebot"]);
});

test("no old home: nothing happens, whether or not the new home exists", () => {
  const u = freshUserHome();
  expect(run(u.home)).toEqual({ kind: "none" });
  expect(readdirSync(u.home)).toEqual([]);
  writeHome(u.new, freshV3);
  expect(run(u.home)).toEqual({ kind: "none" });
  expect(readdirSync(u.home)).toEqual([".claudiobot"]);
  expect(isLink(u.new)).toBe(false);
});

test("old home only: links the new path to it without moving a byte, then reruns are no-ops", () => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
  const before = readFileSync(join(u.old, "state.json"), "utf8");

  expect(run(u.home)).toEqual({ kind: "linked", from: u.old, to: u.new });
  expect(readlinkSync(u.new)).toBe(".claudebot");
  expect(realpathSync(u.new)).toBe(u.old);
  expect(readFileSync(join(u.new, "state.json"), "utf8")).toBe(before);
  expect(readFileSync(join(u.new, "bots", "b_claude", "CLAUDE.md"), "utf8")).toBe("# memory\n");
  expect(isLink(u.old)).toBe(false);

  for (let i = 0; i < 3; i++) expect(run(u.home)).toEqual({ kind: "none" });
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(before);
});

test("after linking, the store loads through the new path and bot cwds keep their old real path", () => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
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

test.each([
  ["an empty directory", (dir: string) => mkdirSync(dir)],
  ["only a token", (dir: string) => writeHome(dir, null, { userMd: "# About Sam (new)\n\n" })],
  ["a token and the v3 default bot that only greeted", (dir: string) => writeHome(dir, freshV3, { userMd: "# About Sam (new)\n\n" })],
  ["the v2 default bot under its old name", (dir: string) => writeHome(dir, freshV2)],
  ["a state with no bots at all", (dir: string) => writeHome(dir, { version: 3, bots: [], agents: [] })],
] as const)("both homes, new one holds %s: moved aside, then linked", (_, setup) => {
  const u = freshUserHome();
  writeHome(u.old, userV2, { userMd: "# About Sam (old)\n\n" });
  setup(u.new);
  const newEntries = readdirSync(u.new).sort();

  expect(run(u.home)).toEqual({ kind: "moved_aside", from: u.old, to: u.new, aside: join(u.home, ASIDE) });
  expect(realpathSync(u.new)).toBe(u.old);
  expect(readFileSync(join(u.new, "USER.md"), "utf8")).toBe("# About Sam (old)\n\n");
  expect(readdirSync(join(u.home, ASIDE)).sort()).toEqual(newEntries);

  expect(run(u.home)).toEqual({ kind: "none" });
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot", ASIDE]);
});

const userShapes: [string, unknown | string][] = [
  ["two bots (v2)", userV2],
  ["two bots (v3)", upgradeV2(userV2)],
  ["the default bot after the user wrote to it", { ...freshV3, bots: [{ ...freshV3.bots[0]!, messages: upgradeV2(userV2).bots[1]!.messages }] }],
  ["the default bot with a routine", { ...freshV2, bots: [{ ...freshV2.bots[0]!, routines: userV2.bots[0]!.routines }] }],
  ["the default bot with a standing rule", { ...freshV3, bots: [{ ...freshV3.bots[0]!, rules: [{ effect: "allow" }] }] }],
  ["an agent", { ...freshV2, agents: [{ agent: { id: "a_1", title: "Fix tests", where: "mac" }, cwd: "/tmp", messages: [], sessionId: null }] }],
  ["a state.json that is not JSON", "{ \"version\": 2, \"bots\": ["],
  ["a state.json from an unknown version", { version: 9, bots: [], agents: [] }],
  ["a v2 state.json missing bots", { version: 2, agents: [] }],
];

test.each(userShapes)("both homes hold bots, new one has %s: nothing is touched, and reruns say the same", (_, state) => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
  writeHome(u.new, state);
  const oldState = readFileSync(join(u.old, "state.json"), "utf8");
  const newState = readFileSync(join(u.new, "state.json"), "utf8");

  for (let i = 0; i < 2; i++) {
    const result = run(u.home);
    expect(result).toMatchObject({ kind: "conflict", from: u.old, to: u.new });
    expect(result.kind === "conflict" && result.message).toContain(`${u.old} and ${u.new}`);
  }
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
  expect(isLink(u.new)).toBe(false);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(oldState);
  expect(readFileSync(join(u.new, "state.json"), "utf8")).toBe(newState);
});

test("new home holds the user's bots and the old one only the default bot: the new home is kept as is", () => {
  const u = freshUserHome();
  writeHome(u.old, freshV2);
  writeHome(u.new, upgradeV2(userV2));
  expect(run(u.home)).toEqual({ kind: "none" });
  expect(isLink(u.new)).toBe(false);
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot"]);
});

test("a crash between move-aside and link leaves the old home resolving, and the next run links", () => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
  writeHome(u.new, freshV3);
  const crashing = { renameSync: nodeFs.renameSync, symlinkSync: () => { throw new Error("power cut"); } };

  expect(() => migrateHome({ env: {}, home: u.home, now, fs: crashing })).toThrow("power cut");
  expect(existsSync(u.new)).toBe(false);
  expect(readFileSync(join(u.old, "state.json"), "utf8")).toBe(JSON.stringify(userV2));
  expect(readFileSync(join(u.home, ASIDE, "state.json"), "utf8")).toBe(JSON.stringify(freshV3));

  expect(run(u.home)).toEqual({ kind: "linked", from: u.old, to: u.new });
  expect(realpathSync(u.new)).toBe(u.old);
  expect(run(u.home)).toEqual({ kind: "none" });
  expect(readdirSync(u.home).sort()).toEqual([".claudebot", ".claudiobot", ASIDE]);
});

test("a dangling link at the new path is moved aside and replaced", () => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
  symlinkSync(join(u.home, "gone"), u.new);
  expect(run(u.home)).toEqual({ kind: "moved_aside", from: u.old, to: u.new, aside: join(u.home, ASIDE) });
  expect(readlinkSync(join(u.home, ASIDE))).toBe(join(u.home, "gone"));
  expect(realpathSync(u.new)).toBe(u.old);
});

test("the link made in the other direction (old -> new) counts as done", () => {
  const u = freshUserHome();
  writeHome(u.new, upgradeV2(userV2));
  symlinkSync(".claudiobot", u.old);
  expect(run(u.home)).toEqual({ kind: "none" });
  expect(isLink(u.new)).toBe(false);
  expect(readlinkSync(u.old)).toBe(".claudiobot");
});

test("an earlier backup with the same timestamp is kept, and the new one gets a suffix", () => {
  const u = freshUserHome();
  writeHome(u.old, userV2);
  writeHome(u.new, freshV3);
  mkdirSync(join(u.home, ASIDE));
  writeFileSync(join(u.home, ASIDE, "keep.txt"), "earlier");
  expect(run(u.home)).toEqual({ kind: "moved_aside", from: u.old, to: u.new, aside: join(u.home, `${ASIDE}-2`) });
  expect(readFileSync(join(u.home, ASIDE, "keep.txt"), "utf8")).toBe("earlier");
  expect(readFileSync(join(u.home, `${ASIDE}-2`, "state.json"), "utf8")).toBe(JSON.stringify(freshV3));
});
