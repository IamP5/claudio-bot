import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevices, PAIR_CODE_ATTEMPTS, PAIR_CODE_TTL_MS, rejectsOrigin, type PairCode } from "../src/devices";
import type { DeviceId, PairResponse } from "../src/protocol";
import { flushNow, loadWorld } from "../src/store";
import { emptyWorld, type World } from "../src/world";

const start = new Date("2026-10-17T09:00:00.000Z");

function setup(world: World = emptyWorld()) {
  let now = start;
  let saving = true;
  const persists: ("now" | undefined)[] = [];
  const announced: PairCode[] = [];
  const persist = (u?: "now") => {
    if (!saving) throw new Error("disk full");
    persists.push(u);
  };
  const devices = createDevices({ world, persist, now: () => now, announce: (code) => announced.push(code) });
  return {
    world,
    devices,
    persists,
    announced,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    savesFail: (fail = true) => (saving = !fail),
  };
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

test("the shared token stops working on 1 January 2027, one release after protocol 3; paired phones keep working", () => {
  const { devices, advance } = setup();
  devices.importLegacy("shared");
  const { deviceId, token } = paired(devices.pair(devices.newCode().code, "phone"));
  const sunset = Date.parse("2027-01-01T00:00:00.000Z");

  advance(sunset - start.getTime() - 1);
  expect(devices.authenticate(ws({}, "?token=shared"))).not.toBeNull();
  advance(1);
  expect(devices.authenticate(ws({}, "?token=shared"))).toBeNull();
  expect(devices.authenticate(bearer("shared"))).toBeNull();
  expect(devices.authenticate(bearer(token))).toBe(deviceId);
});

test("seen records when the device last connected", () => {
  const { devices, advance } = setup();
  const { deviceId } = paired(devices.pair(devices.newCode().code, "phone"));
  advance(60_000);
  devices.seen(deviceId);
  expect(devices.list(null)[0]!.lastSeenAt).toBe(new Date(start.getTime() + 60_000).toISOString());
});

test("a device reconnecting within a minute of the last stamp neither restamps nor saves", () => {
  const { devices, advance, persists } = setup();
  const { deviceId } = paired(devices.pair(devices.newCode().code, "phone"));
  const lastSeen = () => devices.list(null)[0]!.lastSeenAt;
  devices.seen(deviceId);
  const saves = persists.length;

  advance(59_000);
  devices.seen(deviceId);
  expect(lastSeen()).toBe(start.toISOString());
  expect(persists.length).toBe(saves);

  advance(1_000);
  devices.seen(deviceId);
  expect(lastSeen()).toBe(new Date(start.getTime() + 60_000).toISOString());
  expect(persists.slice(saves)).toEqual([undefined]);
});

test("any request carrying an Origin header is refused", () => {
  expect(rejectsOrigin(new Request("http://127.0.0.1:7878/ws", { headers: { origin: "https://evil.example" } }))).toBe(true);
  expect(rejectsOrigin(new Request("http://127.0.0.1:7878/ws", { headers: { origin: "null" } }))).toBe(true);
  expect(rejectsOrigin(new Request("http://127.0.0.1:7878/ws"))).toBe(false);
});

const burn = (devices: ReturnType<typeof setup>["devices"]) => {
  let last: PairResponse | { error: string } = { error: "" };
  for (let i = 0; i < PAIR_CODE_ATTEMPTS; i++) last = devices.pair("2222-2222", "attacker");
  return last;
};

test("while no phone is paired, a burned code is replaced at once and shown on the Mac", () => {
  const { devices, announced } = setup();
  devices.newCode();
  expect(burn(devices)).toEqual({ error: expect.stringContaining("showing on the Mac") });
  expect(announced).toHaveLength(1);
  expect("deviceId" in devices.pair(announced[0]!.code, "phone")).toBe(true);
});

test("while no phone is paired, an expired code is replaced and shown on the Mac", () => {
  const { devices, announced, advance } = setup();
  const old = devices.newCode().code;
  advance(PAIR_CODE_TTL_MS);
  expect(devices.pair(old, "phone")).toEqual({ error: expect.stringContaining("showing on the Mac") });
  expect(announced).toHaveLength(1);
  expect(announced[0]!.code).not.toBe(old);
  expect("deviceId" in devices.pair(announced[0]!.code, "phone")).toBe(true);
});

test("once the last phone is revoked, a pairing attempt brings up a code on the Mac", () => {
  const { devices, announced } = setup();
  const { deviceId } = paired(devices.pair(devices.newCode().code, "phone"));
  devices.revoke(deviceId);
  expect(devices.pair("2222-2222", "phone")).toEqual({ error: expect.stringContaining("showing on the Mac") });
  expect(announced).toHaveLength(1);
});

test("the legacy phone alone still counts as unpaired", () => {
  const { devices, announced } = setup();
  devices.importLegacy("shared");
  devices.newCode();
  burn(devices);
  expect(announced).toHaveLength(1);
});

test("with a phone paired, a spent code is not replaced and the error says how to get one", () => {
  const { devices, announced, advance } = setup();
  paired(devices.pair(devices.newCode().code, "phone"));
  devices.newCode();
  expect(burn(devices)).toEqual({ error: expect.stringContaining("--pair") });
  const late = devices.newCode().code;
  advance(PAIR_CODE_TTL_MS);
  expect(devices.pair(late, "tablet")).toEqual({ error: expect.stringContaining("--pair") });
  expect(announced).toEqual([]);
});

test("a pairing that cannot be saved hands out no token and leaves the code usable", () => {
  const { devices, savesFail } = setup();
  const { code } = devices.newCode();
  savesFail();
  expect(() => devices.pair(code, "phone")).toThrow("disk full");
  expect(devices.list(null)).toEqual([]);
  savesFail(false);
  expect("deviceId" in devices.pair(code, "phone")).toBe(true);
});

test("a revoke that cannot be saved leaves the device paired, in its place", () => {
  const { devices, savesFail } = setup();
  const first = paired(devices.pair(devices.newCode().code, "first"));
  paired(devices.pair(devices.newCode().code, "second"));
  savesFail();
  expect(() => devices.revoke(first.deviceId)).toThrow("disk full");
  expect(devices.authenticate(bearer(first.token))).toBe(first.deviceId);
  expect(devices.list(null).map((d) => d.name)).toEqual(["first", "second"]);
});

test("control and format characters never reach a stored name", () => {
  const cases: [sent: string, stored: string][] = [
    ["Alex\u0000's\u0007 iPhone", "Alex's iPhone"],
    ["Alex\n\tiPhone", "Alex iPhone"],
    ["\u202Eenohp\u202C \u200Bx", "enohp x"],
    ["\u001b[31mred\u001b[0m", "[31mred[0m"],
    ["\u0000\u200B", "Phone"],
  ];
  for (const [sent, stored] of cases) {
    const { devices } = setup();
    paired(devices.pair(devices.newCode().code, sent));
    expect([sent, devices.list(null)[0]!.name]).toEqual([sent, stored]);
  }
});

test("a long name is cut between characters, never inside one", () => {
  const { devices } = setup();
  paired(devices.pair(devices.newCode().code, "x".repeat(63) + "\u{1F600}\u{1F600}"));
  expect(devices.list(null)[0]!.name).toBe("x".repeat(63) + "\u{1F600}");
});
