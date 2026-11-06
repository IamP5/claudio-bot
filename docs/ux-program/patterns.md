# Run-state pattern library

Reference patterns for the Sessions UX audit. Each pattern says what the user sees, why it works, where it comes from, which scenarios it informs, and what it means for ClaudioBot. Scenarios and rubric ids are in `scenarios/sessions.md`. The phone's data model is in `../sessions-design.md`.

## 1. Method

**Sources.**

| Key | Source | Version | How it was studied |
| --- | --- | --- | --- |
| T3 | pingdotgg/t3code (web, mobile, relay, server) | `4741dc563f5df538babe02421dca513f2458e577` | Read only, two slices (A: list and run state; B: subagents, background work, notifications, approvals). Nothing from the clone was run. |
| CLI | Claude Code CLI | 2.1.305, model haiku | Observed. S1 to S8 driven in a pty (120x45), screens captured as text, plus `-p --output-format stream-json`. User settings applied (fullscreen TUI, agent teams env), so every TUI subagent ran in the background. |
| DT | Claude Code desktop (Code tab) | Desktop 2.42304.2 | Not observed on screen. Built from docs, the app's own `ccd_*` tool schemas, the main-process bundle (strings, read only), and on-disk store shapes. |

**Evidence levels.** Every source line below carries one.

- **observed**: CLI screen text quoted verbatim, or stream-json events seen in the raw logs.
- **code**: T3 file:line at the SHA above. The behavior is what the code does; it was not run.
- **doc**: DT official docs (D = desktop, SA = sub-agents, TR = tools reference, RC = remote control, PJ = projects, AV = agent view). `doc-CLI` means documented for the CLI only.
- **bundle / tool / disk**: DT strings and logic in `app.asar`, its `ccd_*` tool text, or store key shapes. Real, but one build and minified.
- **inferred**: a reading not confirmed by a screen or by code that renders it.

**Citation check.** 24 T3 citations were checked with `sed -n` / `grep -n` against the clone at the SHA. 23 hold as written. One was corrected.

| Citation | Claim | Result |
| --- | --- | --- |
| `apps/mobile/src/features/threads/threadListV2.ts:61-68` | list status union | holds |
| `threadListV2.ts:169-201` | approval > input > waiting > working > failed/limited > ready | holds |
| `packages/client-runtime/src/state/models.ts:316-343` | timer from work start, never last activity; `Ns`/`Nm`/`Nh Mm` | holds |
| `apps/mobile/src/features/threads/floating-working-status.ts:10-41` | single pill state union | holds |
| `apps/mobile/src/features/threads/floating-working-control.tsx:553-593` | "Working 2m 05s", tabular nums | holds |
| `apps/mobile/src/features/threads/use-visible-second-clock.ts:5-30` | ticks only when focused and app active | holds |
| `packages/shared/src/orchestrationV2PendingBackgroundWork.ts:95-110` | commands do not hold completion; subagent, monitor, background_task do | holds |
| `packages/shared/src/agentAwareness.ts:68`, `:122-125` | user stop gives no awareness state; completed with held work reports running | holds |
| `apps/mobile/src/features/threads/ThreadBackgroundWorkSheet.tsx:41-66` | "Nothing running in the background." | holds |
| `apps/mobile/src/features/threads/PendingApprovalCard.tsx:22-80` | Allow once / Allow session / Decline; dead-requester and read-only notes | holds |
| `apps/mobile/src/features/agent-awareness/foregroundNotificationBehavior.ts:5-28` | suppress push for the thread on screen | holds |
| `apps/mobile/src/connection/app-state-wakeups.ts:3-18` | probe under 10 s away, full reconnect at 10 s or more | holds |
| `packages/client-runtime/src/delayedStatus.ts:3-74` | 400 ms show delay, 400 ms minimum visible | holds |
| `packages/client-runtime/src/connection/hostFreeze.ts:12-25` | "<host> froze for Ns", CPU load text | holds |
| `packages/provider-core/src/server/ProviderAdapter.ts:607-620` | `stopSubagent` with `requestedAt` guard | holds |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:10024-10110` | per-task stop | **corrected**: `stopTask` (:10024) only stops a running *workflow* task and errors otherwise; per-subagent stop is `stopSubagent` in the same range. Slice B's note that the adapter could stop a background Bash through it is dropped. |
| `infra/relay/src/agentActivity/ApnsClient.ts:22`, `:161` | APNs stale-date now + 10 min | holds |
| `infra/relay/src/agentActivity/agentActivityAlerts.ts:14` | terminal alert freshness 2 min | holds |
| `apps/server/src/relay/AgentAwarenessRelay.ts:540-600` | 5 s publish confirm window (`:575`) | holds |
| `apps/web/src/components/Sidebar.logic.ts:579-603` | web priority: Pending Approval 5 ... Completed 1 | holds |
| `apps/mobile/src/features/threads/thread-work-log.tsx:1023`, `:1054`, `:1345` | "exit N" badge; ", tool call failed" label; "Double tap to show N tool calls" hint | holds |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts:1156-1159` | "You stopped after", "Worked for" | holds |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx:1067-1080` | `lastError` on failed or limited rows | holds |
| `packages/client-runtime/src/state/threadShell.ts:50-94`, `ThreadDetailScreen.tsx:674-690` | child request bubbles up; pill pushes to child | holds |

Other T3 citations below come from the two slice reports and were not re-checked one by one. Paths below are shortened: `m/` = `apps/mobile/src/features/threads/`, `cr/` = `packages/client-runtime/src/state/`, `sh/` = `packages/shared/src/`, `web/` = `apps/web/src/components/`, `relay/` = `infra/relay/src/agentActivity/`, `ct/` = `packages/contracts/src/orchestrationV2.ts`.

## 2. Pattern library

### State

**P-STATE-1. One derived status per row, attention first.**
- Sees: one icon, color and word per row: Approval, Input, Working, Waiting, Failed, Limited, Done.
- Why: status is a pure function of the shell. Attention beats working, so a blocked run never looks busy.
- Sources: T3 `m/threadListV2.ts:169-201`; web ranks `web/Sidebar.logic.ts:579-603`. DT sidebar dots: unread (blue), needs input, failed (tool). DT agent view: Working, Needs input, Idle, Completed, Failed, Stopped (doc-CLI AV).
- Scenarios: S1, S4, S5, S7.
- For ClaudioBot: derive `row.status` on the bridge with a fixed precedence and send the word, not just a flag.

**P-STATE-2. Failure is classified and shown on the row.**
- Sees: a failed row replaces its subtitle with the error, one line, red. A usage limit is amber "Limited", not "Failed".
- Why: triage from the list without opening the thread.
- Sources: T3 `m/thread-list-v2-items.tsx:1067-1080`, classes `ct:1239-1246`. DT `failed` dot until "Mark as completed" (tool, bundle).
- Scenarios: S4, S7.
- For ClaudioBot: carry a one-line cause on a failed row and a failed step.

**P-STATE-3. "Needs you" has two sources.**
- Sees: a needs-input dot when a permission prompt is open, or when the turn ended blocked.
- Why: DT counts a main-turn permission prompt only after it has been pending 10 s, then falls back to a model-written end-of-turn category (`blocked`, `need_input`, `failed`, `review_ready`).
- Sources: DT `isSessionWaitingOnUser`, `postTurnSummary`, `turnWrapUp` (bundle, disk).
- Scenarios: S3, S7.
- For ClaudioBot: the bridge already reads `local_*.json`; it ignores `postTurnSummary` and `error*`, which carry DT's classification.

**P-STATE-4. A child's request bubbles to the parent and the list.**
- Sees: the parent row reads Approval or Input when a nested subagent asks. In the thread the pill says "Subagent needs approval" and opens the child.
- Why: walks the lineage to any depth with cycle protection; approval beats input.
- Sources: T3 `cr/threadShell.ts:50-94`, `m/ThreadDetailScreen.tsx:674-690`.
- Scenarios: S1, S8.
- For ClaudioBot: a permission card raised inside a subagent must surface on the session row.

**P-STATE-5. One status slot in the thread, strict precedence.**
- Sees: one pill above the composer: connection, then (hidden while an approval card shows) preparing, syncing, child input, compacting, "Working 2m 05s", background "Running: X" with Stop, snoozed or settled, goal.
- Why: never two competing statuses. A disconnect pre-empts "Working", so a dead socket cannot show a live-looking timer.
- Sources: T3 `m/floating-working-status.ts:10-41`, `m/ThreadDetailScreen.tsx:648-756`.
- Scenarios: S2, S5, S6, S8.
- For ClaudioBot: one thread status line with a written precedence; connection wins.

**P-STATE-6. Subagents have real terminal states.**
- Sees: per agent: Working, Waiting, Idle, Completed, Failed, Cancelled, Interrupted, each with a dot (sky, emerald, rose, muted).
- Why: a failed agent must not read like a finished one.
- Sources: T3 `m/SubagentStatusDot.tsx:6-36`, `cr/subagentDisplay.ts:11-39`, enum `ct:698-739`. DT doc SA: a background subagent ending on an API error is "marked failed". CLI observed: no failed state; a failing command inside an agent ends `Agent "Run failing ls command" finished · 6s`.
- Scenarios: S4.
- For ClaudioBot: an Agent step whose subagent errored reads `error`, never `ok`.

**P-STATE-7. The thread says the user stopped it.**
- Sees: CLI `⏺ Agent "Sleep 150 seconds" was stopped by user` and `⎿  Interrupted · What should Claude do instead?`. Web fold "You stopped after 47s".
- Why: a stop is a distinct outcome from done and from failure.
- Sources: CLI observed (S4.log). T3 `web/chat/MessagesTimeline.logic.ts:1156-1159`.
- Scenarios: S4.
- For ClaudioBot: emit a stopped notice item after `session_stop`, and a `stopped` step state.

### Background work

**P-BG-1. "Turn over, work still running" is its own state.**
- Sees: CLI `✻ Worked for 4s · done 12:11 AM · 1 shell still running`, footer `· 1 shell`, `✻ Waiting for 3 background agents to finish`. T3 pill "Running: npm test" / "Waiting on 2 subagents and 1 command".
- Why: the turn ending is not the session resting. The suffix is rewritten away when the work ends.
- Sources: CLI observed (S2S3.log, S1.log). T3 `cr/threadExecution.ts:281-358`. DT counts `background_task` as activity for keep-awake and quit, but the row likely looks idle (bundle, inferred).
- Scenarios: S2, S3, S8.
- For ClaudioBot: a busy row and a running step while any background task lives, even with no turn.

**P-BG-2. Do not report Done while held work remains.**
- Sees: no early "Done" push or badge.
- Why: the awareness phase stays `running` while subagents, monitors or background tasks hold completion.
- Sources: T3 `sh/orchestrationV2PendingBackgroundWork.ts:95-110`, `sh/agentAwareness.ts:122-125`.
- Scenarios: S2, S3, S8.
- For ClaudioBot: copy the rule, but let a background Bash hold it too (T3 does not; see A-6).

**P-BG-3. A home for background work.**
- Sees: a list of tasks with kind (Subagent, Command, Monitor), icon, and open or stop. Empty: "Nothing running in the background."
- Sources: T3 `m/ThreadBackgroundWorkSheet.tsx:24-29`, `:41-66`. CLI observed `/tasks`: `3 active agents`, `x to stop · ctrl+x ctrl+k to stop all agents`. DT doc D: tasks pane lists subagents, shells, workflows; click to see output or stop.
- Scenarios: S2, S8.
- For ClaudioBot: one tappable status entry opening a list of live tasks.

**P-BG-4. Completion lands in the feed with an outcome.**
- Sees: CLI `⏺ Background command "Run ten-second tick loop in background" completed (exit code 0)`, then an automatic new turn that reports the result.
- Why: the user sees the end and its result without asking.
- Sources: CLI observed (S2S3.log). T3 notification turn item `ct:1082-1088`, `m/thread-work-log.tsx:971-976`. DT `<task-notification>` with status and `duration_ms` (disk).
- Scenarios: S2, S3, S8.
- For ClaudioBot: a thread item within seconds of the task ending, with exit code or outcome.

**P-BG-5. Nested work points at its owner.**
- Sees: (on the wire) a background task names the subagent that started it.
- Sources: CLI observed stream-json `parent_task_id`, `owned_by_subagent:true`. T3 `parentTaskId` `ct:816-821`. DT meta `parentAgentId`, `spawnDepth` (disk).
- Scenarios: S8.
- For ClaudioBot: keep the link and show "started by starter" on the command.

**P-BG-6. Live output tail, fetched only when opened.**
- Sees: CLI `Shell details · Status: running · Runtime: 12s` with a live output box. T3 expanded command row streams output, auto-follows, "Earlier output not shown", "No output.".
- Why: costs nothing while collapsed.
- Sources: CLI observed (S2S3.log). T3 `m/thread-command-output.tsx:12-99`.
- Scenarios: S2, S5.
- For ClaudioBot: tap a running Bash step to tail its output file.

**P-BG-7. Work killed by a restart is named.**
- Sees: CLI on resume `⏺ Background shell command didn't finish before the previous session ended`.
- Sources: CLI observed (S6b.log). T3 `apps/server/src/orchestration-v2/RestartBackgroundNote.ts:30-50`.
- Scenarios: S6, S8.
- For ClaudioBot: a bridge restart that loses a task says so in the thread.

### Subagents

**P-SUB-1. Count plus grouped card.**
- Sees: pill segment "2/3" (live/total), then "3 done". Feed card "Ran 3 subagents" with summary "1 working · 1 done · 1 failed", rose if any failed, and a group elapsed time.
- Sources: T3 `cr/threadSubagents.ts:64-89`, `m/thread-subagent-group.tsx:64-185`, `cr/subagentDisplay.ts:24-39`. CLI observed: only `Waiting for N` text; no aggregate.
- Scenarios: S1, S4.
- For ClaudioBot: show N running of M on the thread while subagents run.

**P-SUB-2. Subagent row with live progress.**
- Sees: dot, title (prompt fallback, 80 chars), status word, ticking elapsed, and a 3-line detail: progress while live, result when done.
- Sources: T3 `m/SubagentRow.tsx:31-88`, `cr/subagentDisplay.ts:113-124`. CLI observed agent panel `◯ general-purpose  Run sleep-echo job 1   9s · ↓ 39.2k tokens`; current tool only in `/tasks` detail `Progress › Bash(perl -e 'sleep 20'; echo done-3)`.
- Scenarios: S1, S5.
- For ClaudioBot: put the subagent's current tool on its row (S1.6).

**P-SUB-3. A subagent is a child thread you can open.**
- Sees: tap pushes the child; Back returns to the parent. Child threads are hidden from the main list. CLI: the main view switches to the agent's transcript with `❯ Message @general-purpose…`.
- Sources: T3 `m/thread-subagent-group.tsx:152-170`, `m/threadListV2.ts:619`. CLI observed (S4.log).
- Scenarios: S1, S7, S8.
- For ClaudioBot: a child row (parentId = session) that opens read-only, not listed at top level.

### Time

**P-TIME-1. Elapsed counts from the server's work start.**
- Why: a silent tool keeps counting up, and reopening the thread shows the true age.
- Sources: T3 `cr/models.ts:316-343` ("never last activity").
- Scenarios: S1, S2, S5, S6 (all `.how-long` items).
- For ClaudioBot: every running step carries a start time on the wire.

**P-TIME-2. A ticking per-second timer that stays still in width.**
- Sees: "Working 2m 05s" in tabular numerals; list rows coarser ("Working 2m").
- Why: motion proves life. The clock pauses when off-screen or backgrounded.
- Sources: T3 `m/floating-working-control.tsx:553-593`, `m/use-visible-second-clock.ts:5-30`. CLI observed spinner `✶ Choreographing… (1m 48s · ↓ 221 tokens)`.
- Scenarios: S5 (S5.7), S2.
- For ClaudioBot: a timer on the running step and on the thread status.

**P-TIME-3. A timer on the running tool row itself.**
- Sees: CLI `⏺ Sleeping 120 seconds, then printing woke · 1m 45s` / `⎿  $ perl -e 'sleep 120'; echo woke (1m 44s)`.
- Sources: CLI observed (S5.log). T3 lacks it (only run and subagent timers).
- Scenarios: S5.
- For ClaudioBot: per-step elapsed, not only per-turn.

**P-TIME-4. Finished work states its duration and end time.**
- Sees: CLI `✻ Cooked for 28s · done 12:10 AM`, `⏺ Agent "Run sleep-echo job 1" finished · 23s`. Web "Worked for 3m 12s".
- Sources: CLI observed. T3 `web/chat/MessagesTimeline.logic.ts:1159`.
- Scenarios: S1, S3, S7.
- For ClaudioBot: done steps show how long they took.

### Liveness

**P-ALIVE-1. Shimmer on the live row.**
- Sees: the running tool row shimmers; finished rows are static. Off when backgrounded or reduced motion.
- Sources: T3 `m/thread-work-log.tsx:252-275`, `:266-267`.
- Scenarios: S5.
- For ClaudioBot: one live-row indicator distinct from a spinner left behind.

**P-ALIVE-2. A heartbeat on the wire during silence.**
- Sees: (protocol) CLI stream-json `tool_progress {tool_name:"Bash", elapsed_time_seconds:30, heartbeat:true}` about every 30 s.
- Why: the only way a client can tell silent from dead.
- Sources: CLI observed (sj-S5.jsonl).
- Scenarios: S5 (S5.4).
- For ClaudioBot: send a frame at least every 30 s per running session.

**P-ALIVE-3. Stale state degrades honestly.**
- Sees: past the stale date every in-flight Live Activity row reads "Out of date". A host stall shows "Mac froze for 12s".
- Sources: T3 `relay/ApnsClient.ts:22`, `:161`, `relay/agentActivityPayloads.ts:110`, `packages/client-runtime/src/connection/hostFreeze.ts:12-25`.
- Scenarios: S5, S6.
- For ClaudioBot: when frames stop, say so instead of ticking on.

### Stop

**P-STOP-1. Stop replaces Send, aimed at one run.**
- Sees: a red Stop where Send was, label "Stop agent".
- Why: Stop carries the `runId`, so a late tap cannot kill a newer run.
- Sources: T3 `m/ThreadComposer.tsx:1077`, `m/ThreadRouteScreen.tsx:563`. DT doc D: stop button or Esc.
- Scenarios: S1, S2, S4, S5, S8 (all `.stop` items).
- For ClaudioBot: Stop visible whenever `controls.working`, including background-only work.

**P-STOP-2. Stop one task.**
- Sees: CLI `/tasks` → `x to stop`. Web per-subagent stop square, "Could not stop subagent" on failure. DT tasks pane stop.
- Why: stopping one sleeper should not kill the rest. A `requestedAt` guard stops a delayed tap from killing a resumed task.
- Sources: CLI observed (S4.log). T3 `web/chat/ThreadRelationshipsControl.tsx:367-392`, `packages/provider-core/src/server/ProviderAdapter.ts:607-620`. DT `query.stopTask` (bundle).
- Scenarios: S4, S8.
- For ClaudioBot: per-task stop in the background list.

**P-STOP-3. Stop-all and leave are confirmed.**
- Sees: CLI `Press ctrl+x ctrl+k again to stop background agents`. CLI "Background this session?" with `2 local agents running` and "they will be stopped". DT quit guard "Claude is working in N sessions."
- Sources: CLI observed (S4.log, S7.log). DT bundle.
- Scenarios: S4, S7.
- For ClaudioBot: confirm only when Stop kills more than the visible turn.

**P-STOP-4. Stop has a pending state and a failure path.**
- Sees: "Stopping..." then rest; "Could not update thread" alert if it fails. A user stop does not fire a Done push.
- Sources: T3 `m/ThreadDetailScreen.tsx:640`, `:713`, `sh/agentAwareness.ts:68`.
- Scenarios: S4.
- For ClaudioBot: show Stopping until the bridge confirms; no completion push after a user stop.

### Notifications

**P-NOTIFY-1. Alert on transitions, by kind, with levels.**
- Sees: pushes for approval, input, completion, failure, each toggleable. DT: done is passive ("Claude finished a task"), needs-input is active ("Claude is waiting for your input"); per kind off, badge or banner.
- Sources: T3 `relay/agentActivityAlerts.ts:14-161`, `packages/contracts/src/relay.ts:22-40`. DT bundle.
- Scenarios: S3.
- For ClaudioBot: a push when background work ends with the app away (S3.1), deep link to the session (S3.2).

**P-NOTIFY-2. Never buzz for what is on screen.**
- Sources: T3 `apps/mobile/src/features/agent-awareness/foregroundNotificationBehavior.ts:5-28`. DT suppresses while the session is viewed (bundle, doc D). CLI: Remote Control pushes skip while at the terminal (doc RC).
- Scenarios: S3.
- For ClaudioBot: suppress the push for the watched session.

**P-NOTIFY-3. Debounce and dedupe.**
- Why: no replay buzz, no Done at thread birth, one alert per run.
- Rules: no previous baseline means replay, no alert. Terminal alerts only if under 2 min old. First "completed" and tombstones wait 5 s. Web dedupes on `runId:status`. Many rows coalesce to "3 agents finished".
- Sources: T3 `relay/agentActivityAlerts.ts:14`, `apps/server/src/relay/AgentAwarenessRelay.ts:575`, `web/ThreadNotificationCoordinator.tsx:128-238`.
- Scenarios: S3, S6.
- For ClaudioBot: a reconnect must not resend old pushes.

**P-NOTIFY-4. One notification thread per session.**
- Sources: T3 APNs `thread-id` (`relay/ApnsClient.ts:120-170`). DT `session-<id>` (bundle).
- Scenarios: S3, S7.
- For ClaudioBot: set `thread-id` to the session id.

**P-NOTIFY-5. Live Activity for several agents.**
- Sees: up to 5 rows sorted attention, failed, running, done; "3 active agents · 1 needs attention".
- Sources: T3 `apps/mobile/src/widgets/AgentActivity.tsx:22-150`, `relay/agentActivityAggregate.ts:14-35`.
- Scenarios: S3, S7.
- For ClaudioBot: later; relies on P-ALIVE-3 for staleness.

### Connection

**P-CONN-1. Say the connection state, tap to retry.**
- Sees: "Reconnecting to Mac", "Failed to connect. Retrying...", "You are offline"; full-screen "Retry now".
- Sources: T3 `apps/mobile/src/features/home/workspace-connection-status.ts:8-48`, `apps/mobile/src/features/connection/EnvironmentConnectionNotice.tsx:20-92`.
- Scenarios: S6.
- For ClaudioBot: the connection line replaces Working while down.

**P-CONN-2. Resume from a cursor, equal to a fresh open.**
- Why: no duplicates, nothing missing; cursor seeded from the cached snapshot.
- Sources: T3 `cr/threads.ts:213-240`, `:856` (`afterSequence`).
- Scenarios: S6 (S6.3).
- For ClaudioBot: `watch_session` with `after` must equal a fresh snapshot.

**P-CONN-3. Foreground wake: probe or reconnect.**
- Why: under 10 s away, probe; at 10 s or more, full reconnect.
- Sources: T3 `apps/mobile/src/connection/app-state-wakeups.ts:3-18`.
- Scenarios: S3, S6.
- For ClaudioBot: on foreground, refresh list and thread before showing state.

**P-CONN-4. No flicker for short syncs.**
- Why: "Syncing" shows after 400 ms and then stays at least 400 ms.
- Sources: T3 `packages/client-runtime/src/delayedStatus.ts:3-74`.
- Scenarios: S6.
- For ClaudioBot: same thresholds for any transient status.

**P-CONN-5. Requests know if the asker is still alive.**
- Sees: buttons disabled with "The provider process for this request is no longer available."
- Sources: T3 `m/PendingApprovalCard.tsx:22-80`. DT doc D: prompts wait with no time limit and are lost if a new process starts.
- Scenarios: S6, S4.
- For ClaudioBot: after a bridge or session restart, mark orphaned cards dead.

**P-CONN-6. Queue what was typed offline.**
- Sources: T3 `apps/mobile/src/state/thread-outbox-model.ts:33-60`.
- Scenarios: S6.
- For ClaudioBot: optional; at least never drop a send silently.

**P-CONN-7. On return, one checklist.**
- Sees: DT: can't reconnect, auth error, waiting request, or "send a message to continue".
- Sources: DT doc D.
- Scenarios: S6.
- For ClaudioBot: a single return notice in the thread, not a guess.

### List

**P-LIST-1. Attention first; working rows recede.**
- Sees: pinned, then active, then shelves "Working (4)", "Snoozed", "Settled". A finished thread jumps to the top. DT Projects Overview: Ready for review, Waiting on you, Working, Idle.
- Sources: T3 `m/threadListV2.ts:571-778`, `m/thread-list-v2-items.tsx:243`, `cr/threadInbox.ts:15-126`. DT doc PJ.
- Scenarios: S7 (S7.5).
- For ClaudioBot: a visible working count and working rows that stand out.

**P-LIST-2. Unread done, from a server watermark.**
- Sees: green "Done" on rows that finished after the last visit; opening clears it.
- Why: watermark on the server syncs devices; a fresh completion is written at once, not throttled.
- Sources: T3 `m/threadListV2.ts:142-153`, `m/ThreadDetailScreen.tsx:379-428`. DT blue unread dot (tool).
- Scenarios: S2, S3, S8 (unread items).
- For ClaudioBot: the bridge flips unread when background work ends, not only when a turn ends.

**P-LIST-3. Rows you can tell apart.**
- Sees: title, project, branch, relative time. CLI picker `Perl sleep command` / `8 seconds ago · main · 165.6KB`.
- Sources: T3 `m/thread-list-v2-items.tsx:960-1100`. CLI observed (S7.log).
- Scenarios: S7 (S7.3).
- For ClaudioBot: never show a bare id as a title.

**P-LIST-4. Acknowledge without archiving.**
- Sees: DT "Mark as completed" clears a needs-input or failed dot until the next event. T3 settle and snooze; approval, input or a new failure wakes a snooze early.
- Sources: DT tool `ccd_sidebar__mark_completed`. T3 `cr/threadSettled.ts:82-169`.
- Scenarios: S7.
- For ClaudioBot: later.

**P-LIST-5. Empty states name the cause.**
- Sees: "No environments connected", "Environment unavailable", "No threads yet", 'No results for "q"'.
- Sources: T3 `apps/mobile/src/features/home/HomeScreen.tsx:145-210`.
- Scenarios: S6, S7.
- For ClaudioBot: an empty list says offline vs none vs filtered.

### Accessibility

**P-A11Y-1. State is a word, not only a color.**
- Sees: every status has a label next to its dot; failed tool rows read ", tool call failed".
- Sources: T3 `m/thread-work-log.tsx:1054`, `:1309`.
- Scenarios: all.
- For ClaudioBot: VoiceOver reads step state and elapsed time.

**P-A11Y-2. Controls say what they act on.**
- Sees: "Stop agent"; "Open approval from <title>"; "Double tap to show 3 tool calls."
- Sources: T3 `m/ThreadComposer.tsx:1077`, `m/ThreadDetailScreen.tsx:679`, `m/thread-work-log.tsx:1345`.
- Scenarios: S1, S4, S8.
- For ClaudioBot: Stop names the session or task it stops.

**P-A11Y-3. Motion respects Reduce Motion and the battery.**
- Sources: T3 `m/thread-work-log.tsx:266-267`, `m/use-visible-second-clock.ts:5-30`.
- Scenarios: S5.
- For ClaudioBot: with Reduce Motion, liveness comes from the timer alone.

**P-A11Y-4. Timers use tabular numerals.**
- Sources: T3 `m/floating-working-control.tsx:571`.
- Scenarios: S5.
- For ClaudioBot: `.monospacedDigit()` on every elapsed label.

## 3. Per-scenario guide

| Scenario | Patterns | What good looks like |
| --- | --- | --- |
| S1 / S1b three parallel subagents | P-SUB-1, P-SUB-2, P-SUB-3, P-STATE-1, P-STATE-4, P-TIME-1, P-TIME-4, P-STOP-1, P-BG-1 (S1b) | Three named steps, all running at once (S1.1, S1.2). Row reads Working the whole time, also when the turn ended and S1b agents still run (S1.3). Each step flips to done only when its own transcript ends (S1.4). Each running step has a wire start time and a ticking timer (S1.5). Each row shows what the agent is doing now (S1.6). Stop stays up until the last agent ends (S1.7). Screen: "2 of 3 running", three rows with live indicators, Stop (S1.8); at rest no spinner (S1.9). |
| S2 long background Bash | P-BG-1, P-BG-2, P-BG-3, P-BG-4, P-BG-6, P-TIME-1, P-STOP-1, P-LIST-2 | Step label carries the command (S2.1). After the turn ends, the row is still busy and the thread shows a running step (S2.2a/b), never an idle row. Elapsed from the real start after reopening (S2.3). An item lands within seconds of the end, with exit code (S2.4). Row goes unread (S2.5). Stop present while it runs (S2.6). |
| S3 finishes while app is away | P-NOTIFY-1, P-NOTIFY-2, P-NOTIFY-3, P-NOTIFY-4, P-BG-2, P-BG-4, P-LIST-2, P-CONN-3 | A push after the command ends (not after the turn ends) that deep links to the session (S3.1, S3.2). Row unread (S3.3). Thread changes (S3.4). Before leaving it reads running with what runs (S3.5). On return, refreshed state, no stale spinner (S3.7). |
| S4 subagent fails, user stops | P-STATE-6, P-STATE-2, P-STATE-7, P-STOP-1, P-STOP-2, P-STOP-4, P-SUB-1 | Failed step in `error` with its cause (S4.1, S4.2), visibly unlike the running one (S4.7). Stop shows Stopping, then within 30 s nothing runs and the session rests (S4.3, S4.4). A "stopped by you" notice (S4.5). The sleeper's command is really killed on the Mac (S4.6). |
| S5 silent two-minute call | P-TIME-1, P-TIME-2, P-TIME-3, P-ALIVE-1, P-ALIVE-2, P-ALIVE-3, P-STOP-1, P-A11Y-3 | Step names the command (S5.1). Working row and running step for the full window (S5.2). Wire start time (S5.3). A frame at least every 30 s (S5.4). Stop throughout (S5.5). Ends ok with a reply (S5.6). Screens at 30 s and 90 s show different elapsed times (S5.7). Better than all refs: say "no output for 1m 30s" next to the timer. |
| S6 reconnect mid-run | P-CONN-1, P-CONN-2, P-CONN-3, P-CONN-4, P-CONN-5, P-STATE-5, P-NOTIFY-3, P-BG-7 | While down, the connection line replaces Working. After resume-1: step running, Stop up (S6.1). After resume-2: step ok, reply present, rest (S6.2). Resumed view equals a fresh open (S6.3). List row matches the thread after each resume (S6.4). Start time survives (S6.5). No replayed pushes. |
| S7 twelve sessions | P-LIST-1, P-LIST-3, P-STATE-1, P-LIST-5, P-NOTIFY-5 | 12 rows (S7.1). Exactly the 4 sleepers read Working (S7.2). 12 distinct titles (S7.3). All rest at the end (S7.4). On screen: working rows stand out and a count like "4 working" is visible (S7.5). |
| S8 subagent starts background task | P-BG-1, P-BG-2, P-BG-5, P-BG-4, P-SUB-3, P-STATE-4, P-STOP-2, P-LIST-2 | After the parent turn ends, row busy and thread shows a running step (S8.1a/b). The running item names "sleep 60" and its owner "starter" (S8.2). The command's own end is reported, or that it was stopped (S8.3). Row unread after (S8.4). Stop present (S8.5). Screen shows what runs and who started it (S8.6). |

## 4. Anti-patterns and gaps in the references

ClaudioBot should beat all three on each of these.

**A-1. A failed subagent reads as finished.** CLI has no failed agent state: `Agent "Run failing ls command" finished · 6s`, `/tasks` shows `✔ ... done`; stream-json never carries `failed` (observed). An unknown agent type is only an inline tool error with no agent row. DT tasks pane look is undocumented. Do better: `error` state plus cause on the step (S4.1, S4.2).

**A-2. Silent and stuck look the same.** CLI shows three ticking timers and a token count frozen at 221; no last-output time (observed). T3 has no stall detection; only host freeze and Live Activity stale date. DT docs call "no new messages" normal (doc PJ). Do better: a heartbeat on the wire (P-ALIVE-2) plus "no output for N" and a stale state when frames stop.

**A-3. Background work makes the row look idle.** DT `isRunning` goes false at turn end; background work counts only as internal activity (bundle, inferred). CLI `/resume` picker shows a session mid-tool exactly like an idle one (observed). Do better: busy row until every background task ends (S2.2a, S8.1a).

**A-4. Stop only for the whole session.** T3 mobile has thread-wide Stop only; per-subagent stop is web hover only; Background work rows cannot be stopped. CLI per-task stop hides behind `/tasks` → Enter → `x`. Do better: Stop per task in the thread's background list (P-STOP-2).

**A-5. Stale rows after Stop.** CLI kept a stopped agent's panel row frozen at `15s` for about 25 s (observed). T3 maps interrupted and cancelled runs to "ready": a stopped thread just goes quiet, with no list marker. Do better: a `stopped` state and notice, cleared rows within seconds (S4.3, S4.5).

**A-6. A background command does not hold completion.** T3 `backgroundWorkHoldsCompletion` returns false for `command`, so a lone background Bash finishing after the turn never alerts. Do better: any background task holds "done" and its end triggers the push (S3.1).

**A-7. Nested ownership is lost.** CLI `/tasks` during S8 listed only the shell, with nothing tying it to the agent; the shell's own completion and exit code were hidden behind `Agent "Start background sleep loop" finished · 1m 5s` (observed). T3 sheets are flat lists despite `parentTaskId`. Do better: name the owner and report the command's own end (S8.2, S8.3).

**A-8. A frozen timer during waiting.** CLI agent row stuck at `4s` for about 60 s while the agent waited on its own shell, then jumped to `19s` (observed). Do better: timers always count from start time, never from last event (P-TIME-1).

**A-9. Disconnect and user stop share one word.** CLI shows `Interrupted · What should Claude do instead?` for Esc, stop, and a killed process; on resume the model re-ran the command without asking (observed). Do better: distinct "stopped by you" and "connection lost while running" states.

**A-10. Lifetime rules differ by mode, silently.** The same S8 prompt gave a shell that lived on (TUI, backgrounded agent) or was killed at once (headless, foreground agent) (observed; DT doc TR confirms the rule). Do better: when the owner's end kills a task, say so in the thread.

**A-11. Notices held while a panel is open.** CLI `Background task update waiting while this panel is open` (observed). Do better: state updates never wait on UI focus.

**A-12. No "while you were away" summary.** CLI finished work is only in scrollback; finished tasks vanish from `/tasks` once nothing is active (observed). Do better: unread row plus the done item at the top of what the user sees on return (S2.5, S3.3).

**A-13. Same glyph, two meanings.** CLI `⏺` means "focused thread" in the agent panel and "running" in `/tasks` (observed). Do better: one glyph per state everywhere.

**A-14. Clock skew.** T3 timers use device `Date.now()` against server timestamps, with no offset correction. Do better: correct by the bridge's clock on connect.

**A-15. Esc means two things.** CLI Esc closes panels in one place and kills the agent's Bash inside the agent view (observed). Do better: Back never stops work; Stop is always an explicit, labeled control.
