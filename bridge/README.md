# claudebot bridge

A small daemon for your Mac. The ClaudeBot iOS app connects to it over one WebSocket and uses it to run coding tasks with Claude Code. A task runs either on the Mac itself or as a Claude Code cloud session. Every task runs on your own Claude Code login. The wire format is defined in `src/protocol.ts`.

## Run it

```sh
bun install
bun run start
```

On startup the bridge prints its LAN WebSocket URL, its token, a `claudebot://pair?...` link, and a QR code of that link. To pair, scan the QR code from the iOS app. The token is created on the first run and kept in `~/.claudebot/token`. Delete that file to revoke every paired phone.

`claude` must be on `PATH` and logged in. You can check with `claude -p hi`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDEBOT_PORT` | `7878` | Port to listen on, on all interfaces. |
| `CLAUDEBOT_ROOTS` | `~/Dev/projects:~/code:~/Developer:~/Projects` | Colon-separated folders. Each git repo directly inside one is offered as a project. |
| `CLAUDEBOT_HOME` | `~/.claudebot` | Holds `token` and `state.json`, which stores tasks and transcripts. |
| `CLAUDEBOT_CLAUDE` | `claude` on `PATH` | Path to the Claude Code executable. Useful when the bridge runs under launchd. |

## How tasks run

A local task runs through the Claude Agent SDK in the project folder. Each tool permission prompt and each `AskUserQuestion` call is shown on the phone, and the task waits for your answer. A follow-up goes into the same live conversation. If the bridge restarts, a task that was running or waiting comes back as stopped. A task that had finished its turn (idle) still takes follow-ups, and the bridge resumes its session.

A cloud task runs `claude --cloud` in the project folder, so the project needs a GitHub remote.

## Cloud limitations

- The phone gets no live stream from a cloud session. It sees "Cloud session created" with a claude.ai link, and "Follow-up sent" for each follow-up. To watch the work, open the link.
- Approvals and questions in a cloud session are answered on claude.ai, not through the bridge.
- The model and permission mode chosen on the phone are recorded but not passed to `claude --cloud`.

## Tests

```sh
bun test       # unit tests, no network
bun run e2e    # real Claude Code with haiku, in a throwaway repo; costs a few cents
```

`scripts/record.ts` re-records the SDK event streams in `test/recordings/` that the reducer tests replay.
