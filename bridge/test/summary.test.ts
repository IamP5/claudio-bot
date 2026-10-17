import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalDetail, toolSummary } from "../src/summary";

const cwd = "/Users/me/app";

test.each([
  ["Bash", { command: "bun test --watch", description: "run tests" }, "bun test --watch"],
  ["Read", { file_path: "/Users/me/app/src/auth.ts" }, "src/auth.ts"],
  ["Edit", { file_path: "/Users/me/app/README.md", old_string: "a", new_string: "b" }, "README.md"],
  ["Write", { file_path: "/tmp/elsewhere.txt", content: "x" }, "/tmp/elsewhere.txt"],
  ["Grep", { pattern: "TODO", path: "src" }, "TODO"],
  ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
  ["WebFetch", { url: "https://example.com", prompt: "summarize" }, "https://example.com"],
  ["mcp__linear__create_issue", { count: 3, title: "Bug" }, "Bug"],
  ["Bash", { command: "echo one\necho two" }, "echo one echo two"],
] as const)("%s summary", (name, input, expected) => {
  expect(toolSummary(name, input, cwd)).toBe(expected);
});

test("Edit detail is a -/+ diff of old and new strings", () => {
  expect(approvalDetail("Edit", { file_path: "a", old_string: "one\ntwo", new_string: "three" })).toBe("- one\n- two\n+ three");
});

test("Write detail shows only the first 40 lines", () => {
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const lines = approvalDetail("Write", { file_path: "a", content }).split("\n");
  expect(lines).toHaveLength(40);
  expect(lines.at(-1)).toBe("line 40");
});

test("Bash detail is the full command", () => {
  const command = "git add -A &&\n  git commit -m 'x'";
  expect(approvalDetail("Bash", { command })).toBe(command);
});

test("paths under a symlinked cwd are shown relative", () => {
  const real = mkdtempSync(join(tmpdir(), "summary-real-"));
  const link = join(tmpdir(), `summary-link-${process.pid}`);
  symlinkSync(real, link);
  try {
    writeFileSync(join(real, "hello.py"), "");
    expect(toolSummary("Write", { file_path: join(realpathSync(real), "hello.py") }, link)).toBe("hello.py");
    expect(toolSummary("Read", { file_path: join(link, "hello.py") }, realpathSync(real))).toBe("hello.py");
    expect(toolSummary("Read", { file_path: join(realpathSync(real), "new", "file.py") }, link)).toBe("new/file.py");
  } finally {
    rmSync(link);
    rmSync(real, { recursive: true });
  }
});
