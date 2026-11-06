import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityPath, loadIdentity, newIdentity, readIdentity, saveIdentity, signWith, verifyWith, worldOf } from "../src/machine/identity";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "claudiobot-identity-"));
  dirs.push(d);
  return d;
};

test("the first boot makes machine.json at 0600, and every later boot reads the same identity back", () => {
  const h = home();
  const first = loadIdentity(h, "MacBook");
  expect(statSync(identityPath(h)).mode & 0o777).toBe(0o600);
  expect(first).toMatchObject({ machineId: expect.stringMatching(/^m_/), name: "MacBook", home: null });
  expect(loadIdentity(h, "another name")).toEqual(first);
});

test("a signature verifies with its own public key and with no other", () => {
  const a = newIdentity("a");
  const b = newIdentity("b");
  const data = Buffer.from("nonce and id");
  const sig = signWith(a.privateKey, data);
  expect([verifyWith(a.publicKey, data, sig), verifyWith(b.publicKey, data, sig), verifyWith(a.publicKey, Buffer.from("other"), sig)]).toEqual([true, false, false]);
  expect(verifyWith("not a key", data, sig)).toBe(false);
});

test("an enrolled home is kept in machine.json, never in state.json", () => {
  const h = home();
  const me = loadIdentity(h, "MacBook");
  const omarchy = newIdentity("omarchy");
  saveIdentity(h, { ...me, home: { url: "http://omarchy.tailnet.ts.net:7878", machineId: omarchy.machineId, publicKey: omarchy.publicKey, name: "omarchy" } });
  expect(readIdentity(h)?.home?.name).toBe("omarchy");
  expect(readFileSync(identityPath(h), "utf8")).not.toContain("state");
});

test("a machine.json that does not parse stops the boot instead of being replaced by a new identity", () => {
  const h = home();
  writeFileSync(identityPath(h), JSON.stringify({ machineId: "x" }), { mode: 0o600 });
  expect(() => loadIdentity(h, "MacBook")).toThrow("is not a machine identity");
});

test("a home mints its world id once and keeps it in machine.json; a file from before it reads as no world", () => {
  const h = home();
  const { world: _, ...old } = loadIdentity(h, "omarchy");
  writeFileSync(identityPath(h), JSON.stringify(old), { mode: 0o600 });
  const before = readIdentity(h)!;
  expect(before.world).toBeNull();
  const world = worldOf(h, before);
  expect(world).toMatch(/^w_[0-9a-f-]{36}$/);
  expect(readIdentity(h)?.world).toBe(world);
  expect(worldOf(h, readIdentity(h)!)).toBe(world);
});
