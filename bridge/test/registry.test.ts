import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJoinCodes } from "../src/machine/joinCodes";
import { newIdentity } from "../src/machine/identity";
import { createRegistry, registryPath } from "../src/machine/registry";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "claudiobot-registry-"));
  dirs.push(d);
  return d;
};
const now = () => new Date("2026-10-21T12:00:00.000Z");
const mac = newIdentity("MacBook");
const asEnrolled = { id: mac.machineId, name: mac.name, publicKey: mac.publicKey };

test("enrolling a machine pins its key in machines.json at 0600, and a restart reads it back", () => {
  const h = home();
  const r = createRegistry({ bridgeHome: h, now });
  expect(r.enroll(asEnrolled)).toMatchObject({ ok: true, created: true, record: { ackedSeq: 0, lastSeenAt: null, profile: null } });
  expect(statSync(registryPath(h)).mode & 0o777).toBe(0o600);
  expect(createRegistry({ bridgeHome: h, now }).get(mac.machineId)).toMatchObject({ name: "MacBook", publicKey: mac.publicKey, enrolledAt: now().toISOString() });
});

test("enrolling the same machine with the same key again is a no-op; with another key it is refused", () => {
  const r = createRegistry({ bridgeHome: home(), now });
  r.enroll(asEnrolled);
  r.update(mac.machineId, { ackedSeq: 7 });
  expect(r.enroll(asEnrolled)).toMatchObject({ ok: true, created: false, record: { ackedSeq: 7 } });
  expect(r.enroll({ ...asEnrolled, publicKey: newIdentity("x").publicKey })).toEqual({ ok: false, reason: "MacBook is already enrolled with another key." });
  expect(r.list()).toHaveLength(1);
});

test("a join code works once", () => {
  const codes = createJoinCodes({ now });
  const { code } = codes.newCode();
  expect(codes.redeem(code.toLowerCase().replace("-", " "))).toEqual({ ok: true });
  expect(codes.redeem(code).ok).toBe(false);
});

test("five wrong join codes burn the live one, and an expired one is refused", () => {
  let t = now().getTime();
  const codes = createJoinCodes({ now: () => new Date(t) });
  const { code } = codes.newCode();
  for (let i = 0; i < 4; i++) expect(codes.redeem("AAAA-AAAA")).toEqual({ ok: false, error: "That machine code is wrong." });
  expect(codes.redeem("AAAA-AAAA")).toEqual({ ok: false, error: "Too many wrong machine codes. Get a new one." });
  expect(codes.redeem(code).ok).toBe(false);

  const next = codes.newCode();
  t += 10 * 60_000;
  expect(codes.redeem(next.code)).toEqual({ ok: false, error: "That machine code has expired. Get a new one." });
});
