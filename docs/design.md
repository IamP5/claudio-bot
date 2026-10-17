# ClaudioBot v3 design

`docs/grok-bot-reference.md` describes the product. `bridge/src/protocol.ts` is the wire contract, and it wins any disagreement with this file. `fixtures/protocol.json` pins both sides. `bridge/V3-CONTRACT.md` lists each module's interface and owner. `docs/arena-synthesis.md` explains how this design was chosen over two others.

v2 made the product a set of long-lived bots instead of one-off tasks. v3 keeps that product and makes it safe to leave running. Risky tool calls wait for a tap on the phone, and every shell command runs in the OS sandbox. Routines report honestly and stay quiet when there is nothing to say. Spend has a daily cap. Each phone pairs with its own token. A push reaches you when the app is closed. The bridge runs as a LaunchAgent.

## Where things run

The Mac bridge owns every bot. The phone is a view. A bot keeps working, and its routines fire, while the phone is closed.

```
~/.claudiobot/            a link to ~/.claudebot after migration
  state.json              version 3: bots, conversations, sessions, routines, gate, devices, push (atomic)
  state.v2.json.bak       the exact v2 file, kept by the upgrade
  token                   protocol 2's shared token, accepted for one release as the "legacy" device
  token.revoked           written when that phone is revoked, so the token is never imported again
  USER.md                 what any bot has learned about you; every bot may read and add to it
  usage/YYYY-MM.jsonl     one row per turn result: the ledger (0600, append-only)
  audit/YYYY-MM.jsonl     one row per gated tool call (0600, append-only, secrets redacted)
  bots/<botId>/           a bot's home and the cwd of its Claude Code session
    CLAUDE.md             the bot's job and its own notes
    library/              files it makes for you
    inbox/                files you send from the phone
    .history/             messages moved out of state.json past 1,100: bot.jsonl, <agentId>.jsonl
  agent-config/<agentId>/ the empty projectConfigRoot of an agent whose repo is not trusted (0700)
  trash/<botId>-<ms>/     a deleted bot's home, moved here, never deleted
~/.claudiobot.lock        one bridge per home, beside the home's real path so migration can move it
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
| `text.ts` | the one rule set for names, errors and secrets that leave the bridge | nothing |

`store.ts` loads and saves the file. Loading fails closed: an unknown version, unreadable JSON or a malformed record stops the bridge with a message and writes nothing. A v2 file is upgraded in memory, its exact bytes go to `state.v2.json.bak`, and then v3 is written. `persist("now")` writes synchronously (temp file, `fsync`, rename, directory `fsync`) before an effect that depends on it. Everything else is debounced by 250 ms.

## A turn's life

Everything that reaches a bot is an **envelope**: one user message whose first line says where it came from.

| Source | First line |
| --- | --- |
| you typed | `[Alex]`, then the text and `Attached: inbox/<file>` lines |
| you answered or dismissed a card | `[Alex answered "<question>": <option>]`, `[Alex dismissed "<question>" without answering]` |
| you decided a permission card | `[Alex allowed once: Bash \`git push origin main\`. Run exactly that call again now.]` and the Always, Deny and Never forms |
| a routine fired | `[Routine <name> fired]`, its prompt, then either "reply even if nothing changed" (Run now) or "if there is nothing worth telling Alex, call routine_no_update" |
| an agent reported | `[Agent "<title>" (<agentId>) reports]`, then its final text |
| another bot | `[Message from bot <name>]`, then the text |
| the bot was created | `[You were just created by Alex]` or `[You were just created by bot <name>. Brief:]` |

Each envelope has an **initiator**, a pure function of the envelope: `user`, `routine` (scheduled or Run now), `bot` or `agent` (hops, carrying the origin of the chain), or `system`. A turn is **attended** when it is yours or a Run now. Unattended turns get the policy's stricter column and are held by the daily cap.

1. `hub.deliver` turns the envelope into a `SessionInput` and pushes it to the actor's session. The session writes it to the durable inbox with `persist("now")` before the SDK sees it, so a crash never loses a message. A decision envelope is queued with `kind: "continuation"`: it goes right behind the turn in flight, Stop keeps it, and when its turn is sent the session calls `gate.beginTurn`, which starts the grant's 10 minutes.
2. The session's lifecycle is one value, `idle | working | stopping | backoff | parked`, and `step()` is a pure function over it. Only an idle session starts a turn. It checks the ledger's headroom first. An unattended turn at the daily cap parks until midnight, and a mac agent with no budget left fails the turn.
3. Notices (an expired card, work Stop dropped, a restart mid-turn) go on top of the envelope, so they reach the bot without spending a turn.
4. Every tool call passes the gate (below). Three held or denied calls in one turn stop it, with a note.
5. Each text block becomes chat bubbles, one per paragraph. Text after an `ask` card in the same turn is dropped.
6. The result goes to the ledger as a delta of the SDK's running total. Then the session tells the hub how the envelope ended: `done`, `stopped` (by you or by the breaker), `dropped`, `failed`, or `deferred` (a retry or a park, not an ending). Each envelope that leaves the inbox gets exactly one ending.

A turn with output is never replayed after a crash, because it may have had effects. The bot is told it was cut off instead. A transient API error with no output retries after 1, 3 and 8 seconds. A start counts toward the limit of 4 attempts. A usage-limit rejection parks every session until 30 s after the reset. A model's own weekly limit parks only the session that hit it. A query that cannot open at all (no `claude`, options that throw, a sandbox that cannot start) uses no attempt: the envelope keeps its place, the session retries after 30 s, 1, 2 and then every 5 minutes, and the bot or agent shows `unavailable` meanwhile.

One live query serves an actor's turns. It closes after 15 minutes with no turn and no output, so its process exits, and the next turn resumes on a new one inside the prompt cache's hour. An unattended turn always gets a query of its own whose `maxBudgetUsd` is what is left of the day's cap, and an attended turn never runs on such a query. `Session.reopen` replaces the live query at its next chance when the options change (a repo was trusted), and a query whose sandbox failed is replaced after its turn.

**Stop** moves the turn to `stopping`. The gate then denies every call, the SDK is interrupted, and the interrupt's result ends the turn as stopped. If no result arrives within 15 s, the query is killed. Stop also drops queued unattended envelopes with one notice. Your own queued messages still run.

## The gate

Every bot and mac agent query has one `PreToolUse` hook on every tool. Its body is synchronous and wrapped so that any exception becomes a deny, because a hook that throws lets the call run. The policy checks, in order:

1. **Floors**, always denied: the bridge home except the bot's own folder and `USER.md`, writes to config files the bridge itself loads, SSH, GPG and cloud keys, the Keychain, browser profiles and cookies, stored credentials and tokens (the Claude login among them), and password, payment or 2FA entry (handed back to you). Bash is parsed by a real shell tokenizer, and paths are resolved through symlinks and their ancestors before they are matched.
2. **Initiator bans**: no routine changes in a routine-started chain, and no `message_bot` or `create_bot` at 2 or more bot hops.
3. **Limits**: budget or daily cap, and per-bot daily caps on `create_bot` (5) and `start_agent` (20).
4. **Never** rules, then a one-shot **grant** for this exact call, then **Always** rules (an Always given in an attended turn covers attended turns only).
5. **The table** of risky commands by attended or unattended: pushing to the default branch, force-pushing, merging a PR, publishing, deploying, setting secrets, sending data to a web service, deleting outside the bot's folder, changing a config file that controls how it runs, running a command built at runtime, and others. Unattended turns also hold pushes to any branch, writes outside the bot's folder, connector writes, `create_bot`, `start_agent` and routine changes.
6. **Pass**: no opinion, so Claude Code's auto classifier decides as it would without the bridge.

A Bash call that adds hosts to the sandbox's network allowlist (the tool's `allowed_domains`) carries them as a part of its own, so on unattended turns the table holds it with the hosts on the card, and the hosts are part of the call's fingerprint.

An "ask" opens a **permission card** and denies the call with a "held for approval" reason. That is the deny-and-regrant mechanism. Allow once installs a grant for that exact input for 10 minutes and delivers a decision envelope that runs ahead of other queued work, so the model re-issues the call and the grant lets it through. Only a turn of the card's attendance can use the grant, and that binding is saved with it. The card shows the rule in words, the exact call with secrets masked, and what Always would cover. Only a card tap from a paired device approves. Chat text never does. A permission card expires after 2 hours and a question card after 24, each with one reminder at half its life. An expired card leaves a notice that says the call did not run and that the user did not say no.

A transition that opens a card, consumes a grant or adds a rule saves synchronously before the audit row is written and before the hook returns. A repeated hook call for the same `tool_use_id` gets the recorded verdict and opens no second card.

A **trust card** is a permission card on the wire that holds nobody up. A mac agent loads project configuration from an empty folder the bridge owns (`projectConfigRoot`), so a repo's committed `.claude` settings and hooks, `.mcp.json`, commands, agents and skills never run. When the repo has any, the gate posts "Trust <repo>'s Claude settings" once per repo. Allow once records the repo as trusted for that agent, Always for every agent in it (`GateState.repos`), Deny and Never the opposite; the newest answer for a repo wins, and an expired card decides nothing. A trusted repo's live agents reopen their queries, and the next one loads the repo's own config.

## The sandbox

The gate reads command lines. Under it, every Bash call of a bot or a mac agent runs in Claude Code's Seatbelt sandbox, built by `sandbox.ts` with `failIfUnavailable` and no unsandboxed commands, and with the classifier still on. A bot writes only its home and `USER.md`. A mac agent writes its project, the git dirs a commit needs (never their hooks or config), the per-user temp and cache dirs and the build caches. Both are denied the bridge home and the private paths in `private.ts`, the same list the gate's floors refuse, and the bridge's own `CLAUDIOBOT_*` variables. Sandboxed commands reach GitHub, npm, Yarn, PyPI and crates.io; another host takes a re-run with `allowed_domains`, which the classifier reviews and, on unattended turns, the gate holds. Claude Code's sandbox breaks git over ssh, so agents get `GIT_CONFIG_*` that rewrite GitHub ssh remotes to https, and they may read the Keychain for git's credential helper. File tools, web fetches and MCP tools are outside the sandbox: the gate covers those. A sandbox that cannot start is never worked around: commands fail, the bot's chat says so once, and a query that cannot start waits and retries.

## Routines

A routine is a prompt on a five-field cron in the Mac's local time. A routine may run at most every 15 minutes, and a bot may have at most 20.

- `nextRunAt` is stored. It advances, and the running run is recorded, in one synchronous save before the fire is delivered. A crash can lose a fire but never repeat one.
- Missed times collapse into one decision. The newest missed time fires once, marked late, if it is inside the grace window (half the period, between 2 minutes and 2 hours). Otherwise one skipped run is recorded.
- A fire is recorded skipped while the bot is held by a limit, or while its previous run is still queued.
- A scheduled run holds its bubbles until the turn ends. If the bot called `routine_no_update` and asked nothing, the bubbles are dropped, nothing is pushed, and the run settles **quiet**. Otherwise the bubbles post together with one push. Bubbles written before a card the turn opens, or before the breaker's note, go out at once, ahead of it, and a run that opened a permission card is never quiet.
- Run now is attended, never quiet, runs at the daily cap, and its failures never count toward fatigue. Ten failed runs in a row turn a routine off with a note.
- A v2 routine that runs more often than every 15 minutes is turned off with a note at the first tick after the upgrade. Editing its schedule turns it back on.

## Usage

The ledger appends one row per turn result to `usage/YYYY-MM.jsonl`. A row holds the SDK's cumulative cost, the delta charged against that session's previous row, the initiator and the local day. Each bot has a daily cap (`CLAUDIOBOT_DAILY_USD`, default $10, or the bot's own `dailyCapUsd` from the phone) that counts its agents too. Each mac agent has a lifetime budget (`CLAUDIOBOT_AGENT_USD`, default $5). A mac agent's query gets what is left of that budget as `maxBudgetUsd`, and a query opened for an unattended turn gets at most what is left of the day, so the SDK stops a runaway turn mid-way. Attended turns are never held by the daily cap; it is checked before each unattended turn. A routine run the cap cuts short settles `skipped`, not `failed`, and the bot says it used today's budget. Raising a bot's cap from the phone lifts a cap park at once.

## Transport

- **Pairing.** The bridge prints a one-time code (`XXXX-XXXX`, valid for 10 minutes, 5 tries) and a QR code of `claudiobot://pair?url=…&code=…`. The app posts `{code, name}` to `/pair` and gets its own token, which the bridge stores only as a sha256. The socket then authenticates with `Authorization: Bearer <token>`. A paired phone can show a code for another phone. After 10 failed pairings from one address in 10 minutes, `/pair` answers 429.
- **Revoking** a phone closes its sockets with code 4001. Protocol 2's shared token is imported once as the "legacy" device. Revoking it writes `token.revoked`, so it never comes back.
- **The stream.** Every broadcast carries a `seq`, and each bridge start has a new `epoch`. A reconnecting app passes both, and the bridge replays what it missed from a bounded ring. When the ring no longer holds the missed frames, the app gets a fresh hello instead. Frames may be up to 32 MB, because uploads ride inline.
- **Protocol 2 apps.** The app announces `?protocol=3`. A socket that does not gets every permission card as a question card with the options "Allow once" and "Deny", and its answer is read as that decision, so an old build can still approve a call once.

## Push

When no socket is live, `push.ts` posts to `CLAUDIOBOT_PUSH_URL` (an ntfy topic) when a card opens or reminds, or when a turn posts its first bubble. The text is the bot's name and a fixed phrase. No message content leaves the Mac. The click link is `claudiobot://bot/<id>?message=<id>`. Each push key (`<messageId>|<reason>`) is recorded and saved before the send, so a crash never sends twice. A failed send, a 429 included, is logged and never retried. Message pushes are throttled to one per bot per 10 minutes.

## Migration

The project was renamed from claudebot to claudiobot. At start, before anything opens the home, `migrate.ts` reconciles the two homes. When only `~/.claudebot` exists, it links `~/.claudiobot` to it, which keeps every bot's Claude Code session resumable. When the new home holds only what a first run leaves, it moves that home aside and links. When both hold bots, it changes nothing, uses `~/.claudiobot`, and says how to switch. A set `CLAUDIOBOT_HOME` skips all of this. The old `CLAUDEBOT_HOME` is ignored with a warning.

## Bot tools

The in-process MCP server `claudio` gives each bot `ask`, `start_agent`, `message_agent`, `list_projects`, `message_bot`, `create_bot`, `update_self`, `set_routine`, `delete_routine` and `routine_no_update`. Bot names are 1 to 40 characters with no control, format or bidi characters (`text.ts`, which also cleans device names and push titles the same way). The gate covers these tools too, so a routine cannot change routines, and a bot-to-bot chain stops at two hops.

## Agents

- **mac.** A Claude Code session in the project folder, on the same session module and behind the same gate and sandbox as a bot, with its cards in its bot's chat. It loads its repo's own Claude Code config only once the repo is trusted (above). Each turn's final message goes back to the bot as an agent envelope.
- **cloud.** `claude --cloud <prompt>` run in the project folder under `script(1)`, because it refuses to run without a terminal, with a 90 second limit; a follow-up is `claude -p <text> --cloud <session> --output-format json`. The project needs a GitHub remote. The bridge neither gates nor meters it, and it does not report back. The bot gives you the link.

## What stays from v2

The persona, the exchange and note lines, the library and links views, file reads confined to the bot's home, uploads to `inbox/`, the home-list rules (unread, pinned first, hidden bots kept in search) and the default bot **Claudio Bot** (circle, white) are unchanged. `git log` for this file has the v2 text.
