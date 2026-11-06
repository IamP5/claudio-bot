# Grounding: ClaudioBot across two machines (macOS + Linux/Omarchy)

Repo: /Users/tuba/Dev/projects/claudio-bot. All paths below are relative to it; `src/` = `bridge/src/`.
Problem: each bridge keeps the whole world in its own `~/.claudiobot`; the iPhone holds exactly one pairing, so
switching bridges = a different, empty world. Goal: same bots on both, and choose the machine per session/agent.

---------------------------------------------------------------------------------------------------------------------
## 1. State inventory

Bridge home = `process.env.CLAUDIOBOT_HOME ?? ~/.claudiobot` (src/store.ts:26). On this Mac `~/.claudiobot -> .claudebot`
(symlink made by src/migrate.ts). Layout documented at docs/design.md:14-33; observed on disk:
`USER.md agent-config/ audit/ bots/ cache/ run/ state.json state.v2.json.bak token.revoked usage/`.

Legend: P = portable (pure bot data), M = machine-bound (local paths / processes / local Claude Code files), X = mixed.

### 1a. state.json (one file, whole World, version 3)
- Writer: src/store.ts `createSaver` (debounced 250 ms, store.ts:419-450), `flushNow` (store.ts:408), atomic temp+fsync+rename
  (store.ts:223-251). Loader fails closed on unknown version/shape (store.ts:374-405, 307-323). Schema = zod V3_FILE
  (store.ts:132-174); file type StateFileV3 (store.ts:37-53). In-memory `World` (src/world.ts:467-478).
- Every persisted shape is declared in src/world.ts; each slice has a single writer module (docs/design.md:37-60 table).

| Slice | Type (world.ts) | Writer | P/M | Why |
|---|---|---|---|---|
| `bots[]` profile: id,name,title,avatar,pinned,hidden,createdAt,unread,muted,dailyCapUsd | ChatRecord/BotRecord :322-345 | hub.ts | P | pure data |
| `bots[].messages` (chat, cards, questions) | Message[] | hub.say | P* | card answers tie to live gate state (below) |
| `bots[].session` = SessionState {id, pending[], lifecycle, notices, sent, background} | :188-206 | session.ts | **M** | `id` is a Claude Code session id whose transcript lives in `~/.claude/projects/<encoded cwd>/<id>.jsonl` on ONE machine; `pending` is the durable inbox; `lifecycle` working/backoff/parked is per-process |
| `bots[].routines[]` {trigger cron/webhook(tokenHash), nextRunAt, runs[], failStreak} | :216-231 | scheduler.ts (only writer, scheduler.ts:7) | P data / M firing | two schedulers on one routine = double fire |
| `bots[].rules[]` standing allow/deny by signature | :244 | gate.ts | P | signatures, but some may embed local paths |
| `bots[].connectorsOff[]` MCP server names | :339 | connectors.ts | X | names refer to MCP servers configured per machine (~/.claude.json, plugins) |
| `groups[]` {members} | :353 | hub | P | |
| `agents[]` AgentRecord {agent{where:"mac"\|"cloud", worktree{path,branch}, projectName, status}, cwd, repo, base, messages, session, cloudSession, budgetUsd, startedBy, unreported, directed} | :355-382 | agents.ts / session.ts | **M** for where=mac (cwd, repo realpath, worktree path, session jsonl, live child process); cloud agents ~P (claude.ai session id, but follow-up runs `claude` CLI locally) |
| `gate` {open cards, grants, daily counts, repos (RepoTrust{root path}), aliveAt} | :253-299 | gate.ts | X | open permission cards wait on a live query in this process; `repos[].root` is a local realpath |
| `devices[]` {id,name,tokenHash,createdAt,lastSeenAt,legacy} | :303-312 | devices.ts | per-bridge identity | phone token is minted per bridge |
| `push.sent[]` dedupe keys | :318 | push.ts | P-ish | dedupe would need to be shared or double-push |
| `account.parkedUntil` | :208 | session.ts | X | plan usage limit is per Anthropic account (shared), but read per machine |
| `exchanges[]` bot↔bot logs | :391 | world.ts | P | |
| `sessions[]` SessionRecord {id, hidden, visitedAt, mirror, own: OwnDrive{cwd,...,session,cards}} | :397-430 | sessions.ts / own.ts | **M** | overlay on local Claude Code transcripts; `own.cwd` local |
| `sessionPrefs.mirror` | :465 | sessions.ts | M | about mirroring into this Mac's Claude desktop app |

### 1b. Files beside state.json
| Path | Owner | Format | P/M |
|---|---|---|---|
| `bots/<botId>/CLAUDE.md` (job + `## Notes`) | memory.ts:270, home.ts:85-89 | markdown | P |
| `bots/<botId>/.claude/skills/<name>/SKILL.md` | skills.ts:1-10 | markdown | P |
| `bots/<botId>/library/`, `inbox/`, `work/` (BOT_WRITABLE, sandbox.ts:30) | home.ts | files | library/inbox P; `work/` scratch (clones) semi-M |
| `bots/<botId>/.history/bot.jsonl`, `<agentId>.jsonl` (archived messages past 1,100) | hub.ts:293 `archiveOf`, store.ts:258 `appendArchive` | jsonl append | P |
| `bots/<botId>/.claude/.cc-writes` | Claude Code itself | empty dir | ignore |
| `USER.md` (`## Facts` shared by all bots) | memory.ts, home.ts:25,79 | markdown | P |
| `groups/<groupId>.jsonl` (group archive) | hub.ts:351 | jsonl | P |
| `usage/YYYY-MM.jsonl` UsageRow{actor, botId, sessionId, cumulativeUsd, initiator...} | ledger.ts:1-30, 99, 214; dir from hub.ts:223 | append-only 0600 | P data; cumulative cost baseline keyed by sessionId (ledger.ts:108), so rows from two machines merge OK if sessionIds differ |
| `audit/YYYY-MM.jsonl` gate decisions | gate.ts:38, 318; hub.ts:750 | append-only | P (log) |
| `agent-config/<agentId>/` empty projectConfigRoot for untrusted repos | home.ts:60-74 | dir | M |
| `cache/sessions-index.json` (transcript heads), `cache/projects.json` (cwd→project) | sessions.ts:106,121-127,161; main.ts:138 | JSON cache "never state" (design.md:29) | M (regenerable) |
| `run/control.sock` same-user pairing socket for the Mac app | control.ts:19-32 | unix socket | M |
| `token`, `token.revoked` (protocol-2 legacy shared token) | legacy.ts:16-33 | text | per-bridge |
| `trash/<botId>-<ms>/` deleted bot homes | home.ts:132-137 | dirs | P |
| `state.v2.json.bak`, `state.v1.json.bak` | store.ts:273-279 | backup | ignore |
| `~/.claudiobot.lock` (beside realpath of home) | lock.ts:66-71 | "<pid>\n<start UTC>\n" | M |

### 1c. Outside the bridge home (machine-bound by nature)
- Claude Code transcripts: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<encoded cwd>/<sessionId>.jsonl` (main.ts:133, hub.ts:231,
  sessions.ts:516). The bot's cwd is `~/.claudiobot/bots/<id>` (hub.ts:626) so the encoded folder contains the absolute
  home path: `/Users/tuba/...` on mac vs `/home/tuba/...` on Linux -> different folder even with identical bot ids.
- Claude Code live-session registry `~/.claude/sessions/*.json` and Claude desktop store
  `~/Library/Application Support/Claude/claude-code-sessions` (claudeApps.ts:279-283) - mac-only for the latter.
- Agent worktrees `<project>/.claude/worktrees/claudio-<8>` on branch `claudio/<8>` (worktree.ts:7-25); older `~/.claudiobot-worktrees`.
- LaunchAgent plist `~/Library/LaunchAgents/com.claudiobot.bridge.plist`, logs `~/Library/Logs/ClaudioBot` (service.ts:8,27,33).
- iOS: one pairing in the Keychain (see §3). The app keeps no offline copy of bots; everything comes from `hello`.

Migration precedent: decisions.tsv row 33 - moving `~/.claudebot`->`~/.claudiobot` was done with a symlink because
"resume finds a transcript by session id through a symlinked or renamed cwd". A cross-machine move changes the real cwd
AND the machine, so the transcript simply is not there.

---------------------------------------------------------------------------------------------------------------------
## 2. Process / runtime model

### Boot (src/main.ts)
1. `bridgeHome()` -> `holdLock(home)` (main.ts:74-75, 46-58) - exits if another bridge holds the home.
2. `migrateHome` (main.ts:76-92), `loadWorld(home)` (main.ts:99), `createSaver` (main.ts:100).
3. `createDevices`, `legacyToken.reconcile`, `createPush` (ntfy POST to CLAUDIOBOT_PUSH_URL, push.ts:58-80), `createHub`
   with `machine` = `scutil --get ComputerName` || hostname (main.ts:41), userName via `id -F` || $USER (main.ts:44).
4. `serve(...)` on port 7878 (main.ts:96,141), `serveControl` unix socket (main.ts:143).
5. `hub.boot(firstRun)` (hub.ts:1265-1286): gate.resume, ensure USER.md, first run creates default bot, wakes every bot
   with pending/non-idle session, `agents.resume()`, `sessions.resume()`, `webhooks.start()`, sessions index start.
   `hub.startTicker()` -> one clock driving scheduler, gate, push, usage ticks (hub.ts:200-207).

### Bot turn
- One `Session` per bot ("brain", hub.ts:604-650) from src/session.ts `createSession` (session.ts:790). Uses Agent SDK
  `query` with options: `cwd: homes.homeOf(bot.id)`, `resume: bot.session.id`, `settingSources: ["user","project"]`,
  `permissionMode: "auto"`, MCP `claudio` tool server, `hooks: gate.hooks`, `canUseTool: gate.canUseTool`,
  `sandbox: sandboxFor(...)`, `settings: settingsFor(bot.id)` (hub.ts:622-641).
- Durable inbox `session.pending[]` survives restarts; lifecycle idle/working/stopping/backoff/parked (world.ts:107-206).
- Fresh session: bridge picks the id via `Options.sessionId` (session.ts:1045-1092). Resume of a transcript that is gone
  -> "No conversation found with session ID" (session.ts:105-106) -> default `forgotten: "restart"` (session.ts:697-701):
  new session, bot told "[Your earlier conversation history is gone...]" (session.ts:103-104). So a bot moved to another
  machine degrades gracefully (loses Claude Code context, keeps chat/CLAUDE.md/USER.md), it does not crash.
- Context per turn: `memory.context(bot.id)` (USER.md facts) + standing brief; persona says "You work for X on their Mac"
  (prompts.ts:206).
- Cost: ledger.add per result keyed by session id (session.ts:1240); daily caps (ledger.ts:13-14,162-163).

### Agents (src/agents.ts)
- `start(botId, {project, where: "mac"|"cloud", isolate, slash, ...})` (agents.ts:28-41). Tool `start_agent` exposes
  `where: z.enum(["mac","cloud"]).default("mac")` (tools.ts:74-81). **`where` is already a placement axis**, literally
  named "mac".
- Projects = git folders directly under `CLAUDIOBOT_ROOTS` or `~/Dev/projects, ~/code, ~/Developer, ~/Projects`
  (projects.ts:9-12, 38-55); Project = {name, path, branch, githubRepo} (projects.ts:7). `findProject` by path/name/GitHub
  repo (projects.ts:57+) - githubRepo is the only machine-independent project identity.
- mac agents: `prepareWorkspace` (worktree.ts:44+) -> cwd = project or worktree; repo trust card if repo has config
  (agents.ts:367-371); query with `settingSources ["user","project"]`, `projectConfigRoot` (agents.ts:277-279); session id
  `crypto.randomUUID()` (agents.ts:358); reports go back to the bot via `unreported` (world.ts:375-379).
- cloud agents: `claude --cloud <prompt>` run locally under `script -q /dev/null` for a pty (cloud.ts:52-57) and
  follow-ups `claude -p ... --cloud <id>` (cloud.ts:59-62). No gate, no meter, no completion signal (decisions.tsv rows 5,6,19).
  NB: `script -q /dev/null cmd...` is BSD syntax; util-linux needs `script -qc "cmd" /dev/null` -> **cloud agents break on Linux**.

### Scheduler / routines (src/scheduler.ts, cron.ts, clock.ts, webhook.ts)
- Only writer of `BotRecord.routines` (scheduler.ts:7). At-most-once: nextRunAt advanced + run recorded in one
  `persist("now")` before the fire (scheduler.ts:9-11). Missed fires while the Mac slept -> one late fire in a grace window.
- Webhook routines: loopback-only listener `127.0.0.1:7879/hook/<id>` with bearer token, sha256 stored (webhook.ts:6-12;
  docs/design.md:144). Only a program on that machine can fire it.
- Two bridges loading the same routines would each fire them: at-most-once relies on one process + one state.json.

### Gate / approvals (src/gate.ts, policy.ts)
- PreToolUse hook + canUseTool; cards (question/permission/trust) posted into the bot chat; grants, standing rules, daily
  counts, repo trust (world.ts:253-299). A held tool call is a promise inside the live query of this process; cards expire
  (gate.ts:117-126, 523+). `gate.resume(now)` at boot reconciles (hub.ts:1266). A card answered on bridge B cannot unblock
  a query running on bridge A.
- Policy scope uses `os.homedir()`, `userInfo().username`, root home `/var/root` vs `/root` by `process.platform`
  (hub.ts:430-437, 815-821).

### Push
- ntfy-style POST while no socket heard in 45 s; dedupe keys recorded before send (push.ts:7-25). Two bridges each
  pushing for the same bot = duplicates unless one owns pushes.

### "One bridge = the whole world" assumptions
- One home, one lock, one state.json, single in-process writer per slice (design.md:37).
- `hello` carries `machine` (single string) and the full bot list (protocol.ts:552); app treats a new URL as a new world.
- Agent `where: "mac"` means "this bridge's machine"; projects are scanned from local roots only.
- Sessions tab = this machine's `~/.claude/projects` transcripts only.
- Prompts/notices say "the Mac" (prompts.ts:16,161,206).

---------------------------------------------------------------------------------------------------------------------
## 3. Pairing and identity

### Bridge side
- src/devices.ts: only writer of `World.devices`; live pair code memory-only, TTL 10 min, 5 attempts (devices.ts:7-12).
  Token = 32 random bytes, stored as sha256 (devices.ts:8). `authenticate(req)` reads `Authorization: Bearer` (devices.ts:34-38).
- src/serve.ts: `/health` (returns HMAC proof for `?device&nonce`, serve.ts:231-233), `POST /pair` (serve.ts:195-216,235),
  `/ws` upgrade with `?protocol=3` and resume cursor (serve.ts:236-245), first frame `hub.hello(...)` (serve.ts:261).
  `pair_code` from a paired phone mints another code (serve.ts:171-175). `presence {attended}` for the Mac app.
- src/address.ts: URLs offered = tailnet DNS name (`tailscale status --json`), Bonjour `scutil --get LocalHostName`.local,
  LAN IPv4s; `ws://host:7878/ws` (address.ts:5-27, 52-57). Link `claudiobot://pair?url=..&url=..&code=..` (address.ts:29-31).
- src/control.ts: `<home>/run/control.sock` lets the local Mac app mint a code (control.ts:7-32).
- src/access.ts: `CLAUDIOBOT_ACCESS=guarded|full`, `CLAUDIOBOT_SANDBOX=on|off` (access.ts:7-24) - not pairing, but per-bridge.
- **What identifies a bridge:** nothing durable. No bridge id/uuid. The app identifies it by URL + the device token it
  holds (proof via `/health` HMAC). `hello.machine` is a display name only.

### App side (ios/)
- `Pairing {url, credential: .device(id, token) | .legacy(token)}` (ios/ClaudioBot/Model/Pairing.swift:215-224), Codable as
  `{url, token, deviceId}` (Pairing.swift:356-390).
- `PairingVault`: Keychain generic password, service `dev.claudiobot.app.pairing`, **fixed account `"bridge"`**
  (Pairing.swift:393-405) -> exactly ONE pairing stored. `load/save/clear` (Pairing.swift:435-459).
- `BridgeClient.pair(invite)`: redeem -> greet (wait for hello) -> `vault.save` -> `start` (BridgeClient.swift:174-179).
  `start(pairing)`: if URL differs from current, `store.setConnection(.unpaired)`, clears outbox and stream cursor,
  `onForget()` - "Another bridge starts from an empty store, so nothing from the old Mac lingers" (BridgeClient.swift:147-158).
- `changeAddress(to:)` moves the same pairing to another address of the same bridge after HMAC proof (BridgeClient.swift:184-197).
- `unpair()` revokes then `forget` clears vault (BridgeClient.swift:200-209, 248-257).
- App launch: `PairingVault.app.load()` -> `client.start` (ios/ClaudioBot/App/ClaudioBotApp.swift:150-152).
- Store: `connection = .connected(machine: hello.machine)` (ios/ClaudioBot/Model/Store.swift:8,173,269).
- Mac app: `BridgePlace { thisMac, otherMac }` derived from loopback URL, never stored (ios/ClaudioBotMac/LocalBridge.swift:233-240);
  Settings > Bridge "switches between this Mac and another Mac through BridgeClient.pair" (docs/macos-design.md:76).
  "several bridges at once" explicitly **Deferred** (docs/macos-design.md:95).
- **How the user switches today:** re-pair with a code from the other bridge (Settings, Pair / QR / deep link). That
  replaces the single Keychain entry; the old bridge's token is forgotten on the phone (not revoked), and switching back
  requires pairing again.

---------------------------------------------------------------------------------------------------------------------
## 4. Protocol surface (src/protocol.ts 660 lines, PROTOCOL = 3 at :8)
- Features list for additive changes (protocol.ts:18-26): memory, activity, mute, worktrees, connectors, skills,
  webhooks, spend, mentions, commands, exchanges, groups, usage, sessions, presence. Add new capability here, not a bump.
- Server messages: hello {protocol, features, machine, userName, bots} + StreamPosition (protocol.ts:552), bot, bot_removed,
  created, conversation, message, details, agent, file, devices, activity, memory, connectors, skills, commands, exchange,
  webhook_token, usage, error, pair_code (PairOffer {code, expiresAt, urls} :655), sessions/session_rows/session_items/
  session_delta/session_page/session_created/session_tool_output/session_removed.
- Client messages: create_bot, open, send, answer, dismiss, decide, stop, stop_agent, update_bot, mark_unread, delete_bot,
  set_routine, run_routine, details, agent, file, memory, set_fact, forget_fact, confirm_fact, connectors, set_connector,
  skills, delete_skill, commands, exchange, create_group, webhook_token, remove_worktree, refresh_usage, devices,
  revoke_device, pair_code, presence, watch_sessions/unwatch_sessions/watch_session/unwatch_session/session_page/
  session_send/session_stop/session_decide/session_answer/session_create/session_set/session_open_desktop/session_tool/session_prefs.
- PairResponse {deviceId, token} (protocol.ts:660).
- Machine/host-naming fields: `hello.machine` (string); `Agent.where: "mac"|"cloud"` + `projectName` (protocol.ts:208-213);
  `Worktree {path, branch}`; session rows carry cwd/project context; `session_open_desktop` (opens in this Mac's Claude app).
  No field names a bridge id or lets one bridge reference another.
- src/protocol2.ts (54 lines): downgrade shim for protocol-2 apps (permission cards as questions, no session frames).
- iOS mirror: ios/ClaudioBot/Model/Protocol.swift (Hello :1050-1059, decode :1921, PairRequest/PairResponse :2635-2640).

---------------------------------------------------------------------------------------------------------------------
## 5. Machine-specific capabilities (platform audit)

Computer use / Chrome: the bridge has **no built-in computer-use or Chrome integration**. They arrive only as MCP
servers from the user's own Claude Code config (`settingSources: ["user", ...]`), surfaced as "connectors"
(connectors.ts:1-20 mentions `chrome-devtools`, `plugin:vercel:vercel`). So availability = whatever `~/.claude.json` /
plugins / claude.ai connectors exist on that machine. `connectorsOff` stores names that may not exist on the other machine.

| Area | File:line | macOS-only? | Linux behavior |
|---|---|---|---|
| Machine name | main.ts:41 `scutil --get ComputerName` | falls back | hostname() - OK |
| User first name | main.ts:44 `id -F` | falls back | $USER - OK |
| Bonjour name | address.ts:55 `scutil --get LocalHostName` | yes | none; tailnet + LAN still work |
| Tailscale path | address.ts:13,48 `/Applications/Tailscale.app`, `/opt/homebrew/bin` | partly | `Bun.which("tailscale")` on PATH works |
| Service install | service.ts:8-33,125-160 launchd/LaunchAgents; cli.ts:25-28 | **yes** | no systemd unit; run `bun src/main.ts` by hand |
| Doctor | doctor.ts:188,192,236 | **yes** | fails "the service needs macOS" |
| Sandbox | sandbox.ts:86-147 (Seatbelt via Claude Code `sandbox` option, `failIfUnavailable: true`) | mac-tuned | Claude Code uses bubblewrap on Linux; if missing, every Bash call errors (sandbox.ts:175-187). `userTempDirs` /var/folders (sandbox.ts:158-162), `onDisk` /private (sandbox.ts:151), `PUSH_READABLE` Library/Keychains (sandbox.ts:20), CACHES Library/Caches, Xcode (sandbox.ts:23) |
| Git creds in sandbox | sandbox.ts:56-84 AGENT_GIT_ENV, osxkeychain helper | yes | needs a Linux credential path |
| Private paths floor | private.ts:4-82 | **mac-heavy** | browser profiles only under `Library/Application Support/...` (private.ts:7-17); no `~/.config/google-chrome`, `~/.mozilla`, keyrings -> weaker floors on Linux |
| Policy root home | hub.ts:432,816 | handled | `/root` on Linux |
| Managed MCP path | claudeCode.ts:23 `/Library/Application Support/ClaudeCode/managed-mcp.json` | yes | Linux path is `/etc/claude-code/managed-mcp.json` - not checked |
| Claude desktop app | claudeApps.ts:156,176,182,282 (`open -g claude://`, `open -b`, `ioreg` HIDIdleTime, ~/Library store) | **yes** | desktop() empty, mirror/open_in_desktop useless; idleSeconds null |
| Cloud agents | cloud.ts:54 `script -q /dev/null <cmd>` | **BSD script** | breaks with util-linux script |
| Lock | lock.ts:49-55 `ps -o lstart=` | portable | procps supports lstart - OK |
| Webhooks | webhook.ts:6 | portable | per machine loopback |
| Mac app (ios/ClaudioBotMac) | LocalBridge.swift | n/a | Linux bridge is always "otherMac" |
| README | README.md:326 | - | "macOS only. The bridge has only been run on macOS. Linux should be close." |

---------------------------------------------------------------------------------------------------------------------
## 6. Concurrency / single-writer assumptions
- src/lock.ts: "One bridge per home" (lock.ts:5). Hard-link create of `<realpath(home)>.lock`, body pid + start time UTC,
  stale detection via `ps` and boot time (lock.ts:38-80+). Works only on a local filesystem; a home on a network share or
  a synced folder (Syncthing/iCloud) would NOT exclude a bridge on the other machine (different pid namespace, lock file
  would itself sync).
- Single writer per state slice inside one process (world.ts:35-36, design.md:37 "Each module is the only writer of its
  slice"); `Owned<T>` readonly types enforce it at compile time (world.ts:94).
- Whole-file rewrite of state.json every 250 ms of activity (store.ts:445-448); no merge, no per-record version, no
  vector clock. Two bridges writing the same state.json through a file sync = last-writer-wins on the whole world.
- At-most-once effects keyed on `persist("now")` before the effect: scheduler fires (scheduler.ts:9-11), push dedupe
  (push.ts:13-15), devices pairing (devices.ts:29-31). All assume a single process.
- Append-only jsonl (usage, audit, .history, groups) dedupe by id on read (store.ts:253-257) - the friendliest to merge.
- A session id can be held by another live Claude Code (claudeApps.ts holders; session.ts:705 "another live Claude Code is
  busy on the session") - local process view only.

---------------------------------------------------------------------------------------------------------------------
## 7. Existing hints in docs / decisions
- docs/macos-design.md:76 switching = re-pair via `BridgeClient.pair`; :95 "several bridges at once" deferred.
- docs/design.md:31 + bridge/README.md:24 + README.md:219 - one bridge per home, lock beside real path.
- decisions.tsv row 33 - home move via symlink because resume follows the session id through a symlinked cwd.
- decisions.tsv rows 5,6,19 - cloud agents via `claude --cloud` in a pty; fire-and-follow.
- decisions.tsv row 29 - v3 chose "deep modules on state.json" (candidate B) over an event journal (A); the journal was
  rejected for cost ("every event shape foldable forever"). Relevant: sync would favor a journal/CRDT-ish log.
- decisions.tsv row 65 - pairing link repeats url= per address (tailnet, .local, LAN), app keeps the first that answers.
- decisions.tsv row 72 - address change proves the bridge via `/health` HMAC before sending the token.
- src/hub.ts is the 1,301-line wiring hub (createHub hub.ts:209); src/world.ts the 798-line schema+pure rules. No
  existing code for sync, replication, peers, or a bridge id. grep for multi-machine/sync/replica in docs: nothing else.
- Agent.where = "mac" | "cloud" is the one existing placement concept; the natural extension point for "which machine".

---------------------------------------------------------------------------------------------------------------------
## Constraints any design must respect
1. **Claude Code transcripts are local** (`~/.claude/projects/<encoded abs cwd>/<id>.jsonl`). A bot's or agent's
   conversation context can only resume on the machine that has that file at that encoded cwd. Copying jsonl across
   requires identical cwd encoding (home path differs: /Users/tuba vs /home/tuba) or path rewriting. Otherwise the
   bridge's "forgotten -> restart" path (session.ts:697) kicks in: chat kept, Claude context lost.
2. **Live work is process-bound**: running queries, held tool calls (gate cards), background tasks, child pids,
   worktrees and repo realpaths all belong to one machine. A turn/agent must have a single owning machine at a time.
3. **At-most-once effects need one owner**: routine fires, push sends, pairing codes, webhook listeners. If two bridges
   share a bot, exactly one must own its scheduler/push (or a shared lease/claim).
4. **state.json is whole-file, last-writer-wins, fail-closed on unknown shapes**. Naive file sync (Syncthing/iCloud/
   Dropbox) of `~/.claudiobot` with both bridges running will clobber; the lock does not protect across machines.
   Also both bridges must run the same STATE_VERSION or the older one refuses to start (store.ts:320-321).
5. **Single-writer-per-slice discipline** (world.ts/Owned<T>) must be kept; any sync layer should sit at slice/record
   granularity, not raw file copy. Append-only jsonl stores (usage, audit, .history) merge cleanly by id.
6. **Portable core vs local edge**: portable = bot profile, messages, CLAUDE.md, skills, library, inbox, USER.md facts,
   routines definitions, rules, exchanges, groups, usage/audit logs. Local = sessions, agents(mac), gate open cards,
   repo trust roots, worktrees, connectors availability, devices/tokens, cache/, lock, control.sock.
7. **Pairing has no bridge identity**: app stores one `{url, token, deviceId}` under Keychain account "bridge"; switching
   URL wipes the store. Multi-bridge requires a bridge id in hello/PairResponse and a keyed vault (or a hub bridge that
   fronts the others). Device tokens are per bridge; a shared token would need shared `devices` state.
8. **Protocol evolves additively via FEATURES** (protocol.ts:18-26); new fields (e.g. `machines`, `Agent.machine`) should
   be gated by a feature so older apps/bridges keep working. `Agent.where` currently "mac"|"cloud" in both bridge zod
   (store.ts:96, tools.ts:81) and Swift - widening it is a protocol change.
9. **Projects are local paths**: resolve a project across machines by `githubRepo` (projects.ts:7,14-17) or name, not path.
   Project roots differ per machine (`CLAUDIOBOT_ROOTS`).
10. **Linux gaps to close before it is a peer**: cloud.ts `script` syntax, launchd-only service/doctor, Seatbelt-specific
    sandbox paths and bubblewrap dependency, mac-only private-path list (browser profiles), managed-mcp path, Claude
    desktop integration (claudeApps) no-op, prompts saying "Mac".
11. **Security posture**: tokens only as sha256, bridge home unreadable to bots/agents (sandbox denyRead bridgeHome,
    sandbox.ts:101), webhook loopback only, `/health` HMAC proof before sending a token. Any sync channel carries
    state.json (device token hashes, webhook token hashes, chat content) and must be at least as private (0600/0700,
    tailnet-only), and must not let one machine's bot read the other's bridge home through a synced folder inside a
    sandbox-writable path.
12. **Account-level limits are shared**: both bridges use the same Anthropic login; `account.parkedUntil` and daily caps
    (ledger) are per-bridge today, so caps would double unless the ledger is shared.
