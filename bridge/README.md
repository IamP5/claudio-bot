# claudiobot bridge

A small daemon for your Mac. It runs your bots. A bot is a persistent assistant with one long conversation, its own home folder, routines and agents. The ClaudioBot iOS app is a view onto the bridge over one WebSocket. Bots keep working, and routines keep firing, while the phone is closed. Every bot runs on your own Claude Code login.

The wire format is in `src/protocol.ts`. `V3-CONTRACT.md` maps each module's interface and the state it writes. `docs/design.md` at the repo root explains the design, and the root README's Safety model says what the bridge enforces and what it does not.

## Run it

```sh
bun install
bun run start
```

On startup the bridge prints its LAN WebSocket URLs, a one-time pairing code (`pair code: 7KQM-X2PD`, valid for 10 minutes and 5 tries), a `claudiobot://pair?url=…&code=…` link and a QR code of that link. Scan the QR code from the iOS app, or type the address and the code. The app posts the code to `POST /pair` and gets a token for that phone alone. The bridge keeps only its sha256 and never prints it. The socket then authenticates with `Authorization: Bearer <token>`.

Once a phone is paired, the bridge prints no code at start. To pair another phone, use Settings, Pair another device on a paired phone, or run `bun run start --pair`. Revoking a phone in Settings closes its socket with code 4001. After 10 failed pairings from one address in 10 minutes, `/pair` answers 429 for that address.

`claude` must be on `PATH` and logged in. To check, run `claude -p hi`. Only one bridge runs per home. A second one exits and names the lock file beside the home (`~/.claudiobot.lock`). If no bridge is running and the lock stays, delete it.

The first run creates **Claudio Bot**, a general assistant, and it greets you.

## Upgrading from claudebot

At its first start the bridge links `~/.claudiobot` to an existing `~/.claudebot`, so every bot keeps its conversation and its Claude Code session. A `~/.claudiobot` that holds only what a first run leaves is moved aside to `~/.claudiobot.pre-migrate-<time>` first. When both homes hold bots, the bridge touches neither, uses `~/.claudiobot`, and prints how to switch. A set `CLAUDIOBOT_HOME` skips the migration. `CLAUDEBOT_HOME` is no longer read, and the bridge warns while it is set.

The bridge upgrades `state.json` from version 2 to 3 and keeps the exact old file as `state.v2.json.bak`. **Do not run an older bridge against the same home afterwards.** It does not know version 3, treats the file as a first run and overwrites it. To go back, stop the new bridge and copy `state.v2.json.bak` over `state.json` first. Anything changed since the upgrade is lost.

The phone paired with the old shared token keeps working for one release as the "legacy" device. Revoking it writes `token.revoked`, and that token is never accepted again. An app build that does not announce `?protocol=3` sees each permission card as a question card with **Allow once** and **Deny**, and its answer decides the card.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDIOBOT_PORT` | `7878` | Port to listen on, on all interfaces. |
| `CLAUDIOBOT_ROOTS` | `~/Dev/projects:~/code:~/Developer:~/Projects` | Colon-separated folders. Each git repo directly inside one is a project that agents can work in. |
| `CLAUDIOBOT_HOME` | `~/.claudiobot` | The bridge home (below). Setting it skips the migration from `~/.claudebot`. |
| `CLAUDEBOT_HOME` | | The old name. Ignored, with a warning. Rename it to `CLAUDIOBOT_HOME`. |
| `CLAUDIOBOT_CLAUDE` | `claude` on `PATH` | Path to the Claude Code executable. Useful when the bridge runs under launchd. |
| `CLAUDIOBOT_MODEL` | your Claude Code default | Pins the model for bots and agents. Bots run in auto permission mode, so pick a model that supports it: `claude-haiku-4-5` and `claude-sonnet-4-5` silently fall back to default mode. |
| `CLAUDIOBOT_USER_NAME` | first word of `id -F`, else `$USER` | Your first name, as bots use it. |
| `CLAUDIOBOT_DAILY_USD` | `10` | Daily spend cap per bot in US dollars, its agents included. The cap set in a bot's profile wins. |
| `CLAUDIOBOT_AGENT_USD` | `5` | Lifetime budget per Mac agent in US dollars. |
| `CLAUDIOBOT_PUSH_URL` | off | An ntfy topic URL. When set, the bridge pushes while no phone is connected. |

## What is on disk

```
~/.claudiobot/          (a link to ~/.claudebot after migration)
  state.json            version 3: bots, conversations, sessions, routines, cards, devices, pushes
  state.v2.json.bak     the v2 file as it was before the upgrade
  token                 the protocol 2 shared token, accepted for one release
  token.revoked         present once the legacy phone was revoked
  USER.md               facts about you that every bot may read and add to
  usage/YYYY-MM.jsonl   one row per turn: cost, delta, who started it (0600)
  audit/YYYY-MM.jsonl   one row per checked tool call, secrets redacted (0600)
  bots/<botId>/         a bot's home and the working folder of its session
    CLAUDE.md           the bot's job and its own notes
    library/            files the bot makes, listed in the app's Library
    inbox/              files you send from the phone
  trash/<botId>-<ms>/   the home of a deleted bot
```

`state.json` is written atomically. If it cannot be read, or holds a version this bridge does not know, the bridge stops with a message and leaves the file alone. Deleting a bot moves its home to `trash/`. Nothing is deleted.

## How a bot runs

Each bot has one Claude Code session through the Agent SDK, resumed from its stored session id after a restart. The session uses the `claude_code` system prompt with the bot's persona appended, loads your user settings and the bot's `CLAUDE.md`, and runs with `permissionMode: "auto"`.

Everything that reaches a bot is one message whose first line says where it came from, such as `[Alex]`, `[Routine digest fired]`, `[Agent "Fix login" (a_...) reports]` or `[Alex allowed once: Bash \`git push origin main\`. Run exactly that call again now.]`. Messages wait in a durable inbox inside `state.json`, saved before Claude sees them, and the bot takes them one turn at a time. Each paragraph the bot writes becomes one chat bubble. Tool calls do not show.

- **Stop** interrupts the turn in flight and drops queued background work, such as routine fires and messages from other bots, leaving the bot one notice that says so. Your own queued messages still run.
- **Retries.** A transient API error before any output retries after 1, 3 and 8 seconds. A turn that already had output is never replayed after a crash, because it may have had effects. The bot is told instead.
- **Limits.** A usage-limit rejection pauses every bot until 30 s after the reset. A model's own weekly limit pauses only the bot that hit it. The bot shows **Parked**.

A bot acts through the `claudio` MCP tools: `ask` posts a question card, `start_agent` and `message_agent` run coding agents, `list_projects` lists the repos, `message_bot` and `create_bot` reach other bots, `update_self` renames the bot (names are 1 to 40 characters), `set_routine` and `delete_routine` manage its schedule, and `routine_no_update` ends a routine run that has nothing to say.

## Approvals

Every tool call of a bot or a Mac agent passes a `PreToolUse` hook. Some calls are always refused, such as anything touching the bridge home outside the bot's own folder, keys, the Keychain, browser data or the Claude login. Risky calls, such as pushing to the default branch, are refused with a "held for approval" reason, and a permission card opens in the bot's chat. **Allow once** lets that exact call run once in the next 10 minutes, and the bot is told to run it again. **Always** and **Never** become standing rules for the bot and its agents. A permission card expires after 2 hours and a question card after 24, each with one reminder at half its life. Three held or refused calls in one turn stop the turn. The root README's Safety model has the full list and the limits.

## Agents

A bot starts an agent for coding work in a project.

- A **mac** agent is a Claude Code session in the project folder, behind the same gate and counted against its bot's daily cap and its own budget. When its turn ends, its final message goes back to the bot, which decides what to tell you.
- A **cloud** agent runs `claude --cloud` in the project folder, so the project needs a GitHub remote. The bridge neither checks its tool calls nor counts its cost. It does not report back. The bot gives you the claude.ai link instead.

If the bridge restarts while a mac agent is working, the agent is marked failed and its bot is told. A message to the agent resumes it.

## Routines

A routine is a prompt a bot receives on a schedule, written as five-field cron in the Mac's local time. A routine may run at most every 15 minutes, and a bot may have at most 20.

The bridge stores each routine's next run time and saves it before it fires, so a crash can lose a fire but never repeat one. Times missed while the Mac slept collapse into one decision. The newest one fires, marked late, if it is within half the routine's period (between 2 minutes and 2 hours). Otherwise one skipped run is recorded. A fire is skipped while the bot is at its daily cap or paused by a limit, or while its previous run is still queued.

A scheduled run's messages wait until the run ends. If the bot called `routine_no_update` and asked nothing, they are dropped and the run is recorded **quiet**. Otherwise they post together, with one push. Messages written before a card the run opens go out first, and a run that asked for approval is never quiet. Run now from the phone always replies, runs even at the daily cap, and never counts toward the 10 failures in a row that turn a routine off. Each routine keeps its newest 20 runs.

## Push

With `CLAUDIOBOT_PUSH_URL` set to an ntfy topic, the bridge posts when no phone is connected and a card opens, a card reminds, or a turn posts its first message. The text is the bot's name and a fixed phrase. No message content leaves the Mac. The click link opens `claudiobot://bot/<id>?message=<id>`. Each push is recorded before it is sent, so a crash never sends one twice. A failed send, an HTTP 429 included, is logged and not retried. Message pushes are limited to one per bot every 10 minutes, with no cap across bots.

## Tests

```sh
bun test         # unit tests, no network, no Claude
bunx tsc --noEmit
bun run e2e      # real Claude Code in a temp home, about $0.40 to $0.70
```

The e2e script starts the bridge with `CLAUDIOBOT_HOME` in a temp folder, so it never touches `~/.claudebot` or `~/.claudiobot`. It pairs over `POST /pair` and drives the bridge through the socket like the app. It covers a user turn, a mac agent's report, Stop on a running command, a held `git push origin main` that must not reach a local bare remote before Allow once (once through `decide`, once through a protocol 2 socket's answer), quiet and non-quiet routine runs after a restart, and session resume. It pins `claude-sonnet-5-5`, because auto mode needs it. `E2E_MODEL` overrides the model, and `E2E_BRIDGE_LOG=<file>` keeps the bridge's log. It never starts a cloud agent, and it prints the total the ledger charged.
