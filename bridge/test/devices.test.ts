import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices, PAIR_CODE_ATTEMPTS, PAIR_CODE_TTL_MS, rejectsOrigin } from "../src/devices";
import type { DeviceId, PairResponse } from "../src/protocol";
import { flushNow, loadWorld } from "../src/store";
import { emptyWorld, type World } from "../src/world";

const start = new Date("2026-10-17T09:00:00.000Z");

function setup(world: World = emptyWorld()) {
  let now = start;
  const persists: ("now" | undefined)[] = [];
  const devices = createDevices({ world, persist: (u) => persists.push(u), now: () => now });
  return { world, devices, persists, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

function paired(result: PairResponse | { error: string }): PairResponse {
  if ("error" in result) throw new Error(`expected a pairing, got: ${result.error}`);
  return result;
}

const ws = (headers: Record<string, string> = {}, query = "") => new Request(`http://127.0.0.1:7878/ws${query}`, { headers });
const bearer = (token: string) => ws({ authorization: `Bearer ${token}` });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("a code is eight characters from an alphabet with no look-alikes, valid for ten minutes", () => {
  const { devices } = setup();
  for (let i = 0; i < 50; i++) {
    const { code, expiresAt } = devices.newCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt).toBe(new Date(start.getTime() + PAIR_CODE_TTL_MS).toISOString());
  }
});

test("pairing with the code returns a token that authenticates as that device", () => {
  const { devices, world } = setup();
  const { deviceId, token } = paired(devices.pair(devices.newCode().code, "Alex's iPhone"));
  expect(devices.authenticate(bearer(token))).toBe(deviceId);
  expect(devices.list(deviceId)).toEqual([
    { id: deviceId, name: "Alex's iPhone", createdAt: start.toISOString(), lastSeenAt: null, legacy: false, current: true },
  ]);
  expect(world.devices.map((d) => d.tokenHash)).toEqual([sha256(token)]);
});

test("the code is typed forgivingly: any case, with or without the dash", () => {
  for (const shape of [(c: string) => c.toLowerCase(), (c: string) => c.replace("-", ""), (c: string) => ` ${c.replace("-", " ")} `]) {
    const { devices } = setup();
    expect("deviceId" in devices.pair(shape(devices.newCode().code), "phone")).toBe(true);
  }
});

test("a code pairs one device only", () => {
  const { devices } = setup();
  const { code } = devices.newCode();
  paired(devices.pair(code, "first"));
  expect(devices.pair(code, "second")).toEqual({ error: expect.any(String) });
  expect(devices.list(null).map((d) => d.name)).toEqual(["first"]);
});

test("a code expires after ten minutes", () => {
  const fresh = setup();
  const early = fresh.devices.newCode().code;
  fresh.advance(PAIR_CODE_TTL_MS - 1);
  expect("deviceId" in fresh.devices.pair(early, "phone")).toBe(true);

  const stale = setup();
  const late = stale.devices.newCode().code;
  stale.advance(PAIR_CODE_TTL_MS);
  expect(stale.devices.pair(late, "phone")).toEqual({ error: expect.any(String) });
  expect(stale.devices.list(null)).toEqual([]);
});

test("wrong codes burn the live code on the last allowed attempt", () => {
  const cases: [wrong: number, pairs: boolean][] = [
    [0, true],
    [PAIR_CODE_ATTEMPTS - 1, true],
    [PAIR_CODE_ATTEMPTS, false],
  ];
  for (const [wrong, pairs] of cases) {
    const { devices } = setup();
    const { code } = devices.newCode();
    for (let i = 0; i < wrong; i++) expect(devices.pair("2222-2222", "attacker")).toEqual({ error: expect.any(String) });
    expect([wrong, "deviceId" in devices.pair(code, "phone")]).toEqual([wrong, pairs]);
  }
});

test("a new code replaces the old one and resets the attempts", () => {
  const { devices } = setup();
  const old = devices.newCode().code;
  for (let i = 0; i < PAIR_CODE_ATTEMPTS - 1; i++) devices.pair("2222-2222", "attacker");
  const current = devices.newCode().code;
  expect(devices.pair(old, "phone")).toEqual({ error: expect.any(String) });
  expect("deviceId" in devices.pair(current, "phone")).toBe(true);
});

test("pairing with no code ever issued fails", () => {
  const { devices } = setup();
  expect(devices.pair("ABCD-EFGH", "phone")).toEqual({ error: expect.any(String) });
});

test("a pairing is flushed to disk before the token is handed out", () => {
  const { devices, persists } = setup();
  paired(devices.pair(devices.newCode().code, "phone"));
  expect(persists).toEqual(["now"]);
});

test("a blank or very long name is cleaned up rather than refused", () => {
  const { devices } = setup();
  paired(devices.pair(devices.newCode().code, "   "));
  paired(devices.pair(devices.newCode().code, "x".repeat(500)));
  expect(devices.list(null).map((d) => d.name.length)).toEqual(["Phone".length, 64]);
});

test("only the token hash reaches state.json", () => {
  const home = mkdtempSync(join(tmpdir(), "claudiobot-devices-"));
  homes.push(home);
  const { devices, world } = setup();
  const { deviceId, token } = paired(devices.pair(devices.newCode().code, "phone"));
  devices.importLegacy("legacy-shared-token");
  flushNow(world, home);

  const raw = readFileSync(join(home, "state.json"), "utf8");
  expect(raw).not.toContain(token);
  expect(raw).not.toContain("legacy-shared-token");
  expect(raw).toContain(sha256(token));

  const reloaded = setup(loadWorld(home).world).devices;
  expect(reloaded.authenticate(bearer(token))).toBe(deviceId);
});

test("bearer auth rejects anything but an exact paired token", () => {
  const { devices } = setup();
  const { token } = paired(devices.pair(devices.newCode().code, "phone"));
  const rejected = [
    ws(),
    ws({ authorization: token }),
    ws({ authorization: "Bearer" }),
    ws({ authorization: `Basic ${token}` }),
    bearer(token.slice(1)),
    bearer(token.toUpperCase()),
    bearer(sha256(token)),
  ];
  for (const req of rejected) expect(devices.authenticate(req)).toBeNull();
});

test("a paired device never authenticates from the query string", () => {
  const { devices } = setup();
  const { token } = paired(devices.pair(devices.newCode().code, "phone"));
  expect(devices.authenticate(ws({}, `?token=${token}`))).toBeNull();
});

test("the legacy token works from the query string or a bearer header, for the legacy device only", () => {
  const { devices } = setup();
  devices.importLegacy("shared");
  devices.importLegacy("shared");
  const [legacy] = devices.list(null);
  expect(devices.list(null)).toEqual([{ id: legacy!.id, name: expect.any(String), createdAt: start.toISOString(), lastSeenAt: null, legacy: true, current: false }]);
  expect(devices.authenticate(ws({}, "?token=shared"))).toBe(legacy!.id);
  expect(devices.authenticate(bearer("shared"))).toBe(legacy!.id);
  expect(devices.authenticate(ws({}, "?token=other"))).toBeNull();
});

test("a bad bearer header is not rescued by a legacy query token", () => {
  const { devices } = setup();
  devices.importLegacy("shared");
  expect(devices.authenticate(ws({ authorization: "Bearer wrong" }, "?token=shared"))).toBeNull();
});

test("only one legacy device is ever imported", () => {
  const { devices } = setup();
  devices.importLegacy("shared");
  devices.importLegacy("another");
  expect(devices.list(null).filter((d) => d.legacy)).toHaveLength(1);
  expect(devices.authenticate(ws({}, "?token=another"))).toBeNull();
});

test("revoking a device stops its token at once and is flushed before returning", () => {
  const { devices, persists } = setup();
  const keep = paired(devices.pair(devices.newCode().code, "keep"));
  const drop = paired(devices.pair(devices.newCode().code, "drop"));
  persists.length = 0;

  expect(devices.revoke(drop.deviceId)).toBe(true);
  expect(persists).toEqual(["now"]);
  expect(devices.authenticate(bearer(drop.token))).toBeNull();
  expect(devices.authenticate(bearer(keep.token))).toBe(keep.deviceId);
  expect(devices.revoke(drop.deviceId)).toBe(false);
  expect(devices.revoke("d_nobody" as DeviceId)).toBe(false);
});

test("revoking the legacy device stops the shared token", () => {
  const { devices } = setup();
  devices.importLegacy("shared");
  expect(devices.revoke(devices.list(null)[0]!.id)).toBe(true);
  expect(devices.authenticate(ws({}, "?token=shared"))).toBeNull();
});

test("seen records when the device last connected", () => {
  const { devices, advance } = setup();
  const { deviceId } = paired(devices.pair(devices.newCode().code, "phone"));
  advance(60_000);
  devices.seen(deviceId);
  expect(devices.list(null)[0]!.lastSeenAt).toBe(new Date(start.getTime() + 60_000).toISOString());
});

test("any request carrying an Origin header is refused", () => {
  expect(rejectsOrigin(new Request("http://127.0.0.1:7878/ws", { headers: { origin: "https://evil.example" } }))).toBe(true);
  expect(rejectsOrigin(new Request("http://127.0.0.1:7878/ws", { headers: { origin: "null" } }))).toBe(true);
  expect(rejectsOrigin(new Request("http://127.0.0.1:7878/ws"))).toBe(false);
});
