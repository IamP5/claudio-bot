import type { ProjectId, SessionId, SessionProject, SessionRow, SessionServerMessage, SessionsChannelFrame } from "../protocol";
import type { MachineId } from "./wire";

// The home's view of every other machine's Sessions tab: each machine's rows and projects as it last listed them,
// in memory only, so the home never writes a machine's sessions to its own disk. It answers which machine holds a
// session id, the routing table for the phone's session requests. A machine's rows stay while it is offline, as last
// known; the phone tells them apart by the machine's online flag.

type SessionsFrame = Extract<SessionServerMessage, { type: "sessions" }>;

/** One machine's list. claimed: ids it answered for before its rows named them (a session it just created). */
type Slice = { rows: Map<SessionId, SessionRow>; projects: Map<ProjectId, SessionProject>; claimed: Set<SessionId> };

export type RemoteSessions = {
  /** The machine whose list holds the session, or null when none does (or the home's own list holds it). */
  ownerOf(id: SessionId): MachineId | null;
  /** The sessions the home routes to this machine. */
  idsOf(machine: MachineId): SessionId[];
  /** Every machine's rows and projects, each row naming its machine. */
  list(): { rows: SessionRow[]; projects: SessionProject[] };
  /** A machine's whole list replaces what the home had of it. Returns the change, as the phone's channel frame. */
  replace(machine: MachineId, frame: SessionsFrame): SessionsChannelFrame;
  /** A machine's channel frame, folded in. Returns it as the phone should see it. */
  apply(machine: MachineId, frame: SessionsChannelFrame): SessionsChannelFrame;
  /** The machine answered for a session its rows do not name yet. */
  claim(machine: MachineId, id: SessionId): void;
};

export const isEmpty = (f: SessionsChannelFrame) => f.rows.length === 0 && f.removed.length === 0 && f.projects.length === 0;

/** home: the home's own list holds the id. The home wins an id both list, as when two bridges share one ~/.claude. */
export function createRemoteSessions(deps: { home: (id: SessionId) => boolean }): RemoteSessions {
  const slices = new Map<MachineId, Slice>();
  const sliceOf = (machine: MachineId): Slice => {
    let s = slices.get(machine);
    if (!s) slices.set(machine, (s = { rows: new Map(), projects: new Map(), claimed: new Set() }));
    return s;
  };
  /** The machine's own claim about which machine it is is not trusted: the link it came over says. */
  const stamped = (machine: MachineId, rows: readonly SessionRow[]) => rows.filter((r) => !deps.home(r.id)).map((r) => ({ ...r, machine }));

  function fold(machine: MachineId, rows: readonly SessionRow[], removed: readonly SessionId[], projects: readonly SessionProject[]): SessionsChannelFrame {
    const s = sliceOf(machine);
    const upserts = stamped(machine, rows);
    for (const r of upserts) {
      s.rows.set(r.id, r);
      s.claimed.delete(r.id);
    }
    const gone = removed.filter((id) => s.rows.delete(id) && !deps.home(id));
    for (const p of projects) s.projects.set(p.id, p);
    return { type: "session_rows", rows: upserts, removed: gone, projects: [...projects] };
  }

  return {
    ownerOf(id) {
      if (deps.home(id)) return null;
      for (const [machine, s] of slices) if (s.rows.has(id) || s.claimed.has(id)) return machine;
      return null;
    },
    idsOf: (machine) => [...(slices.get(machine)?.rows.keys() ?? []), ...(slices.get(machine)?.claimed ?? [])],
    list() {
      const rows = [...slices.values()].flatMap((s) => [...s.rows.values()].filter((r) => !deps.home(r.id)));
      const projects = new Map<ProjectId, SessionProject>();
      for (const s of slices.values()) for (const p of s.projects.values()) projects.set(p.id, p);
      return { rows, projects: [...projects.values()] };
    },
    replace(machine, frame) {
      const s = sliceOf(machine);
      const listed = new Set(frame.rows.map((r) => r.id));
      return fold(machine, frame.rows, [...s.rows.keys()].filter((id) => !listed.has(id)), frame.projects);
    },
    apply: (machine, frame) => fold(machine, frame.rows, frame.removed, frame.projects),
    claim: (machine, id) => void sliceOf(machine).claimed.add(id),
  };
}
