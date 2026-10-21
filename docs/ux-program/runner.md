# Scenario runner

The UX audit runs scenarios: a situation set up on a throwaway bridge, recorded as the phone sees it, and judged against a rubric of what the user must be able to tell. The runner is `.claude/skills/verify-claudio-bot/bin/scenario.ts`. It launches and cleans up its bridge through `control-claudio.ts` and imports that helper's socket code, so every rule of the `verify-claudio-bot` skill holds: the user's bridge on port 7878 and `~/.claudiobot` are never touched.

Run everything from the repo root with the budget guard lifted for the program:

```bash
export CLAUDIOBOT_VERIFY_BUDGET_USD=100000
R=.claude/skills/verify-claudio-bot/bin/scenario.ts
(cd bridge && bun install)   # once per checkout
```

## Running a scenario

```bash
$R list                       # the registry: id, area, lane, title, rubric size
$R run S2                     # protocol lane: bridge + socket only
$R run S1,S4,S5               # several, one after another
$R run S3 --sim               # simulator lane: also leases a device, installs the app, takes screenshots
$R run S3 --sim --pair-wait 180
$R doc sessions > docs/ux-program/scenarios/sessions.md   # regenerate the rubric doc
```

Scenarios live in `bin/scenarios.ts` as data: setup actions, preconditions and rubric items, each item with its lane and, for protocol items, a mechanical check. `docs/ux-program/scenarios/sessions.md` is generated from it, so edit the registry, never the doc.

Exit code 0 means the scenario was judged (rubric failures are findings, not runner failures). 2 means a precondition failed: the scenario could not produce its situation, and its rubric is reported not judged. 1 means the runner itself failed. Every session turn runs on haiku. Each permission card a scenario raises is answered Allow once, and the timeline records the tap.

## Evidence layout

Each run writes to `$CLAUDIOBOT_VERIFY_DIR/scenarios/<id>/<stamp>[-sim]/` (default `$(realpath $TMPDIR)/claudiobot-verify`), or `--out <dir>`:

| file | what |
| --- | --- |
| `report.md`, `report.json` | outcome, preconditions, each rubric verdict with its reason, marks (seconds since start), spend |
| `timeline.jsonl` | every frame about the scenario's own sessions, both directions, with `at` in ms; list frames are cut to the run's seed projects |
| `threads.txt` | the same, one readable line per frame |
| `transcripts/` | Claude Code's transcripts of the scenario's sessions, subagents included, copied before cleanup removes them |
| `screenshots/` | simulator lane only: `pair-confirm.png`, `after-pairing.png` and each scenario shot |
| `launch.log`, `cleanup.log` | control-claudio's output; cleanup also keeps the bridge's own snapshot under `evidence/<run>/final/` |

Verdicts: `pass`, `fail`, `review` (a simulator item with screenshots for a person or agent to judge), `not-judged` (a mark it needs was never reached, or the precondition failed) and `skipped` (a simulator item on the protocol lane).

## The simulator pool and leases

Three simulators, `ClaudioBot-UX-1` to `-3`, cloned from a shut-down iPhone 17 Pro on the newest iOS runtime. No other device is ever cloned, booted or shut down.

```bash
$R pool ensure                # clones the missing ones; idempotent
$R pool status
$R lease status               # holder, label, heartbeat age per device
$R lease acquire --label "auditor chat" [--boot] [--wait 3600]
#   LEASED device=ClaudioBot-UX-2 udid=… token=…
$R lease heartbeat ClaudioBot-UX-2 --token <token>   # at least every 10 minutes
$R lease boot ClaudioBot-UX-2 --token <token>
$R lease release ClaudioBot-UX-2 --token <token>     # shuts the device down, frees it
```

A lease is the directory `$CLAUDIOBOT_VERIFY_DIR/leases/<device>/`, made with `mkdir` (atomic), holding `owner.json` (pid, label, token, time) and a `heartbeat` file the holder touches. Every agent must use the same `CLAUDIOBOT_VERIFY_DIR` (the default is shared by all worktrees) or it will not see the others' leases. `acquire` takes the first free device and polls every 5 s while all three are held. A lease whose heartbeat is older than 10 minutes is reclaimed under a short global mutex (`leases/.reclaim`), and its device is shut down. The runner boots only a device it holds, and releases it (shutting it down) at the end, on SIGINT, SIGTERM and on an uncaught error; within a run it heartbeats every minute. `lease acquire` from the command line does not hold the lease for its own process, so another agent keeps it alive with `lease heartbeat` and frees it with `lease release`.

`bin/lease-proof.sh [log]` starts five lease-holding jobs (`$R sim-job --label jobN --hold 60`: lease, boot, screenshot, hold, release) against the three devices, samples the booted devices every 10 s, then fakes a lease with an 11-minute-old heartbeat and shows it reclaimed while a fresh one is left alone. The last proof is `docs/ux-program/evidence/step0-lease-proof.txt`.

## The app on a leased device, and pairing

`$R sim-build` (and `run --sim`) builds the Debug app once per `ios/` tree into `$CLAUDIOBOT_VERIFY_DIR/ios-build/` with `xcodebuild … -destination 'generic/platform=iOS Simulator'`, so the build touches no device; a lock keeps concurrent runs from building twice. The runner installs it and launches it with `-pairingVault claudiobot-ux-<device>`, a Debug launch argument that keeps the pairing in a throwaway Keychain item.

What is automated:

1. The runner asks its bridge for a one-time code over the socket (`pair_code`).
2. It opens `claudiobot://pair?url=ws%3A%2F%2F127.0.0.1%3A<port>%2Fws&code=<code>` with `xcrun simctl openurl`. The app shows its confirmation ("Nothing reaches the bridge before you tap Pair"), captured as `screenshots/pair-confirm.png`.
3. It polls the bridge's `devices` list for up to `--pair-wait` seconds (default 120). A new device means the app paired, and `paired` is true in the report.
4. `open-thread` uses `claudiobot://session/<id>`, and `app background|foreground` launches Settings over the app, then the app again.

What is not: the tap on **Pair**. `simctl` has no input command, no `idb` or similar is installed, and the app has no launch argument that confirms a pairing link on its own (`-demo`, `-demoScreen` and `-pairingVault` are the only Debug hooks; demo mode runs no bridge). An agent with the iOS Simulator tool taps Pair on the leased device while the runner prints `PAIR: tap "Pair" … within Ns`. Unpaired, every screenshot is still taken and the simulator items show the unpaired app, and a scenario that needs a paired app (S3) reports its precondition failed. Reaching the Sessions sidebar (S7.5) needs a tap too; threads open by deep link.
