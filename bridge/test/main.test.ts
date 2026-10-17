import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test("SIGTERM still exits when the last save fails, and says the state was not saved", async () => {
  const home = mkdtempSync(join(tmpdir(), "claudiobot-main-"));
  homes.push(home);
  const bridge = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDIOBOT_HOME: home, CLAUDIOBOT_PORT: "0", CLAUDIOBOT_USER_NAME: "Alex", CLAUDIOBOT_CLAUDE: join(home, "no-claude") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new Response(bridge.stdout).text();
  const err = new Response(bridge.stderr).text();
  const started = Date.now();
  while (!(await Bun.file(join(home, "state.json")).exists()) && Date.now() - started < 10_000) await Bun.sleep(20);
  await Bun.sleep(300);

  chmodSync(home, 0o500);
  bridge.kill("SIGTERM");
  const code = await Promise.race([bridge.exited, Bun.sleep(5_000).then(() => "still running")]);
  if (code === "still running") bridge.kill("SIGKILL");

  expect(code).toBe(1);
  expect(await out).toContain("shutdown: state.json was not saved");
  expect(await err).not.toContain("error:");
}, 20_000);

test("a first start creates the home so that only its owner can list it", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-main-"));
  homes.push(root);
  const home = join(root, "fresh");
  const bridge = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
    env: { PATH: process.env.PATH, HOME: root, CLAUDIOBOT_HOME: home, CLAUDIOBOT_PORT: "0", CLAUDIOBOT_USER_NAME: "Alex", CLAUDIOBOT_CLAUDE: join(root, "no-claude") },
    stdout: "ignore",
    stderr: "ignore",
  });
  const started = Date.now();
  while (!(await Bun.file(join(home, "state.json")).exists()) && Date.now() - started < 10_000) await Bun.sleep(20);
  bridge.kill("SIGTERM");
  await bridge.exited;
  expect((statSync(home).mode & 0o777).toString(8)).toBe("700");
}, 20_000);
