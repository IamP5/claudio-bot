import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGithubRepo, scanProjects } from "../src/projects";

test.each([
  ["git@github.com:acme/web.git", "acme/web"],
  ["https://github.com/acme/web.git", "acme/web"],
  ["https://github.com/acme/web", "acme/web"],
  ["https://gitlab.com/acme/web.git", null],
])("github repo from %s", (url, expected) => {
  expect(parseGithubRepo(url)).toBe(expected);
});

test("scan returns realpaths and keeps the folder name of a symlinked project", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "scan-")));
  try {
    const target = join(base, "elsewhere", "real-app");
    mkdirSync(join(target, ".git"), { recursive: true });
    const root = join(base, "root");
    mkdirSync(root);
    symlinkSync(target, join(root, "linked"));
    const rootLink = join(base, "root-link");
    symlinkSync(root, rootLink);
    const [project] = await scanProjects([rootLink]);
    expect(project?.path).toBe(target);
    expect(project?.name).toBe("linked");
  } finally {
    rmSync(base, { recursive: true });
  }
});
