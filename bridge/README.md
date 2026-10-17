# claudiobot bridge

A small daemon for your Mac. It runs your bots. A bot is a persistent assistant with one long conversation, its own home folder, routines and agents. The ClaudioBot iOS app is a view onto the bridge over one WebSocket. Bots keep working, and routines keep firing, while the phone is closed. Every bot runs on your own Claude Code login. The wire format is in `src/protocol.ts`, and `docs/design.md` at the repo root explains the design.

## Run it

```sh
bun install
bun run start
```

On startup the bridge prints its LAN WebSocket URL, its token, a `claudiobot://pair?...` link and a QR code of that link. To pair, scan the QR code from the iOS app. The token is created on the first run and kept in `~/.claudiobot/token`. To revoke every paired phone, delete that file.

`claude` must be on `PATH` and logged in. To check, run `claude -p hi`.

The first run creates **Claudio Bot**, a general assistant, and it greets you.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDIOBOT_PORT` | `7878` | Port to listen on, on all interfaces. |
| `CLAUDIOBOT_ROOTS` | `~/Dev/projects:~/code:~/Developer:~/Projects` | Colon-separated folders. Each git repo directly inside one is a project that agents can work in. |
| `CLAUDIOBOT_HOME` | `~/.claudiobot` | Holds the token, `state.json`, `USER.md`, the bot homes and the trash. |
| `CLAUDIOBOT_CLAUDE` | `claude` on `PATH` | Path to the Claude Code executable. Useful when the bridge runs under launchd. |
| `CLAUDIOBOT_MODEL` | your Claude Code default | Pins the model for bots and agents. The e2e script sets `haiku`. |
| `CLAUDIOBOT_USER_NAME` | first word of `id -F`, else `$USER` | Your first name, as bots use it. |

## What is on disk

```
~/.claudiobot/
  token
  state.json          bots, conversations, routines and agents
  USER.md             facts about you that every bot may read and add to
  bots/<botId>/       a bot's home and the working folder of its session
    CLAUDE.md         the bot's job and its own notes
    library/          files the bot makes, listed in the app's Library
    inbox/            files you send from the phone
  trash/<botId>-<ms>/ the home of a deleted bot
```

Deleting a bot moves its home to `trash/`. Nothing is deleted.

## How a bot runs

Each bot has one Claude Code session through the Agent SDK. It starts the first time something reaches the bot, and after a restart it resumes from the stored session id, so the bot remembers the conversation. The session uses the `claude_code` system prompt with the bot's persona appended, loads your user settings and the bot's `CLAUDE.md`, and runs with `permissionMode: "auto"`.

Everything that reaches a bot is one message whose first line says where it came from, such as `[Bruno]`, `[Routine digest fired]` or `[Agent "Fix login" (a_...) reports]`. Messages queue, and the bot takes them one turn at a time. While a turn runs, the bot's status is `working`. Each text block the bot writes becomes one chat bubble. Tool calls do not show.

A bot acts through the `claudio` MCP tools: `ask` posts a question card, `start_agent` and `message_agent` run coding agents, `list_projects` lists the repos, `message_bot` and `create_bot` reach other bots, `update_self` renames the bot, and `set_routine` and `delete_routine` manage its schedule.

## Agents

A bot starts an agent for coding work in a project.

- A **mac** agent is a Claude Code session in the project folder. When its turn ends, its final message goes back to the bot, which decides what to tell you.
- A **cloud** agent runs `claude --cloud` in the project folder, so the project needs a GitHub remote. It does not report back. The bot gives you the claude.ai link instead. Follow-ups go through `claude -p ... --cloud <session>`.

If the bridge restarts while a mac agent is working, the agent is marked failed and its bot is told. A message to the agent resumes it.

## Routines

A routine is a prompt a bot receives on a schedule, written as five-field cron in the Mac's local time. The bridge checks at the start of each minute and fires a routine at most once per minute. Runs missed while the Mac slept are skipped.

## Tests

```sh
bun test         # unit tests, no network
bunx tsc --noEmit
bun run e2e      # real Claude Code with haiku in a temp home; costs about 3 cents
```

The e2e script never starts a cloud agent, because that creates a real session in your account. It prints the cost of each session it ran.
