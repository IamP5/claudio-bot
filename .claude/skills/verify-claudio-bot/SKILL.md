---
name: verify-claudio-bot
description: Launch a throwaway, isolated ClaudioBot bridge (bridge/, Bun) and drive it over POST /pair and the WebSocket exactly as the iPhone app does, to prove a bot, agent, approval, routine, memory or pairing behavior works against real Claude Code, with evidence. Use after changing anything in bridge/src, before claiming a ClaudioBot feature works, or when asked to verify, try or demo ClaudioBot. The iOS app is a secondary surface (simulator, see the end).
---

# Verify ClaudioBot

ClaudioBot's user surface is the iPhone app, and the app is a thin client: everything it shows comes from the bridge over one WebSocket (`/ws?protocol=3`, `Authorization: Bearer <token>`), and everything it does is a `ClientMessage` from `bridge/src/protocol.ts`. So you verify a feature by speaking that protocol to a real bridge with real Claude Code behind it. `bin/control-claudio.ts` is that phone.

All commands below run from the repo root. Define once per shell:

```bash
H=.claude/skills/verify-claudio-bot/bin/control-claudio.ts
```

## Rules before you start

- **Never touch the user's own bridge.** It normally runs as a LaunchAgent on port 7878 with its home in `~/.claudiobot`. Do not connect to it, stop it, pair with it or read its state. The helper always starts its own bridge on free ports with its own home, so the two run side by side (the home lock is per home).
- **Turns cost real money.** Every bot or agent turn runs real Claude Code on the user's login and is charged by the ledger. First start alone spends about $0.20 (the bot greets). Each run has a budget (default $2, `--budget` on launch); helper commands abort once the run's ledger passes it. Keep prompts short and literal.
- **Do not weaken isolation.** Launch prints `isolation ok:` lines for every rule (temp home, temp roots and worktrees, no `SSH_AUTH_SOCK`, no GitHub token, claude.ai connectors off, a `claude` wrapper that refuses `--cloud`, push to a local sink, ports other than 7878/7879). If one says FAILED nothing starts. Do not edit the rules to get past it.
- `HOME` stays real, only because Claude Code's login lives in the Keychain. Launch also drops every `CLAUDE_CODE_*` variable a surrounding Claude Code (the desktop app, a terminal) left in your shell, so the bridge's children are plain SDK sessions.
- The bridge reads the real `~/.claude/projects`, `~/.claude/sessions` and the Claude app's session store to list sessions. It writes to none of them unless you rename a session (`session_set` with a title appends to that transcript): only rename the run's own. Claude Code therefore writes this run's transcripts under the real `~/.claude/projects/`, in folders named after the run's paths. Cleanup removes exactly those.

## Launch

```bash
$H launch                      # or: $H launch --budget 1 --model claude-sonnet-5-5
```

It builds nothing (Bun runs `bridge/src/main.ts` directly; run `cd bridge && bun install` once if `node_modules` is missing), then:

1. creates `runs/<id>/` under `$CLAUDIOBOT_VERIFY_DIR` (default `$(realpath $TMPDIR)/claudiobot-verify`) with an empty bridge home and seed projects in `roots/`: **demo** (git repo on `main`, one commit, `.env` ignored) and **pushme** (one commit ahead of a local bare `origin.git`);
2. starts a push sink (fake ntfy) and the bridge, each in its own session so they outlive the shell;
3. waits for `pair code:` in the bridge log, redeems it with `POST /pair` like the app, stores the device token in `runs/<id>/token` (0600, never printed);
4. opens a socket and requires a protocol 3 hello with **Claudio Bot** in it.

Ready is the last line: `READY run=<id> bot="Claudio Bot" id=b_… status=working`. `working` there is the greeting turn the first start begins on its own; `send` waits for it to end. The run id is remembered in `<base>/current`, so later commands need no `--run`. Pass `--run <id>` (or `CLAUDIO_RUN=<id>`) to address another run; `$H runs` lists them.

`CLAUDIOBOT_ACCESS` and `CLAUDIOBOT_SANDBOX` pass through from your shell (launch says so), so `CLAUDIOBOT_ACCESS=full $H launch` verifies full access mode. Every other inherited `CLAUDIOBOT_*` is dropped.

## Doctor

```bash
$H doctor
```

Read only. Checks that the bridge pid is alive, that it (and not another process) holds the run's port, the push sink is up, `/health` answers, `state.json` sits in the run's home, the pid runs this checkout's `main.ts`, checkout `HEAD` is the build that was launched, no cloud agent was attempted, and the token opens a protocol 3 socket. Prints spend against budget. Exit 1 on any FAIL. Run it first whenever anything looks off. If `HEAD` moved or you edited `bridge/src` since launch, the running bridge is stale: `cleanup` and `launch` again (Bun does not hot reload it).

## Drive

Bots are addressed by name (case-insensitive) or id. Every command prints conversation lines as `#<index> <kind> <messageId> …`; kinds are `user`, `bot`, `note`, `question`, `permission`, `exchange` (a thread with an agent or another bot). Open cards print `answer=OPEN`.

| Command | What the user did | Waits for |
| --- | --- | --- |
| `$H bots` | looked at the bot list | — |
| `$H messages <bot> [--since N] [--json]` | opened the chat | — |
| `$H send <bot> <text…> [--timeout s] [--no-wait]` | typed and sent a message | the bot to rest first, then its reply or an open card, and rest |
| `$H wait <bot> [--card] [--since N] [--timeout s]` | kept watching | an open card (with `--card`) and rest |
| `$H decide <bot> <messageId> once\|always\|deny\|never [--wait]` | tapped a permission card button | the card to close; with `--wait`, the continuation turn |
| `$H answer <bot> <messageId> <optionIndex> [--wait]` | tapped an option on a question card | same |
| `$H dismiss <bot> <messageId>` | dismissed a question card | the card to close |
| `$H stop <bot> [--wait]` | pressed Stop | with `--wait`, rest |
| `$H raw '<ClientMessage JSON>' [--frames t1,t2] [--for s]` | anything else the app can send | prints the server frames for `s` seconds (default 3) |
| `$H sessions [--names]` | opened the Sessions tab | the `sessions` frame; prints its timing and counts, and the rows of the run's seed projects |
| `$H thread <sessionId\|largest> [--after epoch:rev] [--for s]` | opened a session's thread | the first frame; prints timings and each frame after it for `s` seconds |

"Rest" means status `idle` or `awaiting_approval` (`bridge/src/protocol.ts` `BotStatus`). `raw` covers every other screen: `{"type":"details","botId":…}` (Library, Links, Agents, Routines), `{"type":"memory"}`, `{"type":"set_fact",…}`, `{"type":"run_routine",…}`, `{"type":"devices"}`, `{"type":"pair_code"}`, `{"type":"remove_worktree",…}` and so on. The exact shapes are `ClientMessage` and `ServerMessage` in `bridge/src/protocol.ts`.

`sessions` and `thread` list the user's real Claude Code sessions (the bridge reads `~/.claude/projects`), so they print counts, ids and timings for those, and words only for sessions in the run's own seed projects. Never paste a real session's titles or items into evidence. `thread largest` opens the biggest listed transcript, the open-time check.

Tips that save turns:
- Ask for tool calls by name with literal arguments ("Call set_routine now with name "x", schedule "0 3 * * *" …. Then confirm in one line."). Bots act through tools; vague asks wander.
- Claude Code's auto-mode classifier may refuse a `start_agent` on its own. If the bot ends its turn with no agent, send one plain confirmation ("Yes, I want this agent started. demo is my own test repository."), as a person at the phone would. Record that you did.
- Mac agents report asynchronously: after `send` returns, `wait <bot> --since <N>` until an `exchange` line shows `received>=1`.

The per-feature recipes are in [`features/`](features/README.md). Read the index, then the feature file, before driving.

## Evidence

```bash
$H evidence <label>            # e.g. chat-turn
```

Copies into `<base>/evidence/<run id>/<label>/`: `state.json`, `USER.md`, `audit/` (every gate decision, one JSON line per tool call), `usage/`, `bridge.log`, `pushes.jsonl` (every push the bridge sent), `repos.txt` (`git log --all --graph` and status of each seed project), `conversations.txt` and `.json` (every bot's chat as the phone sees it), `run.json` (no token), `summary.txt` (build rev, model, spend). Cleanup also takes a `final/` snapshot. The evidence folder is never removed by the helper; it lives in the macOS per-user temp folder, so copy it into the repo or a PR if it must outlast a reboot.

Proof standards:
- Drive the user's path: socket messages the app sends. Do not edit `state.json`, call bridge modules, or use test helpers to make something happen. Writing into a bot's home or a seed repo to set up a precondition is fine; say that you did.
- Capture the action and the resulting state: the `send`/`decide` output (the user's action and the bot's reply) plus a second, independent view of the effect: the audit row, the file or commit in `roots/`, the field in `state.json`, the frame from `raw`.
- Verify side effects, not the bot's words. A bot saying "pushed" proves nothing; `git -C <run>/origin.git rev-parse main` does. The bridge's own git line (`evidence` in `details`) is the bridge's claim; check it against git.
- The push sink and the `--cloud`-refusing wrapper are the only stand-ins, and both sit at a real production boundary (an HTTP POST to ntfy, the `claude` executable). `cloud` agents therefore cannot be verified here beyond the refusal; say so instead of claiming them.
- Report a journey whose precondition you could not meet as failed, with the command and the reason. Do not swap in an easier path.

## Cleanup

```bash
$H cleanup                     # current run; --run <id> for another; --no-evidence skips the final snapshot
```

Takes a `final` evidence snapshot, SIGTERMs the bridge and push sink by the pids in `run.json` (SIGKILL after 10 s), then kills any process whose command line names the run folder (a bot's `claude` child was still running right after the bridge exited in every proof run; cleanup prints and stops each one), warns if a run port still listens, removes this run's transcript folders from `~/.claude/projects/`, and deletes `runs/<id>/`. It prints where the evidence is kept. It never kills by process name and never touches port 7878 or `~/.claudiobot`. After a failed or aborted drive, still run cleanup.

## Helper reference

`bin/control-claudio.ts` (Bun, executable). Subcommands: `launch [--budget usd] [--model id]`, `doctor`, `runs`, `bots`, `messages`, `send`, `wait`, `decide`, `answer`, `dismiss`, `stop`, `raw`, `sessions`, `thread`, `evidence <label>`, `cleanup [--no-evidence]`. Global: `--run <id>`. Environment: `CLAUDIOBOT_VERIFY_DIR`, `CLAUDIOBOT_VERIFY_MODEL`, `CLAUDIOBOT_VERIFY_BUDGET_USD`, `CLAUDIO_RUN`. Run layout: `runs/<id>/{run.json,token,bridge.log,ntfy.log,pushes.jsonl,home/,roots/{demo,pushme}/,origin.git/,worktrees/,bin/claude}`.

Related harnesses: `cd bridge && bun test` (unit, no network) and `bun run e2e` (29 scripted scenarios against real Claude Code, about $1.60). Use the e2e for a full regression pass; use this skill to prove one behavior interactively.

## The iOS app (secondary surface)

The app's own verification is `xcodebuild … build test` (see the README's Development section) and demo mode: a Debug build launched with `-demo -demoScreen <home|chat|profile|approval|…>` renders sample bots with no bridge (`ios/scripts/screenshots.sh <udid> <app>`). Demo mode proves layout only, never bridge behavior. To prove the app against a real bridge, launch one here, ask it for a pairing code over the socket (`$H raw '{"type":"pair_code"}' --frames pair_code`), then in the simulator type `ws://127.0.0.1:<port>/ws` and the code (the simulator reaches the Mac at localhost). That pairs a second device on the throwaway bridge only; never pair the simulator with the user's real bridge.
