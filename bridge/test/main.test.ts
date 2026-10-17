import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
