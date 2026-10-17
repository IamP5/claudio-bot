# Bridge v3 contract

This file maps the v3 bridge core: each module's interface, the unit that owns it, and the state it writes. Units U1 to U8 edit only their own files and build against these interfaces. A unit that needs an interface changed reports it as a deviation instead of editing a file it does not own. The doc comments in each module carry the full invariants; this page is the index.

## State: `state.json` version 3

`world.ts` declares every persisted shape. A slice typed `Owned<T>` is a readonly field holding deeply readonly data, so only its writer can change it. The writer uses a module-private cast and mutates in place.

| Slice | Type in `world.ts` | Only writer | Notes |
|---|---|---|---|
| `BotRecord` profile, `dailyCapUsd` | `BotRecord` | `hub.ts` | `update_bot`, `update_self` |
| `BotRecord.messages`, `.unread` | `Message[]` | `hub.ts` (`say` → `post`) | the gate and scheduler call the hub's `say` and `note` |
| `BotRecord.session`, `AgentRecord.session` | `SessionState` (`Pending`, `ActiveTurn`, `Lifecycle`, `Notice`) | `session.ts` | resume id, durable inbox (`Pending.settles`, required, names the routine run a turn end settles), lifecycle with deadlines, notices |
| `World.account` | `AccountState` | `session.ts` | account-wide usage-limit park |
| `BotRecord.routines` | `RoutineRecord[]` | `scheduler.ts` | `nextRunAt`, newest 20 runs, `failStreak` |
| `BotRecord.rules` | `StandingRule[]` | `gate.ts` | Always/Never, keyed by `Signature`, allow rules carry `appliesTo` |
| `World.gate` | `GateState` (`OpenCard`, `Grant`, `DailyCount`) | `gate.ts` | card deadlines, permission match keys, one-shot grants, daily tool counts |
| `World.devices` | `DeviceRecord[]` | `devices.ts` | token hashes only; `legacy` marks the imported protocol-2 token |
| `World.push` | `PushState` | `push.ts` | `${messageId}|${reason}` keys (reason `card`, `reminder` or `message`), recorded before sending |
| `AgentRecord.agent`, `.cloudSession`, `.startedBy` | `Agent`, `string \| null`, `Initiator` | `agents.ts` | cloud agents are neither gated nor metered; `startedBy` is the bot turn's initiator at `start_agent` |

`store.ts` owns the file. `loadWorld` fails closed. It checks every bot and agent record (v3) or every v2 record against the fields the bridge reads, and a malformed record, an unknown version, unreadable JSON or a failed upgrade throws `StateFileError` without writing anything. A v2 file is upgraded in memory first, then its exact bytes are copied to `state.v2.json.bak`, then v3 is written in place. A v1 file is backed up to `state.v1.json.bak` and treated as a first run. A backup is never overwritten. When the name holds other bytes, the copy goes to the next free `.1`, `.2` suffix, and bytes already backed up are not copied again.

`flushNow(world, home)` and `saver.schedule("now")` write synchronously. They write the whole body to a temp file with a unique name, `fsync` it, check its size, rename it over `state.json` with mode 0600, then `fsync` the directory. The guarantee is against a crash of this process. On macOS `fsync` does not flush the drive cache (that needs `F_FULLFSYNC`), so a power loss can still lose the newest write. `saver.schedule()` debounces by 250 ms. A failed debounced write is logged, stays pending and retries with a doubling delay capped at 30 s. `saver.schedule("now")` and `saver.flush()` throw when the write fails, with the retry still armed. `Persist = (urgency?: "now") => void` is the type every module receives, and a module whose `persist("now")` throws must not perform the effect the write was meant to precede.

README, upgrading: "Once the new bridge has started, do not run an older bridge against the same home. It does not know state version 3, treats the file as a first run and overwrites it. To go back, stop the new bridge and copy `state.v2.json.bak` over `state.json` first; anything changed since the upgrade is lost."

## Modules

| Module | Owner | Interface | State on `claudio/u9-integrate` |
|---|---|---|---|
| `protocol.ts`, `parse.ts`, `fixtures.ts`, `fixtures/protocol.json` | U0 | wire types, `parseClientMessage`, fixtures with compile-time coverage of every type and kind | final |
| `protocol2.ts` | U9 | `forProtocol2` (a frame as a protocol 2 socket gets it), `cardReply` (a card tap as a `CardReply`), `PROTOCOL_2_OPTIONS` | final |
| `world.ts`, `store.ts` | U0 | state types and pure rules (`settleCard`, `openCard`, `botStatus`, `holdOf`, `routineView`, `RUNS_ON_BOT`, `upsertRoutine`, `rootOf`, `isRoutineChain`, `hopsOf`, `hopsAfter`) | final |
| `hub.ts`, `agents.ts`, `tools.ts`, `prompts.ts` | U0, wired by U9 | `Hub`, `HubDeps` (`push` required, `claude` for a fake SDK in tests), `tickEach`, `Agents`, `BotActions`, `botName`, `Envelope`, `SessionInput`, `inputOf`, `initiatorOf`, `settlesOf`, `runsAhead`, `withNotices`, `notices`, `DEFAULT_BOT`, `defaultBotJob` | final, except the `forgetBot` cast (below) |
| `gate.ts` | U1 | `Gate` (`hooks`, `ask`, `answer`, `forgetBot`, `tick`, `nextDeadline`), `GateDeps`, `CardReply`, `AuditRow`, `failClosed`, `denyOutput`, `toCall`, `toHookOutput` | scaffold until `claudio/u1-gate` merges |
| `policy.ts` | U1 | `decide(call, ctx): Decision`, `ToolCall`, `Scope`, `PolicyContext`, `fingerprint`, `detailOf`, `redact` | scaffold until `claudio/u1-gate` merges |
| `session.ts`, `turn.ts` | U2 | `createSession(spec): Session`, `SessionSpec`, `TurnEnd` | final |
| `ledger.ts` | U3 | `Ledger` (`add` with `fresh?`, `headroom`, `budgetLeft`, `dailyLeft`), `UsageRow`, `Headroom`, default caps | final |
| `scheduler.ts`, `cron.ts` | U4 | `Scheduler` (`upsert`, `remove`, `setEnabled`, `runNow`, `noUpdate`, `settle`, `tick`, `nextDeadline`), `SchedulerDeps.parked(bot, attended)` | final |
| `clock.ts` | U4 | `Clock` (`start`, `poke`, `stop`), `Tickable` | final |
| `devices.ts`, `stream.ts`, `serve.ts`, `legacy.ts`, `lock.ts`, `main.ts` | U5, `serve.ts` downgrade by U9 | `Devices`, `rejectsOrigin`, `Stream`, `serve`, `Legacy`, `lockHome` | final |
| `push.ts` | U6 | `Push.notify(bot, reason, messageId)`, `senderFromEnv` | final |
| `migrate.ts` | U7 | `migrateHome(deps): Migration` | final; reads the default bot from `prompts.ts` |

## Rules each unit builds on

- **Initiator.** `prompts.initiatorOf(envelope)` derives it; nothing passes it by hand. `attended` is true for `user` and for a manual routine run. A manual run is still `kind: "routine"`, so routine bans apply to it. The `bot` and `agent` kinds are hops and carry `hops` and `origin`. `origin` is the `Origin` (`user`, `routine` or `system`) where the chain began, and `world.rootOf` reads it from any initiator. `hops` counts bot-to-bot hops along the whole chain. A bot message or creation carries `world.hopsAfter(turn)`, which is one more than `world.hopsOf(turn)`. An agent report carries the agent turn's `hopsOf` unchanged, so an agent hop neither adds a hop nor resets the count. The lineage is flattened, so a persisted initiator never nests however long the chain grows.
- **Queued input.** `prompts.inputOf(envelope, userName)` gives the `SessionInput` (`text`, `initiator`, `settles`, `ahead`) that `Session.push` queues. `settles` is the routine run, set only for a routine's own fire (`settlesOf`). The hub settles a run from `Pending.settles` and never from the initiator, so an approval continuation that carries a routine's initiator never settles the run again. The scheduler's boot sweep and overlap check read `settles` too.
- **Turn output (hub).** The hub reads only the turn in flight (`onMessage`'s `turn` argument), so envelopes Stop drops while it runs never reset it, and output with no turn posts as plain bubbles. A routine's scheduled fire (`settles` set, not manual) holds its bubbles until its end. `turn.quiet && !turn.asked` drops them, settles the run `quiet` and pushes nothing. Otherwise they post with one `message` push, after `post` so the push throttle sees the message. Bubbles before an `ask` go out at once. A `stopped` end notes "Stopped by <user>" only when `by` is `user`; a breaker stop settles a routine run `skipped` with `BREAKER_NOTE`. Bot status reads `session.working` and `session.parkedFor`, and `awaiting_approval` counts every open permission card with `actor.botId` equal to the bot, agents' cards included.
- **Gate (U1).** The order is floors, initiator bans, limits, Never, grant, Always, the table, then pass. The routine bans test `world.isRoutineChain(initiator)`, and the hop cap tests `world.hopsOf(initiator) >= 2`, so both hold through agent hops. `forgetBot(botId)` drops the bot's open cards, the grants of the bot and its agents, and its daily counts; `delete_bot` calls it before `persist("now")`. `ask` posts a permission card and returns SDK `deny` with the held reason; SDK `ask` and `defer` are never returned. A gate transition that opens a card, consumes a grant or adds a rule calls `persist("now")` before the audit append and before the hook returns. A repeated `tool_use_id` gets the recorded verdict. The hook body is synchronous and stays inside `failClosed`, because a throwing hook fails open. `toCall` keeps `subagent` (`agent_id`, `agent_type`) and `mcpServer`. Policy passes the SDK's own `Agent` and `SubagentHandback` calls. The gate reports each hold or deny through `GateDeps.denied`, and it denies every call while `turnOf(actor).stopping` is true.
- **Session (U2).** `Lifecycle` holds `idle`, `working`, `stopping`, `backoff` and `parked`, and stores every deadline. The lifecycle is `parked` exactly while the queue head is held, for the account's usage limit as well as the daily cap. `world.holdOf(state)` reads the hold from it, and the hub shows `parked` only for a held head with no turn running. `Pending.settles` is copied from the queued input. While stopping, the interrupt's `error_during_execution` result maps to `TurnEnd` `stopped`, which is never a failure and is never retried. Each envelope that leaves the queue gets exactly one `TurnEnd`. Stop removes queued unattended envelopes as `dropped`, each with a notice. The third denial in one turn moves the session to `stopping` and calls `spec.note`. Notices go on top of the next envelope through `withNotices`.
- **Ledger (U3).** The cost baseline is the session's last row. `add` takes `fresh?: boolean`, true when the query started without a resume id. A session with no row charges its whole cumulative when `fresh`, because the SDK's running total began at 0. Otherwise a session with no row (one resumed from before the ledger) adopts the first result and charges 0. The daily cap holds unattended turns only. Attended turns run, and `capReached` tells the session to note it.
- **Scheduler and clock (U4).** The hub's `changed(bot, "now")` calls `persist("now")` before it broadcasts, and the scheduler delivers a fire only after that returns, so a fire is at most once. The hub's `parked(bot, attended)` is the account's usage limit, or a `usage_limit` hold on the bot's session, or, for unattended work only, any hold or a reached daily cap. `update_bot` with `dailyCapUsd` calls `recheck()` on the bot's session and its mac agents' sessions. `nextRunAt` advances before a fire. An overdue routine fires once inside the grace window, or else records `skipped`. `settle` is called exactly once per fire, for the fire's own turn end. `SchedulerDeps.parked(bot, attended)` is true when no turn of that attendance can start. The account's usage limit holds every turn, and the bot's daily cap holds unattended ones. `upsertRoutine` clears `nextRunAt` when the trigger or `enabled` changes, and re-enabling also clears `failStreak`. The clock ticks every `Tickable` at boot, at the earliest `nextDeadline`, and at least every 60 s. The hub's tickers are the scheduler, the gate, and an aggregate of all live sessions. A ticker that throws is logged and the rest still run (`hub.tickEach`). The hub calls `clock.poke()` from its `changed()`, which `say`, `note`, every bot session's `onChange` and every agent change reach. A module that moves a deadline must reach one of them, or the clock sleeps past it until the 60 s cap.
- **Transport (U5).** `serve.ts` answers `devices`, `revoke_device` and `pair_code` before `hub.handle`, which replies to them with an error. It passes `hub.hello(stream.position(resumed))` (the position is required) and publishes `stream.append(message)`.
- **Protocol 2 sockets (U9).** A socket that did not connect with `?protocol=3` subscribes to its own topic and gets every frame through `forProtocol2`: a permission card becomes a question card with the options `Allow once` and `Deny` (answered `once`/`always` → 0, `deny`/`never` → 1, `expired` kept), with the same `seq`. It is never offered a resume, because the ring holds protocol 3 frames. The hub reads an `answer` on a permission card through `cardReply` as `decide` once (option 0) or deny (option 1), refuses any other option, and reads `dismiss` on one as deny.
- **Agents (U9 wiring).** A mac agent's query opens with `maxBudgetUsd`: `budgetLeft(agent)` for an attended queue head, `min(budgetLeft(agent), dailyLeft(bot))` for an unattended one. It is read once per live query, so it is only ever stricter than the ledger. Bot queries pass none.

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

## Integration (U9)

Done on `claudio/u9-integrate`: every item above, `HubDeps.push` and the hello position required, `loadOrCreateToken` deleted, `Pending.settles` required and validated at load, `log` and `userName` passed to the sessions, scheduler and clock, bot names capped at 40 characters with no control or bidi characters in `create_bot` and `update_self`, and the default bot's name, avatar and job shared with `migrate.ts`. `scripts/e2e.ts` covers pairing, a user turn, an agent report, Stop, a held push approved through `decide` and through a protocol 2 answer, quiet and non-quiet routine runs after a restart, and resume. It passed all 10 scenarios twice against this branch merged with `claudio/u1-gate` at 5118e69.

Known risk, not seen in either e2e run: Claude Code can run a turn on its own (a background task finishing). Results carry no turn id, so such a result during a bridge turn could end the bridge's turn early.

## After the U1 merge

These touch `gate.ts`, `policy.ts` or their tests, or wait on them.

- `hub.ts`: drop the `(gate as Gate & { forgetBot?… })` cast in `delete_bot`; U1's `Gate` declares `forgetBot`. Its own `persist("now")` makes `delete_bot` save twice, which the hub test allows.
- `policy.ts`: switch `chainOf` to the world lineage helpers (`isRoutineChain`, `hopsOf`).
- `gate.test.ts`, `policy.test.ts` at 5118e69 do not typecheck against U0.1 shapes (`AgentRecord.startedBy`, `Initiator.origin` on `bot`). `bun test` passes; `tsc` does not.
- Reminders: `Push.notify` returns nothing and skips the push while a socket is live or push is off. The gate must not treat a reminder as delivered because it called `notify`; the in-app card still shows, and push is best effort. Decide and test this in `gate.ts`.
- Add a hub test with the real gate: three denied calls in one turn stop it with the breaker note and no "Stopped by" note, and a routine run settles `skipped` with `BREAKER_NOTE`. The scaffold gate never denies, so it cannot be written before the merge.
- Re-check the README's gate numbers against U1's final values: permission cards 2 h, questions 24 h, one reminder at half-life, grants 10 min, `create_bot` 5 and `start_agent` 20 per bot per day, and the floor and table rows it names.
- Rerun `bun run e2e` on the merged branch. The runs above used U1's committed branch, not its fix round.
