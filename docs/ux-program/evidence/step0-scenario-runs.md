# Step 0: scenario runs

Every run below launched its own bridge through `control-claudio`, drove only sessions it created in the run's `demo` seed project (haiku), and was cleaned up (`cleanup.log` in each evidence folder shows the run folder and its transcripts removed). No real session's title or content is recorded here. Full per-scenario reports are in `step0-reports/`; the raw evidence (timeline, threads, transcripts) stayed in `$TMPDIR/claudiobot-verify/scenarios/<id>/<stamp>/`.

Build under test: `e7acec3` (S2 ran on `212ba74`, with the same bridge code). Total spend for the runs listed: about $0.15.

| scenario | lane | outcome | pass | fail | what failed (findings, not runner errors) |
| --- | --- | --- | --- | --- | --- |
| S1 three subagents, session waits | protocol | judged | 5 | 2 | no per-step start time (S1.5); nothing shows what a running subagent does inside (S1.6) |
| S1b three subagents, async (Claude Code's default) | protocol | judged | 1 | 6 | Agent steps read `ok` about 31 to 33 s before their subagents end; row idle for 33 of the 36 s they ran; no Stop offered while they run |
| S2 long background Bash | protocol | judged | 3 | 4 | after the turn ends the list and the thread read idle while the command runs; no Stop; nothing to time it by. Finishing does show (wake-turn reply) and the row turns unread |
| S3 finishes while app backgrounded | simulator | precondition failed | - | - | the app was not paired (no one tapped Pair); every other precondition held, and all screenshots were taken |
| S4 subagent fails, Stop from phone | protocol | judged | 6 | 0 | none: the failed step reads `error` with its cause, Stop leaves the other `denied` with an "Interrupted" notice, and its command did not finish |
| S5 silent two-minute call | protocol | judged | 5 | 1 | no frame for 121 s during the call, so only a client-side clock can tell alive from stuck (S5.4) |
| S6 reconnect mid-run | protocol | judged | 5 | 0 | none: both resumes (ring replay) match a fresh open, running then done |
| S7 twelve sessions | protocol | judged | 3 | 1 | 10 distinct titles for 12 sessions (S7.3; the prompts differ only in a task number) |
| S8 subagent starts background work | protocol | judged | 2 | 4 | same as S2 for work a subagent started: list and thread idle, nothing names it, no Stop |

Behaviors the runs surfaced that shaped the scenarios:

- Claude Code blocks a leading foreground `sleep N` ("Blocked: standalone sleep 30"), so long foreground calls use `perl -e 'sleep N'`.
- The `Agent` tool defaults to async subagents. Unpinned, haiku chose sync in one run and async in another, so S1 and S1b pin `run_in_background` and check it as a precondition.
- In the first S8 run, the subagent's background command never wrote `nested.txt` within 150 s. In the second it finished at 60 s. Whether a subagent's background work survives looks intermittent and is worth an audit round.
- The bridge never marks a watched thread unread, so scenarios leave a thread before judging unread and reopen it to judge the thread.

Simulator lane, S3 on `ClaudioBot-UX-1`: lease, boot, install, launch with `-pairingVault`, the pairing link (`step0-reports/S3-screenshots/pair-confirm.png` shows "Pair with 127.0.0.1:55459?"), the deep link to the thread, Settings over the app and back, and five screenshots, then shutdown and release. The lease proof is `step0-lease-proof.txt`.

## S3 paired unattended (`c11fb96`)

`run S3 --sim` on `ClaudioBot-UX-1` with `-pairingAutoConfirm YES`: the app paired with the run's bridge with no tap, 0.3 s after the runner began polling the devices list. Every precondition held, so S3 was judged for the first time. 115 s, $0.0097. The report is `step0-reports/S3-sim-paired.md`, with `thread-before`, `while-away` and `thread-after` in `step0-reports/S3-sim-paired/`.

| item | verdict | why |
| --- | --- | --- |
| S3.1 push says the work finished | fail | no push after `bg-done` (one push in the run, before it) |
| S3.2 the push opens the session | fail | no push links to the session |
| S3.3 the row turns unread | fail | the row read `unread=false`, status idle |
| S3.4 the thread gains the result on return | pass | a new assistant message after `bg-done` |
| S3.5 before leaving, the thread shows the command running | fail (judged from `thread-before`) | the thread reads "Ran 1 command" and "started" with no running indicator, so it looks finished while the 60 s command runs |
| S3.6 a notification while away | fail (judged from `while-away`) | Settings in front, no banner |
| S3.7 back in the app, the result and no stale indicator | pass (judged from `thread-after`) | the wake-turn reply says the command finished, and nothing reads running |

`pair-link.png` and `after-pairing.png` were not copied here: the app lists every project on the Mac the bridge runs on, so they show real session titles. The same holds for any `--sim` screenshot of the Sessions list, S7's `mixed` included. All three pool devices read Shutdown after the run.
