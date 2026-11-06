import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedGit, inRepo } from "../src/evidence";
import { PRIVATE } from "../src/private";
import { appendArchive } from "../src/store";
import { splitHistory } from "../src/world";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-helpers-")));
  roots.push(dir);
  return dir;
};
const sh = (cwd: string, ...argv: string[]) => {
  const ran = Bun.spawnSync(argv, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  if (ran.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${ran.stderr}`);
};

test("hardenedGit runs no hook, fsmonitor or filter program the repo configures", async () => {
  const repo = temp();
  const ran = join(repo, "ran");
  sh(repo, "git", "init", "-q");
  sh(repo, "git", "config", "filter.evil.clean", `touch ${ran}-clean`);
  sh(repo, "git", "config", "filter.evil.smudge", `touch ${ran}-smudge`);
  sh(repo, "git", "config", "filter.evil.required", "true");
  sh(repo, "git", "config", "core.fsmonitor", `touch ${ran}-fsmonitor`);
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });

  const git = await hardenedGit(repo);
  expect(await git(["add", "-A"])).toBe("");
  expect(await git(["status", "--porcelain"])).toContain("a.txt");
  expect(["clean", "smudge", "fsmonitor"].filter((k) => existsSync(`${ran}-${k}`))).toEqual([]);
});

test("inRepo finds a .git in the folder or above it, and nothing outside", () => {
  const repo = temp();
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "a", "b"), { recursive: true });
  expect([inRepo(repo), inRepo(join(repo, "a", "b")), inRepo(temp())]).toEqual([true, true, false]);
});

test("splitHistory leaves a thread within bounds alone, then archives the oldest and keeps the newest thousand and the pinned", () => {
  const n = (count: number) => Array.from({ length: count }, (_, i) => i);
  expect(splitHistory(n(1100), () => false)).toBeNull();
  const split = splitHistory(n(1101), (m) => m === 3)!;
  expect(split.kept).toHaveLength(1001);
  expect(split.kept.slice(0, 2)).toEqual([3, 101]);
  expect(split.archived).toEqual(n(101).filter((m) => m !== 3));
});

test("appendArchive appends JSON lines to a private file in a private folder", () => {
  const path = join(temp(), "history", "main.jsonl");
  appendArchive(path, [{ id: 1 }]);
  appendArchive(path, [{ id: 2 }, { id: 3 }]);
  expect(readFileSync(path, "utf8")).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
  expect([statSync(path).mode & 0o777, statSync(join(path, "..")).mode & 0o777]).toEqual([0o600, 0o700]);
});

test.each(Object.entries(PRIVATE))("PRIVATE.%s holds distinct relative paths with no trailing slash", (_platform, paths) => {
  const all = Object.values(paths).flat();
  expect(all.filter((p) => p.startsWith("/") || p.startsWith("~") || p.endsWith("/") || p.includes(".."))).toEqual([]);
  expect(new Set(all).size).toBe(all.length);
});
