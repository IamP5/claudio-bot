import type { Device, DeviceId, PairResponse } from "./protocol";
import type { Persist } from "./store";
import type { World } from "./world";

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

export function createDevices(deps: { world: World; persist: Persist; now: () => Date }): Devices {
  throw new Error("not implemented");
}

/** Browsers send Origin on WebSocket upgrades and cross-site POSTs; the iOS app never does. Reject before auth. */
export const rejectsOrigin = (req: Request): boolean => req.headers.has("origin");
