import type { MachineProfile } from "./profile";
import type { AgentRuntime } from "./runtime";
import { profileView, type Applied, type Intent, type MachineId, type ProfileView } from "./wire";

/** since: when it came online, or while offline when it was last heard from; null when not known. */
export type MachineStatus = { online: boolean; since: string | null };

/**
 * What became of an intent sent to a machine. undelivered: the machine was offline, went offline, or did not answer in
 * time, so it may never have seen the intent; sending it again is safe, since a machine applies an intentId once.
 */
export type Sent = Applied | { ok: false; reason: string; undelivered: true };

export type Machine = {
  id: MachineId;
  name: string;
  /** As it last reported it; null for a machine that never linked. */
  profile(): ProfileView | null;
  status(): MachineStatus;
  send(intent: Intent): Promise<Sent>;
};

export type Machines = {
  self(): Machine;
  of(id: MachineId): Machine | null;
  list(): Machine[];
};

/** The machine in this process, under the id in machine.json: send is the runtime's apply, and it is online while the process runs. */
export function createLocalMachine(id: MachineId, runtime: AgentRuntime, profile: MachineProfile): Machine {
  const view = profileView(profile);
  return { id, name: profile.name, profile: () => view, status: () => ({ online: true, since: null }), send: (intent) => runtime.apply(intent) };
}

/** remote: the machines enrolled into this home, read afresh on each call. */
export function createMachines(self: Machine, remote: () => readonly Machine[] = () => []): Machines {
  const list = () => [self, ...remote()];
  return { self: () => self, of: (id) => list().find((m) => m.id === id) ?? null, list };
}
