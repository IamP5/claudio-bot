import { join } from "node:path";
import { z } from "zod";
import { readPrivate, writePrivate } from "./files";
import { profileViewSchema, type MachineId, type ProfileView, type Seq } from "./wire";

// <bridgeHome>/machines.json, 0600, on the home: the machines enrolled into it, each pinned to its public key. The link
// refuses any machine not here. ackedSeq is the newest event the home handled from that machine and saved.

export type MachineRecord = {
  id: MachineId;
  name: string;
  publicKey: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  ackedSeq: Seq;
  /** As the machine last reported it; null until its first link. */
  profile: ProfileView | null;
};

export type Enrolled = { ok: true; record: MachineRecord; created: boolean } | { ok: false; reason: string };

export type Registry = {
  list(): readonly MachineRecord[];
  get(id: MachineId): MachineRecord | null;
  /** Same id and key again: a no-op. Same id, another key: refused, since only a forged or swapped file does that. */
  enroll(m: { id: MachineId; name: string; publicKey: string }): Enrolled;
  update(id: MachineId, patch: Partial<Pick<MachineRecord, "lastSeenAt" | "ackedSeq" | "profile" | "name">>): void;
  /** Unpins the machine, so its link is refused from then on. False: it was not enrolled. */
  remove(id: MachineId): boolean;
};

const FILE = z.object({
  machines: z.array(
    z.object({
      id: z.string().min(1) as unknown as z.ZodType<MachineId>,
      name: z.string().min(1),
      publicKey: z.string().min(1),
      enrolledAt: z.string(),
      lastSeenAt: z.string().nullable(),
      ackedSeq: z.number().int().nonnegative(),
      profile: profileViewSchema.nullable(),
    }),
  ),
});

export const registryPath = (bridgeHome: string) => join(bridgeHome, "machines.json");

function load(path: string): MachineRecord[] {
  const raw = readPrivate(path);
  if (raw === null) return [];
  const parsed = FILE.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${path} does not parse: ${z.prettifyError(parsed.error).split("\n")[0]}`);
  return parsed.data.machines;
}

export function createRegistry(deps: { bridgeHome: string; now: () => Date }): Registry {
  const path = registryPath(deps.bridgeHome);
  const machines = load(path);

  const save = () => writePrivate(path, `${JSON.stringify({ machines }, null, 2)}\n`);

  return {
    list: () => machines,
    get: (id) => machines.find((m) => m.id === id) ?? null,
    enroll(m) {
      const known = machines.find((r) => r.id === m.id);
      if (known) {
        return known.publicKey === m.publicKey ? { ok: true, record: known, created: false } : { ok: false, reason: `${known.name} is already enrolled with another key.` };
      }
      const record: MachineRecord = { ...m, enrolledAt: deps.now().toISOString(), lastSeenAt: null, ackedSeq: 0, profile: null };
      machines.push(record);
      try {
        save();
      } catch (e) {
        machines.pop();
        throw e;
      }
      return { ok: true, record, created: true };
    },
    remove(id) {
      const i = machines.findIndex((m) => m.id === id);
      if (i === -1) return false;
      const [gone] = machines.splice(i, 1);
      try {
        save();
      } catch (e) {
        machines.splice(i, 0, gone!);
        throw e;
      }
      return true;
    },
    update(id, patch) {
      const record = machines.find((m) => m.id === id);
      if (!record) return;
      Object.assign(record, patch);
      save();
    },
  };
}
