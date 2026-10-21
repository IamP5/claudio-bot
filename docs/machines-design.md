# Machines: one world of bots across the Mac and the Linux box

Status: superseded by [vps-design.md](vps-design.md) (remote session replaces remote process for every home). Synthesized from a three-way architect arena (home + workers, replicated peers,
per-machine bots unified by the phone). Base: home + workers.

## Problem

Each bridge keeps its whole world in its own `~/.claudiobot/state.json` and bot homes. The phone stores one
pairing (Keychain account `"bridge"`, `Pairing.swift:395`) and wipes its store when the URL changes
(`BridgeClient.swift:147-158`). Moving the phone from the Mac bridge to the Omarchy bridge lands in a different
world, so the bots vanish.

The user wants two things:

1. The same bots, with chat, memory, routines, skills, library and agents, whichever machine the phone reaches.
2. A choice of machine for the work. That covers which computer an agent codes on, whose screen it controls,
   and whose Chrome it drives.

Constraints the design must respect:

- Claude Code transcripts live at `~/.claude/projects/<encoded cwd>/<id>.jsonl`. The encoded folder contains
  `/Users/tuba` on the Mac and `/home/tuba` on Linux, so a session resumes only on the machine that made it.
- Held approval cards, live queries, worktrees and repo realpaths belong to one process on one machine.
- Routine fires, push dedupe and pair codes are at-most-once because one process saves before acting
  (`scheduler.ts:9-11`). Two bridges loading the same bots would fire routines twice.
- `state.json` is rewritten whole every 250 ms. Syncing it as a file loses data, and `lock.ts` only excludes
  processes on one host.
- Computer use and Chrome are not bridge features. They are MCP servers in each machine's own `~/.claude`.
  Picking a machine for that work therefore means running Claude Code on that machine.

## Usage

```
# Omarchy (always on) becomes the home. Its world is the world.
$ claudiobot machines add
  claudiobot://join?url=ws://omarchy.tail1234.ts.net:7878&code=K7Q-2MX   (10 min)

# Mac joins as a machine and brings its bots along.
$ claudiobot join 'claudiobot://join?url=...&code=K7Q-2MX' --bring
  Joined "Tuba's bots" (home: omarchy). Imported 3 bots, 2 routines, 41 facts.
```

On the phone:

- **Settings > Machines** lists `omarchy · Linux · home · online` and `Tuba's MacBook · macOS · online`.
  Each machine shows chips for what it offers: Chrome, Computer use, Claude desktop, and its projects.
- **Bot settings > Agents run on** offers Automatic, omarchy, or Tuba's MacBook.
- **New session** groups projects by machine. Picking a project picks the machine.
- **Agent rows** carry a machine chip.
- A bot told "check the checkout page in Chrome on my Mac" starts an agent with `machine: "Tuba's MacBook"`.
  That agent's `claude` process runs on the Mac and loads the Mac's chrome-devtools and computer-use servers.
- When the Mac sleeps, every bot keeps working from omarchy. Only agents pinned to the Mac wait, shown as
  "Waiting for Tuba's MacBook", and they resume when it wakes.

Bridge call sites:

```ts
// tools.ts start_agent gains `machine`; `where` keeps "mac" | "cloud" on the wire.
const placed = placeAgent({ asked: a.machine, project: a.project, bot, home, machines: machines.list() });
if (!placed.ok) return placed.reason;  // "Tuba's MacBook is offline since 21:50. claudio-bot is also on omarchy."
await agents.start(botId, { ...a, machine: placed.machine });

// agents.ts: the agent's session is the only thing that learns about the machine.
const m = machines.of(rec);
const ws = await m.call("workspace.prepare", { repo: rec.repo, isolate, agentId: rec.agent.id });
createSession({ ...spec, spawn: m.spawn, options: () => agentOptions(rec, m.profile(), ws) });
```

## Shape

### The core move: remote process, not remote bridge

The home keeps the Agent SDK in its own process. Only the `claude` child runs on the worker. `session.ts`
already takes the spawner as a dependency (`SessionSpec.spawn`, `session.ts:715`, wired at `:1081` through
`spawnClaudeCodeProcess`). The SDK talks to the CLI over stdin and stdout. Piping those two streams over a link
means the gate hooks, `canUseTool`, the in-process `claudio` MCP server, held cards, the durable inbox and the
ledger all stay in one process, unchanged.

The spike on 2026-10-20 checked this directly. A real query with an SDK MCP server, a PreToolUse hook,
`canUseTool`, `sandbox` and `settings` produced these spawn options:

- `args` held flags and an inline settings JSON. No machine-local paths.
- `env` added one key (`CLAUDE_CODE_SDK_READS_SESSION_STATE`) and no paths.
- `command` was the platform binary bundled with the SDK
  (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`).
- `cwd` was the path we passed.

So the worker swaps `command` for its own bundled binary. Requiring both bridges to run the same release keeps
the CLI version equal to the home's SDK version.

### Data

Every record that names a path or process carries the machine it belongs to. The record stays in the one world.

```ts
type MachineId = string & { readonly __brand: "MachineId" };
type WorldId = string & { readonly __brand: "WorldId" };

/** Who the home is. Only role.ts writes it. epoch only rises. */
type HomeClaim = { machine: MachineId; epoch: number; since: string };

type MachineRecord = {
  id: MachineId;
  name: string;
  publicKey: string;               // ed25519; the private key stays in machine.json
  urls: string[];
  lastSeenAt: string | null;
  profile: MachineProfile | null;  // last reported
};

/** Facts about one machine that today are scattered os.* reads (hub.ts:430-437, 815-821, sandbox.ts, claudeCode.ts:23). */
type MachineProfile = {
  platform: "darwin" | "linux";
  homedir: string; username: string; rootHome: "/var/root" | "/root";
  bridgeHome: string; tempDirs: string[]; projectRoots: string[];
  claude: { path: string; version: string } | null;
  sandbox: "seatbelt" | "bubblewrap" | "unavailable";
  desktopApp: boolean;
  managedMcpPath: string;
  connectors: { name: string; kind: "chrome" | "computer-use" | "other" }[];  // what the user can pick this machine for
};

// World gains:
//   world: { id: WorldId; name: string; home: HomeClaim }
//   machines: Map<MachineId, MachineRecord>
// Machine tags:
//   AgentRecord.machine: MachineId    (pinned for life)
//   SessionRecord.machine: MachineId  (Sessions tab overlay)
//   RepoTrust.machine: MachineId      (root is a realpath there)
//   BotRecord.agentsOn: MachineId | null
// Machine-local, never shared: <home>/machine.json = { machineId, worldId, privateKey } (0600).
```

The role is derived and never stored: `home` when `world.home.machine === identity.machineId`, else `worker`.

### Ownership

| State | Single writer | Lives on |
|---|---|---|
| Bots, messages, routines, rules, groups, exchanges, agents[], sessions overlay, gate, devices, push, ledger | home process (today's per-slice writers) | home `state.json` |
| Bot homes (CLAUDE.md, skills, library, inbox, `.history`), USER.md, usage, audit | home process | home |
| Bot transcripts | Claude Code on the home | home `~/.claude/projects` |
| Agent and own-session transcripts, worktrees, checkouts, project list | Claude Code or git on that machine | that machine, read through machine ops |
| `machine.json`, lock, `cache/`, `run/`, `agent-config/` | each machine | never leaves |

Nothing has two writers. A worker writes no world state.

### The Machine module

```ts
type Machine = {
  readonly id: MachineId;
  profile(): MachineProfile;
  status(): { online: true } | { online: false; since: string | null };
  spawn(o: SpawnOptions, stderr: (d: string) => void, exited: () => void): SpawnedProcess;
  call<K extends OpName>(op: K, arg: OpArg<K>): Promise<OpResult<K>>;
};
type Machines = { self(): Machine; of(owner: { machine: MachineId }): Machine; list(): Machine[]; onStatus(f: (id: MachineId) => void): () => void };
```

The interface has three working members. Behind them sit local versus remote, auth, multiplexing, reconnect,
backpressure, the process-group kill, and op validation on both ends. `machine/ops.ts` holds the one op table
both ends derive from:

- `projects.list`
- `workspace.prepare`
- `workspace.remove`
- `workspace.evidence`
- `fs.resolveReal`
- `transcript.exists`, needed for the resume-or-fresh decision (`hub.ts:781`, `agents.ts:272`, `own.ts:314`)
- `sessions.index`
- `sessions.read`
- `sessions.holder`
- `desktop.open`

Only `ops.ts` imports worktree, evidence, transcript and claudeApps. An import-boundary test enforces that.

### The link

- Each worker dials the home over one WebSocket at `/link` on the existing port, over the tailnet.
- Auth is mutual ed25519. Each side signs `(nonce, worldId, epoch, machineId)` and checks it against the
  public keys in `world.machines`.
- The link carries channels for control (heartbeat and profile), ops, one channel per remote `claude`
  process, and a proxied phone socket.
- A blip under 90 s resumes the channels, so a remote `claude` keeps running. After that the worker kills the
  process group and `session.ts` takes its existing "died mid-turn" path.
- The worker refuses any spawn whose cwd is outside its project roots, its worktrees or its bridge home.

### Placement

- **Bot turns run on the home.** The bot's cwd, transcript and memory are there. A bot reaches another machine
  through an agent, and the prompt's new Machines block lists each machine's connectors. A bot on omarchy then
  knows that Chrome work on the Mac means `start_agent({ machine: "Tuba's MacBook" })`.
- **Agents and Sessions-tab sessions are placed once and pinned.** `placeAgent` is a pure function with this
  order of preference:
  1. An explicit machine wins. It is refused if that machine is offline or lacks the project.
  2. Otherwise, the only online machine that has the project. Projects match by `githubRepo`, then by name.
  3. Otherwise `bot.agentsOn`.
  4. Otherwise the home.
  5. If more than one machine still fits, the call is refused with a sentence naming the choices.
- A machine-offline wait does not spend `MAX_STARTS`. `machines.onStatus` wakes waiting sessions.
- Cloud agents run on the home.

### Protocol (feature `machines`, no version bump)

- `hello` gains `world: { id, name, epoch, home, via }` and `machines: MachineInfo[]`.
- `Agent` gains `machine`. `SessionRow` and `SessionProject` gain `machine`.
- New frames:
  - `machines`, sent on any change;
  - `join_code`, to add a machine;
  - `remove_machine`;
  - `update_bot`'s patch gains `agentsOn`.
- `fixtures/protocol.json` pins every new shape for the Swift mirror.

### iOS

- `Pairing` keeps one Keychain entry and gains `world: WorldID?` and `endpoints`, which lists every
  machine's URLs with the home first.
- `BridgeClient.start` dials the endpoints in order. Under the same world id it keeps the store. A different
  world id still wipes, as today.
- New views:
  - `MachinesSettingsView`;
  - `MachineChip` on agent and session rows;
  - an "Agents run on" picker in bot settings;
  - project grouping by machine in New session.
- The Mac app needs no second socket. When the Mac is a worker, its loopback socket proxies to the home.

### Routines never fire twice

Only a process in the home role builds a hub, so a worker has no scheduler object to fire with. A role change
exits with code 75, and launchd or systemd restarts the process into its new role. Webhook hits on a worker's
loopback listener are forwarded to the home, which checks the token and fires as today.

## Synthesis decision

**Base: A (home + workers).** Both the cross-judge and I picked it. It is the only candidate that meets both
goals without a merge layer, and it fits this setup: the always-on Omarchy box is the home, and the Mac is a
worker that offers its projects, Chrome and computer use while it is awake. It reuses a seam the SDK documents
for exactly this case (`sdk.d.ts:2812`, "runs Claude Code on another machine"). It keeps decision row 29 intact,
with no journal and no per-record merge.

**Grafts:**

- **From B.**
  - Connector kinds in `MachineProfile` (chrome, computer-use), shown as chips on the phone and as a Machines
    block in the bot prompt. This is what makes "use Chrome on my Mac" route correctly without the user
    naming the machine.
  - Planned home handoff (Phase 6) carries the bot transcript with the home path and `cwd` fields rewritten.
    When the carry fails, the bot gets a recap of its last ~20 messages instead of today's bare "your history
    is gone".
  - User message ids derived from `clientId`, so a send retried through another endpoint lands once.
- **From C.**
  - `join --bring` and handoff use an idempotent `moveId` handshake with tombstones (freeze, pack, import,
    finish). Any step can be retried, and a replayed import answers the existing bot.
  - Settings > Machines and the protocol fixture pin ship early, so the phone shows both machines before any
    remote work runs.
- **From the cross-judge.**
  - The `transcript.exists` op, which A's table missed.
  - The remote-spawn spike moved first, as a go/no-go. It has been run and passed (see Shape).

**Rejected:**

- **B (replicated peers).** Wall-clock last-writer-wins on about 16 replicated kinds, adopt hooks across 8
  modules, and an AEAD peer link. Its fleet key travels in a 6-digit pair code with no PAKE, which is not safe.
  Its continuity edge over A only matters if no machine is always on.
- **C (per-machine bots, phone merges).** The smallest bridge diff, but it reproduces the complaint: bots on
  a sleeping Mac go dark, and agents run only on their bot's machine. It also claimed `z.looseObject` keeps a
  new top-level `bridge` field through a downgrade. That claim is false, because `toFile` (`store.ts:353`)
  writes only named fields.

**Deferred from A.** Read-only replicas on workers, forced promotion and split-brain salvage (A's Phases 5-6).
With Omarchy always on as home, the loss they guard against is "the Linux box is down". They come back if that
turns out to matter, or if the home should move to a third always-on host.

## Tradeoffs accepted

- We accept that bots go dark when the home is down, in exchange for one writer of every bot fact. The
  mitigation is to make the always-on machine the home.
- We accept that bot turns run only on the home, so the bot's own connectors are the home's. In exchange, bot
  homes and bot transcripts have one location. Reach elsewhere goes through agents.
- We accept one tailnet round trip per remote tool call (the hook request and its answer), in exchange for
  the gate, the cards and the `claudio` tool server staying in one process.
- We accept that agents never move between machines. "Continue on the other machine" is a new agent seeded
  with the old one's last report.
- We accept a state V4 bump, so both bridges upgrade together (`store.ts:321` refuses unknown versions). They
  have to anyway, to speak the link.
- We accept that the device token is valid on every machine of the world, so a compromised machine is a
  compromised world. That fits one person's two computers.

## Alternatives considered

- **Remote session (the worker runs the SDK and the session state machine).** Agent session state would get
  a second writer, held cards would become RPCs, and the `claudio` tool server would need a remote copy.
- **Syncing `~/.claudiobot` with Syncthing or iCloud.** It clobbers `state.json`, the lock does not cross
  machines, and both schedulers fire.
- **Automatic home failover.** Two nodes cannot tell sleep from a partition, so they would double-fire
  routines.

## Open questions

- Is the Omarchy box really always on? If both machines sleep, should the home be a third small host (a Pi or
  a VPS running only the bridge, with no projects)? The design treats that as a plain machine with empty
  `projectRoots`.
- Should a message sent while the home is unreachable queue on the phone and drain on reconnect (today's
  outbox), or should the app say the home is offline? The sketch keeps today's outbox.
- Daily caps become world-wide because the ledger is at the home. That matches the shared Anthropic account.
  Is that the intended behavior?
- Should remote spawn also require the home's address to be on the tailnet (`100.64.0.0/10`), on top of the
  key check?

## Phased delivery

Each phase ends in a check the `verify-claudio-bot` harness can run. Throwaway bridges use different
`CLAUDIOBOT_HOME` and port values on one host first, then the real Mac and Omarchy.

| # | Unit | Proof |
|---|---|---|
| 0 | **Linux parity.** Work items:<br>• `readProfile` and `scopeFor` replace the `os.*` reads<br>• Linux sandbox paths and private-path floors (`~/.config/google-chrome`, `~/.mozilla`, keyrings)<br>• the managed-mcp path<br>• `script -qc` in cloud.ts<br>• a systemd user unit and the doctor<br>• prompts name the machine, not "the Mac" | On Omarchy: pair, a sandboxed Bash turn, an agent with a worktree, a card, a routine fire, and a cloud agent. `scopeFor` tests for darwin and linux profiles. |
| 1 | **Machine as data.** `machine.json`, state V4 with a V3 migration that fills `self`, `LocalMachine` with the op table, and agents, sessions and gate going through `machines.of`. No behavior change. | Existing suite green. The import-boundary test passes. The verify run still passes. |
| 2 | **Link and join.** `/link` with ed25519 and the mux, `join_code` and `claudiobot join` without `--bring`, the `machines` frame, and a minimal Settings > Machines. | Two bridges. Online and offline flip on kill and restart. A bad key or a lower epoch is refused. |
| 3 | **Remote agents.** `remoteSpawn` and `acceptSpawn`, remote ops, `placeAgent`, `start_agent.machine`, the machine-offline wait, the connector Machines block in the prompt, and the agent machine chip. | A bot on the home starts an agent on the worker. Its Bash raises a card answered from the phone client. The transcript appears in the worker's `~/.claude/projects`. A 30 s link cut completes the turn, and a 120 s cut resumes it. |
| 4 | **Sessions tab across machines.** Per-machine index and read ops, machine-scoped project ids, and `session_create` on a worker project. | Rows from both machines. Drive a turn on a worker session. |
| 5 | **Migration.** `join --bring` with the `moveId` handshake, device tokens carried over, and a union by id at the home. | Two fixture worlds become one. The old device token connects through either machine. Routines fire only from the home. A repeat import is a no-op. |
| 6 | **iOS.** Endpoints and dial order, keep the store within one world, an "Agents run on" picker, and the New session machine grouping. | Simulator against two local bridges. An old app build still works against the new bridge. |

Phases 0 to 3 deliver goal 2. Phase 5 delivers goal 1 for the existing two worlds. Moving the home
(planned handoff with transcript carry) is a later phase. Before building it, run a spike to check whether
`claude --resume` accepts a transcript copied under a different encoded cwd.

## Next step

Phase 0: write `readProfile` and `scopeFor`, move `hub.ts:428-438` and `:813-822` onto them with darwin and
linux tests, then fix `cloud.ts:54`.
