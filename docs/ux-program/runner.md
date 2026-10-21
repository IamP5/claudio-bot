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
$R run S1 --sim --content-size accessibility-extra-extra-extra-large --appearance dark   # simctl ui for the run, reset after
$R doc sessions > docs/ux-program/scenarios/sessions.md   # regenerate the rubric doc
```

Scenarios live in `bin/scenarios.ts` as data: setup actions, preconditions and rubric items, each item with its lane and, for protocol items, a mechanical check. `docs/ux-program/scenarios/sessions.md` is generated from it, so edit the registry, never the doc. Every scenario runs on the protocol lane; S3 judges its push and unread items there through the run's push sink (`pushes.jsonl`), and its screenshots need `--sim`.

Exit code 0 means the scenario was judged (rubric failures are findings, not runner failures). 2 means a precondition failed: the scenario could not produce its situation, and its rubric is reported not judged. 1 means the runner itself failed. Every session turn runs on haiku. Each permission card a scenario raises is answered Allow once, and the timeline records the tap. A scenario with `holdCardsS` (S5) taps it that many seconds after the card appears, so the waiting state is on the wire.

## What the runner does for the user

The phone, and with `--sim` the app, reach the bridge through a TCP relay the runner owns. The relay is how the network fails: `reconnect` with `how: "close"` ends the sockets and refuses new ones for the window; `how: "half-open"` passes nothing either way and closes nothing, as when a phone loses signal or iOS suspends the app. Reconnects send `?epoch&after` with the stream position the phone holds, as the app's `StreamCursor` does, and the report says whether the hello resumed and how many frames were replayed. A message sent while the socket is closed waits in an outbox and goes after the next hello and the thread watches, as in the app; one sent into a half-open socket is lost.

| action | what it does |
| --- | --- |
| `create`, `send` | a new session, or a message in one (`interrupt: true` is "Stop and send") |
| `until`, `sleep`, `mark` | wait for a condition on the evidence, wait, or mark the time |
| `leave`, `return` | the phone unwatches a thread, or watches it again from its position |
| `open-thread`, `show-list` | with `--sim`, the app opens the thread by its link (then 3 s to draw) or is relaunched on the Sessions list; on the protocol lane `open-thread` watches the thread again if the phone had left it |
| `app background`, `app foreground` | with `--sim`, Settings over the app and back; on the protocol lane the phone's socket goes half-open, then the phone reconnects (mark `<mark>-list` when the list arrives, before any thread is watched) |
| `reconnect` | drop (`close` or `half-open`), optional `send` while down, reconnect with resume, compare each thread with a fresh open as JSON in order (unless `compare: false`) |
| `ps` | sample the Mac's processes matching a pattern whose working directory is the seed project; the report lists every sample |
| `kill-claude` | SIGKILL the Claude Code process whose command line names the session |
| `restart-bridge` | `control-claudio restart`: the bridge stops and starts on the same port, home and roots; the phone reconnects |
| `screenshot` | simulator lane only |

Simulator shots of a thread come after `open-thread`, so `running.png`, `done.png`, `background-running.png` and the rest show the thread their rubric item names. S2 and S8 relaunch the app on the list (`show-list`) after the mid-background shot, so the app is not watching the thread while the list's unread mark is judged.

## Evidence layout

Each run writes to `$CLAUDIOBOT_VERIFY_DIR/scenarios/<id>/<stamp>[-sim]/` (default `$(realpath $TMPDIR)/claudiobot-verify`), or `--out <dir>`:

| file | what |
| --- | --- |
| `report.md`, `report.json` | outcome, preconditions, each rubric verdict with its reason, marks (seconds since start), process samples, spend; with `--sim`, `app.stamp` (the `ios/` tree the installed app was built from) and `app.bundle` (the digest of the bundle on the device) |
| `timeline.jsonl` | every frame about the scenario's own sessions, both directions, with `at` in ms; list frames are cut to the run's seed projects |
| `threads.txt` | the same, one readable line per frame |
| `transcripts/` | Claude Code's transcripts of the scenario's sessions, subagents included, copied before cleanup removes them |
| `screenshots/` | simulator lane only: `pair-confirm.png`, `after-pairing.png` and each scenario shot |
| `launch.log`, `restart.log`, `cleanup.log` | control-claudio's output; cleanup also keeps the bridge's own snapshot under `evidence/<run>/final/`. Cleanup runs on every way out (the end of the run, SIGINT, SIGTERM, a crash), so an interrupted run leaves no bridge behind. It covers a launch that fails or is interrupted once launch has printed `STARTED run=<id>` |

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

`$R sim-build` (and `run --sim`) builds the Debug app once per `ios/` tree with `xcodebuild … -destination 'generic/platform=iOS Simulator'`, so the build touches no device. The stamp is the tree's hash, plus a hash of the content of any uncommitted change under `ios/` (the diff against HEAD and every untracked file), so two trees with different edits to one file never share a stamp. Each stamp builds into its own folder, `$CLAUDIOBOT_VERIFY_DIR/ios-build/<stamp>/`, and writes `stamp` there last. Worktrees that run at once never share a build, so a run that waits for a lease still installs its own tree's app however many other trees build meanwhile. A lock per stamp (`ios-build/<stamp>.lock`) keeps concurrent runs of one tree from building twice. The three most recently used builds are kept (each is about 400 MB). A build in progress is never pruned, and neither is one a live run uses: each run leaves its pid in `ios-build/<stamp>.users/` from the build until it exits, and markers of dead pids are ignored. Before it installs, the runner checks that the folder's `stamp` is its own. After, it compares a digest of every file in the bundle on the device with the build's, and the run fails if either differs. The runner launches the app with three Debug launch arguments:

- `-pairingVault claudiobot-ux-<device>` keeps the pairing in a throwaway Keychain item.
- `-pairingAutoConfirm YES` confirms a pairing link as soon as the confirmation would show, since `simctl` cannot tap Pair. It is compiled out of Release.
- `-sidebarMode sessions` opens on the Sessions list. It sets the sidebar choice the app already keeps in UserDefaults, through the launch-argument domain, so it needs no app code.

The pairing:

1. The runner asks its bridge for a one-time code over the socket (`pair_code`).
2. It opens `claudiobot://pair?url=ws%3A%2F%2F127.0.0.1%3A<relay port>%2Fws&code=<code>` with `xcrun simctl openurl`, and the app confirms it on its own. `screenshots/pair-link.png` is the app 3 s later.
3. It polls the bridge's `devices` list for up to `--pair-wait` seconds (default 120). A new device means the app paired, and `paired` is true in the report.
4. `open-thread` uses `claudiobot://session/<id>`, and `app background|foreground` launches Settings over the app, then the app again.

A paired app lists every project on the Mac the bridge runs on, not only the run's seed project. A screenshot of the Sessions list (`pair-link`, `after-pairing`, S7's `mixed`) can show real session titles, so judge it in place and never copy it into the repo.

## The swipe check

A screenshot cannot show a main thread that never settles. `ios/scripts/swipe-check.sh` swipes each demo thread down once at each Dynamic Type size, through XCUITest, and fails when a swipe takes over 10 s or the app's mean CPU over the next 10 s stays above 50%. XCUITest waits up to 60 s for the app to go idle after a swipe, so a hang reads as a swipe of about a minute; a swipe that settles takes 1 to 4 s, most of it the scroll's deceleration. `MAX_SWIPE_S` and `MAX_CPU` change the limits. It is a zsh script: run it as `ios/scripts/swipe-check.sh`, and started from bash or sh it runs itself again under zsh. Any step that fails (a missing argument, the driver build, the install) ends it with a non-zero status, so only exit 0 is a pass. Run it on a device you hold, with the app `sim-build` made:

```bash
$R lease acquire --label "swipe check" --boot     # LEASED device=… udid=… token=…
ios/scripts/swipe-check.sh <udid> "$CLAUDIOBOT_VERIFY_DIR/ios-build/<stamp>/Build/Products/Debug-iphonesimulator/ClaudioBot.app"
#   ok workrun large swipe=1.2s cpu-after=12% (…)
#   FAIL workrun accessibility-extra-extra-extra-large swipe=60.5s cpu-after=99% (…)
$R lease release <device> --token <token>
```

`SCREENS` and `SIZES` narrow the matrix (default: `workrun thread plan streaming longthread approvals approvalsanswered` at `large`, `accessibility-extra-large` and `accessibility-extra-extra-extra-large`). With `ATTACH=1` it swipes the app once as it runs, at the content size the run set, instead of launching demo screens, so it can swipe a live thread mid-scenario. Start `$R run S1b --sim --content-size accessibility-extra-extra-extra-large`, then run `ATTACH=1 ios/scripts/swipe-check.sh <the run's udid>` when its log prints `mark s1b-started`. The driver builds first, for 10 to 30 s, so the swipe lands while the three subagents run:

```
ok live current swipe=2.7s cpu-after=10% (…)
```
