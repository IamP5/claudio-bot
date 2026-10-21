# Handoff: one world of bots, agents on any machine

Written 2026-10-20 for the session that implements this. Read it top to bottom before touching code.

## Goal

The user runs the bridge on a Mac laptop and on an Omarchy (Arch Linux) desktop. Today each bridge keeps its own
world in `~/.claudiobot`, so when the phone switches bridges the bots vanish. The target:

1. One set of bots, which lives on **Omarchy (the home)**.
2. The user picks the machine where a coding agent or Claude Code session runs (Omarchy or the Mac). The agent
   runs on that machine with its projects, Chrome and computer use.
3. Later, the home moves to a VPS without a redesign.

## Decided

- **The design is [vps-design.md](vps-design.md).** It is a remote session design:
  - A non-home machine runs today's full agent runtime: `agents.ts`, `session.ts`, `gate.ts`, sandbox, its
    ledger slice and its transcripts.
  - The home sends typed intents (start, message, stop, card answer, session frames).
  - The machine streams typed events back (agent, report, card, usage, sessions, profile, refused, snapshot).
  - Nothing of the Agent SDK crosses the wire.

  Read the whole doc, including "Bot stand-ins on the laptop". Replace "VPS" with "Omarchy" throughout for now.
- **The home is Omarchy.** It runs the bots, scheduler, push, the phone socket and the bot ledger. The Mac is a
  machine that dials out to Omarchy over Tailscale.
- **Rejected alternatives.** [machines-design.md](machines-design.md) (remote `claude` process) is superseded:
  on an untrusted home, the SDK's stdin control channel (`apply_flag_settings`, `mcp_set_servers`, `mcp_call`)
  is a shell on the laptop. Replicated peers and the per-machine phone merge were also rejected.
  `decisions.tsv` has the rows.
- **Phone-signed answers are deferred** until the home moves to an untrusted host. Omarchy is the user's own
  machine, so the signing key, digests and leases buy nothing yet. Still, keep the `SignedAnswer` field on the
  wire from day one, nullable, and always null for now. That way adding signatures later is additive and needs
  no wire change. Revisit before any VPS move. This was my call; tell the user if you disagree.
- **Judges and adversarial reviewers run on Opus 5.5 at medium or high effort** (user preference, saved in
  memory).

## Access modes are first-class

The user runs with `CLAUDIOBOT_ACCESS=full` and `CLAUDIOBOT_SANDBOX=off` and wants that supported everywhere.
Both are read per process from the environment (`accessOf(process.env)`, `access.ts`). They are used in:

- `agents.ts:266` and `:370`: repo trust and project config;
- `policy.ts:682-683`: `FULL_FLOORS` and `FULL_HELD`;
- `sandbox.ts:99-101`: sandbox off, and the bridge home as the only denied read under full.

Rules for this work:

- **Each machine's mode is its own.** The Mac's agents follow the Mac's environment, and Omarchy's bots follow
  Omarchy's. The home never sends a mode in an intent, and a machine never adopts one from the wire. This
  comes free with the remote-session shape because the gate, policy and sandbox run where the agent runs.
  Don't break it by threading `Access` through `wire.ts`.
- **Report it.** `MachineProfile` gains `access: { full: boolean; sandbox: boolean }`. The phone shows it as a
  chip ("Full access, no sandbox"), and the bot's Machines prompt block names it.
- **No bubblewrap requirement when the sandbox is off.** The Linux parity bubblewrap check (doctor and boot)
  applies only when `access.sandbox` is true. With it off, Bash runs unsandboxed and nothing should demand bwrap.
- **Floors still hold under full.** `FULL_FLOORS` keeps the bridge's own state off limits, and `FULL_HELD` rows
  (default-branch pushes, history rewrites, publish, deploy, secrets) still raise a card. On a machine, those
  cards travel as `card` events to the phone and back as `card.answer` intents. Phase 4 must prove a
  `FULL_HELD` card from a full, sandbox-off Mac agent.
- **Linux path checks under full.** `scopeFor(profile)` must give the right `bridgeHome` on Linux. The bridge
  home is the only denied read under full, and with the sandbox off only the policy floor protects it. Add a
  test that a full, sandbox-off agent on a Linux profile is refused a read of `~/.claudiobot/state.json`.
- **Test matrix.** Phases 1, 4 and 5 run their verify checks twice: guarded with the sandbox on, and full with
  the sandbox off. The second is what the user actually runs, so it is the one that must pass first.
- **Before any untrusted home.** A full, sandbox-off machine trusts its home completely, since the home's
  prompt becomes unsandboxed code on that machine. The "Later" phase must refuse to enroll a full machine to
  an untrusted home unless starts need a signed tap or lease. It should say so in plain words at enrollment.

## Defaults for the open questions

The user has not answered these. Build against these defaults, and tell the user about each one when it
first matters.

- **Start tier.** `open` while the home is Omarchy: an intent from the home starts the agent. `guarded` (a tap
  or a lease) arrives with signed answers, before any VPS move.
- **Old "Always" rules** in `BotRecord.rules` that apply to agents are not copied to the Mac. The Mac asks
  again. This is safer and simpler.
- **Daily caps.** A bot's `dailyCapUsd` keeps counting its remote agents through `usage` events. Each machine
  may also set its own cap.
- **Mac app as approver.** Not now. It arrives with signed answers.

## Phases

Each phase ends in a check. Use the project skill `verify-claudio-bot`, which launches throwaway bridges and
drives them like the phone. Start with two throwaway homes on one host (different `CLAUDIOBOT_HOME` and port),
then try the real Mac and Omarchy.

| # | Unit | Done when |
|---|---|---|
| 0 | **Stand-in spike.** A `bun test` in `bridge/test/`: a World with zero real bots, one bot stand-in record and one `AgentRecord`. Wire `createGate` and `createAgents` with the fake SDK, as existing tests do. Force a PreToolUse ask, then tick, answer and expire. | The card survives a tick (`gate.ts:512` reconcile), the answer runs with a one-shot grant, and expiry posts its notice. Write down the minimal stand-in fields. This is the go/no-go for the shape. |
| 1 | **Linux parity on Omarchy**, in both access modes. Work items:<br>• `cloud.ts:54` uses `script -qc "cmd" /dev/null` on Linux<br>• a systemd user unit in `service.ts`/`cli.ts`, and the doctor on Linux<br>• sandbox paths from a `MachineProfile`: tmp dirs, a Linux private-path floor (`~/.config/google-chrome`, `~/.mozilla`, keyrings), the bubblewrap check<br>• managed-mcp path `/etc/claude-code/managed-mcp.json`<br>• prompts name the machine, not "the Mac" (`prompts.ts:16,161,206`)<br>• `hub.ts:430-437` and `:815-821` move onto `scopeFor(profile)` | On Omarchy, guarded and then full with the sandbox off: pair, a Bash turn, an agent in a worktree, a card, a routine fire, a cloud agent. `scopeFor` has darwin and linux tests. The bridge home read is refused under full with the sandbox off. |
| 2 | **`AgentRuntime` extracted** behind `apply(intent)` and `events(after)`, with an in-process `LocalMachine` and a pure `placeAgent`. The hub reaches agents only through `machines.self().send`. | Existing suite green, plus an import-boundary test for `machine/`. The verify run is unchanged. |
| 3 | **Wire and link.** `machine/wire.ts` (zod beside the types, `SignedAnswer` nullable); `machine.json` identity; machine-mode boot when it is present; `dialHub` on the machine and `/link` on the home with mutual ed25519 and replay by seq; enrollment by join code; the `machines` frame and `hello.machines` behind the `machines` feature; a minimal Settings > Machines. | Two bridges: enroll, online and offline flip, a bad key is refused, events replay after a kill. |
| 4 | **Remote agents end to end.** Start, message, stop and remove-worktree as intents; cards as events mirrored into the bot chat through `hub.say`; offline queues with TTLs; the mirror cache; `start_agent.machine`; connector chips; a Machines block in the bot prompt. | A bot on the home starts an agent on the machine. Its Bash raises a card answered from the phone client. The transcript is in the machine's `~/.claude/projects`. Kill the machine mid-turn and restart it, and the report arrives once. |
| 5 | **Sessions tab routing** by machine. `SessionRow.machine`. | Rows from both machines, and a turn driven on a machine's session. |
| 6 | **Migration.** Export the Mac's world, import it on Omarchy with a union by id and idempotent `moveId` tombstones. Device tokens are carried over. The Mac keeps its local agents. | Both worlds become one on Omarchy. A repeat import is a no-op. Routines fire only on Omarchy. |
| 7 | **iOS.** One pairing with endpoints, keep the store within one world, machine chips, an "Agents run on" picker, New session grouped by machine. | Simulator against two local bridges. An old app build still works. |
| Later | **Before any VPS:** signed answers with call digests, leases, the guarded tier, a Tailscale ACL that makes the home a sink, and the hostile-home harness. | See vps-design.md. |

## Traps found during design

- **Gate and ledger are tied to bot records.** Cards are `BotRecord.messages` (`gate.ts:48`). `reconcile`
  drops cards whose bot is absent (`gate.ts:512`), `answer` says "Unknown bot" (`gate.ts:630`), rules are read
  from `BotRecord.rules` (`gate.ts:287`, `:410`), caps from `capFor(botId)` (`ledger.ts:156`), and settings from
  `bot.connectorsOff` (`hub.ts:505`). Phase 0 exists to settle this.
- **Unknown top-level `state.json` fields are dropped on save.** `store.ts:353` writes only named fields, even
  though `V3_FILE` is a `z.looseObject`. A new top-level slice needs a schema change, and both bridges must
  upgrade together (`store.ts:321` refuses unknown versions). Keep machine identity in `machine.json`, not in
  `state.json`.
- **The gate never awaits I/O** (`gate.ts:51`). An ask is a deny, a card, then a continuation. Don't add a
  blocking hook.
- **Agents have no `claudio` MCP server.** Only bots do (`hub.ts:631`). Agent reports flow through
  `deps.reported`, which becomes the `report` event.
- **Transcripts resume only on the machine that wrote them.** The encoded cwd contains `/Users/tuba` or
  `/home/tuba`. When the transcript is missing, `forgotten: "restart"` (`session.ts:697`) is the fallback.
- **`Agent.where: "mac" | "cloud"` is on the wire** in both zod and Swift. Keep it, and add `machine` beside it.
- **The iOS app holds one pairing** under the Keychain account `"bridge"` (`Pairing.swift:395`). It wipes the
  store when the URL changes (`BridgeClient.swift:147-158`). The fix is to compare world ids, not URLs.

## Files

- [vps-design.md](vps-design.md) is the design: wire types, ownership table, trust, phases.
- [machines-grounding.md](machines-grounding.md) is the codebase map with file:line citations: state
  inventory, runtime, pairing, protocol, Linux gaps, constraints.
- [machines-design.md](machines-design.md) is the superseded first design. It is useful for `MachineProfile`,
  `placeAgent` and the Phase 0 Linux parity list.
- `decisions.tsv` has the last four rows from this design session.
- Nothing from this session is committed. `docs/` and `decisions.tsv` have uncommitted changes. Commit them
  first, on a branch.

## Start here

1. Create a branch, then commit the docs and `decisions.tsv`.
2. Phase 0: write the stand-in test, run `bun test` in `bridge/`, and record go or no-go in `decisions.tsv`.
3. If go, start Phase 1 on Omarchy. Phase 1 needs the real Linux box, or a Linux VM if Omarchy isn't reachable
   from the session.
