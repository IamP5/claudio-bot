import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceLine, prOf, readEvidence } from "../src/evidence";

const NOW = new Date("2026-10-17T12:00:00.000Z");
// Each case spawns real git several times; a loaded machine can take seconds.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-evidence-")));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string, body: string) {
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

function repo() {
  const dir = temp();
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "README.md", "hello\n");
  return dir;
}

test("a branch's commits ahead of main, its diffstat and a clean checkout", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "fix-login");
  commit(dir, "login.ts", "a\nb\nc\n");
  commit(dir, "README.md", "hello\nworld\n");

  expect(await readEvidence(dir, "Done.", NOW)).toEqual({
    at: NOW.toISOString(),
    branch: "fix-login",
    head: git(dir, "rev-parse", "--short", "HEAD"),
    ahead: 2,
    changed: 2,
    insertions: 4,
    deletions: 0,
    dirty: false,
    pr: null,
  });
});

test("uncommitted or untracked work marks the checkout dirty", async () => {
  const dir = repo();
  writeFileSync(join(dir, "notes.txt"), "draft\n");
  expect((await readEvidence(dir, "", NOW))?.dirty).toBe(true);
  rmSync(join(dir, "notes.txt"));
  writeFileSync(join(dir, "README.md"), "changed\n");
  expect(await readEvidence(dir, "", NOW)).toMatchObject({ branch: "main", ahead: 0, changed: 0, dirty: true });
});

test("with an origin, commits made straight on the default branch count against origin's copy", async () => {
  const origin = repo();
  const dir = join(temp(), "clone");
  git(origin, "clone", "-q", origin, dir);
  commit(dir, "fix.ts", "x\n");
  expect(await readEvidence(dir, "", NOW)).toMatchObject({ branch: "main", ahead: 1, changed: 1, insertions: 1 });
});

test("a detached HEAD has no branch, and a repo with no commits has no head", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "--detach");
  expect(await readEvidence(dir, "", NOW)).toMatchObject({ branch: null, ahead: 0 });

  const empty = temp();
  git(empty, "init", "-q", "-b", "main");
  expect(await readEvidence(empty, "", NOW)).toMatchObject({ branch: "main", head: null, ahead: 0, dirty: false });
});

test("outside a repo, or in a folder that is gone, there is no evidence", async () => {
  expect(await readEvidence(temp(), "Opened https://github.com/o/r/pull/1", NOW)).toBeNull();
  expect(await readEvidence(join(temp(), "missing"), "", NOW)).toBeNull();
});

test("the first GitHub pull request URL in the final message is the PR", () => {
  const cases: [string, string | null][] = [
    ["Opened https://github.com/acme/shop/pull/42 and https://github.com/acme/shop/pull/43.", "https://github.com/acme/shop/pull/42"],
    ["PR: <https://github.com/a-b/c.d/pull/7>", "https://github.com/a-b/c.d/pull/7"],
    ["See https://github.com/acme/shop/issues/4", null],
    ["http://github.com/acme/shop/pull/4", null],
    ["No PR yet.", null],
  ];
  for (const [text, pr] of cases) expect(prOf(text)).toBe(pr);
});

test("the bridge's git ignores an fsmonitor and a filter driver the repo configures", async () => {
  const dir = repo();
  const out = temp();
  const planted = (name: string) => {
    const script = join(out, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch '${join(out, name)}.ran'\ncat\n`);
    chmodSync(script, 0o755);
    return script;
  };
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
  commit(dir, "a.txt", "one\n");
  git(dir, "config", "core.fsmonitor", planted("fsmonitor"));
  git(dir, "config", "filter.evil.clean", planted("clean"));
  writeFileSync(join(dir, "a.txt"), "two\n");
  const ran = () => ["fsmonitor", "clean"].filter((n) => existsSync(join(out, `${n}.ran`)));

  expect(await readEvidence(dir, "", NOW)).toMatchObject({ dirty: true });
  expect(ran()).toEqual([]);

  git(dir, "status", "--porcelain");
  git(dir, "add", "a.txt");
  expect(ran()).toEqual(["fsmonitor", "clean"]);
});

test("the evidence line states git's facts in one bracketed line", () => {
  const e = { at: NOW.toISOString(), branch: "fix", head: "abc1234", ahead: 1, changed: 3, insertions: 10, deletions: 2, dirty: true, pr: "https://github.com/o/r/pull/9" };
  expect(evidenceLine(e)).toBe(
    "[Git, read by the bridge after this turn: branch fix at abc1234; 1 commit ahead of the default branch; 3 files changed (+10 -2); uncommitted changes in the checkout; PR named: https://github.com/o/r/pull/9.]",
  );
  expect(evidenceLine({ ...e, branch: null, head: null, ahead: 0, changed: 1, dirty: false, pr: null })).toBe(
    "[Git, read by the bridge after this turn: branch (detached); 0 commits ahead of the default branch; 1 file changed (+10 -2); nothing uncommitted; no PR URL in its message.]",
  );
});

test("a filter driver whose name holds = is blanked like any other", async () => {
  const dir = repo();
  const out = temp();
  const script = join(out, "clean.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${join(out, "clean.ran")}'\ncat\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=a=b\n");
  commit(dir, "a.txt", "one\n");
  git(dir, "config", "filter.a=b.clean", script);
  writeFileSync(join(dir, "a.txt"), "two\n");

  expect(await readEvidence(dir, "", NOW)).toMatchObject({ dirty: true });
  expect(existsSync(join(out, "clean.ran"))).toBe(false);
  git(dir, "add", "a.txt");
  expect(existsSync(join(out, "clean.ran"))).toBe(true);
});

test("a default branch named like an option is never passed to git as one", async () => {
  const dir = repo();
  const out = temp();
  const target = join(out, "PWNED");
  git(dir, "checkout", "-q", "-b", "fix");
  commit(dir, "fix.ts", "x\n");
  git(dir, "update-ref", `refs/heads/--output=${target}`, "main");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/--output=${target}`);

  const evidence = await readEvidence(dir, "", NOW);
  expect(readdirSync(out)).toEqual([]);
  expect(evidence).toMatchObject({ branch: "fix", ahead: 1, changed: 1 });
});
