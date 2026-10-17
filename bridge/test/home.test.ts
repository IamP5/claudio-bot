import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomes } from "../src/home";
import type { BotId } from "../src/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "claudebot-homes-")));
afterAll(() => rmSync(root, { recursive: true }));
const homes = createHomes(root);
let n = 0;
const fresh = () => {
  const id = `b${++n}` as BotId;
  homes.create(id, "# memory\n");
  return { id, home: homes.homeOf(id) };
};

test("a new home has CLAUDE.md, library and inbox, and creating it again keeps the bot's edits", () => {
  const { id, home } = fresh();
  writeFileSync(join(home, "CLAUDE.md"), "# edited\n");
  homes.create(id, "# memory\n");
  expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("# edited\n");
  expect(existsSync(join(home, "library"))).toBe(true);
  expect(existsSync(join(home, "inbox"))).toBe(true);
});

test("library lists files recursively, newest first, skipping dotfiles, with home-relative paths", () => {
  const { id, home } = fresh();
  mkdirSync(join(home, "library", "notes"));
  writeFileSync(join(home, "library", "old.md"), "old");
  writeFileSync(join(home, "library", "notes", "new.md"), "new!");
  writeFileSync(join(home, "library", ".DS_Store"), "");
  utimesSync(join(home, "library", "old.md"), new Date("2026-01-01"), new Date("2026-01-01"));
  expect(homes.library(id).map((f) => [f.path, f.size])).toEqual([
    ["library/notes/new.md", 4],
    ["library/old.md", 3],
  ]);
});

test("reads text and images inside the home", async () => {
  const { id, home } = fresh();
  writeFileSync(join(home, "library", "plan.md"), "# Plan\n");
  writeFileSync(join(home, "inbox", "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(home, "blob.bin"), Buffer.from([0, 1, 2]));
  expect(await homes.read(id, "library/plan.md")).toEqual({ mime: "text/markdown", content: "# Plan\n", data: null });
  expect(await homes.read(id, "inbox/dot.png")).toEqual({ mime: "image/png", content: null, data: "iVBORw==" });
  expect(await homes.read(id, "blob.bin")).toMatchObject({ content: null, data: null });
});

test("refuses paths that resolve outside the home", async () => {
  const { id, home } = fresh();
  writeFileSync(join(root, "secret.txt"), "token");
  symlinkSync(join(root, "secret.txt"), join(home, "library", "link.txt"));
  for (const path of ["../../secret.txt", join(root, "secret.txt"), "library/link.txt", "missing.md"]) {
    expect(await homes.read(id, path)).toHaveProperty("error");
  }
});

test("uploads land in inbox under unique, safe names", () => {
  const { id, home } = fresh();
  const data = Buffer.from("hi").toString("base64");
  const saved = homes.saveUploads(id, [
    { name: "shot.png", mime: "image/png", data },
    { name: "shot.png", mime: "image/png", data },
    { name: "../../escape.txt", mime: "text/plain", data },
  ]);
  expect(saved).toEqual([
    { name: "shot.png", mime: "image/png", path: "inbox/shot.png" },
    { name: "shot.png", mime: "image/png", path: "inbox/shot-2.png" },
    { name: "../../escape.txt", mime: "text/plain", path: "inbox/escape.txt" },
  ]);
  expect(readdirSync(join(home, "inbox")).sort()).toEqual(["escape.txt", "shot-2.png", "shot.png"]);
});

test("uploads over 10 MB are refused", () => {
  const { id } = fresh();
  const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  expect(homes.saveUploads(id, [{ name: "big.bin", mime: "application/octet-stream", data: big }])).toHaveProperty("error");
});

test("trash moves the home aside instead of deleting it", () => {
  const { id, home } = fresh();
  writeFileSync(join(home, "library", "keep.md"), "keep");
  homes.trash(id, new Date(1000));
  expect(existsSync(home)).toBe(false);
  expect(readFileSync(join(root, "trash", `${id}-1000`, "library", "keep.md"), "utf8")).toBe("keep");
});
