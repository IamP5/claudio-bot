import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endGroup, groupAlive, shellGroups } from "../src/procs";

const started: number[] = [];
let dir = "";
afterEach(() => {
  for (const g of started.splice(0)) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {}
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for Claude Code: a process that starts one shell per task id in a group of its own, writing to <id>.output. */
async function claudeCode(...ids: string[]): Promise<number> {
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
  const cc = await claudeCode("bk1", "bk2");
  const found = await shellGroups(cc);
  started.push(...found.values());
  expect([...found.keys()].sort()).toEqual(["bk1", "bk2"]);
  for (const g of found.values()) expect([g === cc, groupAlive(g)]).toEqual([false, true]);
});

test("a process with no background shells has none, and a pid that is gone has none either", async () => {
  const p = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  started.push(p.pid!);
  expect((await shellGroups(p.pid!)).size).toBe(0);
  expect((await shellGroups(999_999)).size).toBe(0);
});

test("ending a group stops every process in it, and a group already gone counts as ended", async () => {
  const cc = await claudeCode("bk1");
  const group = (await shellGroups(cc)).get("bk1")!;
  started.push(group);
  expect(await endGroup(group)).toBe(true);
  expect(groupAlive(group)).toBe(false);
  expect(await endGroup(group)).toBe(true);
});
