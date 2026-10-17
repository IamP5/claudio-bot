# How the v3 bridge design was chosen

v3 had to add five things to the v2 bridge: approval before risky tool calls, routines that are honest about what they did, spend limits, pairing per device, and a way to keep running when the phone is closed. Three runners designed the same core independently. A judge scored them, and a synthesis picked a base and grafted the best parts of the others onto it. This page is the record of that choice. `docs/design.md` describes the result, and `decisions.tsv` logs each decision with its evidence.

## The candidates

- **A, event journal.** Every fact is an event in an append-only log, and state is a fold over it. It scored highest with the judge (24), but every historical event shape must stay foldable forever. It was about 3,700 lines against 2,800 for B, and it needed a big-bang rollout behind one serial spine.
- **B, deep modules on `state.json`.** One module per concern (gate, session, ledger, scheduler, devices, push), each the only writer of its slice of one state file. It scored 20.
- **C, state machines.** It modeled each session as a tagged union with a pure `step()`, and wrote the strictest tool policy. It scored 23.

## The decision

The base is **B**. The judge's objections to B each had a cheap fix, which the synthesis adopted. A's costs are structural, and a small bridge is part of its safety argument, because a person can read all of it. From C the synthesis took the session lifecycle as a pure `step()` over `idle | working | stopping | backoff | parked`, the tool policy (fails closed, splits Bash into segments, records whether an Always was given in an attended turn), the three-denials breaker, the account-wide usage-limit park, and deadlines stored as data behind one clock. From A it took the idempotent hook (a repeated `tool_use_id` gets the recorded verdict), push recorded before it is sent, hop and daily caps on `message_bot`, `create_bot` and `start_agent`, and agent budgets passed to the SDK as `maxBudgetUsd`.

All three runners agreed on these points, which shipped as they were: gate in a `PreToolUse` hook, never return the SDK's `ask`, let unknown calls through to Claude Code's auto classifier, count cost as deltas of the SDK's running total, hold routine bubbles so a quiet run posts nothing, set a 15-minute routine floor and a cap of 20 routines per bot, and pair with a one-time code.

## What the SDK probe settled

A probe against the installed SDK (0.3.302) and CLI (2.1.301) answered the questions the designs depended on.

- `PreToolUse` fires under auto mode before any permission step. It fires for built-in tools, for in-process MCP tools and for a subagent's calls. A hook `deny` blocks the call, and the model sees the reason. An `allow` skips the classifier.
- **A hook that throws fails open,** and the tool runs. A hook that times out fails closed. So the gate's body is synchronous and catches everything into an explicit deny.
- **`defer` was rejected.** It holds the exact call across processes, but resuming the session replays the call automatically, and whether the hook sees that replay depends on settings timing. The bridge therefore uses deny-and-regrant. The call is denied with a "held for approval" reason. Allow once installs a 10-minute grant for that exact input, and the model re-issues the call.
- `interrupt()` ends a turn with an `error_during_execution` result about 14 ms later, and the session stays usable. Stop reads that result as stopped, never as a failure.
- `resume` finds a transcript by session id through a symlinked or renamed cwd. That is why migration links `~/.claudiobot` to `~/.claudebot` instead of copying it.
- `claude-haiku-4-5` and `claude-sonnet-4-5` silently run in default mode when auto is asked for. `claude-sonnet-5-5` honors auto, so the e2e script pins it.

## Gaps the synthesis added

None of the candidates covered these, so the synthesis added them.

- Migration reconciles the two homes: link when only the old one exists, move a near-empty new home aside, and refuse to choose when both hold bots.
- The daily cap holds unattended work only. A message you type still runs, with a note that the cap is reached.
- Stop drops queued unattended work and records each dropped routine fire as a skipped run.
- Cloud agents are neither gated nor metered, and the README says so.
