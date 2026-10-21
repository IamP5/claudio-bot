import type { MachineProfile } from "./profile";
import type { AgentRuntime } from "./runtime";
import type { Applied, Intent, MachineId } from "./wire";

/** The bridge's own machine. Phase 3 replaces it with the id in machine.json. */
export const SELF = "self" as MachineId;

export type MachineStatus = { online: true } | { online: false; since: string | null };

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

/** The machine in this process: send is the runtime's apply, and it is online while the process runs. */
export function createLocalMachine(runtime: AgentRuntime, profile: MachineProfile): Machine {
  return { id: SELF, profile: () => profile, status: () => ({ online: true }), send: (intent) => runtime.apply(intent) };
}

export function createMachines(self: Machine): Machines {
  return { self: () => self, of: (id) => (id === self.id ? self : null), list: () => [self] };
}
