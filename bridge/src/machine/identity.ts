import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readPrivate, writePrivate } from "./files";
import type { WorldId } from "../protocol";
import { newMachineId, type MachineId } from "./wire";

// <bridgeHome>/machine.json, 0600: who this bridge is on the link. Every bridge has one from its first boot, a home
// included (it is its own machine). home is set by `claudiobot machine enroll`, and while it is set the bridge boots as
// a machine of that home. Never in state.json, which is the world and moves with it; this file stays on its computer.

/** The home this machine enrolled into: where to dial it and the key it must prove it holds. */
export type HomeRef = { url: string; machineId: MachineId; publicKey: string; name: string };

/**
 * Keys are DER, base64: the public key SPKI, the private key PKCS#8. world: the world this bridge is home to, minted on
 * its first boot as a home; null on a bridge that never booted as one, and on files from before it.
 */
export type Identity = { machineId: MachineId; name: string; publicKey: string; privateKey: string; home: HomeRef | null; world: WorldId | null };

const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const machineId = z.string().regex(/^m_[0-9a-f-]{36}$/) as unknown as z.ZodType<MachineId>;
const FILE: z.ZodType<Identity> = z.object({
  machineId,
  name: z.string().min(1),
  publicKey: b64,
  privateKey: b64,
  home: z.object({ url: z.url(), machineId, publicKey: b64, name: z.string().min(1) }).nullable(),
  world: (z.string().regex(/^w_[0-9a-f-]{36}$/) as unknown as z.ZodType<WorldId>).nullable().default(null),
});

/** The computer's own name (System Settings on macOS), else its hostname. run gives "" for a command that fails. */
export const computerName = async (run: (argv: string[]) => Promise<string>) =>
  (await run(["scutil", "--get", "ComputerName"])) || hostname().replace(/\.local$/, "");

export const identityPath = (bridgeHome: string) => join(bridgeHome, "machine.json");

export function newIdentity(name: string): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    machineId: newMachineId(),
    name,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    home: null,
    world: null,
  };
}

/** machine.json, or null when there is none yet. Throws on a file that does not parse, rather than replacing an identity. */
export function readIdentity(bridgeHome: string): Identity | null {
  const path = identityPath(bridgeHome);
  const raw = readPrivate(path);
  if (raw === null) return null;
  const parsed = FILE.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${path} is not a machine identity: ${z.prettifyError(parsed.error).split("\n")[0]}`);
  return parsed.data;
}

export function saveIdentity(bridgeHome: string, identity: Identity) {
  writePrivate(identityPath(bridgeHome), `${JSON.stringify(identity, null, 2)}\n`);
}

/** The identity in machine.json, created with this name on first use. */
export function loadIdentity(bridgeHome: string, name: string): Identity {
  const found = readIdentity(bridgeHome);
  if (found) return found;
  const made = newIdentity(name);
  saveIdentity(bridgeHome, made);
  return made;
}

/** The home's world id, minted and saved on its first call. */
export function worldOf(bridgeHome: string, identity: Identity): WorldId {
  if (identity.world !== null) return identity.world;
  const world = `w_${crypto.randomUUID()}` as WorldId;
  saveIdentity(bridgeHome, { ...identity, world });
  return world;
}

export const signWith = (privateKey: string, data: Buffer): string =>
  sign(null, data, createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" })).toString("base64");

/** False for a bad signature and for a key or signature that does not decode. */
export function verifyWith(publicKey: string, data: Buffer, sig: string): boolean {
  try {
    return verify(null, data, createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}
