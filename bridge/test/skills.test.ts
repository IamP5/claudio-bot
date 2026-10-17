import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHomes } from "../src/home";
import type { BotId } from "../src/protocol";
import { createSkills, descriptionOf } from "../src/skills";
import { botToolServer, type BotActions } from "../src/tools";

const BOT = "b_ada" as BotId;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  dirs.push(root);
  const homes = createHomes(root);
  homes.create(BOT, "# Ada\n");
  const reopened: BotId[] = [];
  const skills = createSkills({ homes, reopen: (id) => reopened.push(id), now: () => new Date("2026-10-17T12:00:00Z") });
  const home = homes.homeOf(BOT);
  const skillsDir = join(home, ".claude", "skills");
  return { root, homes, home, skillsDir, skills, reopened };
}

const greet = { name: "greet", description: "Greet the user", body: "Reply exactly GREET-OK" };

test("a saved skill is a SKILL.md in the bot's project skill path, listed back and removed", () => {
  const s = setup();
  const reply = s.skills.save(BOT, greet);
  expect(reply).toContain("greet");

  const file = join(s.skillsDir, "greet", "SKILL.md");
  expect(readFileSync(file, "utf8")).toBe('---\nname: greet\ndescription: "Greet the user"\n---\n\nReply exactly GREET-OK\n');
  expect(s.skills.list(BOT)).toEqual([{ name: "greet", description: "Greet the user", updatedAt: statSync(file).mtime.toISOString() }]);

  expect(s.skills.remove(BOT, "greet")).toEqual({ ok: true });
  expect(existsSync(join(s.skillsDir, "greet"))).toBe(false);
  expect(s.skills.list(BOT)).toEqual([]);
});

test("skill files are private: 0600 files in 0700 folders, with no temp file left behind", () => {
  const s = setup();
  s.skills.save(BOT, greet);
  for (const d of [join(s.home, ".claude"), s.skillsDir, join(s.skillsDir, "greet")]) expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(statSync(join(s.skillsDir, "greet", "SKILL.md")).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(s.skillsDir, "greet"))).toEqual(["SKILL.md"]);
});

test("a description with quotes and colons round-trips through the frontmatter", () => {
  const s = setup();
  const description = 'Use for "deploy": staging, then prod # not a comment';
  s.skills.save(BOT, { ...greet, description });
  expect(s.skills.list(BOT)[0]!.description).toBe(description);
});

test("saving a name again replaces that skill", () => {
  const s = setup();
  s.skills.save(BOT, greet);
  const reply = s.skills.save(BOT, { ...greet, description: "Say hi", body: "Reply exactly HI" });
  expect(reply).toContain("Replaced");
  expect(s.skills.list(BOT).map((k) => k.description)).toEqual(["Say hi"]);
  expect(readFileSync(join(s.skillsDir, "greet", "SKILL.md"), "utf8")).toContain("Reply exactly HI");
});

test("reopen is called once per save and per remove, and not for a refusal", () => {
  const s = setup();
  s.skills.save(BOT, greet);
  s.skills.save(BOT, greet);
  s.skills.remove(BOT, "greet");
  expect(() => s.skills.save(BOT, { ...greet, name: "Bad Name" })).toThrow();
  s.skills.remove(BOT, "greet");
  expect(s.reopened).toEqual([BOT, BOT, BOT]);
});

const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123"].join("");

test.each([
  ["an upper-case name", { name: "Greet" }],
  ["a name with a space", { name: "say hi" }],
  ["a name with a leading hyphen", { name: "-greet" }],
  ["a name with a double hyphen", { name: "say--hi" }],
  ["a path in the name", { name: "../escape" }],
  ["a name over 64 characters", { name: "a".repeat(65) }],
  ["an empty description", { description: "  " }],
  ["a two-line description", { description: "Greet\nthe user" }],
  ["a description over 200 characters", { description: "d".repeat(201) }],
  ["an empty body", { body: "\n" }],
  ["a body over 20 KB", { body: "b".repeat(20 * 1024 + 1) }],
  ["a hidden character in the description", { description: "Greet‮resu" }],
  ["a hidden character in the body", { body: "Reply​ exactly" }],
  ["a secret in the body", { body: `Use the token ${secret} to call the API` }],
  ["a secret in the description", { description: `password=hunter2hunter2` }],
])("save refuses %s", (_, patch) => {
  const s = setup();
  expect(() => s.skills.save(BOT, { ...greet, ...patch })).toThrow();
  expect(s.skills.list(BOT)).toEqual([]);
  expect(s.reopened).toEqual([]);
});

test("the edges of the limits are accepted, and a body keeps its line breaks and tabs", () => {
  const s = setup();
  s.skills.save(BOT, { name: "a".repeat(64), description: "d".repeat(200), body: `${"b".repeat(20 * 1024 - 2)}\n\t` });
  s.skills.save(BOT, { ...greet, body: "Step one\r\n\tStep two\n" });
  expect(s.skills.list(BOT).map((k) => k.name)).toEqual(["a".repeat(64), "greet"]);
});

test("a bot holds at most 30 skills, but can still replace one at the cap", () => {
  const s = setup();
  for (let i = 0; i < 30; i++) s.skills.save(BOT, { ...greet, name: `skill-${i}` });
  expect(() => s.skills.save(BOT, { ...greet, name: "one-more" })).toThrow(/30/);
  expect(s.skills.save(BOT, { ...greet, name: "skill-7", body: "Changed" })).toContain("Replaced");
  expect(s.skills.list(BOT)).toHaveLength(30);
});

test("a symlinked skills folder is never written through, listed or removed from", () => {
  const s = setup();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  dirs.push(outside);
  mkdirSync(join(outside, "greet"));
  writeFileSync(join(outside, "greet", "SKILL.md"), "---\nname: greet\ndescription: planted\n---\nbody\n");
  mkdirSync(join(s.home, ".claude"));
  symlinkSync(outside, s.skillsDir);

  expect(() => s.skills.save(BOT, { ...greet, name: "new-one" })).toThrow();
  expect(existsSync(join(outside, "new-one"))).toBe(false);
  expect(s.skills.list(BOT)).toEqual([]);
  expect(s.skills.remove(BOT, "greet").ok).toBe(false);
  expect(existsSync(join(outside, "greet", "SKILL.md"))).toBe(true);
});

test("a symlinked .claude folder is never written through", () => {
  const s = setup();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  dirs.push(outside);
  symlinkSync(outside, join(s.home, ".claude"));
  expect(() => s.skills.save(BOT, greet)).toThrow();
  expect(readdirSync(outside)).toEqual([]);
});

test("a symlinked skill folder or SKILL.md is not listed, removed or replaced", () => {
  const s = setup();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  dirs.push(outside);
  writeFileSync(join(outside, "SKILL.md"), "---\ndescription: planted\n---\n");
  s.skills.save(BOT, { ...greet, name: "real" });
  symlinkSync(outside, join(s.skillsDir, "linked"));
  mkdirSync(join(s.skillsDir, "file-link"));
  symlinkSync(join(outside, "SKILL.md"), join(s.skillsDir, "file-link", "SKILL.md"));

  expect(s.skills.list(BOT).map((k) => k.name)).toEqual(["real"]);
  expect(s.skills.remove(BOT, "linked").ok).toBe(false);
  expect(() => s.skills.save(BOT, { ...greet, name: "linked" })).toThrow();
  expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toContain("planted");
});

test("removing an unknown or invalid name is refused", () => {
  const s = setup();
  expect(s.skills.remove(BOT, "nope")).toEqual({ ok: false, error: expect.stringContaining("nope") });
  expect(s.skills.remove(BOT, "../library").ok).toBe(false);
  expect(existsSync(join(s.home, "library"))).toBe(true);
});

test("a bot with no home lists nothing and cannot save", () => {
  const s = setup();
  const ghost = "b_ghost" as BotId;
  expect(s.skills.list(ghost)).toEqual([]);
  expect(() => s.skills.save(ghost, greet)).toThrow();
  expect(s.skills.remove(ghost, "greet").ok).toBe(false);
});

test("a hand-written skill lists with its description, and stray files are ignored", () => {
  const s = setup();
  mkdirSync(join(s.skillsDir, "notes"), { recursive: true });
  writeFileSync(join(s.skillsDir, "notes", "SKILL.md"), "---\nname: notes\ndescription: Take notes: briefly\n---\nbody\n");
  mkdirSync(join(s.skillsDir, "empty"));
  writeFileSync(join(s.skillsDir, "README.md"), "hi");
  expect(s.skills.list(BOT).map(({ name, description }) => ({ name, description }))).toEqual([{ name: "notes", description: "Take notes: briefly" }]);
});

test.each([
  ['---\ndescription: "Say \\"hi\\""\n---\n', 'Say "hi"'],
  ["---\ndescription: 'It''s fine'\n---\n", "It's fine"],
  ["---\r\nname: x\r\ndescription: plain\r\n---\r\n", "plain"],
  ["no frontmatter", ""],
  ["---\nname: x\n---\n", ""],
])("descriptionOf(%p) is %p", (text, expected) => {
  expect(descriptionOf(text)).toBe(expected);
});

test("save_skill over MCP replies with the save, and a refusal reaches the model as a tool error", async () => {
  const s = setup();
  const server = botToolServer(BOT, { saveSkill: (id, a) => s.skills.save(id, a) } as BotActions);
  const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverEnd);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(clientEnd);

  const ok = await mcp.callTool({ name: "save_skill", arguments: greet });
  expect(ok.isError).toBeFalsy();
  expect(s.skills.list(BOT).map((k) => k.name)).toEqual(["greet"]);

  const bad = await mcp.callTool({ name: "save_skill", arguments: { ...greet, name: "Not Valid" } });
  expect(bad.isError).toBe(true);
  expect(JSON.stringify(bad.content)).toContain("lowercase");
});
