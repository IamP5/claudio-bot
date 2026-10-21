import { basename, isAbsolute } from "node:path";
import type { MachineId, ProjectRef } from "./wire";

/** online false: the start waits in the home's queue until the machine links. */
export type Placement = { ok: true; machine: MachineId; name: string; online: boolean; project: ProjectRef } | { ok: false; reason: string };

export type PlaceInput = {
  /** The machine the bot named in start_agent, by name (any case) or id; null: it named none. */
  asked: string | null;
  /** The bot's agentsOn; null: the home's own machine. */
  preferred: MachineId | null;
  self: MachineId;
  where: "mac" | "cloud";
  /** As the bot named it: a folder name, an "owner/repo" or a path. */
  project: string;
  machines: readonly { id: MachineId; name: string; online: boolean }[];
};

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Which machine runs the agent, and the project as that machine will resolve it in its own roots. The machine the bot
 * named wins, then the bot's agentsOn, then the home. A cloud agent always starts from the home.
 */
export function placeAgent(a: PlaceInput): Placement {
  const names = a.machines.map((m) => m.name).join(", ");
  const asked = a.asked?.trim().toLowerCase() || null;
  const machine =
    a.where === "cloud"
      ? a.machines.find((m) => m.id === a.self)
      : asked !== null
        ? a.machines.find((m) => m.id === a.asked?.trim() || m.name.toLowerCase() === asked)
        : a.machines.find((m) => m.id === (a.preferred ?? a.self));
  if (!machine) {
    if (asked !== null) return { ok: false, reason: `No machine "${a.asked?.trim()}". Machines: ${names}.` };
    return { ok: false, reason: `This bot's agents run on a machine that is no longer enrolled. Name one of ${names} in machine.` };
  }
  const named = a.project.trim();
  // A path is this machine's; another machine knows the folder only by its name.
  const name = machine.id !== a.self && isAbsolute(named) ? basename(named) : a.project;
  return { ok: true, machine: machine.id, name: machine.name, online: machine.online, project: { githubRepo: GITHUB_REPO.test(named) ? named : null, name } };
}
