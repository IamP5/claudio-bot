<h1 align="center">ClaudioBot</h1>

<p align="center">
  <b>Bots that work for you, built on Claude Code. Running on your own Mac.</b><br>
  An open-source, self-hosted take on Grok Bot–style personal agents, with an iPhone app.
</p>

<p align="center">
  <img src="ios/screenshots/home.png" width="230" alt="Home: a list of bots">
  <img src="ios/screenshots/chat.png" width="230" alt="A chat with a question card">
  <img src="ios/screenshots/engineer.png" width="230" alt="A bot supervising coding agents">
</p>

---

ClaudioBot gives you a handful of **bots**, each with one job. A bot is not a chat session that ends. It is a long-lived assistant that:

- **remembers you** and keeps notes about its own work;
- **runs routines** on a schedule ("weekdays at 7:57 AM, post my news digest");
- **starts coding agents** in your repositories, supervises them, checks their work and reports back with the branch or PR;
- **asks before acting**: a risky tool call, such as a push to `main`, waits for your tap on a permission card;
- **talks to other bots**, so a bot-maker bot can design and brief new bots for you.

Everything runs on **your Mac, with your own Claude Code login**. There is no hosted backend, no API key to paste and no third-party server between you and your code. The iPhone app is a window onto the bots. They keep working while it is closed.

> ClaudioBot is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic or xAI. "Claude" and "Claude Code" are trademarks of Anthropic. ClaudioBot needs a working Claude Code install and follows its terms of use.

## How it works

```
 iPhone / iPad (SwiftUI)                       Your Mac
┌───────────────────────┐   WebSocket   ┌──────────────────────────────────────────┐
│  bot list, chats,     │◀────────────▶ │  bridge (Bun)                            │
│  question and         │  a token per  │   ├─ one Claude Code session per bot     │
│  permission cards,    │  paired phone │   │    (Claude Agent SDK, your login)    │
│  routines, library,   │  LAN or       │   ├─ the gate: every tool call checked,  │
│  agents, links        │  Tailscale    │   │    risky ones held for your tap      │
└───────────────────────┘               │   ├─ claudio MCP tools: ask, start_agent │
                                        │   │    message_bot, set_routine, …       │
                                        │   ├─ routines, spend caps, push          │
                                        │   └─ agents                              │
                                        │        ├─ mac:   Claude Code in a repo   │
                                        │        └─ cloud: claude --cloud session  │
                                        └──────────────────────────────────────────┘
```

- **The bridge** is a small Bun server in [`bridge/`](bridge). It owns every bot. Each bot is one persistent Claude Code session (through the Claude Agent SDK) with its own home folder for memory and files. It resumes after restarts.
- **Bots act through tools**, not by printing commands. `ask` posts a question card. `start_agent` launches a coding agent. `set_routine` schedules work. `message_bot` and `create_bot` reach other bots.
- **Agents do the coding.** A bot hands repository work to a Claude Code agent, either on your Mac in the project folder or as a Claude Code cloud session. Mac agents report every result back to their bot, which checks the claim before telling you.
- **The gate stands between a bot and your machine.** Every tool call a bot or a Mac agent makes passes a check first. Some calls are refused outright, such as reading your SSH keys. Risky ones, such as `git push origin main`, wait for your tap on the phone. The rest go on to Claude Code's own auto mode. See [Safety model](#safety-model).
- **The app** in [`ios/`](ios) is SwiftUI for iPhone and iPad. It pairs with the bridge by a one-time code and talks to it over one WebSocket.

## Features

| | |
| --- | --- |
| **Persistent bots** | Each bot has a name, a job, an avatar (13 shapes × 11 colors), a memory file and a home folder. New bots introduce themselves, ask what you need, and name themselves. |
| **Question cards** | A bot asks with lettered options (A, B, C). Tap one, dismiss it, or type something else. Cards don't block the bot, survive restarts, and expire after a day. |
| **Approvals** | A held tool call shows as a permission card: the rule that asked, the exact command, and what Always would cover. Allow once, Always, Deny or Never. Nothing you type in the chat approves a call. |
| **Coding agents** | `mac` agents run Claude Code in your repo and report back. `cloud` agents start a Claude Code cloud session and give you the link. The chat shows "Messaged ⚙ Fix login" and "Message from ⚙ Fix login", and tapping either opens the full thread. |
| **Routines** | Cron schedules in local time, shown as "Weekdays at 9:00 AM", with an on/off switch, Run now and the last 20 runs in the bot's profile. A routine with nothing to report posts nothing. |
| **Spend caps** | Each bot has a daily cap that its agents share, and each Mac agent has a budget. At the cap, routines and other background work wait until midnight. Your own messages still run. |
| **Library and links** | Files a bot writes to `library/` show up in its Library tab, with a viewer for markdown, text and images. Every link a bot shares is collected under Links. |
| **Bots talking to bots** | A bot can message another bot or create a new one with a brief. |
| **Phone niceties** | Unread dots, an attention badge when a bot is waiting on you, notifications with answer buttons, an optional push through [ntfy](https://ntfy.sh) when the app is closed, dictation, photo and file uploads, and pin, rename, hide and delete. |
| **Your data stays home** | State lives in `~/.claudiobot`. Deleting a bot moves its folder to `trash/`. Nothing is deleted for real. |

<p align="center">
  <img src="ios/screenshots/profile.png" width="200" alt="Bot profile with routines and avatar picker">
  <img src="ios/screenshots/agent.png" width="200" alt="A bot's thread with a coding agent">
  <img src="ios/screenshots/newchat.png" width="200" alt="New chat picker">
  <img src="ios/screenshots/factory.png" width="200" alt="A bot that creates other bots">
</p>

## Quick start

**You need:**
- macOS with [Bun](https://bun.sh) 1.3 or later;
- Claude Code installed and logged in (check with `claude -p hi`);
- Xcode 26 and [XcodeGen](https://github.com/yonaskolb/XcodeGen) for the app, which needs iOS 18 or later.

**1. Start the bridge**

```bash
git clone https://github.com/IamP5/claudio-bot.git
cd claudio-bot/bridge
bun install
bun run start
```

It prints its address, a one-time pairing code such as `pair code: 7KQM-X2PD` (valid for 10 minutes) and a QR code. The first run creates **Claudio Bot**, a general assistant that greets you.

**2. Run the app**

```bash
cd ../ios
xcodegen
open ClaudioBot.xcodeproj
```

Pick your iPhone (or a simulator) and your signing team, then run. A free Apple ID works; the app then expires after 7 days. Tap **Scan QR code** and scan the code from the bridge, or type the address and the code. The app trades the code for a token of its own. The phone and the Mac need to be on the same network, or on the same [Tailscale](https://tailscale.com) tailnet when you're away from home.

To pair another phone, open Settings on a paired phone and tap **Pair another device**, or restart the bridge with `bun run start -- --pair`.

**3. Put a bot to work**

- Ask Claudio Bot to *"add a CONTRIBUTING.md to my-app using an agent on the Mac"*.
- Tap **+ → Create new Bot** and answer its first question.
- Ask any bot to *"check my repo every weekday at 9 and tell me what changed"*.

## Upgrading

The project used to be called claudebot, with its home in `~/.claudebot`. On its first start the new bridge links `~/.claudiobot` to `~/.claudebot`, so every bot keeps its conversation and its Claude Code session. If `~/.claudiobot` already holds only what a first run leaves, the bridge moves it aside to `~/.claudiobot.pre-migrate-<time>` first and says so. If both folders hold bots, it touches neither, uses `~/.claudiobot`, and prints how to switch.

- **Do not run the old bridge after upgrading.** The new bridge rewrites `state.json` as version 3, which an old bridge does not understand. An old bridge treats it as a first run and overwrites it. To go back, stop the new bridge and copy `state.v2.json.bak` over `state.json` first. Anything changed since the upgrade is lost.
- **`CLAUDEBOT_HOME` is ignored.** If you set it, rename it to `CLAUDIOBOT_HOME`. Until then the bridge warns at every start.
- **Your phone keeps working for one release.** A phone paired with the old shared token connects as the "legacy" device. The new app trades that token for its own on its first connection. An app build from before this release still connects, and it sees each permission card as a question with **Allow once** and **Deny**.
- **Fast routines are paused.** Routines may now run at most every 15 minutes. A routine that ran more often is turned off with a note in its chat. Edit its schedule to turn it back on.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDIOBOT_PORT` | `7878` | Port the bridge listens on. |
| `CLAUDIOBOT_ROOTS` | `~/Dev/projects:~/code:~/Developer:~/Projects` | Colon-separated folders. Every git repo directly inside one is a project agents can work in. |
| `CLAUDIOBOT_HOME` | `~/.claudiobot` | State, shared `USER.md`, bot homes, usage and audit logs, and trash. Setting it skips the migration from `~/.claudebot`. |
| `CLAUDEBOT_HOME` | | The old name. It is ignored, with a warning at start. |
| `CLAUDIOBOT_CLAUDE` | `claude` on `PATH` | Path to the Claude Code executable (handy under launchd). |
| `CLAUDIOBOT_MODEL` | your Claude Code default | Pins the model for every bot and agent. Auto permission mode needs a model that supports it. |
| `CLAUDIOBOT_USER_NAME` | your macOS first name | The name bots call you. |
| `CLAUDIOBOT_DAILY_USD` | `10` | Each bot's daily spend cap in US dollars, its agents included. A bot's own cap, set from its profile, wins. |
| `CLAUDIOBOT_AGENT_USD` | `5` | Each Mac agent's lifetime budget in US dollars. |
| `CLAUDIOBOT_PUSH_URL` | off | An [ntfy](https://ntfy.sh) topic URL for pushes while the app is closed. |

### Push

The app only gets notifications while it has a socket open. iOS suspends it a short while after you leave it. To hear from your bots after that, install the ntfy app, subscribe to a topic with a long random name, and start the bridge with that topic:

```bash
CLAUDIOBOT_PUSH_URL=https://ntfy.sh/claudiobot-<long random string> bun run start
```

The bridge pushes only while no phone is connected: when a card opens, when it reminds you, and when a turn posts its first message. A push says only the bot's name and "needs you", "is still waiting for you" or "has an update for you". No message content leaves your Mac. Tapping it opens ClaudioBot at that message. Each card and message is pushed at most once, and messages at most once per bot every 10 minutes. There is no cap across bots. A failed send is logged and never retried, and that includes ntfy's 429 when a topic gets too much traffic. Anyone who knows the topic name can read the bot names, so use a private ntfy server or a name nobody can guess.

## Safety model

ClaudioBot runs agents unattended on your machine, so read this before you use it on work that matters. Some of these protections are enforced by the bridge's code. Others depend on Claude Code or on the model following instructions. This section says which is which.

### What the bridge enforces

- **Pairing.** A phone pairs with a one-time code that the bridge prints. The code lasts 10 minutes and allows 5 tries. Each phone gets its own token. The bridge stores only a hash of it, and never prints or logs it. Settings on any paired phone lists the phones and can revoke one, which closes its connection at once. After 10 failed pairings from one address in 10 minutes, the bridge refuses that address for 10 minutes with HTTP 429. Requests that carry a browser `Origin` header are refused, so a web page cannot reach the bridge. Revoking a phone paired before this release writes `token.revoked`, and the old shared token is never accepted again, even if the `token` file comes back.
- **The gate.** Every tool call by a bot or a Mac agent passes a check first. That covers every built-in tool, every MCP tool and every call a subagent makes.
  - **Always refused:** the bridge's own state and other bots' folders, SSH, GPG and cloud keys, the Keychain, browser profiles and cookies, the Claude login, and typing passwords, payment details or 2FA codes. The bot is told to hand those back to you.
  - **Held for your tap:** risky commands such as pushing to the default branch, force-pushing, merging a pull request, publishing a package and deploying. The call is blocked and a permission card opens. It runs only after you tap **Allow once** (that exact call, within 10 minutes) or **Always** (that kind of call for this bot). Nothing typed in the chat approves a call. A card expires after 2 hours, with one reminder at the halfway point. An expired call did not run, and the bot is told you did not say no.
  - **Stricter when you are not there:** routines, messages between bots and agent turns get the stricter column of the rules. Work that began as a routine cannot create or delete routines, even several bots later. A chain of bot-to-bot messages stops at two hops. A bot may create at most 5 bots and start at most 20 agents a day.
  - **Fails closed:** if the check itself fails, the call is blocked. Three blocked or held calls in one turn stop that turn.
- **Spend caps.** Each bot has a daily cap that its agents share (`CLAUDIOBOT_DAILY_USD`, default $10). At the cap, routines and other background work wait until midnight. A message you type still runs, and the bot's chat says the cap is reached. Each Mac agent has a lifetime budget (`CLAUDIOBOT_AGENT_USD`, default $5), and Claude Code stops the agent's turn when it runs out.
- **Audit.** Every checked tool call is appended to `audit/YYYY-MM.jsonl` in the bridge home, with secrets and file contents redacted. Every turn's cost is appended to `usage/YYYY-MM.jsonl`. Both files are readable only by you.
- **State.** `state.json` is written atomically. A file the bridge cannot read stops the bridge instead of being overwritten. Only one bridge runs per home: a lock file sits beside the home (`~/.claudiobot.lock`), and a second bridge refuses to start.
- **Files.** File reads from the app are confined to the bot's home. Uploads land in the bot's `inbox/`, at most 10 MB each, inside socket frames of at most 32 MB.

### What it does not enforce

- **The rules are not a sandbox.** The gate reads command lines and file paths. It does not watch what a program does once it runs. A script the bot writes and then runs, `python -c`, `node -e`, `make` or any interpreter can do anything the rules would have held. Bots and agents run as you, with your files and your network.
- **Unlisted calls go to Claude Code.** A call that no rule mentions passes to Claude Code's auto permission mode, whose classifier decides. That judgment is Claude Code's, not the bridge's.
- **Cloud agents are not gated or metered.** They run on claude.ai under your account, outside the bridge.
- **"Ask before outward actions" is a prompt.** Every bot is told never to merge, deploy, post, message people, set secrets, spend money or delete data without your yes. The gate holds the commands it knows. For everything else, that instruction is a prompt, not a guarantee.
- **Your own tools come along.** Bots load your Claude Code user settings, so your MCP servers and skills are available to them. Their calls pass the same gate, but what a server does on its end is up to that server.
- **Costs are estimates.** The caps use the cost Claude Code reports. A cap is checked before a turn starts, so one turn can go past it. The auto classifier's own requests are not counted.
- **The network is yours to secure.** The bridge listens on every interface with plain `ws://`. Don't expose port 7878 to the internet. Use your LAN, or Tailscale for remote access.

## Project layout

```
bridge/                 Bun + TypeScript server
  V3-CONTRACT.md        every module's interface, owner and state slice
  src/protocol.ts       the WebSocket contract (the app mirrors it)
  src/world.ts          every persisted shape and the pure rules over them
  src/hub.ts            client messages and tool calls, routed to the modules below
  src/session.ts        one bot's or agent's turns: durable inbox, Stop, retries, parks
  src/gate.ts           the tool-call check, permission and question cards, audit
  src/policy.ts         the rules the gate applies
  src/scheduler.ts      routines, run history and the one clock
  src/ledger.ts         spend, daily caps and agent budgets
  src/devices.ts        pairing and per-device tokens
  src/serve.ts          HTTP, the socket and the resumable stream
  src/push.ts           ntfy pushes
  src/migrate.ts        the move from ~/.claudebot
  src/tools.ts          the in-process "claudio" MCP tools bots call
  src/agents.ts         mac and cloud agents
  scripts/e2e.ts        end-to-end test against real Claude Code
ios/                    SwiftUI app (xcodegen project.yml)
  ClaudioBot/Model      protocol, store (reducer), bridge client, pairing
  ClaudioBot/Views      home, chat, question cards, profile, agents, avatars
fixtures/protocol.json  shared fixtures both test suites decode
docs/                   product study, design notes and how v3 was chosen
decisions.tsv           the decision log from building it
```

## Development

```bash
# bridge
cd bridge
bun test                 # unit tests, no network
bunx tsc --noEmit
bun run e2e              # real Claude Code (claude-sonnet-5-5) in a temp home, $0.40 to $0.70

# app
cd ios
xcodegen
xcodebuild -scheme ClaudioBot -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test
./scripts/screenshots.sh # demo-mode screenshots (launch args: -demo -demoScreen <screen>)
```

The bridge and the app share one contract. If you change `bridge/src/protocol.ts`, update `bridge/src/fixtures.ts`, regenerate `fixtures/protocol.json` with `bun src/fixtures.ts`, and mirror the change in `ios/ClaudioBot/Model/Protocol.swift`. Both test suites decode the same fixtures.

## Limitations and roadmap

- **Cloud agents don't report back.** `claude --cloud` gives no completion signal to another program, so cloud agents are fire-and-follow with a link. A backend that streams cloud runs is the top roadmap item.
- **Push goes through ntfy, not APNs.** With `CLAUDIOBOT_PUSH_URL` set, the ntfy app shows the push and opens ClaudioBot when tapped. Native push needs APNs and a relay server.
- **No voice mode, no group chats, no sidebar sections yet.**
- **macOS only.** The bridge has only been run on macOS. Linux should be close.
- **No Mac app.** The iPad layout runs on Apple silicon Macs as "Designed for iPad". A native Mac app is not built yet.

Issues and pull requests are welcome. Please run both test suites before you open a PR.

## License

[MIT](LICENSE)
