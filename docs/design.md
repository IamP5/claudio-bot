# ClaudioBot v3 design

`docs/grok-bot-reference.md` describes the product. `bridge/src/protocol.ts` is the wire contract, and it wins any disagreement with this file. `fixtures/protocol.json` pins both sides. `bridge/V3-CONTRACT.md` lists each module's interface and owner. `docs/arena-synthesis.md` explains how this design was chosen over two others.

v2 made the product a set of long-lived bots instead of one-off tasks. v3 keeps that product and makes it safe to leave running. Risky tool calls wait for a tap on the phone, and every shell command runs in the OS sandbox. Routines report honestly and stay quiet when there is nothing to say. Spend has a daily cap. Each phone pairs with its own token. A push reaches you when the app is closed. The bridge runs as a LaunchAgent. Bots remember what you confirm, save skills, and can be fired by a local webhook. Mac agents report with git's facts and can work in their own worktree.

## Where things run

The Mac bridge owns every bot. The phone is a view. A bot keeps working, and its routines fire, while the phone is closed.

```
~/.claudiobot/            a link to ~/.claudebot after migration
  state.json              version 3: bots, conversations, sessions, routines, gate, devices, push (atomic)
  state.v2.json.bak       the exact v2 file, kept by the upgrade
  token                   protocol 2's shared token, accepted for one release as the "legacy" device
  token.revoked           written when that phone is revoked, so the token is never imported again
  USER.md                 facts about you; a bot's own facts are proposals until you confirm them
  usage/YYYY-MM.jsonl     one row per turn result: the ledger (0600, append-only)
  audit/YYYY-MM.jsonl     one row per gated tool call (0600, append-only, secrets redacted)
  bots/<botId>/           a bot's home and the cwd of its Claude Code session
    CLAUDE.md             the bot's job and its own notes (## Notes)
    .claude/skills/       skills the bot saved with save_skill
    library/              files it makes for you
    inbox/                files you send from the phone
    work/                 its scratch: clones, scripts, downloads
    .history/             messages moved out of state.json past 1,100: bot.jsonl, <agentId>.jsonl
  agent-config/<agentId>/ the empty projectConfigRoot of an agent whose repo is not trusted (0700), removed with its bot
  trash/<botId>-<ms>/     a deleted bot's home, moved here, never deleted
~/.claudiobot-worktrees/  mac agents' worktrees, <project>/<agentId> (CLAUDIOBOT_WORKTREES moves it)
~/.claudiobot.lock        one bridge per home, beside the home's real path so migration can move it;
                          the pid and its start time in UTC tell a running bridge from a stale lock
                          (~/.claudebot.lock once the home links there; the bridge then holds both)
```

## Modules

Each module is the only writer of its slice of `state.json`. `world.ts` declares every persisted shape, and a slice another module owns is typed `Owned<T>` (deeply readonly), so a write from the wrong module does not compile.

| Module | Owns | Writes |
| --- | --- | --- |
| `hub.ts` | client messages, tool calls, wiring | bot profiles, conversations |
| `session.ts` | one actor's turns: durable inbox, lifecycle, notices | `BotRecord.session`, `AgentRecord.session`, `World.account` |
| `gate.ts`, `policy.ts` | the `PreToolUse` hook, question, permission and trust cards, standing rules, grants, repo trust, audit | `World.gate`, `BotRecord.rules` |
| `sandbox.ts`, `private.ts` | the Seatbelt sandbox for every bot and agent shell command, and the private paths it shares with the gate's floors | nothing |
| `scheduler.ts`, `clock.ts` | routines, run history, the one clock | `BotRecord.routines` |
| `ledger.ts` | spend per bot per day and per agent, the caps | `usage/` |
| `devices.ts`, `serve.ts`, `stream.ts` | pairing, socket auth, the resumable broadcast | `World.devices` |
| `push.ts` | ntfy pushes while no socket is live | `World.push` |
| `migrate.ts`, `lock.ts` | the move from `~/.claudebot`, one bridge per home | the home links |
| `cli.ts`, `service.ts`, `doctor.ts` | the `claudiobot` command: LaunchAgent install, status, doctor, logs, pair, update | the plist and the log |
| `claudeCode.ts` | facts about the Claude Code install (version floor, config dir, managed MCP) and reads from a query that runs no turn | nothing |
| `text.ts` | the one rule set for names, errors and secrets that leave the bridge | nothing |
| `memory.ts` | facts, proposals and notes, and the facts block a bot's turn carries | `USER.md`, a bot's `CLAUDE.md` |
| `skills.ts` | a bot's saved skills | `bots/<id>/.claude/skills/` |
| `connectors.ts` | which MCP servers a bot and its agents load | `BotRecord.connectorsOff` |
| `activity.ts` | the activity line | nothing |
| `webhook.ts` | the loopback listener that fires webhook routines | nothing (the token hash is the scheduler's) |
| `evidence.ts`, `worktree.ts` | hardened git reads after an agent's turn, agent worktrees | worktrees under `~/.claudiobot-worktrees` |

`store.ts` loads and saves the file. Loading fails closed: an unknown version, unreadable JSON or a malformed record stops the bridge with a message and writes nothing. A v2 file is upgraded in memory, its exact bytes go to `state.v2.json.bak`, and then v3 is written. `persist("now")` writes synchronously (temp file, `fsync`, rename, directory `fsync`) before an effect that depends on it. Everything else is debounced by 250 ms.

`claudiobot install` pins PATH, the `CLAUDIOBOT_*` variables, `CLAUDE_CONFIG_DIR` and `ENABLE_CLAUDEAI_MCP_SERVERS` into the plist, since launchd hands the service nothing from the shell; HOME is never pinned. `claudiobot doctor` checks the service as launchd runs it: the claude it resolves on the service PATH and a warning below `MIN_CLAUDE` (2.1.301), the Claude Code config dir it reads, and the login, read from a query that is sent no message, so the doctor spends no turn. Where an admin's `managed-mcp.json` exists, Claude Code exits on `--strict-mcp-config`, so the cloud CLI, the commands probe and the doctor leave it out (`claudeCode.ts`).

## A turn's life

Everything that reaches a bot is an **envelope**: one user message whose first line says where it came from.

| Source | First line |
| --- | --- |
| you typed | `[Alex]`, then the text and `Attached: inbox/<file>` lines |
| you answered or dismissed a card | `[Alex answered "<question>": <option>]`, `[Alex dismissed "<question>" without answering]` |
| you decided a permission card | `[Alex allowed once: Bash \`git push origin main\`. Run exactly that call again now.]` and the Always, Deny and Never forms |
| a routine fired | `[Routine <name> fired]`, its prompt, a webhook call's payload fenced as data, then either "reply even if nothing changed" (Run now) or "if there is nothing worth telling Alex, call routine_no_update" |
| an agent reported | `[Agent "<title>" (<agentId>) reports]`, the bridge's `[Git, read by the bridge after this turn: …]` line, then its final text |
| another bot | `[Message from bot <name>]`, then the text |
| the bot was created | `[You were just created by Alex]` or `[You were just created by bot <name>. Brief:]` |

Each envelope has an **initiator**, a pure function of the envelope: `user`, `routine` (scheduled or Run now), `bot` or `agent` (hops, carrying the origin of the chain), or `system`. A turn is **attended** when it is yours or a Run now. Unattended turns get the policy's stricter column and are held by the daily cap.

1. `hub.deliver` turns the envelope into a `SessionInput` and pushes it to the actor's session. The session writes it to the durable inbox with `persist("now")` before the SDK sees it, so a crash never loses a message. A decision envelope is queued with `kind: "continuation"`: it goes right behind the turn in flight, Stop keeps it, and when its turn is sent the session calls `gate.beginTurn`, which starts the grant's 10 minutes.
2. The session's lifecycle is one value, `idle | working | stopping | backoff | parked`, and `step()` is a pure function over it. Only an idle session starts a turn. It checks the ledger's headroom first. An unattended turn at the daily cap parks until midnight, and a mac agent with no budget left fails the turn.
3. Notices (an expired card, work Stop dropped, a restart mid-turn) go on top of the envelope, so they reach the bot without spending a turn. So do the standing brief (persona, name and job) and the facts block when they changed since the session last got them. A resumed Claude Code session keeps the system prompt it started with, so this is how a rename or a new job reaches it. Both count as sent only once the model answers the turn.
4. Every tool call passes the gate (below). Three held or denied calls in one turn stop it, with a note.
5. Each text block becomes chat bubbles, one per paragraph. Text after an `ask` card in the same turn is dropped. Each tool call sets the actor's activity line (below).
6. The result goes to the ledger as a delta of the SDK's running total. Then the session tells the hub how the envelope ended: `done`, `stopped` (by you or by the breaker), `dropped`, `failed`, or `deferred` (a retry or a park, not an ending). Each envelope that leaves the inbox gets exactly one ending.

A turn with output is never replayed after a crash, because it may have had effects. The bot is told it was cut off instead. A transient API error with no output retries after 1, 3 and 8 seconds. A start counts toward the limit of 4 attempts. A usage-limit rejection parks every session until 30 s after the reset. A model's own weekly limit parks only the session that hit it. When Claude Code has deleted the transcript a resumed query names, the first turn fails with "No conversation found" for that id before any output. The session then drops the id, starts a new session with the same envelope, notes it in the chat, and tells the bot its history is gone. A query that cannot open at all (no `claude`, options that throw, a sandbox that cannot start) uses no attempt: the envelope keeps its place, the session retries after 30 s, 1, 2 and then every 5 minutes, and the bot or agent shows `unavailable` meanwhile.

One live query serves an actor's turns. It closes after 15 minutes with no turn and no output, so its process exits, and the next turn resumes on a new one inside the prompt cache's hour. An unattended turn always gets a query of its own whose `maxBudgetUsd` is what is left of the day's cap, and an attended turn never runs on such a query. `Session.reopen` replaces the live query at its next chance when the options change (a repo was trusted), and a query whose sandbox failed is replaced after its turn.

**Stop** moves the turn to `stopping`. The gate then denies every call, the SDK is interrupted, and the interrupt's result ends the turn as stopped. If no result arrives within 15 s, the query is killed. Stop also drops queued unattended envelopes with one notice. Your own queued messages still run.

## The gate

Every bot and mac agent query has one `PreToolUse` hook on every tool. Its body is synchronous and wrapped so that any exception becomes a deny, because a hook that throws lets the call run. The policy checks, in order:

1. **Floors**, always denied: the bridge home except the bot's own folder and `USER.md`, writes to config files the bridge itself loads, SSH, GPG and cloud keys, the Keychain, browser profiles and cookies, stored credentials and tokens (the Claude login among them), password, payment or 2FA entry (handed back to you), and a WebFetch or URL-taking connector call to a loopback, private, link-local, CGNAT or local-only host. A floor holds on attended turns too: a bot fetching a dev server on `localhost` is refused rather than asked, because a fetch's URL can carry data to anything on the LAN or the tailnet. Bash is parsed by a real shell tokenizer, and paths are resolved through symlinks and their ancestors before they are matched. A command over 32 KB, or one that would resolve more than 4,096 paths, is held as too long to check, except that a floor root spelled in its raw text is still refused.
2. **Initiator bans**: no routine changes in a routine-started chain, and no `message_bot` or `create_bot` at 2 or more bot hops.
3. **Refusals**: a `claudio` tool the bridge does not serve, and a call to a connector the user turned off for the bot.
4. **Limits**: budget or daily cap, and per-bot daily caps on `create_bot` (5) and `start_agent` (20).
5. **Never** rules, then a one-shot **grant** for this exact call, then **Always** rules (an Always given in an attended turn covers attended turns only).
6. **The table** of risky commands by attended or unattended: pushing to the default branch, force-pushing, merging a PR, publishing, deploying, setting secrets, sending data to a web service, deleting outside the bot's folder, changing a config file that controls how it runs (the bot's own `CLAUDE.md` and `.claude/skills` included), editing `USER.md` directly, running a command built at runtime, and others. Unattended turns also hold pushes to any branch, writes outside the bot's folder, connector writes, `create_bot`, `start_agent`, `remember`, `save_skill` and routine changes.
7. **Pass**: no opinion, so Claude Code's auto classifier decides as it would without the bridge.

Code an interpreter runs can write any file it names, and the tokenizer cannot read the code. So for an interpreter (`python`, `node`, `ruby`, `R`, `sqlite3`, `vim`, `emacs` and the others) or a launcher (`uv`, `poetry`, `conda` and the others), each spelling of `CLAUDE.md`, `USER.md`, `.mcp.json` or `.claude/` in that command's own words or in a heredoc opened on its line counts as a write, and a `USER.md` anywhere in the code counts as a write to the user's. Words of other commands on the line, such as a commit message, are not read. More than 64 such names in one command is held.

A push can carry the repo anywhere its remote points. Pushing to a URL, an `ext::` remote, a scp-style or local path, a remote added or re-pointed on the same line, or under a `-c`, `--config-env` or `GIT_CONFIG_*` that sets a remote URL, an `insteadOf` or an include asks in every turn with no Always. Re-pointing a remote in a call of its own (`git remote add`, `set-url`, or `git config` of those keys with a value) asks the same way, because the next push would trust it.

A Bash call that adds hosts to the sandbox's network allowlist (the tool's `allowed_domains`) carries them as a part of its own, so on unattended turns the table holds it with the hosts on the card, and the hosts are part of the call's fingerprint.

An "ask" opens a **permission card** and denies the call with a "held for approval" reason. That is the deny-and-regrant mechanism. Allow once installs a grant for that exact input for 10 minutes and delivers a decision envelope that runs ahead of other queued work, so the model re-issues the call and the grant lets it through. Only a turn of the card's attendance can use the grant, and that binding is saved with it. The card shows the rule in words, the exact call, and what Always would cover. Nothing in the call is masked, because the approver must see what runs, and a masked base64 run could be the payload. Hidden characters, line separators and look-alike spaces show as `<U+XXXX>`. The card is stored as shown, in `state.json` and later in `.history/`; only the audit row is redacted. Only a card tap from a paired device approves. Chat text never does. A permission card expires after 2 hours and a question card after 24, each with one reminder at half its life. An expired card leaves a notice that says the call did not run and that the user did not say no. While a card is open the gate saves `aliveAt` each minute, and a restart adds the time the bridge was down to every open card's deadline.

A transition that opens a card, consumes a grant or adds a rule saves synchronously before the audit row is written and before the hook returns. A repeated hook call for the same `tool_use_id` gets the recorded verdict and opens no second card.

Claude Code also asks on its own: auto mode's classifier cannot decide, a `permissions.ask` rule matches, or a protected path is touched. Bots and mac agents pass the gate's `canUseTool`, which holds such a call the same way: a permission card in the bot's chat, an audit row, and a deny with the "held for approval" reason, under the same open-card cap and the same "already waiting" dedupe. Its rule is `claude.ask` and its signature names the exact call, so the card offers no Always and Never refuses only that call. A `tool_use_id` the hook already decided gets that verdict, so a retry the grant let through the hook is allowed when Claude Code asks about it again.

Nobody sits at a bot's or an agent's terminal, so `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` are disallowed for both. A bot's `claudio` tools that have no effect outside its turn (`ask`, `list_projects`, `list_routines`, `routine_no_update`; `tools.ts` classifies every tool) are in `allowedTools`, so they skip the classifier. The hook still sees each call.

A **trust card** is a permission card on the wire that holds nobody up. A mac agent loads project configuration from an empty folder the bridge owns (`projectConfigRoot`), so a repo's committed `.claude` settings and hooks, `.mcp.json`, commands, agents and skills never run. When the repo has any, the gate posts "Trust <repo>'s Claude settings" once per repo. Allow once records the repo as trusted for that agent, Always for every agent in it (`GateState.repos`), Deny and Never the opposite; the newest answer for a repo wins, and an expired card decides nothing. A trusted repo's live agents reopen their queries, and the next one loads the repo's own config.

## The sandbox

The gate reads command lines. Under it, every Bash call of a bot or a mac agent runs in Claude Code's Seatbelt sandbox, built by `sandbox.ts` with `failIfUnavailable` and no unsandboxed commands, and with the classifier still on. A bot writes only `library/`, `inbox/` and `work/` in its home, and is denied every `CLAUDE.md`, `CLAUDE.local.md`, `.claude` and `.mcp.json` under its home and `USER.md`, because those are what its later turns load as instructions; the bridge writes them through `remember`, `save_skill` and `update_self`. A mac agent writes its project except its `.claude`, `.mcp.json` and `CLAUDE.local.md` (its `CLAUDE.md` is ordinary repo work, and a Write or Edit of it is still a card), the git dirs a commit needs (never their hooks or config), the per-user temp and cache dirs and the build caches. Both are denied the bridge home and the private paths in `private.ts`, the same list the gate's floors refuse, and the bridge's own `CLAUDIOBOT_*` variables. Sandboxed commands reach GitHub, npm, Yarn, PyPI and crates.io; another host takes a re-run with `allowed_domains`, which the classifier reviews and, on unattended turns, the gate holds. Claude Code's sandbox breaks git over ssh, so agents get `GIT_CONFIG_*` that rewrite GitHub ssh remotes to https, and they may read the Keychain for git's credential helper. File tools, web fetches and MCP tools are outside the sandbox: the gate covers those. A sandbox that cannot start is never worked around: commands fail, the bot's chat says so once, and a query that cannot start waits and retries.

## Routines

A routine is a prompt on a five-field cron in the Mac's local time. A routine may run at most every 15 minutes, and a bot may have at most 20.

- `nextRunAt` is stored. It advances, and the running run is recorded, in one synchronous save before the fire is delivered. A crash can lose a fire but never repeat one.
- Missed times collapse into one decision. The newest missed time fires once, marked late, if it is inside the grace window (half the period, between 2 minutes and 2 hours). Otherwise one skipped run is recorded.
- A fire is recorded skipped while the bot is held by a limit, or while its previous run is still queued.
- A scheduled run holds its bubbles until the turn ends. If the bot called `routine_no_update` and asked nothing, the bubbles are dropped, nothing is pushed, and the run settles **quiet**. Otherwise the bubbles post together with one push. Bubbles written before a card the turn opens, or before the breaker's note, go out at once, ahead of it, and a run that opened a permission card is never quiet.
- Run now is attended, never quiet, runs at the daily cap, and its failures never count toward fatigue. Ten failed runs in a row turn a routine off with a note.
- A v2 routine that runs more often than every 15 minutes is turned off with a note at the first tick after the upgrade. Editing its schedule turns it back on.
- A **webhook** routine has no schedule (`schedule` "", shown as "When called"). `webhook.ts` listens on 127.0.0.1 only (`CLAUDIOBOT_WEBHOOK_PORT`, default 7879, `0` for a free port). A call is `POST /hook/<routineId>` with `Authorization: Bearer whk_…`. The phone mints the token (`webhook_token`) and sees it once; the bridge stores only its sha256, a new token invalidates the old, and none is minted while the listener could not bind. A request with an `Origin` header or another `Host` gets 403, a wrong token 401, a body over 16 KB 413, a call within 60 s of the last fire 429 (a last fire in the future, from a clock set back, counts as elapsed), a paused, running or parked routine 409, and a run that could not start 500. The token is checked again after the body is read. The body reaches the bot fenced as data, never as the user's words. A loopback listener and a bearer token keep a web page and other machines out; the cooldown keeps a looping script from spending the day's cap.

## Usage

The ledger appends one row per turn result to `usage/YYYY-MM.jsonl`. A row holds the SDK's cumulative cost, the delta charged against that session's previous row, the initiator and the local day. Each bot has a daily cap (`CLAUDIOBOT_DAILY_USD`, default $10, or the bot's own `dailyCapUsd` from the phone) that counts its agents too. Each mac agent has a lifetime budget (`CLAUDIOBOT_AGENT_USD`, default $5). A mac agent's query gets what is left of that budget as `maxBudgetUsd`, and a query opened for an unattended turn gets at most what is left of the day, so the SDK stops a runaway turn mid-way. Attended turns are never held by the daily cap; it is checked before each unattended turn. Each `bot` frame carries today's spend, and at local midnight the hub resends every bot frame so the phone's count starts again at zero. A routine run the cap cuts short settles `skipped`, not `failed`, and the bot says it used today's budget. A mac agent the daily cap stops shows `capped`, not `failed`, and resumes on a message tomorrow or a raised cap; an agent whose own budget ran out fails. Raising a bot's cap from the phone lifts a cap park at once.

## Transport

- **Pairing.** The bridge prints a one-time code (`XXXX-XXXX`, valid for 10 minutes, 5 tries) and a QR code of `claudiobot://pair?url=…&url=…&code=…`, one `url=` per address, best first: the tailnet name, the Bonjour `.local` name, then each LAN IPv4. The app posts `{code, name}` to `/pair` at the first address that answers, moves on only when one does not answer, keeps the address that worked, and gets its own token, which the bridge stores only as a sha256. The socket then authenticates with `Authorization: Bearer <token>`. A paired phone can show a code for another phone. After 10 failed pairings from one address in 10 minutes, `/pair` answers 429.
- **Moving to another address.** The token is the phone's only secret, so the app does not send it to an address until whatever answers there proves it already holds it. `GET /health?device=<id>&nonce=<hex>` returns `proof`, the HMAC-SHA256 of the nonce keyed by the sha256 of the device's token, which only this bridge and that phone know. A legacy pairing has no device to prove, so it pairs again.
- **Revoking** a phone closes its sockets with code 4001. Protocol 2's shared token is imported once as the "legacy" device. Revoking it writes `token.revoked`, so it never comes back.
- **The stream.** Every broadcast carries a `seq`, and each bridge start has a new `epoch`. A reconnecting app passes both, and the bridge replays what it missed from a bounded ring. When the ring no longer holds the missed frames, the app gets a fresh hello instead. Frames may be up to 32 MB, because uploads ride inline.
- **Repeated sends.** A send carries a `clientId`. The app keeps sends the bridge has not echoed and resends them after a hello, so a send lost in a reconnect still arrives. A resend whose `clientId` the bot already has gets that message back and queues nothing. The app gives a send up once three sockets took it without an echo.
- **Signals.** The activity line is a frame with no `seq`: it goes to connected protocol 3 sockets and is never stored, replayed or pushed. `hello.features` names the screens this bridge backs.
- **Protocol 2 apps.** The app announces `?protocol=3`. A socket that does not gets every permission card as a question card with the options "Allow once" and "Deny", and its answer is read as that decision, so an old build can still approve a call once.

## Push

When no socket is live, `push.ts` posts to `CLAUDIOBOT_PUSH_URL` (an ntfy topic) when a card opens or reminds, or when a turn posts its first bubble. The text is the bot's name and a fixed phrase. No message content leaves the Mac. The click link is `claudiobot://bot/<id>?message=<id>`. Each push key (`<messageId>|<reason>`) is recorded and saved before the send, so a crash never sends twice. A failed send, a 429 included, is logged and never retried. Message pushes are throttled to one per bot per 10 minutes. A muted bot sends no message push; a card still pushes, because a held call waits on you. At start no phone has reconnected yet, so a push for a card already open waits 60 s and goes out only if no phone came back.

## Migration

The project was renamed from claudebot to claudiobot. At start, before anything opens the home, `migrate.ts` reconciles the two homes. When only `~/.claudebot` exists, it links `~/.claudiobot` to it, which keeps every bot's Claude Code session resumable. When the new home holds only what a first run leaves, it moves that home aside and links. When both hold bots, it changes nothing, uses `~/.claudiobot`, and says how to switch. A set `CLAUDIOBOT_HOME` skips all of this. The old `CLAUDEBOT_HOME` is ignored with a warning.

## Bot tools

The in-process MCP server `claudio` gives each bot `ask`, `start_agent`, `message_agent`, `list_projects`, `message_bot`, `create_bot`, `update_self` (name, avatar, and the job, which only a turn the user started may change), `set_routine`, `delete_routine`, `list_routines`, `routine_no_update`, `remember` and `save_skill`. Bot names are 1 to 40 characters with no control, format or bidi characters (`text.ts`, which also cleans device names and push titles the same way). The gate covers these tools too, so a routine cannot change routines, and a bot-to-bot chain stops at two hops.

## Memory

A bot remembers through `remember`, never by editing a file: the gate cards any direct write to `USER.md`, to the bot's own `CLAUDE.md` or to its `.claude/skills` in every turn. `remember` about `self` adds a line to the bot's `CLAUDE.md` `## Notes`. `remember` about `user` adds a fact to `USER.md`'s `## Facts` as that bot's **proposal**. The proposal reaches only that bot's queries, marked unconfirmed, until you confirm it in Settings, Memory (`confirm_fact`). Facts you add or confirm reach every bot. The reason is reach: a web page or a webhook payload that talks one bot into remembering a rule must not spread it to every bot unseen. Filtering text that reads as an instruction is only a speed bump, since any rule can be phrased as a fact.

Each fact line keeps its id, time and proposer in an HTML comment, so a hand edit of `USER.md` survives and the phone's ids stay valid. A line with no comment counts as confirmed: no bot writes `USER.md` unseen, because the bot sandbox denies it and a Write or Edit of it is a card. The phone matches a proposal to its bot's chat by `proposerBotId`, since a bot's name can change. Before each turn the bot's session reads `memory.context(botId)`, the confirmed facts and its own proposals, fenced as data, at most 3 KB, and puts it on top of the turn's message when it changed since that session last sent it. It stays out of the system prompt because a resumed Claude Code session keeps the system prompt it started with. The bridge refuses a fact that is empty, over 300 characters, carries hidden characters or an HTML comment, or looks like a secret (a known token shape, a password, PIN or SSN with its value, or 13 to 19 digits that pass the Luhn check, so most phone numbers are kept), and any fact once 50 are kept. A bot's fact is also refused when it reads as an instruction to bots. `remember` passes in an attended turn and asks in an unattended one, with no Always. A change reopens the affected queries, so the next turn sees it.

The first-run brief asks three questions and keeps the answers with `remember`. They stay proposals. Once the user says what they want help with, the bot sets its job with `update_self`, and it ends by pointing you to Settings, Memory. The model paraphrases an answer into a fact, and the bridge cannot tell an answer from the rest of the turn without exact matching, which would strip the facts of their context.

## Skills and connectors

`save_skill` writes `bots/<id>/.claude/skills/<name>/SKILL.md` (frontmatter `name` and a JSON-quoted `description`, then the body), which Claude Code loads as a project skill. The file is 0600 in 0700 folders and written atomically, and the bridge never writes through a symlink or replaces a SKILL.md that is not a plain file. A name matches `^[a-z0-9]+(-[a-z0-9]+)*$` up to 64 characters, the description is one line up to 200, the body at most 20 KB, a bot keeps at most 30, and secrets and hidden characters are refused. A save or delete reopens the bot's query and sends every phone the new list.

A **connector** is an MCP server a bot's queries load. The phone sees each one's name, status and switch, never its configuration. `BotRecord.connectorsOff` is saved and covers the bot's agents. It reaches every query at open as the `deniedMcpServers` flag setting and the live query at once through `toggleMcpServer`, and the gate denies any call to an off server (`connector.off`), so an agent that kept its query through a toggle is still held to it.

## Commands

Typing `/` in the composer lists what the bot's own Claude Code session can run: the user's skills, plugin skills (`plugin:skill`), the bot's project skills, and nine allowed built-ins (compact, code-review, security-review, simplify, init, verify, dataviz, deep-research, claude-api). The list comes from the Agent SDK's `supportedCommands()` and lives in one table in `bridge/src/commands.ts`. Every other built-in stays hidden, so a new CLI built-in never appears by default, and neither does a skill that shares a hidden built-in's name. Reading the list opens a query and sends it nothing, so it costs no turn. The cache belongs to the query it came from and is read again once that query closes. A skill the bot saves shows at once: the menu adds the skills in its home that the open query does not list yet, under the same rule that a built-in owns its name.

A send whose text starts with `/name` for a listed command is a `command` turn. Claude Code expands a command sent as the bare string, or as the last text block of the message's content when that block starts with `/`, so text blocks above it (a name line, context) leave it a command. Text prepended inside that same block makes it plain text (measured on Agent SDK 0.3.302 and Claude Code 2.1.301). A `/word` that is not on the list goes as an ordinary message, so it can never run `/clear` on a bot's long-lived session. `start_agent` takes `slash` the same way, so a bot can hand an agent a skill that only the user may invoke.

## Mentions and exchanges

Typing `@` lists bots, then the bot's connectors with their status, as Grok Bot does. A pick becomes a token, and the send carries `mentions` next to the plain text. The bridge drops a mention of a bot that does not exist, or of a connector that is off or unseen. It keeps the rest on the user message and adds one line per mention to the bot's turn: message this bot with `message_bot` for its part of the request, or use this connector's tools. A handoff starts at hop 0 of the user's chain, so the mentioned bot can still answer. `message_bot` finds a bot by id, name or title.

The bridge keeps the text of every `message_bot` message for each pair of bots, the newest 200, and drops a pair's log when either bot is deleted. Tapping "Messaged X" opens it, like Grok Bot.

## Groups

A group is a chat with the user and 2 to 8 bots. On the wire it is a `Bot` with `kind: "group"` and `members`, so the app lists, renames, pins, mutes and deletes it like a bot. In the bridge it lives in `World.groups`, apart from `world.bots`, and has no Claude Code session, home folder, routines, agents, skills, connectors, commands or uploads. Every path that walks the bots therefore never reaches a group. Its ids start with `g_`, and its older messages archive to `groups/<id>.jsonl`.

A user message goes to the members it mentions, or to every member when it mentions none. Each of those members gets a turn that carries the group's name, its members and the recent transcript. The member's reply posts to the group as a bot message with `from` set to that member. A reply with no text posts nothing. A reply that mentions another member by name hands that member a turn at the next hop, and the shared hop limit of 2 stops the chain. Cards a member opens during a group turn stay in that member's own chat, and the group gets a line saying so. The group shows `working` only while its members run turns for it. Its `activity` line names them ("ana and Bo are typing…"), which the app reads for its typing row.

## The activity line

While a turn runs, the app shows one line per bot or mac agent, such as "Reading hub.ts" or "Running tests". `activity.ts` reads it from `tool_use` blocks only, cuts URLs to their host, drops command-line options with their values, then masks secrets with `text.redact`. It sends at most one line per actor every 1.5 s, sends the trailing line when the window closes, and never sends the same text twice. Every turn end clears it, a deferred one included, and `delete_bot` clears it before `bot_removed`. Tool use between turns sets none. The line is a signal: never stored, replayed or pushed.

## Agents

- **mac.** A Claude Code session in the project folder, on the same session module and behind the same gate and sandbox as a bot, with its cards in its bot's chat. It loads its repo's own Claude Code config only once the repo is trusted (above). Its standing rules (who started it, that nobody is at its terminal and its final message is reported, work on a branch, verify, open a PR) are appended to Claude Code's system prompt, so they hold in every turn; its first turn carries only the task. A cloud agent gets the same rules at the top of its first message. Each turn's final message goes back to the bot as an agent envelope, cut at 8,000 characters (`RELAYED_MAX`, the same cap as a `message_bot` text) at a line or word break with a pointer to the whole report on the agent's card.
- **Evidence.** After each `done` turn the bridge reads git in the agent's folder: branch, head, commits ahead of the default branch (or of the commit its worktree started from), files changed, uncommitted work, and a GitHub PR URL the agent named. Its line goes above the agent's words in the report, and an agent line that imitates it is marked as the agent's. The same facts ride on `Agent.evidence`. The turn's report is saved on the agent's record (`unreported`) before git is read and cleared once it reaches the bot, so a restart while git is read delivers it with fresh evidence instead of telling the bot the agent was cut off. The bridge runs git hardened: hooks, fsmonitor, filter drivers, pagers, the system config and prompts off, `protocol.file.allow=never`, no inherited `GIT_*` variable, refs after `--end-of-options`, and a 10 s timeout. It never runs a test command from the model or the repo.
- **Worktrees.** `start_agent` takes `isolate`: `none`, `worktree` or `auto` (the default: a worktree when the checkout has uncommitted work or another live mac agent works there). A worktree goes in `~/.claudiobot-worktrees/<project>/<agentId>` on branch `claudio/<short id>`, outside every bot home, from the default branch. Repo trust and project config key on the main checkout. Only the user removes one (`remove_worktree`), and never with `--force`: removal is refused while the agent works, when the worktree is dirty, or when it holds ignored files other than build folders, such as an `.env`. The branch stays, and nothing deletes a worktree on its own. Deleting a bot whose agents hold worktrees is refused unless the phone sends `force`; the app's dialog waits up to 3 s for the bot's details, names the worktrees, and then deletes with them left on the Mac.
- **Capped.** An agent the daily cap stopped shows `capped` and resumes on a message tomorrow or a raised cap.
- **cloud.** `claude --cloud <prompt>` run in the project folder under `script(1)`, because it refuses to run without a terminal, with a 90 second limit; a follow-up is `claude -p <text> --cloud <session> --output-format json`. The project needs a GitHub remote. The bridge neither gates nor meters it, and it does not report back. The bot gives you the link.

## What stays from v2

The persona, the exchange and note lines, the library and links views, file reads confined to the bot's home, uploads to `inbox/`, the home-list rules (unread, pinned first, hidden bots kept in search) and the default bot **Claudio Bot** (circle, white) are unchanged. `git log` for this file has the v2 text.
