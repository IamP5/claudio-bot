# Bots on a VPS, agents on your machines

Status: accepted 2026-10-20 with Omarchy as the home first (the VPS is a later move). Not built. Handoff: [handoff-machines.md](handoff-machines.md). Supersedes the "remote process" core of [machines-design.md](machines-design.md).
Synthesized from a two-way architect arena (remote process vs remote session), judged by Opus 5.5.

## Problem

The bots should live on an always-on Linux VPS at a third-party host. Coding agents and the user's own Claude
Code sessions should run on the Omarchy desktop or the Mac laptop, because that is where the projects, Chrome and
computer use are.

A rented, internet-facing box changes the trust picture of the first proposal. There, the home process held the
Agent SDK and the gate, and each laptop ran only the `claude` child with its stdio piped over a link. If the home
is a VPS, whoever owns the VPS owns that stdin. The SDK's control channel on it includes:

- `apply_flag_settings`, which merges arbitrary keys into the live session settings (`sdk.d.ts:3931`);
- `mcp_set_servers`, which accepts stdio server configs and so can run any command (`sdk.d.ts:4850`);
- `mcp_call`, documented as "No permission check" (`sdk.d.ts:4742`).

A laptop could filter that stream, but the filter must classify about 40 control subtypes that change with
every SDK release. One miss gives the VPS a shell as the user. It would also put one internet round trip on
every tool call, under the gate's 30 s fail-closed hook timeout (`gate.ts:52`).

## Usage

```
# VPS: Debian, joined to the tailnet, no public port. Bots live here.
vps$ claude setup-token                              # long-lived subscription token
vps$ claudiobot env set CLAUDE_CODE_OAUTH_TOKEN      # ~/.claudiobot/env, 0600, denied to bots by the sandbox
vps$ claudiobot import mac-world.tar.zst             # bots, chat, memory, routines, skills, usage
vps$ claudiobot service install                      # systemd user unit, bound to the tailscale0 address only

# Each laptop becomes a machine: same binary, no bots, no scheduler, no push.
mac$ claudiobot machine enroll
  Scan with the phone. Enrolled "Tuba's MacBook" into "Tuba's bots" (home: vps).
  Approver pinned: Tuba's iPhone. Agents may run in ~/Dev/projects. Cap $20/day. Tier: guarded.
```

On the phone:

- **Settings > Machines** lists `vps · home`, `Tuba's MacBook · online · Chrome, Computer use` and
  `omarchy · offline since 23:10`.
- Agent rows carry a machine chip.
- A bot told "check checkout in Chrome on my Mac" starts an agent on the Mac. That agent runs entirely on the
  Mac and loads the Mac's own MCP servers.
- Its approval cards show in the bot chat as today. Tapping Allow signs the answer with a key that lives on the
  phone, and the Mac checks that signature before it runs anything.
- If the Mac is asleep, the start queues ("Waiting for Tuba's MacBook") and runs when it wakes.

Bridge call sites:

```ts
// VPS hub: the bot asks, the machine decides and reports through events.
const placed = placeAgent({ asked: a.machine, project: a.project, bot, machines: machines.list() });
if (!placed.ok) return placed.reason;
const id = await machines.of(placed.machine).send({ kind: "agent.start", intentId, botId, title, prompt, project: placed.project, lease });

// Laptop, machine mode: today's agent modules behind two members.
const runtime = createAgentRuntime({ world, homes, ledger, gate, sandbox, sessions, claude });
dialHub(identity, runtime);   // intents in, events out, replay by seq
```

## Shape

### Where everything runs

| | VPS (home) | Laptop (machine) |
|---|---|---|
| Runs | bots, scheduler, push, phone socket, ledger for bots, cloud agents | agents, own sessions, gate for those, sandbox, private-path floors |
| Holds | chat, memory, skills, library, routines, bot transcripts | agent records, agent cards and grants, repo trust, agent rules, agent transcripts, worktrees |
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; an API key is the hard-isolation option | the laptop's own `claude` login; no credential crosses the link |
| Network | binds to its tailnet address only | dials out to the VPS (`/link`); no inbound port, NAT and sleep are fine |

### The wire is intents and events, never the SDK

`machine/wire.ts` holds the one list. Zod parses both ends at the socket, and `fixtures/protocol.json` pins the
schemas.

```ts
type Intent =
  | { kind: "agent.start"; intentId: string; botId: BotId; bot: BotStandIn; title: string; prompt: string; project: ProjectRef; isolate: Isolate; budgetUsd: number | null; lease: SignedLease | null }
  | { kind: "agent.message"; intentId: string; agentId: AgentId; text: string }
  | { kind: "agent.stop"; intentId: string; agentId: AgentId }
  | { kind: "agent.removeWorktree"; intentId: string; agentId: AgentId }
  | { kind: "card.answer"; intentId: string; cardId: MessageId; signed: SignedAnswer }
  | { kind: "session"; intentId: string; frame: SessionClientMessage }
  | { kind: "snapshot" };

type Event = { seq: Seq; at: string } & (
  | { kind: "agent"; agent: Agent; thread: AgentMessage[]; spentUsd: number }
  | { kind: "report"; agentId: AgentId; botId: BotId; text: string }
  | { kind: "card"; botId: BotId; message: Card; digest: CallDigest }
  | { kind: "usage"; row: UsageRow }
  | { kind: "sessions"; frame: ServerMessage }
  | { kind: "profile"; profile: MachineProfile }
  | { kind: "refused"; intentId: string; reason: string }
  | { kind: "snapshot"; agents: AgentMirror[]; openCards: Card[] });

/** What the laptop is holding, canonicalized: tool name, input, cwd. The phone renders FROM this, not from the card text. */
type CallDigest = { tool: string; input: unknown; cwd: string; sha256: string };
/** Covers the digest, so a VPS that rewrote the card's description cannot reuse the signature. */
type SignedAnswer = { deviceId: DeviceId; cardId: MessageId; digest: string; reply: CardReply; at: string; sig: string };
/** Lets a routine start agents without a tap: bot, repo, expiry. Signed on the phone. */
type SignedLease = { deviceId: DeviceId; botId: BotId; repo: string; until: string; sig: string };
type ProjectRef = { githubRepo: string | null; name: string };   // never a path; the laptop resolves it in its own roots
```

### Who decides what a remote agent may do

The laptop decides, from four things the VPS cannot change:

1. **Floors.** `policy.ts`, private paths, `sandboxFor`, the project roots, the daily cap and the live-agent
   cap. They are evaluated in-process in the laptop's gate, with no network involved.
2. **Signed answers.** An "ask" card settles only on a `SignedAnswer` that verifies against an approver key
   pinned at enrollment. The signature covers the call digest, so the phone signs what it displayed. "Always"
   rules are created only by signed answers and live in the laptop's state.
3. **The laptop's own access mode.** `CLAUDIOBOT_ACCESS` and `CLAUDIOBOT_SANDBOX` are read from the laptop's environment, never from the wire, and reported in `MachineProfile`. A full, sandbox-off laptop trusts its home completely, so it may enroll to an untrusted home only with signed starts.
4. **The tier**, set on the laptop:
   - **guarded** (the default): `agent.start` needs a fresh tap or a `SignedLease`. Chrome, computer use, other
     MCP servers and `git push` always ask.
   - **open**: starts run when asked.
   - **locked**: nothing starts.

If the VPS is fully compromised, it can:

- read bot chat and memory;
- read the reports and card text of online machines;
- under a lease you signed, start sandboxed agents in that repo, with any prompt, up to the laptop's cap;
- stop agents.

It cannot run anything outside the sandbox, approve a held call, trust a repo, add a rule, drive Chrome or
computer use, or exceed the cap. The Tailscale ACL makes the VPS a sink: it accepts connections but cannot dial
the laptops.

### Bot stand-ins on the laptop

The judge checked the claim that `agents.ts`, `gate.ts` and `session.ts` run unchanged without a hub, and it is
false. A card is a `BotRecord.messages` entry (`gate.ts:48`), so with no bot record on the laptop:

- `reconcile` drops cards whose bot is absent (`gate.ts:512`);
- `answer` returns "Unknown bot" (`gate.ts:630`);
- the gate reads rules from `BotRecord.rules` (`gate.ts:287`, `:410`);
- the ledger looks up caps by bot (`ledger.ts:156`);
- the agent settings read `bot.connectorsOff` (`hub.ts:505`).

The fix is a **bot stand-in**. The laptop's World holds one minimal `BotRecord` per bot that has agents there:
name, `connectorsOff` and `dailyCapUsd` (from the intent), and `rules` and `messages` (the laptop's own). It is
created by `agent.start` and updated only by the laptop's runtime. That keeps one writer per slice:

- The laptop owns its stand-in's cards and rules.
- The VPS bot chat shows a mirror of those cards, written only by `card` events through `hub.say`. A phone tap
  never settles anything on the VPS.

### Offline, sleep, latency

- **Gate latency.** Hooks and `canUseTool` run on the laptop, with no network per tool call. Only "ask" crosses
  the internet, and it waits on a human anyway.
- **Queued intents.** Intents queue on the VPS per machine with a TTL by kind: starts 24 h, card answers until
  the card expires, stops 10 min.
- **Reconnect.** The laptop replays its event outbox from the VPS's acked seq and ignores intent ids it already
  applied.
- **Sleep.** A laptop that sleeps mid-turn suspends the agent rather than killing it. While an agent runs, the
  laptop holds a sleep inhibitor, and `claudiobot worker pause` kills everything locally.
- **VPS down.** Bots go dark, as on any single home. Running agents finish locally, and their events wait in
  the outbox.

### Sessions tab, push, privacy, size

- **Sessions tab.** `session_*` frames are routed to the owning machine's own `sessions.ts`, and rows carry
  `machine`. Laptop tool output is kept off the VPS disk by default (`persist: "text"`).
- **Push.** Only the VPS pushes, and it sends titles only, with no message text.
- **Privacy at rest.** The VPS holds chat and memory in clear for its own process. LUKS protects against
  snapshots and resale, and tang can unlock it from Omarchy at boot. Nothing protects chat from live root on
  the VPS. The design protects the laptops from that.
- **Size.** About 250 MB per live bot query, and three or four awake at once. That means 2 vCPU, 8 GB RAM and
  40 GB disk, with bubblewrap for the bot sandbox, around $20 to 40 a month.

## Synthesis decision

**Base: S (remote session).** Opus scored it 20 to P's 15, and I agree. It puts enforcement where the code runs,
there is no hostile control channel to filter, and the hook path never touches the internet. Nothing of the SDK
crosses the wire, so the VPS and the laptops can run different releases.

**Grafts from P:**

- Answers sign a call digest the phone renders from, which closes S's hole where a VPS could show a harmless
  description and collect a valid signature.
- The guarded tier is the default, with signed leases so routines can start agents without a tap. This
  replaces S's default where the VPS could start agents without asking.
- Enrollment works through a QR with an HMAC over a one-time secret, so the phone does not have to reach the
  laptop directly.
- The Tailscale ACL makes the VPS a sink.
- `persist: "text"` and title-only push.
- A sleep inhibitor and `worker pause`.
- The Mac app acts as a local approver over `control.sock`.
- A hostile-home test harness: forged, replayed and widened answers, and out-of-root projects.
- LUKS with tang unlock.

**Rejected from P:**

- The five-layer stdio floor.
- A floor hook that blocks for 900 s, which breaks the gate's "never awaits I/O" rule (`gate.ts:51`).

P's factual errors, for the record:

- `update_settings` cannot rewrite sandbox or hooks.
- `read_file` is gated like the Read tool.
- `plugin_install` is a message, not a control subtype.
- Its flag allowlist would have refused `--project-config-root`, which every untrusted-repo agent needs.

**Change to the first proposal.** S also works with Omarchy as the home, so it replaces remote process there as
well. That leaves one shape for every home. The spawn-seam spike in machines-design.md stays true, but nothing
uses it any more.

## Tradeoffs accepted

- We accept a bot stand-in record on each laptop, in exchange for reusing today's gate, ledger and agent code
  where the code runs.
- We accept a phone signing key and an enrollment step, in exchange for a VPS that cannot approve anything.
- We accept that agent "Always" rules move from the bot to the laptop, in exchange for the laptop enforcing
  rules only it can change.
- We accept that bot turns run on the VPS with the VPS's connectors, so Chrome and computer use are reached
  through agents.
- We accept that the VPS shows an offline machine's agents only as their last mirrored copy.

## Alternatives considered

- **Remote process.** Rejected for an untrusted home because of the control-channel attack surface and one
  internet round trip per tool call.
- **The phone talks to every machine as a separate bridge, and the VPS relays.** Bots would land back on a
  laptop, and the phone would have to merge several worlds.
- **A public bridge through `tailscale funnel`.** It widens the VPS's exposure and does nothing for the
  laptops. Deferred for phones without Tailscale.

## Open questions

1. Is "a compromised VPS can start sandboxed agents in a repo you leased" acceptable, or should the default be
   locked except for fresh taps?
2. Should agent "Always" rules from before the migration be copied to the laptop the agent ran on, or dropped
   and asked again?
3. Should a bot's `dailyCapUsd` keep counting its remote agents (via `usage` events), or do laptop caps replace
   that?
4. Is the Mac app an approver too, with its own key?

## Phased delivery

| # | Unit | Proof |
|---|---|---|
| 0 | **Stand-in spike.** A test World with zero real bots, a stand-in and one `AgentRecord`; force a PreToolUse ask; tick, answer and expire. List the stand-in's fields. | The card survives a tick, the answer runs with a one-shot grant, and expiry posts its notice. This is the go/no-go. |
| 1 | **Linux parity**, plus a systemd unit, `env set`, a bubblewrap check in the doctor, and the token env deny in the sandbox | On a Linux VM: pair, a sandboxed Bash turn, an agent in a worktree, a card, a routine fire and a cloud agent |
| 2 | **`AgentRuntime` and `LocalMachine` extracted**, with `placeAgent`; the hub reaches agents only through `machines.self().send` | Suite green, import-boundary test, verify run unchanged |
| 3 | **Wire, identity, approval** (digest signing), machine-mode boot, `dialHub`, enrollment, and Settings > Machines | Two bridges on one host: enroll, online/offline, bad key refused, replay after a kill |
| 4 | **Remote agents end to end**: tiers, leases, offline queues, mirror | A hub bot starts an agent on a machine. An unsigned answer and a mismatched digest are both refused, and a signed one runs. The hostile-home harness passes. |
| 5 | **Sessions tab routing** | Rows from two machines, and a signed own-session card |
| 6 | **Migration**: export and import with `moveId` tombstones; laptops keep their local agents | The Mac world moves to the VPS. A week-old Mac agent still shows. A repeat import is a no-op. |
| 7 | **iOS**: approver key in the Secure Enclave, digest rendering, enroll, chips, "Agents run on" | Simulator against the VPS and one machine. An old app build still works for VPS-local cards. |

## Next step

The Phase 0 stand-in spike, as a `bun test` in `bridge/test/`, before any wire code.
