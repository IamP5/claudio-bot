import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { branchOf, prepareWorkspace, removeWorktree, worktreesRoot } from "../src/worktree";

const AGENT = "a_ab12cd34-0000-4000-8000-000000000000";
// Each case spawns real git several times; a loaded machine can take seconds.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-worktree-")));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo() {
  const dir = join(temp(), "shop");
  Bun.spawnSync(["mkdir", dir]);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return { path: dir, name: "shop" };
}

test("none and a clean checkout under auto work in the project folder", async () => {
  const project = repo();
  const root = temp();
  const folder = { cwd: project.path, worktree: null, base: null, note: null };
  expect(await prepareWorkspace(project, AGENT, "none", { root })).toEqual(folder);
  expect(await prepareWorkspace(project, AGENT, "auto", { root })).toEqual(folder);
  expect(readdirSync(root)).toEqual([]);
});

test("worktree makes a new worktree on claudio/<id> from main, and the main checkout is untouched", async () => {
  const project = repo();
  const root = temp();
  git(project.path, "checkout", "-q", "-b", "elsewhere");
  writeFileSync(join(project.path, "wip.txt"), "mine\n");

  const ws = await prepareWorkspace(project, AGENT, "worktree", { root });

  const path = join(root, "shop", AGENT);
  expect(ws).toEqual({ cwd: path, worktree: { path, branch: "claudio/ab12cd34" }, base: git(project.path, "rev-parse", "main"), note: null });
  expect(branchOf(AGENT)).toBe("claudio/ab12cd34");
  expect([git(path, "symbolic-ref", "--short", "HEAD"), git(path, "rev-parse", "HEAD")]).toEqual(["claudio/ab12cd34", git(project.path, "rev-parse", "main")]);
  expect([git(project.path, "symbolic-ref", "--short", "HEAD"), git(project.path, "status", "--porcelain")]).toEqual(["elsewhere", "?? wip.txt"]);
  expect(existsSync(join(path, "wip.txt"))).toBe(false);
  expect((statSync(join(root, "shop")).mode & 0o777).toString(8)).toBe("700");
});

test("auto makes a worktree when the checkout is dirty or another live agent works in it", async () => {
  const project = repo();
  const root = temp();
  expect((await prepareWorkspace(project, "a_11111111", "auto", { root, busy: true })).worktree?.branch).toBe("claudio/11111111");
  writeFileSync(join(project.path, "README.md"), "edited\n");
  expect((await prepareWorkspace(project, "a_22222222", "auto", { root })).worktree?.branch).toBe("claudio/22222222");
});

test("a worktree made from origin's default branch does not track it", async () => {
  const origin = repo();
  const dir = join(temp(), "clone");
  git(origin.path, "clone", "-q", origin.path, dir);
  git(dir, "branch", "-q", "-m", "main", "local-only");

  const ws = await prepareWorkspace({ path: dir, name: "clone" }, AGENT, "worktree", { root: temp() });

  expect(git(ws.cwd, "rev-parse", "HEAD")).toBe(git(dir, "rev-parse", "origin/main"));
  expect(Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: ws.cwd }).exitCode).not.toBe(0);
});

test("a folder outside git works in place, unless a worktree was asked for", async () => {
  const dir = temp();
  expect(await prepareWorkspace({ path: dir, name: "notes" }, AGENT, "auto", { root: temp() })).toEqual({ cwd: dir, worktree: null, base: null, note: null });
  expect(prepareWorkspace({ path: dir, name: "notes" }, AGENT, "worktree", { root: temp() })).rejects.toThrow("notes is not a git repository");
});

test("a repo with no main or master branch cannot have a worktree, and auto works in the folder with a note", async () => {
  const project = repo();
  git(project.path, "branch", "-q", "-m", "main", "trunk");
  expect(prepareWorkspace(project, AGENT, "worktree", { root: temp() })).rejects.toThrow("no main or master branch");
  expect(await prepareWorkspace(project, AGENT, "auto", { root: temp(), busy: true })).toEqual({
    cwd: project.path,
    worktree: null,
    base: null,
    note: "shop has no main or master branch to start a worktree from, so the agent works in the project folder.",
  });
});

test("a repo whose filter is required (git-lfs) still gets a worktree, with the filter not run", async () => {
  const project = repo();
  writeFileSync(join(project.path, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(join(project.path, "a.bin"), "blob\n");
  git(project.path, "add", ".");
  git(project.path, "commit", "-q", "-m", "lfs");
  git(project.path, "config", "filter.lfs.smudge", "/nonexistent/git-lfs smudge");
  git(project.path, "config", "filter.lfs.process", "/nonexistent/git-lfs filter-process");
  git(project.path, "config", "filter.lfs.required", "true");

  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  expect(readFileSync(join(ws.cwd, "a.bin"), "utf8")).toBe("blob\n");
});

test("making the worktree runs none of the repo's hooks or filters", async () => {
  const project = repo();
  const out = temp();
  const planted = (name: string) => {
    const script = join(out, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch '${join(out, name)}.ran'\ncat 2>/dev/null\nexit 0\n`);
    chmodSync(script, 0o755);
    return script;
  };
  writeFileSync(join(project.path, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(project.path, "a.txt"), "one\n");
  git(project.path, "add", ".");
  git(project.path, "commit", "-q", "-m", "attrs");
  writeFileSync(join(project.path, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${join(out, "hook")}.ran'\n`);
  chmodSync(join(project.path, ".git", "hooks", "post-checkout"), 0o755);
  git(project.path, "config", "filter.evil.smudge", planted("smudge"));
  const ran = () => ["hook", "smudge"].filter((n) => existsSync(join(out, `${n}.ran`)));

  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  expect([ran(), git(ws.cwd, "show", "HEAD:a.txt")]).toEqual([[], "one"]);

  git(project.path, "worktree", "add", "-q", "--detach", join(temp(), "plain"), "main");
  expect(ran()).toEqual(["hook", "smudge"]);
});

test("removing is refused while the worktree holds uncommitted work, and keeps the branch and its commits", async () => {
  const project = repo();
  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  const worktree = ws.worktree!;
  writeFileSync(join(ws.cwd, "fix.ts"), "x\n");

  expect(await removeWorktree(project.path, worktree)).toEqual({ ok: false, error: expect.stringContaining("uncommitted changes") });
  expect(existsSync(join(ws.cwd, "fix.ts"))).toBe(true);

  git(ws.cwd, "add", ".");
  git(ws.cwd, "commit", "-q", "-m", "fix");
  const head = git(ws.cwd, "rev-parse", "HEAD");
  expect(await removeWorktree(project.path, worktree)).toEqual({ ok: true });
  expect([existsSync(ws.cwd), git(project.path, "rev-parse", worktree.branch)]).toEqual([false, head]);
  expect(git(project.path, "worktree", "list")).not.toContain(ws.cwd);
});

test("a worktree folder deleted by hand is pruned", async () => {
  const project = repo();
  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  rmSync(ws.cwd, { recursive: true, force: true });
  expect(await removeWorktree(project.path, ws.worktree!)).toEqual({ ok: true });
  expect(git(project.path, "worktree", "list")).not.toContain(ws.cwd);
});

test("making the worktree blanks a filter driver whose name holds =", async () => {
  const project = repo();
  const out = temp();
  const script = join(out, "smudge.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${join(out, "smudge.ran")}'\ncat\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(project.path, ".gitattributes"), "*.txt filter=a=b\n");
  writeFileSync(join(project.path, "a.txt"), "one\n");
  git(project.path, "add", ".");
  git(project.path, "commit", "-q", "-m", "attrs");
  git(project.path, "config", "filter.a=b.smudge", script);

  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  expect([existsSync(join(out, "smudge.ran")), git(ws.cwd, "show", "HEAD:a.txt")]).toEqual([false, "one"]);
});

test("a default branch named like an option never reaches git worktree add as one", async () => {
  const project = repo();
  git(project.path, "checkout", "-q", "-b", "elsewhere");
  writeFileSync(join(project.path, "other.txt"), "x\n");
  git(project.path, "add", ".");
  git(project.path, "commit", "-q", "-m", "elsewhere");
  git(project.path, "update-ref", "refs/heads/--lock", "elsewhere");
  git(project.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/--lock");

  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  expect(git(ws.cwd, "rev-parse", "HEAD")).toBe(git(project.path, "rev-parse", "main"));
  expect(git(project.path, "worktree", "list", "--porcelain")).not.toContain("locked");
});

test("removing is refused while the worktree holds ignored files, except build folders that come back", async () => {
  const project = repo();
  writeFileSync(join(project.path, ".gitignore"), ".env\nnode_modules/\ndist/\n");
  git(project.path, "add", ".");
  git(project.path, "commit", "-q", "-m", "ignore");
  const ws = await prepareWorkspace(project, AGENT, "worktree", { root: temp() });
  mkdirSync(join(ws.cwd, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(ws.cwd, "node_modules", "left-pad", "index.js"), "x\n");
  mkdirSync(join(ws.cwd, "dist"));
  writeFileSync(join(ws.cwd, "dist", "app.js"), "x\n");
  writeFileSync(join(ws.cwd, ".env"), "TOKEN=1\n");

  expect(await removeWorktree(project.path, ws.worktree!)).toEqual({ ok: false, error: expect.stringContaining("ignored files that removing it would delete: .env.") });
  expect(existsSync(join(ws.cwd, ".env"))).toBe(true);

  rmSync(join(ws.cwd, ".env"));
  expect(await removeWorktree(project.path, ws.worktree!)).toEqual({ ok: true });
  expect(existsSync(ws.cwd)).toBe(false);
});

test("worktrees go under ~/.claudiobot-worktrees unless CLAUDIOBOT_WORKTREES names another folder", () => {
  expect(worktreesRoot({})).toBe(join(homedir(), ".claudiobot-worktrees"));
  expect(worktreesRoot({ CLAUDIOBOT_WORKTREES: "/tmp/wt" })).toBe("/tmp/wt");
});
