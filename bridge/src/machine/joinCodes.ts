import { display, normalize, PAIR_CODE_ATTEMPTS, PAIR_CODE_TTL_MS, randomCode, sameBytes, type PairCode } from "../devices";

// The one-time code a computer enrolls into this home with: minted by a paired phone (machine_code) or by
// `claudiobot machine invite` on the home, redeemed at POST /enroll. The same rules as a pairing code: one live code,
// ten minutes, five attempts, single use, compared in constant time. Memory only.

export type JoinCodes = {
  /** Replaces the live code. */
  newCode(): PairCode;
  redeem(code: string): { ok: true } | { ok: false; error: string };
};

export function createJoinCodes(deps: { now: () => Date }): JoinCodes {
  let live: { code: string; expiresAt: Date; attemptsLeft: number } | null = null;

  return {
    newCode() {
      const expiresAt = new Date(deps.now().getTime() + PAIR_CODE_TTL_MS);
      live = { code: randomCode(), expiresAt, attemptsLeft: PAIR_CODE_ATTEMPTS };
      return { code: display(live.code), expiresAt: expiresAt.toISOString() };
    },
    redeem(code) {
      if (live === null) return { ok: false, error: "No machine code is active. Get one from Settings > Machines on the phone, or run claudiobot machine invite on the home." };
      if (deps.now() >= live.expiresAt) {
        live = null;
        return { ok: false, error: "That machine code has expired. Get a new one." };
      }
      if (!sameBytes(Buffer.from(normalize(code)), Buffer.from(live.code))) {
        live.attemptsLeft -= 1;
        if (live.attemptsLeft > 0) return { ok: false, error: "That machine code is wrong." };
        live = null;
        return { ok: false, error: "Too many wrong machine codes. Get a new one." };
      }
      live = null;
      return { ok: true };
    },
  };
}
