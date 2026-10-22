import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endGroup, groupAlive, shellGroups, stillRuns } from "../src/procs";
import { backgroundCommand } from "./shells";

const started: number[] = [];
const ends: (() => Promise<void>)[] = [];
let dir = "";
afterEach(async () => {
  for (const g of started.splice(0)) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {}
  }
  for (const end of ends.splice(0)) await end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function fakeClaudeWithShells(...ids: string[]): Promise<number> {
  dir = mkdtempSync(join(tmpdir(), "procs-"));
  mkdirSync(join(dir, "tasks"));
  const forks = ids.map((id) => `if (fork() == 0) { setpgrp(0, 0); open(STDOUT, ">", "${dir}/tasks/${id}.output"); exec("sleep", "30"); }`).join(" ");
  const p = spawn("perl", ["-e", `$SIG{CHLD} = "IGNORE"; ${forks} sleep 30;`], { detached: true, stdio: "ignore" });
  started.push(p.pid!);
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(50);
    if ((await shellGroups(p.pid!)).size === ids.length) break;
  }
  return p.pid!;
}

test("each background shell's process group is found by the task id its output file names", async () => {
  const cc = await fakeClaudeWithShells("bk1", "bk2");
  const found = await shellGroups(cc);
  started.push(...found.values());
  expect([...found.keys()].sort()).toEqual(["bk1", "bk2"]);
  for (const [id, g] of found) expect([g === cc, await stillRuns(g, id)]).toEqual([false, true]);
});

test("a process with no background shells has none, and a pid that is gone has none either", async () => {
  const p = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  started.push(p.pid!);
  expect((await shellGroups(p.pid!)).size).toBe(0);
  expect((await shellGroups(999_999)).size).toBe(0);
});

test("ending a group stops every process in it, and a group already gone counts as ended", async () => {
  const cc = await fakeClaudeWithShells("bk1");
  const group = (await shellGroups(cc)).get("bk1")!;
  started.push(group);
  expect(await endGroup(group, "bk1")).toBe(true);
  expect(groupAlive(group)).toBe(false);
  expect(await endGroup(group, "bk1")).toBe(true);
});

test("a group that now runs something else is not the task's, and is never signalled", async () => {
  const other = backgroundCommand("someone-else");
  ends.push(other.end);
  expect(await stillRuns(other.pid, "bk1")).toBe(false);
  expect(await endGroup(other.pid, "bk1")).toBe(true);
  expect(groupAlive(other.pid)).toBe(true);
});

test("a group the user may not signal, or no group at all, does not run", () => {
  expect([groupAlive(1), groupAlive(0), groupAlive(-5)]).toEqual([false, false, false]);
});
