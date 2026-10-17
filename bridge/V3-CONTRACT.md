# Bridge v3 contract

This file maps the v3 bridge core: each module's interface, the unit that owns it, and the state it writes. Units U1 to U8 edit only their own files and build against these interfaces. A unit that needs an interface changed reports it as a deviation instead of editing a file it does not own. The doc comments in each module carry the full invariants; this page is the index.

## State: `state.json` version 3

`world.ts` declares every persisted shape. A slice typed `Owned<T>` is a readonly field holding deeply readonly data, so only its writer can change it. The writer uses a module-private cast and mutates in place.

| Slice | Type in `world.ts` | Only writer | Notes |
|---|---|---|---|
| `BotRecord` profile, `dailyCapUsd` | `BotRecord` | `hub.ts` | `update_bot`, `update_self` |
| `BotRecord.messages`, `.unread` | `Message[]` | `hub.ts` (`say` → `post`) | the gate and scheduler call the hub's `say` and `note` |
| `BotRecord.session`, `AgentRecord.session` | `SessionState` (`Pending`, `ActiveTurn`, `Lifecycle`, `Notice`) | `session.ts` | resume id, durable inbox, lifecycle with deadlines, notices |
| `World.account` | `AccountState` | `session.ts` | account-wide usage-limit park |
| `BotRecord.routines` | `RoutineRecord[]` | `scheduler.ts` | `nextRunAt`, newest 20 runs, `failStreak` |
| `BotRecord.rules` | `StandingRule[]` | `gate.ts` | Always/Never, keyed by `Signature`, allow rules carry `appliesTo` |
| `World.gate` | `GateState` (`OpenCard`, `Grant`, `DailyCount`) | `gate.ts` | card deadlines, permission match keys, one-shot grants, daily tool counts |
| `World.devices` | `DeviceRecord[]` | `devices.ts` | token hashes only; `legacy` marks the imported protocol-2 token |
| `World.push` | `PushState` | `push.ts` | `cardId|card` and `cardId|reminder` keys, recorded before sending |
| `AgentRecord.agent`, `.cloudSession` | `Agent`, `string \| null` | `agents.ts` | cloud agents are neither gated nor metered |

`store.ts` owns the file. `loadWorld` fails closed: v2 is copied byte for byte to `state.v2.json.bak` and upgraded in place, v1 is backed up and treated as a first run, and anything else throws `StateFileError` without writing. `flushNow(world, home)` and `saver.schedule("now")` write synchronously through a temp file, `fsync` and rename, with mode 0600. `saver.schedule()` debounces by 250 ms. `Persist = (urgency?: "now") => void` is the type every module receives.

## Modules

| Module | Owner | Interface | Scaffold body |
|---|---|---|---|
| `protocol.ts`, `parse.ts`, `fixtures.ts`, `fixtures/protocol.json` | U0 | wire types, `parseClientMessage`, fixtures with compile-time coverage of every type and kind | final |
| `world.ts`, `store.ts` | U0 | state types and pure rules (`settleCard`, `openCard`, `botStatus`, `routineView`, `hopsAfter`) | final |
| `hub.ts`, `agents.ts`, `tools.ts`, `prompts.ts` | U0 | `Hub`, `HubDeps`, `Agents`, `BotActions`, `Envelope`, `initiatorOf`, `runsAhead`, `withNotices`, `notices` | final wiring |
| `gate.ts` | U1 | `Gate` (`hooks`, `ask`, `answer`, `tick`, `nextDeadline`), `GateDeps`, `CardReply`, `AuditRow`, `failClosed`, `denyOutput`, `toCall`, `toHookOutput` | hook passes every call (`{}`) inside `failClosed`; today's question cards |
| `policy.ts` | U1 | `decide(call, ctx): Decision`, `ToolCall`, `Scope`, `PolicyContext`, `fingerprint`, `detailOf`, `redact` | throws |
| `session.ts`, `turn.ts` | U2 | `createSession(spec): Session`, `SessionSpec`, `TurnEnd` | today's in-memory queue; `interrupt` throws; notices kept in memory |
| `ledger.ts` | U3 | `Ledger` (`add`, `headroom`, `budgetLeft`), `UsageRow`, `Headroom`, default caps | logs each result as today; never limits |
| `scheduler.ts`, `cron.ts` | U4 | `Scheduler` (`upsert`, `remove`, `setEnabled`, `runNow`, `noUpdate`, `settle`, `tick`, `nextDeadline`) | today's minute-matching fire; `runNow` throws |
| `clock.ts` | U4 | `Clock` (`start`, `poke`, `stop`), `Tickable` | wakes every minute as today |
| `devices.ts`, `stream.ts`, `main.ts` | U5 | `Devices`, `rejectsOrigin`, `Stream` | throw; `main.ts` unchanged |
| `push.ts` | U6 | `Push.notify(bot, reason, messageId)` | throws; the hub treats a missing push as off |
| `migrate.ts` | U7 | `migrateHome(deps): Migration` | throws; not called yet |

## Rules each unit builds on

- **Initiator.** `prompts.initiatorOf(envelope)` derives it; nothing passes it by hand. `attended` is true for `user` and for a manual routine run. A manual run is still `kind: "routine"`, so routine bans apply to it. `bot.hops` comes from `world.hopsAfter`.
- **Gate (U1).** The order is floors, initiator bans, limits, Never, grant, Always, the table, then pass. `ask` posts a permission card and returns SDK `deny` with the held reason; SDK `ask` and `defer` are never returned. A gate transition that opens a card, consumes a grant or adds a rule calls `persist("now")` before the audit append and before the hook returns. A repeated `tool_use_id` gets the recorded verdict. The hook body is synchronous and stays inside `failClosed`, because a throwing hook fails open. `toCall` keeps `subagent` (`agent_id`, `agent_type`) and `mcpServer`. Policy passes the SDK's own `Agent` and `SubagentHandback` calls. The gate reports each hold or deny through `GateDeps.denied`, and it denies every call while `turnOf(actor).stopping` is true.
- **Session (U2).** `Lifecycle` holds `idle`, `working`, `stopping`, `backoff` and `parked`, and stores every deadline. While stopping, the interrupt's `error_during_execution` result maps to `TurnEnd` `stopped`, which is never a failure and is never retried. Each envelope that leaves the queue gets exactly one `TurnEnd`. Stop removes queued unattended envelopes as `dropped`, each with a notice. The third denial in one turn moves the session to `stopping` and calls `spec.note`. Notices go on top of the next envelope through `withNotices`.
- **Ledger (U3).** The cost baseline is the session's last row. A session with no row adopts the first result and charges 0. The daily cap holds unattended turns only. Attended turns run, and `capReached` tells the session to note it.
- **Scheduler and clock (U4).** `nextRunAt` advances before a fire. An overdue routine fires once inside the grace window, or else records `skipped`. The clock ticks every `Tickable` at boot, at the earliest `nextDeadline`, and at least every 60 s. The hub's tickers are the scheduler, the gate, and an aggregate of all live sessions.
- **Transport (U5).** `main.ts` answers `devices`, `revoke_device` and `pair_code` before `hub.handle`. Until then the hub replies with an error. `main.ts` passes `hub.hello(stream.position(resumed))` and publishes `stream.append(message)`. Without a position, the hello carries `epoch: ""`, which means no replay ring.

## Wire: protocol 3

Protocol 3 adds to protocol 2 and changes the meaning of no existing field.

- `hello.protocol`, plus `epoch`, `seq` and `resumed`. Broadcast frames carry `seq` (`Broadcast`).
- Message kind `permission` with `from`, `tool`, `label`, `detail`, `always`, `answer` (`once | always | deny | never | expired | null`) and `expiresAt`. Questions gain answer `"expired"` and `expiresAt` (`null` for cards from before protocol 3).
- `Bot.status` gains `awaiting_approval` and `parked`, and `Agent.status` gains the same two. `Bot.dailyCapUsd`, settable through `update_bot`.
- `Routine` keeps `schedule` and `describe`, and gains `trigger`, `nextRunAt` and `runs` (`RoutineRun` with `status`, `late`, `manual` and `note`).
- Client messages: `decide`, `stop`, `stop_agent`, `run_routine`, `devices`, `revoke_device` and `pair_code`. Server messages: `devices` and `pair_code`. HTTP: `PairRequest` and `PairResponse`.

Every server fixture decodes with today's `ios/ClaudioBot/Model/Protocol.swift`. A new kind, status or type decodes as `.unknown`, and `"expired"` decodes as a closed card. Today's `ProtocolTests` will still fail, because they pin 12 fixtures per side and a byte-exact round trip. U8 updates them.

## Left for U9 in U0 files

- Hold the bubbles of a routine-initiated turn until its result. If `turn.quiet && !turn.asked`, drop them and settle the run `quiet`. This needs U2's `quiet` flag in `turn.ts`.
- Make `HubDeps.push` and the `hello` position required once `main.ts` passes them.
- Delete `loadOrCreateToken` once `devices.importLegacy` replaces the shared token.
