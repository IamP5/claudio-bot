import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices } from "../src/devices";
import { flushNow, loadWorld } from "../src/store";
import { bridgeReady, collect } from "./output";

// What main.ts prints at start, from a real bridge in a temp home: the pairing code only while no phone of its own is paired.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup({ paired = 0, legacyToken }: { paired?: number; legacyToken?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "claudiobot-startup-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin);
  writeFileSync(join(bin, "scutil"), "#!/bin/sh\necho Studio\n", { mode: 0o755 });
  if (paired > 0) {
    const { world } = loadWorld(home);
    const devices = createDevices({ world, persist: () => flushNow(world, home), now: () => new Date(), announce: () => {} });
    for (let i = 0; i < paired; i++) devices.pair(devices.newCode().code, `Phone ${i}`);
    flushNow(world, home);
  }
  if (legacyToken !== undefined) writeFileSync(join(home, "token"), `${legacyToken}\n`);
  return { root, home, bin };
}

async function start(s: ReturnType<typeof setup>, args: string[] = []) {
  const bridge = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    env: {
      PATH: `${s.bin}:${process.env.PATH}`,
      HOME: s.root,
      CLAUDIOBOT_HOME: s.home,
      CLAUDIOBOT_PORT: "0",
      CLAUDIOBOT_WEBHOOK_PORT: "0",
      CLAUDIOBOT_USER_NAME: "Alex",
      CLAUDIOBOT_CLAUDE: join(s.root, "no-claude"),
    },
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const out = collect(bridge.stdout);
  try {
    const port = await bridgeReady(out);
    return { text: out.text(), port };
  } finally {
    bridge.kill("SIGTERM");
    await bridge.exited;
  }
}

test("a first start names the Mac, lists its socket URLs and prints a code whose link points at the first of them", async () => {
  const { text, port } = await start(setup());
  const urls = [...text.matchAll(/^ {2}(ws:\/\/\S+)$/gm)].map((m) => m[1]!);
  const code = text.match(/^pair code: (\S+) \(single use, until .+\)$/m)?.[1];

  expect(text).toStartWith("claudiobot bridge on Studio\n");
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((u) => u.endsWith(`:${port}/ws`))).toBe(true);
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(text).toContain(`pair: claudiobot://pair?url=${encodeURIComponent(urls[0]!)}&code=${code}\n`);
});

test.each([
  [1, "1 paired device."],
  [2, "2 paired devices."],
])("with %i paired, it says how many and prints no code", async (paired, line) => {
  const { text } = await start(setup({ paired }));
  expect(text).toContain(`${line} To pair another, use Settings on a paired phone or restart with --pair.`);
  expect(text).not.toContain("pair code:");
});

test("--pair prints a code even when a phone is paired", async () => {
  const { text } = await start(setup({ paired: 1 }), ["--pair"]);
  expect(text).toContain("pair code:");
  expect(text).not.toContain("paired device");
});

test("a phone paired only through the old shared token still gets a code, so it can re-pair with its own", async () => {
  const { text } = await start(setup({ legacyToken: "shared-secret" }));
  expect(text).toContain("pair code:");
});
