import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjects, findProject, parseGithubRepo, type Project, projectLabels, scanProjects } from "../src/projects";
import type { ProjectId } from "../src/protocol";

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

describe("project of a cwd", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "projects-")));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const repo = (name: string, origin: string | null) => {
    const path = join(base, name);
    mkdirSync(join(path, "src"), { recursive: true });
    git(path, "init", "-q");
    git(path, "commit", "-q", "--allow-empty", "-m", "init");
    if (origin) git(path, "remote", "add", "origin", origin);
    return path;
  };
  const soundless = repo("br-soundless", "git@github.com:IamP5/solta-o-som.git");
  const plain = repo("plain", null);

  test("a main checkout and its subfolder are the repo, named after the GitHub repo", () => {
    const projects = createProjects({ file: null });
    const main = projects.of(soundless);
    expect(main).toMatchObject({ root: soundless, name: "solta-o-som", githubRepo: "IamP5/solta-o-som", worktree: false });
    expect(main.id).toMatch(/^[0-9a-f]{16}$/);
    expect(projects.of(join(soundless, "src"))).toEqual(main);
  });

  test("an https origin parses and a repo without a remote takes its folder name", () => {
    const https = repo("web", "https://github.com/acme/web-app.git");
    const projects = createProjects({ file: null });
    expect(projects.of(https)).toMatchObject({ name: "web-app", githubRepo: "acme/web-app" });
    expect(projects.of(plain)).toMatchObject({ root: plain, name: "plain", githubRepo: null, worktree: false });
  });

  test("a folder outside any repo is its own project", () => {
    const loose = join(base, "loose");
    mkdirSync(loose);
    expect(createProjects({ file: null }).of(loose)).toMatchObject({ root: loose, name: "loose", githubRepo: null, worktree: false });
  });

  test("a worktree under .claude/worktrees joins the repo, before and after it is removed", () => {
    const wt = join(soundless, ".claude", "worktrees", "claudio-x");
    git(soundless, "worktree", "add", "-q", "-b", "claudio/x", wt);
    const main = createProjects({ file: null }).of(soundless);
    expect(createProjects({ file: null }).of(wt)).toMatchObject({ id: main.id, root: soundless, worktree: true });
    git(soundless, "worktree", "remove", wt);
    expect(createProjects({ file: null }).of(wt)).toMatchObject({ id: main.id, root: soundless, worktree: true });
  });

  test("a removed worktree outside the repo still maps through the saved file", () => {
    const file = join(base, "cache", "projects.json");
    const wt = join(base, "elsewhere", "claudio-y");
    git(plain, "worktree", "add", "-q", "-b", "claudio/y", wt);
    const first = createProjects({ file });
    const live = first.of(wt);
    expect(live).toMatchObject({ root: plain, name: "plain", worktree: true });
    first.save();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(base, "cache")).mode & 0o777).toBe(0o700);
    git(plain, "worktree", "remove", wt);
    expect(createProjects({ file }).of(wt)).toEqual(live);
    expect(createProjects({ file: null }).of(wt).root).not.toBe(plain);
  });

  test("a corrupt file reads as empty", () => {
    const file = join(base, "corrupt.json");
    writeFileSync(file, "{not json");
    expect(createProjects({ file }).of(plain).root).toBe(plain);
  });
});

test("findProject matches path, folder name, then GitHub repo", () => {
  const projects: Project[] = [
    { name: "br-soundless", path: "/p/br-soundless", branch: null, githubRepo: "IamP5/solta-o-som" },
    { name: "web", path: "/p/web", branch: null, githubRepo: null },
  ];
  expect(findProject(projects, "solta-o-som")?.name).toBe("br-soundless");
  expect(findProject(projects, "iamp5/Solta-O-Som")?.name).toBe("br-soundless");
  expect(findProject(projects, "BR-Soundless")?.name).toBe("br-soundless");
  expect(findProject(projects, " /p/web ")?.name).toBe("web");
  expect(findProject(projects, "nope")).toBeUndefined();
});

describe("labels for projects that share a name", () => {
  const project = (id: string, path: string, githubRepo: string | null = null) => ({ id: id as ProjectId, name: path.split("/").pop()!.replace(/\.git$/, ""), path, githubRepo });

  test("forks of one repo are told apart by owner", () => {
    const labels = projectLabels([project("a", "/Users/me/code/app", "alice/app"), project("b", "/Users/me/forks/app", "bob/app"), project("c", "/Users/me/code/web")]);
    expect(Object.fromEntries(labels)).toEqual({ a: "alice/app", b: "bob/app" });
  });

  test("two clones of the same remote, or folders with no remote, are told apart by their parent folder", () => {
    const labels = projectLabels([project("a", "/Users/me/work/app", "acme/app"), project("b", "/Users/me/home/app", "Acme/App"), project("c", "/Users/me/old/App")]);
    expect(Object.fromEntries(labels)).toEqual({ a: "work/app", b: "home/app", c: "old/App" });
  });

  test("a shared parent folder reaches further up until the paths differ", () => {
    const labels = projectLabels([project("a", "/Users/me/a/src/app"), project("b", "/Users/me/b/src/app")]);
    expect(Object.fromEntries(labels)).toEqual({ a: "a/src/app", b: "b/src/app" });
  });

  test("a project whose name is its own gets no label", () => {
    expect(projectLabels([project("a", "/Users/me/code/app"), project("b", "/Users/me/code/web")]).size).toBe(0);
  });
});
