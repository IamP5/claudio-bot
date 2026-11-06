import { z } from "zod";
import { displayName } from "../text";
import type { Identity } from "./identity";
import type { JoinCodes } from "./joinCodes";
import type { Registry } from "./registry";
import type { MachineId } from "./wire";

// POST /enroll on the home: a computer with a join code pins its key here and gets the home's. The same machine with
// the same key again is answered as before without a code, so a retry after a lost response converges.

export type EnrollRequest = { code: string; machineId: MachineId; name: string; publicKey: string };
export type EnrollResponse = { homeMachineId: MachineId; homePublicKey: string; homeName: string };
/** machine: the enrolled machine's name, for the home's log. */
export type Enrollment = { status: 200; body: EnrollResponse; created: boolean; machine: string } | { status: 400 | 401 | 409; body: { error: string } };

const REQUEST: z.ZodType<EnrollRequest> = z.object({
  code: z.string().min(1).max(32),
  machineId: z.string().regex(/^m_[0-9a-f-]{36}$/) as unknown as z.ZodType<MachineId>,
  name: z.string().min(1).max(200),
  publicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(200),
});

const NAME_LIMIT = 64;

export function enroll(deps: { identity: Identity; registry: Registry; codes: JoinCodes }, body: unknown): Enrollment {
  const parsed = REQUEST.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: "Send {code, machineId, name, publicKey} as JSON." } };
  const r = parsed.data;
  const answer: EnrollResponse = { homeMachineId: deps.identity.machineId, homePublicKey: deps.identity.publicKey, homeName: deps.identity.name };
  const known = deps.registry.get(r.machineId);
  if (known?.publicKey === r.publicKey) return { status: 200, body: answer, created: false, machine: known.name };
  if (known) return { status: 409, body: { error: `${known.name} is already enrolled with another key.` } };
  if (r.machineId === deps.identity.machineId) return { status: 409, body: { error: "That is this home's own id." } };
  const redeemed = deps.codes.redeem(r.code, () => deps.registry.enroll({ id: r.machineId, name: displayName(r.name, NAME_LIMIT) || "Machine", publicKey: r.publicKey }));
  if (!redeemed.ok) return { status: 401, body: { error: redeemed.error } };
  const enrolled = redeemed.value;
  if (!enrolled.ok) return { status: 409, body: { error: enrolled.reason } };
  return { status: 200, body: answer, created: true, machine: enrolled.record.name };
}
