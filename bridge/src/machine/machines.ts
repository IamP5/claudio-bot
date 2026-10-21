import type { MachineProfile } from "./profile";
import type { AgentRuntime } from "./runtime";
import type { Applied, Intent, MachineId } from "./wire";

export type MachineStatus = { online: true; since: string | null } | { online: false; since: string | null };

export type Machine = {
  id: MachineId;
  profile(): MachineProfile;
  status(): MachineStatus;
  send(intent: Intent): Promise<Applied>;
};

export type Machines = {
  self(): Machine;
  of(id: MachineId): Machine | null;
  list(): Machine[];
};

/** The machine in this process, under the id in machine.json: send is the runtime's apply, and it is online while the process runs. */
export function createLocalMachine(id: MachineId, runtime: AgentRuntime, profile: MachineProfile): Machine {
  return { id, profile: () => profile, status: () => ({ online: true, since: null }), send: (intent) => runtime.apply(intent) };
}

/** remote: the machines enrolled into this home, read afresh on each call. */
export function createMachines(self: Machine, remote: () => readonly Machine[] = () => []): Machines {
  const list = () => [self, ...remote()];
  return { self: () => self, of: (id) => list().find((m) => m.id === id) ?? null, list };
}
