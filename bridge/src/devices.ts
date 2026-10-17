import { createHash, timingSafeEqual } from "node:crypto";
import type { Device, DeviceId, PairResponse } from "./protocol";
import type { Persist } from "./store";
import type { DeviceRecord, World } from "./world";

// Pairing and socket auth. The only writer of World.devices; the live pairing code is memory only. Owner: U5.
// Tokens are 32 random bytes, stored as sha256 only and compared in constant time. The token is never printed;
// the bridge prints a one-time code and a claudiobot://pair?url=…&code=… link instead.

export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_CODE_ATTEMPTS = 5;

export type PairCode = { code: string; expiresAt: string };

export type Devices = {
  /** One live code at a time; a new code replaces the old one. Printed at start when no device is paired, and sent to a paired phone on pair_code. */
  newCode(): PairCode;
  /** POST /pair. Single use; a wrong code counts against the attempt limit and the last attempt burns it. */
  pair(code: string, name: string): PairResponse | { error: string };
  /**
   * The socket upgrade. Authorization: Bearer <token> for every device. For one release the legacy device may still
   * present ?token=<shared token>; no other device is ever read from the query string.
   */
  authenticate(req: Request): DeviceId | null;
  /** current marks the device asking. */
  list(current: DeviceId | null): Device[];
  /** Removes the device. The caller closes its live sockets at once. False when it was not paired. */
  revoke(id: DeviceId): boolean;
  seen(id: DeviceId): void;
  /** Registers protocol 2's shared token as the legacy device (hash only), so today's phone keeps working. Idempotent. */
  importLegacy(token: string): void;
};

// No 0/O, 1/I/L, or U: a code read aloud or typed from a screen has one spelling.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const NAME_LIMIT = 64;

const sha256 = (token: string) => createHash("sha256").update(token).digest();
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

function randomCode(): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
      // Rejection sampling keeps every character equally likely.
      if (byte < 256 - (256 % ALPHABET.length) && out.length < CODE_LENGTH) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

/** What a person might type for the code: any case, with or without the dash or spaces. */
const normalize = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function createDevices(deps: { world: World; persist: Persist; now: () => Date }): Devices {
  const records = deps.world.devices as DeviceRecord[];
  let live: { code: string; expiresAt: Date; attemptsLeft: number } | null = null;

  function add(tokenHash: string, name: string, legacy: boolean): DeviceRecord {
    const record: DeviceRecord = {
      id: `d_${crypto.randomUUID()}` as DeviceId,
      name,
      tokenHash,
      createdAt: deps.now().toISOString(),
      lastSeenAt: null,
      legacy,
    };
    records.push(record);
    deps.persist("now");
    return record;
  }

  function match(token: string, eligible: (d: DeviceRecord) => boolean): DeviceId | null {
    const hash = sha256(token);
    let found: DeviceId | null = null;
    for (const d of records) if (sameBytes(hash, Buffer.from(d.tokenHash, "hex")) && eligible(d)) found = d.id;
    return found;
  }

  return {
    newCode() {
      const expiresAt = new Date(deps.now().getTime() + PAIR_CODE_TTL_MS);
      live = { code: randomCode(), expiresAt, attemptsLeft: PAIR_CODE_ATTEMPTS };
      return { code: display(live.code), expiresAt: expiresAt.toISOString() };
    },

    pair(code, name) {
      if (live === null) return { error: "No pairing code is active. Ask the bridge for a new one." };
      if (deps.now() >= live.expiresAt) {
        live = null;
        return { error: "That pairing code has expired. Ask the bridge for a new one." };
      }
      if (!sameBytes(Buffer.from(normalize(code)), Buffer.from(live.code))) {
        live.attemptsLeft -= 1;
        if (live.attemptsLeft > 0) return { error: "That pairing code is wrong." };
        live = null;
        return { error: "Too many wrong pairing codes. Ask the bridge for a new one." };
      }
      live = null;
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
      const clean = name.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT) || "Phone";
      const record = add(sha256(token).toString("hex"), clean, false);
      return { deviceId: record.id, token };
    },

    authenticate(req) {
      const header = req.headers.get("authorization");
      if (header !== null) {
        const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
        return bearer ? match(bearer, () => true) : null;
      }
      const query = new URL(req.url).searchParams.get("token");
      return query ? match(query, (d) => d.legacy) : null;
    },

    list: (current) =>
      records.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        legacy: d.legacy,
        current: d.id === current,
      })),

    revoke(id) {
      const index = records.findIndex((d) => d.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      deps.persist("now");
      return true;
    },

    seen(id) {
      const record = records.find((d) => d.id === id);
      if (!record) return;
      record.lastSeenAt = deps.now().toISOString();
      deps.persist();
    },

    importLegacy(token) {
      const hash = sha256(token).toString("hex");
      if (records.some((d) => d.legacy || d.tokenHash === hash)) return;
      add(hash, "Phone paired before protocol 3", true);
    },
  };
}

/** Browsers send Origin on WebSocket upgrades and cross-site POSTs; the iOS app never does. Reject before auth. */
export const rejectsOrigin = (req: Request): boolean => req.headers.has("origin");
