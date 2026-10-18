# Sessions

The Sessions tab lists every Claude Code session on the Mac by project, like the Claude app's sidebar, and opens any of them as a live thread: the transcript's items, text streaming in as it is written, and the cards Claude Code asks the user to answer. The phone can send to a session, approve its calls, answer its questions, approve its plan, change its model or mode, stop it, and start a new one in any project. A bot's agent shows there too, under its repo, with the bot's badge.

## Sub-features

- `sessions-list` `watch_sessions` answers one `sessions` frame: projects, rows, the mirror setting. The user's real sessions list beside the run's seed projects.
- `sessions-agent-row` a mac agent's row lists under its seed project at once, with its title, working then idle and unread, branch `claudio/…`, `worktree: true`, and `mirror: imported` once the Claude app stand-in imported it.
- `sessions-create` `session_create` in a seed project answers `session_created`; the row is `origin: "phone"`.
- `sessions-approve` a Bash call Claude Code asks about shows as a `permission` item; `session_decide` once lets it run.
- `sessions-stream` a turn's text arrives as `session_delta` frames under the id its transcript item gets, then the upsert.
- `sessions-resume` a socket dropped mid-stream and `watch_session` with the last position resumes from the thread's ring (or a snapshot), and the deltas after it apply at their offsets.
- `sessions-stop` `session_stop` mid-turn ends it; the transcript shows the interruption.
- `sessions-open-large` `thread largest` opens the biggest real transcript: the open time is the check.

## How to get to it (user POV)

- Switch the sidebar from Bots to Sessions; tap a project's + for a new session; tap a row to open its thread.
- In a thread: type and send, tap the card buttons, pull up for earlier pages, Stop.

## Driving it with control-claudio

Preconditions:

- A run is READY. The user's own sessions are read, never written: print counts only for them (`sessions`, `thread` do).

- **List.** Run `$H sessions`. It prints the frame's timing and counts and the rows of the seed projects (none yet).
- **Agent row.** Ask Claudio Bot to start a worktree agent on `demo` (see [mac agents](./mac-agents.md)), then run `$H sessions` a few times: the agent's row shows working with holder `claudio`, then idle and unread. Second view: `<run>/desktop-imports.txt` has one `import <id>` line, and `git -C <run>/roots/demo status --porcelain` is empty.
- **The journey.** Run `$H session-flow` (haiku, a few cents). It asserts and prints each step: create in `demo`, the permission item for `date > when.txt`, Allow once, the step ran, the reply streamed under its item id, the row idle, `when.txt` on disk; a follow-up story with the socket dropped after a few deltas and a new socket resuming it (`ring replay` or `snapshot`), every delta after it applied in order, the upsert equal to the live text; a count stopped mid-turn. Any failed step exits 1 with `FAILED:`.
- **Large transcript.** Run `$H thread largest`. `opened in <ms>` is the open time; a second run shows the cached thread.
- **Proof.** Run `$H evidence sessions`. `state.json` holds `sessions[]` with the phone session's `own` drive; the transcripts are in `~/.claude/projects` under the run's paths until cleanup.

## Gotchas

- Never rename or send to one of the user's own sessions from a run: a rename writes into that transcript, and a send runs a turn in it.
- A phone session runs the model the flow passes (`--model haiku`); without one it runs the transcript's last model or Claude Code's default, which costs more.
- The Claude app is a stand-in in every run (`CLAUDIOBOT_DESKTOP_FAKE`): imports are recorded, never performed. The real import (`open -g claude://resume?session=<id>`) is not verifiable here.
- An agent's commit needs unsigned commits in the seed repos; launch turns signing off there.
