# Bridge v3 contract

This file maps the v3 bridge core: each module's interface, the unit that owns it, and the state it writes. Units U1 to U8 edit only their own files and build against these interfaces. A unit that needs an interface changed reports it as a deviation instead of editing a file it does not own. The doc comments in each module carry the full invariants; this page is the index.

## State: `state.json` version 3

`world.ts` declares every persisted shape. A slice typed `Owned<T>` is a readonly field holding deeply readonly data, so only its writer can change it. The writer uses a module-private cast and mutates in place.

| Slice | Type in `world.ts` | Only writer | Notes |
|---|---|---|---|
| `BotRecord` profile, `dailyCapUsd` | `BotRecord` | `hub.ts` | `update_bot`, `update_self` |
| `BotRecord.messages`, `.unread` | `Message[]` | `hub.ts` (`say` → `post`) | the gate and scheduler call the hub's `say` and `note` |
| `BotRecord.session`, `AgentRecord.session` | `SessionState` (`Pending`, `ActiveTurn`, `Lifecycle`, `Notice`) | `session.ts` | resume id, durable inbox (`Pending.settles` names the routine run a turn end settles), lifecycle with deadlines, notices |
| `World.account` | `AccountState` | `session.ts` | account-wide usage-limit park |
| `BotRecord.routines` | `RoutineRecord[]` | `scheduler.ts` | `nextRunAt`, newest 20 runs, `failStreak` |
| `BotRecord.rules` | `StandingRule[]` | `gate.ts` | Always/Never, keyed by `Signature`, allow rules carry `appliesTo` |
| `World.gate` | `GateState` (`OpenCard`, `Grant`, `DailyCount`) | `gate.ts` | card deadlines, permission match keys, one-shot grants, daily tool counts |
| `World.devices` | `DeviceRecord[]` | `devices.ts` | token hashes only; `legacy` marks the imported protocol-2 token |
| `World.push` | `PushState` | `push.ts` | `${messageId}|${reason}` keys, recorded before sending |
| `AgentRecord.agent`, `.cloudSession`, `.startedBy` | `Agent`, `string \| null`, `Initiator` | `agents.ts` | cloud agents are neither gated nor metered; `startedBy` is the bot turn's initiator at `start_agent` |

`store.ts` owns the file. `loadWorld` fails closed. It checks every bot and agent record (v3) or every v2 record against the fields the bridge reads, and a malformed record, an unknown version, unreadable JSON or a failed upgrade throws `StateFileError` without writing anything. A v2 file is upgraded in memory first, then its exact bytes are copied to `state.v2.json.bak`, then v3 is written in place. A v1 file is backed up to `state.v1.json.bak` and treated as a first run. A backup is never overwritten. When the name holds other bytes, the copy goes to the next free `.1`, `.2` suffix, and bytes already backed up are not copied again.

`flushNow(world, home)` and `saver.schedule("now")` write synchronously. They write the whole body to a temp file with a unique name, `fsync` it, check its size, rename it over `state.json` with mode 0600, then `fsync` the directory. The guarantee is against a crash of this process. On macOS `fsync` does not flush the drive cache (that needs `F_FULLFSYNC`), so a power loss can still lose the newest write. `saver.schedule()` debounces by 250 ms. A failed debounced write is logged, stays pending and retries with a doubling delay capped at 30 s. `saver.schedule("now")` and `saver.flush()` throw when the write fails, with the retry still armed. `Persist = (urgency?: "now") => void` is the type every module receives, and a module whose `persist("now")` throws must not perform the effect the write was meant to precede.

README, upgrading: "Once the new bridge has started, do not run an older bridge against the same home. It does not know state version 3, treats the file as a first run and overwrites it. To go back, stop the new bridge and copy `state.v2.json.bak` over `state.json` first; anything changed since the upgrade is lost."

## Modules

| Module | Owner | Interface | Scaffold body |
|---|---|---|---|
| `protocol.ts`, `parse.ts`, `fixtures.ts`, `fixtures/protocol.json` | U0 | wire types, `parseClientMessage`, fixtures with compile-time coverage of every type and kind | final |
| `world.ts`, `store.ts` | U0 | state types and pure rules (`settleCard`, `openCard`, `botStatus`, `holdOf`, `routineView`, `RUNS_ON_BOT`, `upsertRoutine`, `rootOf`, `isRoutineChain`, `hopsOf`, `hopsAfter`) | final |
| `hub.ts`, `agents.ts`, `tools.ts`, `prompts.ts` | U0 | `Hub`, `HubDeps`, `tickEach`, `Agents`, `BotActions`, `Envelope`, `SessionInput`, `inputOf`, `initiatorOf`, `settlesOf`, `runsAhead`, `withNotices`, `notices` | final wiring |
| `gate.ts` | U1 | `Gate` (`hooks`, `ask`, `answer`, `forgetBot`, `tick`, `nextDeadline`), `GateDeps`, `CardReply`, `AuditRow`, `failClosed`, `denyOutput`, `toCall`, `toHookOutput` | hook passes every call (`{}`) inside `failClosed`; today's question cards; no `forgetBot` yet |
| `policy.ts` | U1 | `decide(call, ctx): Decision`, `ToolCall`, `Scope`, `PolicyContext`, `fingerprint`, `detailOf`, `redact` | throws |
| `session.ts`, `turn.ts` | U2 | `createSession(spec): Session`, `SessionSpec`, `TurnEnd` | today's in-memory queue; `interrupt` throws; notices kept in memory |
| `ledger.ts` | U3 | `Ledger` (`add` with `fresh?`, `headroom`, `budgetLeft`), `UsageRow`, `Headroom`, default caps | logs each result as today; never limits; no `fresh` yet |
| `scheduler.ts`, `cron.ts` | U4 | `Scheduler` (`upsert`, `remove`, `setEnabled`, `runNow`, `noUpdate`, `settle`, `tick`, `nextDeadline`), `SchedulerDeps.parked(bot, attended)` | today's minute-matching fire; `runNow` throws; `parked(bot)` |
| `clock.ts` | U4 | `Clock` (`start`, `poke`, `stop`), `Tickable` | wakes every minute as today |
| `devices.ts`, `stream.ts`, `main.ts` | U5 | `Devices`, `rejectsOrigin`, `Stream` | throw; `main.ts` unchanged |
| `push.ts` | U6 | `Push.notify(bot, reason, messageId)` | throws; the hub treats a missing push as off |
| `migrate.ts` | U7 | `migrateHome(deps): Migration` | throws; not called yet |

## Rules each unit builds on

- **Initiator.** `prompts.initiatorOf(envelope)` derives it; nothing passes it by hand. `attended` is true for `user` and for a manual routine run. A manual run is still `kind: "routine"`, so routine bans apply to it. The `bot` and `agent` kinds are hops and carry `hops` and `origin`. `origin` is the `Origin` (`user`, `routine` or `system`) where the chain began, and `world.rootOf` reads it from any initiator. `hops` counts bot-to-bot hops along the whole chain. A bot message or creation carries `world.hopsAfter(turn)`, which is one more than `world.hopsOf(turn)`. An agent report carries the agent turn's `hopsOf` unchanged, so an agent hop neither adds a hop nor resets the count. The lineage is flattened, so a persisted initiator never nests however long the chain grows.
- **Queued input.** `prompts.inputOf(envelope, userName)` gives the `SessionInput` (`text`, `initiator`, `settles`, `ahead`) that `Session.push` queues. `settles` is the routine run, set only for a routine's own fire (`settlesOf`). The hub settles a run from `Pending.settles` and never from the initiator, so an approval continuation that carries a routine's initiator never settles the run again.
- **Gate (U1).** The order is floors, initiator bans, limits, Never, grant, Always, the table, then pass. The routine bans test `world.isRoutineChain(initiator)`, and the hop cap tests `world.hopsOf(initiator) >= 2`, so both hold through agent hops. `forgetBot(botId)` drops the bot's open cards, the grants of the bot and its agents, and its daily counts; `delete_bot` calls it before `persist("now")`. `ask` posts a permission card and returns SDK `deny` with the held reason; SDK `ask` and `defer` are never returned. A gate transition that opens a card, consumes a grant or adds a rule calls `persist("now")` before the audit append and before the hook returns. A repeated `tool_use_id` gets the recorded verdict. The hook body is synchronous and stays inside `failClosed`, because a throwing hook fails open. `toCall` keeps `subagent` (`agent_id`, `agent_type`) and `mcpServer`. Policy passes the SDK's own `Agent` and `SubagentHandback` calls. The gate reports each hold or deny through `GateDeps.denied`, and it denies every call while `turnOf(actor).stopping` is true.
- **Session (U2).** `Lifecycle` holds `idle`, `working`, `stopping`, `backoff` and `parked`, and stores every deadline. The lifecycle is `parked` exactly while the queue head is held, for the account's usage limit as well as the daily cap. `world.holdOf(state)` reads the hold from it, and the hub shows `parked` only for a held head with no turn running. `Pending.settles` is copied from the queued input. While stopping, the interrupt's `error_during_execution` result maps to `TurnEnd` `stopped`, which is never a failure and is never retried. Each envelope that leaves the queue gets exactly one `TurnEnd`. Stop removes queued unattended envelopes as `dropped`, each with a notice. The third denial in one turn moves the session to `stopping` and calls `spec.note`. Notices go on top of the next envelope through `withNotices`.
- **Ledger (U3).** The cost baseline is the session's last row. `add` takes `fresh?: boolean`, true when the query started without a resume id. A session with no row charges its whole cumulative when `fresh`, because the SDK's running total began at 0. Otherwise a session with no row (one resumed from before the ledger) adopts the first result and charges 0. The daily cap holds unattended turns only. Attended turns run, and `capReached` tells the session to note it.
- **Scheduler and clock (U4).** `nextRunAt` advances before a fire. An overdue routine fires once inside the grace window, or else records `skipped`. `settle` is called exactly once per fire, for the fire's own turn end. `SchedulerDeps.parked(bot, attended)` is true when no turn of that attendance can start. The account's usage limit holds every turn, and the bot's daily cap holds unattended ones. `upsertRoutine` clears `nextRunAt` when the trigger or `enabled` changes, and re-enabling also clears `failStreak`. The clock ticks every `Tickable` at boot, at the earliest `nextDeadline`, and at least every 60 s. The hub's tickers are the scheduler, the gate, and an aggregate of all live sessions. A ticker that throws is logged and the rest still run (`hub.tickEach`). The hub calls `clock.poke()` from its `changed()`, which `say`, `note`, every bot session's `onChange` and every agent change reach. A module that moves a deadline must reach one of them, or the clock sleeps past it until the 60 s cap.
- **Transport (U5).** `main.ts` answers `devices`, `revoke_device` and `pair_code` before `hub.handle`. Until then the hub replies with an error. `main.ts` passes `hub.hello(stream.position(resumed))` and publishes `stream.append(message)`. Without a position, the hello carries `epoch: ""`, which means no replay ring.

## Wire: protocol 3

Protocol 3 adds to protocol 2 and changes the meaning of no existing field.

- `hello.protocol`, plus `epoch`, `seq` and `resumed`. Broadcast frames carry `seq` (`Broadcast`).
- Message kind `permission` with `from`, `tool`, `label`, `detail`, `always`, `answer` (`once | always | deny | never | expired | null`) and `expiresAt`. Questions gain answer `"expired"` and `expiresAt` (`null` for cards from before protocol 3).
- `Bot.status` gains `awaiting_approval` and `parked`, and `Agent.status` gains the same two. `Bot.dailyCapUsd`, settable through `update_bot`.
- `Routine` keeps `schedule` and `describe`, and gains `trigger`, `nextRunAt` and `runs` (`RoutineRun` with `status`, `late`, `manual` and `note`). A `Bot` frame carries each routine's newest 5 runs (`RUNS_ON_BOT`), because every broadcast repeats it. `details` gains `routines`, each with every kept run (at most 20). `lastRunAt` is derived from the full history in both.
- Client messages: `decide`, `stop`, `stop_agent`, `run_routine`, `devices`, `revoke_device` and `pair_code`. Server messages: `devices` and `pair_code`. HTTP: `PairRequest` and `PairResponse`.

Every server fixture decodes with today's `ios/ClaudioBot/Model/Protocol.swift`. A new kind, status or type decodes as `.unknown`, and `"expired"` decodes as a closed card. Today's `ProtocolTests` will still fail, because they pin 12 fixtures per side and a byte-exact round trip. U8 updates them.

## Fix round U0.1: what each unit adapts to

- **U1 (gate, policy).** Add `forgetBot(botId: BotId): void` to `Gate` and implement it as above. Test the routine bans with `isRoutineChain(initiator)` and the hop cap with `hopsOf(initiator) >= 2`, never with `initiator.kind`. `Initiator` now has `origin` on `bot` and `agent` and `hops` on `agent`; `HeldCall.initiator` and audit rows persist it as is. A `persist("now")` inside the hook may now throw; `failClosed` already turns that into a deny.
- **U2 (session, turn).** Take `SessionInput` from `prompts.ts` as the `push` argument and copy `settles` into every `Pending`; then make `Pending.settles` required in `world.ts`. Pass `fresh: options().resume === undefined` (taken when the query starts) to every `ledger.add`. Keep the lifecycle `parked` exactly while the queue head is held, mirroring the account park too, because `holdOf` and the bot status read it. A `persist("now")` that throws must stop the transition it guards.
- **U3 (ledger).** Add `fresh?: boolean` to `Ledger.add` with the baseline rule above. Rows carry the new `Initiator` shape.
- **U4 (scheduler, cron, clock).** Change `SchedulerDeps.parked` to `(bot: BotRecord, attended: boolean) => boolean` and pass `true` for Run now, `false` for a scheduled fire. Rely on `settle` arriving once per fire. In `clock.ts`, log, wrap each ticker in its own try/catch (or import `tickEach` from `hub.ts`), and re-arm in a `finally`. `upsertRoutine` already clears `nextRunAt` on a trigger or `enabled` change; `setEnabled` must do the same when re-enabling, and clear `failStreak`.
- **U5 (devices, stream, main).** Pass the bridge's log as the fourth argument of `createSaver` so failed saves reach the same log. `saver.flush()` at shutdown can throw.
- **U6 (push).** Keys are `${messageId}|${reason}`, as `world.ts` now says. A `persist("now")` that throws means the push was not recorded, so do not send it.
- **U8 (iOS).** Decode the new `routines` on `details` and show the full run history from it. A `Bot` frame's `routines[].runs` now holds at most the newest 5. Run the regenerated `fixtures/protocol.json`.

## Left for U9 in U0 files

- Hold the bubbles of a routine-initiated turn until its result. If `turn.quiet && !turn.asked`, drop them and settle the run `quiet`. This needs U2's `quiet` flag in `turn.ts`.
- Make `HubDeps.push` and the `hello` position required once `main.ts` passes them.
- Delete `loadOrCreateToken` once `devices.importLegacy` replaces the shared token.
- In `hub.ts`, drop the `forgetBot` cast once U1's `Gate` declares it, and drop the `attended = false` default of `parked` once U4's `SchedulerDeps` passes it.
- With the scaffold `session.ts`, `Pending.settles` is never set, so routine runs stay `running`. U2's session fixes that; check it in integration.
