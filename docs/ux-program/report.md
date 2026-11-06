# UX program closing report

The UX program for the ClaudioBot iPhone app ran from 2026-10-21 to 2026-11-02. It audited and fixed all five areas: Sessions, Chat with bots, Home and navigation, Pairing and first run, and Settings and account. It ended under the exit rule the user chose on 2026-11-02. After the final fix wave there was a targeted re-check and then a stop, with no further open-ended audit.

## Result

| Severity | Total | Status |
| --- | --- | --- |
| P0 | 2 | Fixed (Sessions run 1, groups G0–G18) |
| P1 | 172 | 95 fixed by the run 1 and run 2 groups, 77 fixed and re-checked on merged main |
| P2 | 272 | Open, in `backlog.md` |
| Refuted | 24 | Closed |

Main ends at `cf6bc53`. Program PRs #3 to #50 are merged. That covers 41 fix groups plus the runner, docs and bookkeeping PRs.

Three P1s were not seen again in the final re-check:

- **F-FN-004.** The verifier for PR #50 confirmed it live.
- **F-FN-010.** The verifier for PR #48 confirmed it live.
- **F-FN-006.** Only a unit test confirms it. The simulator pool has no phone with an old shared token.

## What changed for users

- **Sessions.** A session tells you what is running, how many things, for how long, whether each is done, failed or stuck, and how to stop it. This holds across subagents, background commands, crashes, bridge restarts, dropped connections and push notifications. When the app cannot know something, it says "may still run" or "can't tell" and does not guess.
- **Chat with bots.** When the Mac is unreachable, the chat says so: "Working when last updated", plus "Not sent" with Retry and Discard. Question and approval cards settle honestly. Typing the exact option answers a card, and a new message cancels a stale approval. VoiceOver names who spoke and reads replies, cards and stop notes. Tables, quotes, rules and nested lists render.
- **Home.** Bot rows show failed, stopped and background work, and failures mark the chat unread. Create bot shows that it is in progress and gives up after a minute offline. Text on bot colours meets 4.5:1 contrast. Rows follow the text size.
- **Pairing and Settings.** The pairing sheet shows progress, times out with a cause and a Try again button, and confirms "Paired &lt;name&gt;". A phone still on the old shared token gets a disabled row that explains why. A slow usage read no longer blocks other requests. The Memory Confirm button is readable in dark mode.

## Top open items

1. **Slow reconnect after a long outage.** This is a P1 candidate.
   - After an 80 s outage, Settings still reads Reconnecting 10–15 s after the Mac is back (T3.3 fails).
   - The T1 simulator run loses its connection about 9 s after Settings opens.
   - The cause is not triaged. It could be the app's reconnect backoff, the runner relay, or the probe sending the app to the background.
2. **Settings after 60 s offline.** It says "Reconnecting" for good instead of saying the Mac is not answering (T3.2).
3. **Phones on the old shared token never upgrade by themselves.** The upgrade asks for a code over the same socket, and the bridge refuses.
4. **The "Creating the new chat…" notice can stick.** If the created reply is lost to a dropped connection, the notice stays until the user taps it.
5. **The remaining P2s,** listed in `backlog.md`.

## How it ran, and what it cost

- **Process.** Every fix group had its own owner agent in its own worktree off main. An independent agent verified each PR live before it merged. Product calls are in `decisions.tsv`, and agent rounds and incidents are in `agents.tsv`.
- **Lean mode from 2026-11-01.** The Sessions audit reruns kept finding new edge cases, and three full audits never converged. The program then switched to these rules:
  - audits of at most 2 rounds;
  - one skeptic per finding;
  - a P1 means something a typical user hits in a normal flow;
  - targeted re-checks instead of fresh hunts;
  - one medium-effort verifier per PR;
  - the four remaining areas audited and fixed in parallel on 6 simulators.

  One Sessions audit had used 65.5M subagent tokens. In lean mode the four-area audit used 19.4M, the final audit 22.5M, and each re-check about 0.5–1.7M.
- **Scope cut on 2026-11-02.** The user dropped accessibility text sizes from audits and verification.
- **Hardest group.** G27, which covers commands the bridge cannot confirm after a restart, needed 8 rounds. Inferring command state from the command text failed four times. The fix that held tracks each command step's own process groups.

## Harness notes for the next run

- **Pass `--run <id>` to every `control-claudio` command.** One cleanup without it followed the shared `current` pointer and shut down another agent's bridge.
- **Plan-mode sessions can write outside the run.** One wrote into the real `~/.claude/plans`. The runner should point Claude Code's home at the run's home.
- **Keep scratchpad evidence small.** macOS purged `/private/tmp` once when the disk filled. Keep evidence somewhere durable.
- **Never treat an empty audit plan as a clean result.** `ux-audit.js` now refuses one.
