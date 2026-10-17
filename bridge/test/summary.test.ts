import { expect, test } from "bun:test";
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
