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
- **asks before acting**, with tappable question cards, before it merges, deploys, posts or spends anything;
- **talks to other bots**, so a bot-maker bot can design and brief new bots for you.

Everything runs on **your Mac, with your own Claude Code login**. There is no hosted backend, no API key to paste and no third-party server between you and your code. The iPhone app is a window onto the bots. They keep working while it is closed.

> ClaudioBot is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic or xAI. "Claude" and "Claude Code" are trademarks of Anthropic. ClaudioBot needs a working Claude Code install and follows its terms of use.

## How it works

```
 iPhone / iPad (SwiftUI)                       Your Mac
┌───────────────────────┐   WebSocket   ┌──────────────────────────────────────────┐
│  bot list, chats,     │◀────────────▶ │  bridge (Bun)                            │
│  question cards,      │  token auth   │   ├─ one Claude Code session per bot     │
│  routines, library,   │  LAN or       │   │    (Claude Agent SDK, your login)    │
│  agents, links        │  Tailscale    │   ├─ claudio MCP tools: ask, start_agent │
└───────────────────────┘               │   │    message_bot, set_routine, …       │
                                        │   ├─ routine scheduler (cron)            │
                                        │   └─ agents                              │
                                        │        ├─ mac:   Claude Code in a repo   │
                                        │        └─ cloud: claude --cloud session  │
                                        └──────────────────────────────────────────┘
```

- **The bridge** is a small Bun server in [`bridge/`](bridge). It owns every bot. Each bot is one persistent Claude Code session (through the Claude Agent SDK) with its own home folder for memory and files. It resumes after restarts.
- **Bots act through tools**, not by printing commands. `ask` posts a question card. `start_agent` launches a coding agent. `set_routine` schedules work. `message_bot` and `create_bot` reach other bots.
- **Agents do the coding.** A bot hands repository work to a Claude Code agent, either on your Mac in the project folder or as a Claude Code cloud session. Mac agents report every result back to their bot, which checks the claim before telling you.
- **The app** in [`ios/`](ios) is SwiftUI for iPhone and iPad. It pairs with the bridge by QR code and talks to it over one WebSocket.

## Features

| | |
| --- | --- |
| **Persistent bots** | Each bot has a name, a job, an avatar (13 shapes × 11 colors), a memory file and a home folder. New bots introduce themselves, ask what you need, and name themselves. |
| **Question cards** | A bot asks with lettered options (A, B, C). Tap one, dismiss it, or type something else. Cards don't block the bot and survive restarts. |
| **Coding agents** | `mac` agents run Claude Code in your repo and report back. `cloud` agents start a Claude Code cloud session and give you the link. The chat shows "Messaged ⚙ Fix login" and "Message from ⚙ Fix login", and tapping either opens the full thread. |
| **Routines** | Cron schedules in local time, shown as "Weekdays at 9:00 AM", with an on/off switch in the bot's profile. |
| **Library and links** | Files a bot writes to `library/` show up in its Library tab, with a viewer for markdown, text and images. Every link a bot shares is collected under Links. |
| **Bots talking to bots** | A bot can message another bot or create a new one with a brief. |
| **Phone niceties** | Unread dots, an attention badge when a bot is waiting on you, notifications with answer buttons, dictation, photo and file uploads, and pin, rename, hide and delete. |
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

It prints its address, a pairing token and a QR code. The first run creates **Claudio Bot**, a general assistant that greets you.

**2. Run the app**

```bash
cd ../ios
xcodegen
open ClaudioBot.xcodeproj
```

Pick your iPhone (or a simulator) and your signing team, then run. A free Apple ID works; the app then expires after 7 days. Tap **Scan QR code** and scan the code from the bridge. The phone and the Mac need to be on the same network, or on the same [Tailscale](https://tailscale.com) tailnet when you're away from home.

**3. Put a bot to work**

- Ask Claudio Bot to *"add a CONTRIBUTING.md to my-app using an agent on the Mac"*.
- Tap **+ → Create new Bot** and answer its first question.
- Ask any bot to *"check my repo every weekday at 9 and tell me what changed"*.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDIOBOT_PORT` | `7878` | Port the bridge listens on. |
| `CLAUDIOBOT_ROOTS` | `~/Dev/projects:~/code:~/Developer:~/Projects` | Colon-separated folders. Every git repo directly inside one is a project agents can work in. |
| `CLAUDIOBOT_HOME` | `~/.claudiobot` | Token, state, shared `USER.md`, bot homes and trash. |
| `CLAUDIOBOT_CLAUDE` | `claude` on `PATH` | Path to the Claude Code executable (handy under launchd). |
| `CLAUDIOBOT_MODEL` | your Claude Code default | Pins the model for every bot and agent. |
| `CLAUDIOBOT_USER_NAME` | your macOS first name | The name bots call you. |

## Safety model

ClaudioBot runs agents unattended on your machine, so read this before you use it on work that matters.

- **Pairing.** The bridge accepts only clients that present its token, which lives in `~/.claudiobot/token`. Delete the file to revoke every paired phone. The QR code contains the token, so treat it like a password.
- **Permissions.** Bots and Mac agents run in Claude Code's auto permission mode. Its classifier screens risky commands. Nobody approves each tool call by hand.
- **Outward actions.** Every bot is told never to merge, deploy, post, message people, set secrets, spend money or delete data without an explicit "yes" from you in chat. That rule is a prompt, not a sandbox. Scope `CLAUDIOBOT_ROOTS` to the repos you want agents to touch.
- **Files.** File reads from the app are confined to the bot's home. Uploads land in the bot's `inbox/`.
- **Network.** The bridge listens on your LAN. Don't expose port 7878 to the internet. Use Tailscale or another private network for remote access.

## Project layout

```
bridge/                 Bun + TypeScript server
  src/protocol.ts       the WebSocket contract (the app mirrors it)
  src/world.ts          the domain: bots, conversations, exchanges, unread rules
  src/hub.ts            bot brains, client messages, scheduler
  src/tools.ts          the in-process "claudio" MCP tools bots call
  src/agents.ts         mac and cloud agents
  src/cron.ts           routines' cron parsing and descriptions
  scripts/e2e.ts        end-to-end test against real Claude Code
ios/                    SwiftUI app (xcodegen project.yml)
  ClaudioBot/Model      protocol, store (reducer), bridge client, pairing
  ClaudioBot/Views      home, chat, question cards, profile, agents, avatars
fixtures/protocol.json  shared fixtures both test suites decode
docs/                   product study and design notes
decisions.tsv           the decision log from building it
```

## Development

```bash
# bridge
cd bridge
bun test                 # unit tests, no network
bunx tsc --noEmit
bun run e2e              # real Claude Code on haiku in a temp home, about $0.03

# app
cd ios
xcodegen
xcodebuild -scheme ClaudioBot -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test
./scripts/screenshots.sh # demo-mode screenshots (launch args: -demo -demoScreen <screen>)
```

The bridge and the app share one contract. If you change `bridge/src/protocol.ts`, update `bridge/src/fixtures.ts`, regenerate `fixtures/protocol.json` with `bun src/fixtures.ts`, and mirror the change in `ios/ClaudioBot/Model/Protocol.swift`. Both test suites decode the same fixtures.

## Limitations and roadmap

- **Cloud agents don't report back.** `claude --cloud` gives no completion signal to another program, so cloud agents are fire-and-follow with a link. A backend that streams cloud runs is the top roadmap item.
- **No remote push.** Notifications fire while the app is open or for a short time after you leave it. True push needs APNs and a relay.
- **No voice mode, no group chats, no sidebar sections yet.**
- **macOS only.** The bridge has only been run on macOS. Linux should be close.
- **No Mac app.** The iPad layout runs on Apple silicon Macs as "Designed for iPad". A native Mac app is not built yet.

Issues and pull requests are welcome. Please run both test suites before you open a PR.

## License

[MIT](LICENSE)
