import { expect, test } from "bun:test";
import { parseGithubRepo, projectId } from "../src/projects";

test.each([
  ["git@github.com:me/drawdown.git", "me/drawdown"],
  ["https://github.com/me/drawdown.git", "me/drawdown"],
  ["https://github.com/me/drawdown", "me/drawdown"],
  ["https://gitlab.com/me/drawdown.git", null],
])("github repo from %s", (url, expected) => {
  expect(parseGithubRepo(url)).toBe(expected);
});

test("project id is stable per path", () => {
  expect(projectId("/Users/me/a")).toBe(projectId("/Users/me/a"));
  expect(projectId("/Users/me/a")).not.toBe(projectId("/Users/me/b"));
});
