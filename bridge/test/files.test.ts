import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine } from "../src/machine/files";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "claudiobot-files-"));
  dirs.push(d);
  return d;
};

test("appendLine adds a line to a regular file and refuses a symlink planted in its place", () => {
  const dir = tmp();
  appendLine(join(dir, "outbox.jsonl"), "one");
  appendLine(join(dir, "outbox.jsonl"), "two");
  expect(readFileSync(join(dir, "outbox.jsonl"), "utf8")).toBe("one\ntwo\n");

  const target = join(tmp(), "elsewhere");
  writeFileSync(target, "kept\n");
  symlinkSync(target, join(dir, "applied.jsonl"));
  expect(() => appendLine(join(dir, "applied.jsonl"), "planted")).toThrow();
  expect(readFileSync(target, "utf8")).toBe("kept\n");
});
