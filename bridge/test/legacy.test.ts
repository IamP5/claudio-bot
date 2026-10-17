import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices } from "../src/devices";
import { legacyToken } from "../src/legacy";
import { emptyWorld } from "../src/world";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(token?: string) {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-legacy-"));
  homes.push(dir);
  if (token !== undefined) writeFileSync(join(dir, "token"), token);
  return dir;
}

/** A fresh device list, as a restart builds it before reconcile. */
const devices = () => createDevices({ world: emptyWorld(), persist: () => {}, now: () => new Date("2026-10-17T09:00:00.000Z"), announce: () => {} });
const legacyIn = (d: ReturnType<typeof devices>) => d.list(null).filter((x) => x.legacy);
const legacyAuth = (d: ReturnType<typeof devices>, token: string) => d.authenticate(new Request(`http://127.0.0.1:7878/ws?token=${token}`));

test("a shared token on disk becomes the legacy device, read without its trailing newline", () => {
  const d = devices();
  legacyToken(home("shared-secret\n")).reconcile(d);
  expect(legacyIn(d)).toHaveLength(1);
  expect(legacyAuth(d, "shared-secret")).toBe(legacyIn(d)[0]!.id);
});

test.each([
  ["no token file", undefined],
  ["an empty token file", ""],
  ["a token file of whitespace", "  \n"],
])("%s imports nothing", (_, token) => {
  const d = devices();
  legacyToken(home(token)).reconcile(d);
  expect(d.list(null)).toEqual([]);
});

test("close writes a private marker and removes the token, and the next start imports nothing", () => {
  const dir = home("shared-secret\n");
  legacyToken(dir).close();

  expect(statSync(join(dir, "token.revoked")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, "token"))).toBe(false);
  const d = devices();
  legacyToken(dir).reconcile(d);
  expect(d.list(null)).toEqual([]);
});

test("once revoked, a token file that comes back is never imported again", () => {
  const dir = home("shared-secret\n");
  legacyToken(dir).close();
  writeFileSync(join(dir, "token"), "shared-secret\n");

  const d = devices();
  legacyToken(dir).reconcile(d);
  expect(d.list(null)).toEqual([]);
  expect(legacyAuth(d, "shared-secret")).toBeNull();
});

test("a legacy device already in the list is dropped at start once the marker exists", () => {
  const dir = home();
  const d = devices();
  d.importLegacy("shared-secret");
  writeFileSync(join(dir, "token.revoked"), "");

  legacyToken(dir).reconcile(d);
  expect(legacyIn(d)).toEqual([]);
});

test("the marker is written before the token is removed, so a close that fails halfway still keeps it out", () => {
  const dir = home();
  // A directory where the token file should be: rmSync without recursive refuses it, so close throws after its first step.
  mkdirSync(join(dir, "token"));

  expect(() => legacyToken(dir).close()).toThrow();
  expect(existsSync(join(dir, "token.revoked"))).toBe(true);
  const d = devices();
  legacyToken(dir).reconcile(d);
  expect(d.list(null)).toEqual([]);
});
