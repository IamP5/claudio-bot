import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandGroups, endGroup, evalArg, groupAlive, psText, read, shellGroups, shellLeaders, taskRun } from "../src/procs";
import { backgroundCommand, evalShell } from "./shells";

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
  for (const [id, g] of found) expect([g === cc, await taskRun(g, id)]).toEqual([false, "runs"]);
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
  expect(await endGroup(group, "bk1")).toBe("stopped");
  expect(groupAlive(group)).toBe(false);
  expect(await endGroup(group, "bk1")).toBe("gone");
});

test("a live group that does not write the task's output may or may not be it, and is never signalled", async () => {
  const other = backgroundCommand("someone-else");
  ends.push(other.end);
  expect(await taskRun(other.pid, "bk1")).toBe("unsure");
  expect(await endGroup(other.pid, "bk1")).toBe("unsure");
  expect(groupAlive(other.pid)).toBe(true);
});

test("a group the user may not signal, or no group at all, does not run", () => {
  expect([groupAlive(1), groupAlive(0), groupAlive(-5)]).toEqual([false, false, false]);
});

test("a process table that cannot be read is said so, after a few tries, and one that recovers is read", async () => {
  const cmd = backgroundCommand("bk1");
  ends.push(cmd.end);
  const bin = mkdtempSync(join(tmpdir(), "lsof-"));
  const path = process.env.PATH;
  try {
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "lsof"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    expect(await taskRun(cmd.pid, "bk1")).toBe("unread");
    expect(await endGroup(cmd.pid, "bk1")).toBe("unsure");
    expect(groupAlive(cmd.pid)).toBe(true);
    const count = join(bin, "count");
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\nif [ ! -f '${count}' ]; then touch '${count}'; exit 1; fi\nexec /usr/sbin/lsof "$@"\n`);
    expect(await taskRun(cmd.pid, "bk1")).toBe("runs");
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the command a Claude Code shell runs is read back exactly, single quotes included, and nothing else is", () => {
  const line = (arg: string) => `/bin/zsh -c source /x/snapshot.sh 2>/dev/null || true && eval '${arg}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`;
  expect(evalArg(line("exec >/dev/null 2>&1;  sleep 3431"))).toBe("exec >/dev/null 2>&1;  sleep 3431");
  expect(evalArg(line(`echo '"'"'a b'"'"'`))).toBe("echo 'a b'");
  expect(evalArg(line(`echo '\\''a'\\''`))).toBe("echo 'a'");
  expect(evalArg("sleep 30")).toBeNull();
  expect(evalArg(`/bin/zsh -c source /x/snapshot.sh && eval 'sort < in.txt' && pwd -P >| /tmp/claude-1-cwd`)).toBe("sort < in.txt");
});

test("a command line with tabs, newlines and non-ASCII reads back from ps as psText writes the command", async () => {
  dir = mkdtempSync(join(tmpdir(), "procs-"));
  const command = "sleep 30 # café…\tand\n: more ~\\ ^";
  const line = `eval '${command}' < /dev/null && pwd -P >| /tmp/claude-x-cwd`;
  const p = spawn("perl", ["-e", `if (fork() == 0) { setpgrp(0, 0); exec("/bin/zsh", "-c", $ARGV[0]); } sleep 30;`, line], { detached: true, stdio: "ignore" });
  started.push(p.pid!);
  let found: { group: number; command: string }[] = [];
  for (let i = 0; i < 50 && found.length === 0; i++) {
    await Bun.sleep(50);
    found = await shellLeaders(p.pid!);
  }
  started.push(...found.map((f) => f.group));
  expect(found.map((f) => evalArg(f.command))).toEqual([psText(command)]);
  expect(psText(command)).toBe("sleep 30 # cafM-CM-)M-bM^@M-&\\011and\\012: more ~\\ ^");
});

test("a read that runs past its timeout is given up on then, even while a child it left holds its output open", async () => {
  const at = Date.now();
  expect(await read(["/bin/sh", "-c", "/bin/sleep 2 & wait"], 200)).toBeNull();
  expect(Date.now() - at).toBeLessThan(1_000);
});

test("commandGroups finds the group of each shell that runs exactly a command, whoever started it, and none once it ends", async () => {
  const command = `sleep ${50_000 + (process.pid % 9_000)}`;
  const near = `${command} `;
  const shells = [evalShell(command), evalShell(command), evalShell(near)];
  ends.push(...shells.map((s) => s.end));
  await Bun.sleep(300);
  const found = (await commandGroups([command, near, "sleep 1"]))!;
  expect([[...found.get(command)!].sort(), found.get(near), found.get("sleep 1")]).toEqual([[shells[0]!.pid, shells[1]!.pid].sort(), [shells[2]!.pid], []]);
  await shells[0]!.end();
  await shells[1]!.end();
  expect((await commandGroups([command]))!.get(command)).toEqual([]);
});
