import { basename, isAbsolute } from "node:path";
import type { MachineProfile } from "./profile";
import type { MachineId, ProjectRef } from "./wire";

export type Placement = { ok: true; machine: MachineId; project: ProjectRef } | { ok: false; reason: string };

export type PlaceInput = {
  /** The machine the bot asked for; null: the home's own. */
  asked: MachineId | null;
  self: MachineId;
  /** As the bot named it: a folder name, an "owner/repo" or a path. */
  project: string;
  machines: readonly { id: MachineId; online: boolean; profile: Pick<MachineProfile, "name"> }[];
};

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

/** Which machine runs the agent, and the project as that machine will resolve it in its own roots. */
export function placeAgent(a: PlaceInput): Placement {
  const id = a.asked ?? a.self;
  const machine = a.machines.find((m) => m.id === id);
  if (!machine) return { ok: false, reason: `No machine "${id}".` };
  if (!machine.online) return { ok: false, reason: `${machine.profile.name} is offline.` };
  const named = a.project.trim();
  // A path is this machine's; another machine knows the folder only by its name.
  const name = machine.id !== a.self && isAbsolute(named) ? basename(named) : a.project;
  return { ok: true, machine: machine.id, project: { githubRepo: GITHUB_REPO.test(named) ? named : null, name } };
}
