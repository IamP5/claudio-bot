# World move

A world move takes every bot from one bridge home to another, for example from the Mac to Omarchy. The two worlds
become one on the new home. Phase 6 of [handoff-machines.md](handoff-machines.md).

## Commands

Each command takes the home lock, so it refuses while a bridge runs on that home. Stop the bridge first.

1. On the old machine, run `claudiobot world export [--out <file>]`. It freezes every bot and group, writes one
   bundle file, and prints the moveId and the next steps.
2. Copy the file to the new machine. Stop its bridge and run `claudiobot world import <file>`. Then start the bridge.
3. Once the bots answer on the new machine, run `claudiobot world finish <moveId>` on the old one. It moves the
   frozen bots' homes to `trash/`, as delete does.

The phone needs no new pairing. Its device record moves with the bundle, so its token works on the new home.

## The handshake

Every step converges when it runs again, after a crash or by hand.

- **Freeze.** Export moves every bot, group and exchange log out of `World.bots` into
  `state.json` `moves[]` as `{ kind: "out", phase: "frozen", held }`. A frozen bot is not in the world the bridge
  loads, so nothing runs, fires or pushes for it. The freeze is saved before the bundle is written. A second
  export finds the frozen move and writes the same bundle again, with the same moveId.
- **Pack.** The bundle is one JSON file (mode 0600): `{ format: 1, moveId, from: { machine, at, machineId }, world,
  files, agents }`. `machineId` and `agents` are optional, as bundles from before them have neither.
  `world` holds the bots, groups, exchanges, devices (not the protocol 2 shared-token device) and `push.sent`.
  `files` holds each bot's home except `work/`, `USER.md`, and the `usage/`, `audit/` and `groups/` logs, base64.
- **Import.** The bundle is checked like a `state.json` and every file path is checked against what export packs.
  Files land first: `USER.md` gains the facts it lacks, a `.jsonl` file gains the lines it lacks, any other file is
  replaced. Then the state is unioned by id and saved with `{ kind: "in", moveId }`. That save is the commit point.
  An import of a moveId already recorded answers "already imported" and changes nothing.
- **Finish.** The frozen homes go to `trash/` first, then the move is saved as `phase: "done"`. A rerun says it is
  already finished. A bot that is live in the world again is skipped: its home stays.
- **Round trip.** A bundle that brings back bots this bridge still holds frozen (Mac to Omarchy, then back before
  finish) takes them out of that move, and a move with nothing left frozen is done, so finish trashes nothing that
  came back.
- **Machines.** A bridge that is a machine of a home refuses to export: the home holds the world. `claudiobot machine
  enroll` refuses a bridge that still has bots and names these steps. The bundle carries the exporting bridge's
  machine id and the agents that stay on it, and the import places them on that machine, so the home hears them once
  it enrolls.

## What moves and what stays

- A moved bot keeps its chat, routines, rules, cap, connector choices and queued inbox. Its Claude Code transcript
  stays on the old machine, so its session starts fresh, with a notice that names the move.
- Permission cards still open expire in the move, since the gate that held them stays behind. The notice names the
  calls that did not run. Open questions stay open, and the new gate adopts them.
- On a shared id, the incoming record wins and no local message is lost.
- Agents, the Sessions overlay, the gate's grants and repo trust, the session preferences, `cache/` and the
  token files stay on the old machine. Its agents keep their worktrees and transcripts there.
