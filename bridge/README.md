# claudiobot bridge

A small daemon for your Mac. It runs your bots. A bot is a persistent assistant with one long conversation, its own home folder, routines and agents. The ClaudioBot iOS app is a view onto the bridge over one WebSocket. Bots keep working, and routines keep firing, while the phone is closed. Every bot runs on your own Claude Code login.

The wire format is in `src/protocol.ts`. `V3-CONTRACT.md` maps each module's interface and the state it writes. `docs/design.md` at the repo root explains the design, and the root README's Safety model says what the bridge enforces and what it does not.

## Run it

```sh
bun install
bun run start
```

On startup the bridge prints its WebSocket URLs, best first (its Tailscale name from `tailscale status` when the node is online, then `<LocalHostName>.local`, then each LAN IPv4; `src/address.ts`). It finds `tailscale` on `PATH`, in `/opt/homebrew/bin` or `/usr/local/bin`, or in Tailscale.app, and kills `tailscale status` and `scutil` after 2 s so a stuck helper never holds up the start. It also prints a one-time pairing code (`pair code: 7KQM-X2PD`, valid for 10 minutes and 5 tries), a `claudiobot://pair?url=…&url=…&code=…` link with one `url=` per address, and a QR code of that link. Scan the QR code from the iOS app, or type the address and the code. The app posts the code to `POST /pair` at the first address that answers, moves to the next only when one does not answer, keeps the address that worked, and gets a token for that phone alone. The bridge keeps only its sha256 and never prints it. The socket then authenticates with `Authorization: Bearer <token>`.

Once a phone is paired, the bridge prints no code at start. To pair another phone, use Settings, Pair another device on a paired phone, or run `bun run start --pair`. Revoking a phone in Settings closes its socket with code 4001. After 10 failed pairings from one address in 10 minutes, `/pair` answers 429 for that address.

`GET /health` answers `{"ok":true}`. With `?device=<id>&nonce=<32 to 128 hex digits>` for a paired device that is not the legacy one, it also returns `proof`, the hex HMAC-SHA256 of the nonce keyed by the raw bytes of the sha256 of that device's token. The app's **Edit address** checks this proof before it sends the token to a new address, so a server that answers on that address never sees the token. A phone on the legacy shared token cannot prove the bridge this way and pairs again instead.

`claude` must be on `PATH` and logged in. To check, run `claude -p hi`. Only one bridge runs per home. A second one exits and names the lock file beside the home's real path: `~/.claudiobot.lock`, or `~/.claudebot.lock` once `~/.claudiobot` links to `~/.claudebot` (the bridge then holds both). The lock records the bridge's pid and its start time in UTC. A lock whose process is gone or started at another time is stale and taken over. A live holder whose start time `ps` cannot read counts as busy. If no bridge is running and the lock stays, delete it.

The first run creates **Claudio Bot**, a general assistant, and it greets you.

## Run as a service

`bun run claudiobot install` runs the bridge as a LaunchAgent in your login session: it starts at login, restarts after a crash at most every 10 seconds, logs to `~/Library/Logs/ClaudioBot/bridge.log` (0600), and keeps the `PATH`, the `CLAUDIOBOT_*` variables and `ENABLE_CLAUDEAI_MCP_SERVERS` of the shell you ran it from. `status`, `doctor`, `logs`, `pair`, `update` and `uninstall` do what the root README's "Run as a service" says. `pair` stops the service while it runs the bridge in the terminal with `--pair`, so bots and routines pause until a phone pairs or you press Ctrl-C, and then it starts the service again if it was running. `doctor` never loads the store: it reads `state.json` read-only and asks `store.checkStateFile` what a start would do. Its Tailscale line prints the socket URL on the tailnet name (`ws://<name>.ts.net:<port>/ws`) beside the 100.x address.

## Upgrading from claudebot

At its first start the bridge links `~/.claudiobot` to an existing `~/.claudebot`, so every bot keeps its conversation and its Claude Code session. A `~/.claudiobot` that holds only what a first run leaves is moved aside to `~/.claudiobot.pre-migrate-<time>` first. When both homes hold bots, the bridge touches neither, uses `~/.claudiobot`, and prints how to switch. A set `CLAUDIOBOT_HOME` skips the migration. `CLAUDEBOT_HOME` is no longer read, and the bridge warns while it is set.

The bridge upgrades `state.json` from version 2 to 3 and keeps the exact old file as `state.v2.json.bak`. **Do not run an older bridge against the same home afterwards.** It does not know version 3, treats the file as a first run and overwrites it. To go back, stop the new bridge and copy `state.v2.json.bak` over `state.json` first. Anything changed since the upgrade is lost.

The phone paired with the old shared token keeps working until 1 January 2027 (`LEGACY_SUNSET` in `src/devices.ts`, `2027-01-01T00:00:00Z`) as the "legacy" device. A legacy socket that is connected at that moment keeps working until it reconnects. From then on the shared token is refused, and that phone pairs again with a code. Revoking it writes `token.revoked`, and that token is never accepted again. An app build that does not announce `?protocol=3` sees each permission card as a question card with **Allow once** and **Deny**, and its answer decides the card. The legacy phone and any app build that does not announce `?protocol=3` can revoke only themselves and can decide a card only with Allow once or Deny.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDIOBOT_PORT` | `7878` | Port to listen on, on all interfaces. |
| `CLAUDIOBOT_ROOTS` | `~/Dev/projects:~/code:~/Developer:~/Projects` | Colon-separated folders. Each git repo directly inside one is a project that agents can work in. |
| `CLAUDIOBOT_HOME` | `~/.claudiobot` | The bridge home (below). Setting it skips the migration from `~/.claudebot`. |
| `CLAUDEBOT_HOME` | | The old name. Ignored, with a warning. Rename it to `CLAUDIOBOT_HOME`. |
| `CLAUDIOBOT_CLAUDE` | `claude` on `PATH` | Path to the Claude Code executable. Useful when the bridge runs under launchd. |
| `CLAUDIOBOT_MODEL` | your Claude Code default | Pins the model for bots and agents. Bots run in auto permission mode, so pick a model that supports it. The SDK probe found that `claude-haiku-4-5` and `claude-sonnet-4-5` silently fall back to default mode. |
| `CLAUDIOBOT_USER_NAME` | first word of `id -F`, else `$USER` | Your first name, as bots use it. |
| `CLAUDIOBOT_DAILY_USD` | `10` | Daily spend cap per bot in US dollars, its agents included. The cap set in a bot's profile wins. |
| `CLAUDIOBOT_AGENT_USD` | `5` | Lifetime budget per Mac agent in US dollars. |
| `CLAUDIOBOT_PUSH_URL` | off | An ntfy topic URL. When set, the bridge pushes while no phone is connected. |
| `CLAUDIOBOT_WEBHOOK_PORT` | `7879` | Port of the webhook listener, on 127.0.0.1 only. `0` picks a free port. |
| `CLAUDIOBOT_WORKTREES` | `~/.claudiobot-worktrees` | The folder Mac agents' worktrees go in. |
| `CLAUDIOBOT_ALLOWED_DOMAINS` | | Comma-separated hosts sandboxed commands reach without review, on top of `github.com`, `*.github.com`, `*.githubusercontent.com`, the npm and Yarn registries, PyPI and crates.io. |
| `CLAUDIOBOT_SANDBOX_STRICT_NETWORK` | off | `1`: that list is the whole allowlist, and a command cannot ask for another host with `allowed_domains`. |
| `CLAUDIOBOT_SANDBOX_GH` | off | `1`: Mac agents may run `gh` (its config becomes readable and the sandbox allows the TLS trust service). Bots never get it. |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | on | Claude Code's switch. `false` leaves claude.ai connectors out of every bot and agent. Claude Code defers connector tools, so leaving them on costs about 1% per turn (root README, Costs). |

## What is on disk

```
~/.claudiobot/          (a link to ~/.claudebot after migration)
  state.json            version 3: bots, conversations, sessions, routines, cards, devices, pushes
  state.v2.json.bak     the v2 file as it was before the upgrade
  token                 the protocol 2 shared token, accepted until 1 January 2027
  token.revoked         present once the legacy phone was revoked
  USER.md               facts about you under ## Facts: yours and confirmed ones reach every bot, a bot's proposals only that bot
  usage/YYYY-MM.jsonl   one row per turn: cost, delta, who started it (0600)
  audit/YYYY-MM.jsonl   one row per checked tool call, secrets redacted (0600)
  bots/<botId>/         a bot's home and the working folder of its session
    CLAUDE.md           the bot's job and its own notes under ## Notes
    .claude/skills/<name>/SKILL.md  skills the bot saved, loaded as project skills
    library/            files the bot makes, listed in the app's Library
    inbox/              files you send from the phone
    work/               the bot's scratch: clones, scripts, downloads
    .history/           older messages moved out of state.json: bot.jsonl and <agentId>.jsonl
  agent-config/<agentId>/  the empty folder an agent loads project config from until its repo is trusted (0700)
  trash/<botId>-<ms>/   the home of a deleted bot
~/.claudiobot-worktrees/<project>/<agentId>/  a Mac agent's worktree, on branch claudio/<short id>
```

`state.json` is written atomically. If it cannot be read, or holds a version this bridge does not know, the bridge stops with a message and leaves the file alone. Deleting a bot moves its home to `trash/` and removes its agents' `agent-config/` folders. While its agents hold worktrees, `delete_bot` is refused unless it carries `force: true`, and the worktrees then stay on the Mac. Nothing else is deleted, and no worktree is removed until you ask.

## How a bot runs

Each bot has one Claude Code session through the Agent SDK, resumed from its stored session id after a restart. The session uses the `claude_code` system prompt with the bot's persona appended, carries its facts about you on the first turn and whenever they change (below), loads your user settings and the bot's `CLAUDE.md`, and runs with `permissionMode: "auto"` and Claude Code's auto memory off (its memory folder is under `~/.claude/projects`, which bots may not touch; a bot remembers through its `remember` tool). Every shell command runs in Claude Code's sandbox, which lets it write only the bot's `library/`, `inbox/` and `work/` (below).

A query with no turn in flight closes after 15 idle minutes, so its `claude` process exits; the next turn resumes the session on a new one, inside the prompt cache's hour. An unattended turn always gets a query of its own, capped at what is left of the day's spend. A turn silent for 30 minutes leaves a note naming the bot. While Claude Code cannot start, the bot shows **Unavailable** and the bridge retries after 30 s, 1, 2 and then every 5 minutes.

Everything that reaches a bot is one message whose first line says where it came from, such as `[Alex]`, `[Routine digest fired]`, `[Agent "Fix login" (a_...) reports]` or `[Alex allowed once: Bash \`git push origin main\`. Run exactly that call again now.]`. Messages wait in a durable inbox inside `state.json`, saved before Claude sees them, and the bot takes them one turn at a time. Each paragraph the bot writes becomes one chat bubble. Tool calls do not show as bubbles. While a turn runs, the chat shows one activity line per bot or Mac agent, such as "Reading hub.ts", built from its tool calls with URLs cut to their host and command options left out. It updates at most every 1.5 s, clears when the turn ends, and goes only to connected phones: it is never stored or pushed.

- **Stop** interrupts the turn in flight and drops queued background work, such as routine fires and messages from other bots, leaving the bot one notice that says so. Your own queued messages still run.
- **Retries.** A transient API error before any output retries after 1, 3 and 8 seconds. A turn that already had output is never replayed after a crash, because it may have had effects. The bot is told instead.
- **Limits.** A usage-limit rejection pauses every bot until 30 s after the reset. A model's own weekly limit pauses only the bot that hit it. The bot shows **Parked**.

A bot acts through the `claudio` MCP tools: `ask` posts a question card, `start_agent` and `message_agent` run coding agents, `list_projects` lists the repos, `message_bot` and `create_bot` reach other bots, `update_self` renames the bot (names are 1 to 40 characters) and, only in a turn you started, sets its job by rewriting the `## Job` section of its `CLAUDE.md`, `set_routine`, `delete_routine` and `list_routines` manage its routines, `routine_no_update` ends a routine run that has nothing to say, `remember` keeps a fact or a note, and `save_skill` saves a skill.

A phone send carries a `clientId`. If the same send arrives again, after a reconnect, the bridge answers with the message it already has and queues nothing.

## Memory and skills

`remember` about `user` adds a fact to `USER.md`'s `## Facts` as that bot's proposal. The bot sees it, marked unconfirmed, from its next query. Other bots see it once you confirm it in Settings, Memory, where you can also add, edit and forget facts. `remember` about `self` adds a line to the bot's `CLAUDE.md` `## Notes`. Each query opens with the facts it may read, fenced as data, at most 3 KB. The bridge refuses a fact that is empty, over 300 characters, holds hidden characters or an HTML comment, or looks like a secret (a token or key, a password, PIN or SSN with its value, or a card number that passes the Luhn check), and any fact once 50 are kept. It also refuses a bot's fact that reads as an instruction to bots. A direct edit of `USER.md`, the bot's `CLAUDE.md` or its `.claude/skills` opens a permission card in every turn. A `USER.md` named in an interpreter's code (`python -c`, a heredoc fed to `node`) counts as a direct write too. The bot's sandbox denies `USER.md`, so a fact line nobody tagged was written by hand and counts as confirmed. The first-run brief asks you three questions, keeps your answers as proposals, asks the bot to set its job with `update_self`, and then points you to Settings, Memory. If `USER.md` cannot be created at start, the bridge logs it and runs without it.

`save_skill` writes `.claude/skills/<name>/SKILL.md` in the bot's home, which Claude Code loads as a project skill from the bot's next turn. A name is lowercase words joined by hyphens, up to 64 characters. The description is one line of up to 200 characters, the body at most 20 KB, and a bot keeps at most 30 skills. Secrets and hidden characters are refused. The bot's profile lists its skills, and you can delete one there.

## Connectors

A bot's profile lists the MCP servers its queries load (your user, plugin and claude.ai servers; never the bridge's own `claudio`), with each one's status and a switch. The phone gets names and statuses only, never configuration. Turning one off is saved in `state.json`, covers the bot's agents, applies to the live query at once and to every later query (`deniedMcpServers`), and the gate refuses any call to it.

## Approvals

Every tool call of a bot or a Mac agent passes a `PreToolUse` hook. Some calls are always refused, such as anything touching the bridge home outside the bot's own folder, keys, the Keychain, browser data or the Claude login. A WebFetch, or a connector call with a `url`, to a loopback, private, link-local or Tailscale address, a dotless name, or a `.local`, `.lan`, `.internal`, `.home.arpa` or `*.ts.net` name is refused too, in your own turns as well, so a bot cannot fetch a dev server on `localhost`. Risky calls, such as pushing to the default branch, pushing to a URL, a path or a remote re-pointed on the same line, or re-pointing a remote, are refused with a "held for approval" reason, and a permission card opens in the bot's chat. **Allow once** lets that exact call run once within 10 minutes of the turn that re-runs it starting (at most 24 hours after the tap), and the bot is told to run it again. **Always** and **Never** become standing rules for the bot and its agents. A permission card shows the exact call with nothing masked, because you must see what runs; hidden and look-alike characters show as `<U+XXXX>`. It is stored that way in `state.json` and, once old, in `.history/`, while the audit row keeps a redacted copy of the input. A permission card expires after 2 hours and a question card after 24, each with one reminder at half its life. Time the bridge was down while a card was open is added back to the card at the next start. Three held or refused calls in one turn stop the turn. The root README's Safety model has the full list and the limits.

## The sandbox

`src/sandbox.ts` builds the Seatbelt sandbox for every Bash call of a bot or a Mac agent, and `src/private.ts` lists the paths both it and the gate keep private. It is enforced by macOS for the command and everything the command starts, with `failIfUnavailable: true` and `allowUnsandboxedCommands: false`, and `autoAllowBashIfSandboxed: false` keeps the auto-mode classifier on every call. It does not cover Read, Write, Edit, Grep, Glob, WebFetch or MCP tools, and it does not open cards: the gate does both.

- A bot writes only `library/`, `inbox/` and `work/` in its home and the sandbox's own `TMPDIR`. It is denied `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/.claude` and `**/.mcp.json` at any depth under its home, and `USER.md`, so no command of the bot can rewrite what its later turns load; Claude Code turns these globs into Seatbelt regexes. It reads its home and `USER.md` and nothing else of the bridge home. A bot made before `work/` existed gets the folder when its next query opens. A Mac agent writes its project, except the project's `.claude`, `.mcp.json` and `CLAUDE.local.md` (`CLAUDE.md` stays writable, and a Write or Edit of it is still a card), the git dirs a commit needs outside it (never their `hooks`, `config` or `config.worktree`), the per-user temp and cache dirs, and the npm, Bun, `~/.cache`, `~/Library/Caches` and Xcode build caches.
- Both are denied the private paths and the bridge's `CLAUDIOBOT_*` variables. A Mac agent may read `~/.ssh/config`, `~/.ssh/known_hosts`, `~/.ssh/*.pub` and `~/Library/Keychains`.
- Pushing: inside the sandbox Claude Code points git's ssh at a SOCKS proxy that refuses it (seen with Claude Code 2.1.301), so for agents the bridge sets `GIT_CONFIG_*` to rewrite `git@github.com:` and `ssh://git@github.com/` to `https://github.com/`, and git's osxkeychain helper supplies the token. That helper also answers any other agent command, which can send the token only to allowed hosts or ones the classifier approved.
- Signing: with `commit.gpgsign` on, `ssh-keygen -Y sign` works only through the SSH agent, which the sandbox may reach when the bridge has `SSH_AUTH_SOCK`; key files stay unreadable and `~/.gnupg` is denied, so GPG signing fails. The e2e runs with no agent and turns signing off in its repos.
- Network: the hosts above go through without review. For another host Claude Code re-runs the command with it in the Bash tool's `allowed_domains`. The classifier reviews that, and on unattended turns the gate holds it on a card that shows the hosts.
- When the sandbox cannot start, a tool result says so: the session tells the bot's chat once, does not count it toward the denial breaker, and closes the query at the turn's end so the next turn tries again. A query that ends because its sandbox could not start is a start failure: the message keeps its place and waits the long start backoff. Nothing is retried without the sandbox.

## Agents

A bot starts an agent for coding work in a project.

- A **mac** agent is a Claude Code session in the project folder, behind the same gate and sandbox and counted against its bot's daily cap and its own budget. When its turn ends, the bridge reads what git says the agent did (branch, commits ahead of the default branch or of the worktree's start, files changed, uncommitted work, and a GitHub PR URL its message named) and puts that line above the agent's final message, which goes back to the bot. The bot checks the claim against git's facts before it tells you. The same facts show on the agent in the app. An agent the daily cap stopped shows **capped** and resumes when you message it tomorrow or raise the cap; an agent that used its own budget fails.
- A **cloud** agent runs `claude --cloud` in the project folder, under `script(1)` because it wants a terminal, with a 90 second limit, so the project needs a GitHub remote. The bridge neither checks its tool calls nor counts its cost. It does not report back. The bot gives you the claude.ai link instead.

A mac agent loads project configuration (`projectConfigRoot`) from `agent-config/<agentId>/`, an empty folder only the bridge writes, until its repo is trusted. The repo's `.claude` settings and hooks, `.mcp.json` servers, commands, agents and skills therefore never load from the checkout or any branch it checks out. When the repo carries any of them, its bot's chat gets one card per repo, "Trust <repo>'s Claude settings", listing what was found. Allow once trusts the repo for that agent, Always for every agent in it (saved in `state.json`), Deny keeps that agent on the empty folder and Never every agent; an expired card decides nothing. Once trusted, each live agent in the repo gets a new query at its next chance, which loads the repo's own config.

`start_agent` takes `isolate`. `none` works in the project folder. `worktree` gives the agent its own git worktree, `~/.claudiobot-worktrees/<project>/<agentId>` (or under `CLAUDIOBOT_WORKTREES`) on branch `claudio/<first 8 of its id>`, started from the default branch. `auto`, the default, makes one when the checkout has uncommitted work or another Mac agent works in the folder. A worktree agent's repo trust and project config come from the main checkout. Only you remove a worktree, from the agent's screen. Removal is refused while the agent works, when the worktree has uncommitted or untracked files, or when it holds ignored files other than build folders (`node_modules`, `.build`, `dist`, `build`, `DerivedData`), such as an `.env`. It never uses `--force`, the branch stays, and nothing removes a worktree on its own. The bridge's own git reads run with hooks, fsmonitor, filters, pagers and the system config off, and time out after 10 s.

If the bridge restarts while a mac agent is working, the agent is marked failed and its bot is told. A message to the agent resumes it.

## Routines

A routine is a prompt a bot receives on a schedule, written as five-field cron in the Mac's local time. A routine may run at most every 15 minutes, and a bot may have at most 20.

The bridge stores each routine's next run time and saves it before it fires, so a crash can lose a fire but never repeat one. Times missed while the Mac slept collapse into one decision. The newest one fires, marked late, if it is within half the routine's period (between 2 minutes and 2 hours). Otherwise one skipped run is recorded. A fire is skipped while the bot is at its daily cap or paused by a limit, or while its previous run is still queued.

A scheduled run's messages wait until the run ends. If the bot called `routine_no_update` and asked nothing, they are dropped and the run is recorded **quiet**. Otherwise they post together, with one push. Messages written before a card the run opens go out first, and a run that asked for approval is never quiet. Run now from the phone always replies, runs even at the daily cap, and never counts toward the 10 failures in a row that turn a routine off. Each routine keeps its newest 20 runs.

A **webhook** routine (`set_routine` with `trigger: "webhook"`) has no schedule and fires when a program on this Mac calls it. The app shows it as "When called". Make its token in the routine's screen: the app shows the URL and the token once, the bridge keeps only the token's sha256, and a new token replaces the old one. The listener runs on 127.0.0.1 only (`CLAUDIOBOT_WEBHOOK_PORT`, default 7879), and no token is handed out when it could not bind.

```sh
curl -X POST -H "Authorization: Bearer whk_…" --data 'build 412 failed' http://127.0.0.1:7879/hook/<routineId>
```

It answers 202 "Fired.", 401 for a wrong or missing token, 403 for a request with an `Origin` header or another `Host`, 413 for a body over 16 KB, 429 within a minute of the routine's last fire, 409 while the routine is paused, still running or parked by a limit, and 500 when the run could not start. The body reaches the bot fenced as data from a program, never as your instructions.

## Push

With `CLAUDIOBOT_PUSH_URL` set to an ntfy topic, the bridge posts when no phone is connected and a card opens, a card reminds, or a turn posts its first message. The text is the bot's name and a fixed phrase. No message content leaves the Mac. The click link opens `claudiobot://bot/<id>?message=<id>`. Each push is recorded before it is sent, so a crash never sends one twice. A failed send, an HTTP 429 included, is logged and not retried. Message pushes are limited to one per bot every 10 minutes, with no cap across bots. A muted bot (its profile's switch) sends no message push, but its cards and reminders still do. After the bridge starts, a push for a card that was already open waits 60 s, and a phone that connects in that time gets none.

## Tests

```sh
bun test         # unit tests, no network, no Claude
bunx tsc --noEmit
bun run e2e      # real Claude Code in a temp home, 29 scenarios, about $1.60, stops at $8
```

The e2e script starts the bridge with `CLAUDIOBOT_HOME` and every project root in a temp folder, so it never touches `~/.claudebot` or `~/.claudiobot`, and points `CLAUDIOBOT_WORKTREES` at a temp folder too. It keeps your `HOME` for the Claude Code login but passes the bridge no `SSH_AUTH_SOCK` or GitHub token, sends pushes to a fake ntfy server of its own, and turns claude.ai connectors off. It pairs over `POST /pair` and drives the bridge through the socket like the app. It covers a user turn; a bot command built at runtime that the gate holds and that, after Allow once (which Claude Code runs without asking its classifier), the sandbox still refuses: a read in the bridge home and a write outside the bot's home; a mac agent's commit and report; Stop on a running command; an agent's `git push origin main` to a local bare remote that waits for Allow once; a bot's held push approved through a protocol 2 socket's answer; a repo whose committed hook must not run until the repo is trusted, and does after; no push while a phone is connected and a push once none is; quiet and non-quiet routine runs after a restart; and session resume. It pins `claude-sonnet-5-5`, because auto mode needs it. `E2E_MODEL` overrides the model, and `E2E_BRIDGE_LOG=<file>` keeps the bridge's log. It never starts a cloud agent, and it prints the total the ledger charged.
