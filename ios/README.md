# ClaudioBot for iPhone and iPad

ClaudioBot is a phone for your bots. A bot is a persistent assistant with one long conversation and one job, such as "news digest" or "engineer". Your bots live on your Mac, in the bridge. They keep working, run their routines and start coding agents while the phone is closed. The app shows them, lets you chat with them, and tells you when one needs you.

The app talks to one thing only: the bridge in `../bridge`, over a single WebSocket. The wire contract is `../bridge/src/protocol.ts`, and `../fixtures/protocol.json` holds a sample of every message. `ClaudioBot/Model/Protocol.swift` mirrors that file. The tests decode every server message and encode every client message in the fixture, and each must round-trip to equal JSON. They read the list from the fixture file, so a new fixture is covered without touching the tests. The app speaks protocol 3. When the bridge's hello reports another protocol, Home shows "Update the bridge" or "Update the app".

## Build and run

Requirements are Xcode 26 and an iOS 18.0 or later simulator or device. The app runs on iPhone and iPad. There are no package dependencies.

```sh
open ios/ClaudioBot.xcodeproj
```

The generated project is committed. After you add or move files, regenerate it from `project.yml`:

```sh
cd ios && xcodegen generate
```

Build and test from the command line:

```sh
xcodebuild -project ios/ClaudioBot.xcodeproj -scheme ClaudioBot \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' build test
```

To run on your own iPhone, pick your team under Signing & Capabilities for the ClaudioBot target.

### Demo mode and screenshots

Debug builds accept `-demo`. It loads sample bots into the store through the same reducer the bridge feeds, with no bridge running. Add `-demoScreen <name>` to open a screen directly. The names are `home`, `newchat`, `chat`, `profile`, `links`, `library`, `file`, `agent`, `digest`, `engineer`, `factory`, `pair`, `settings`, `routine` and `approval`. `mention`, `chip` and `command` open a chat with the composer mid-sentence: the "@" menu, two picked tokens, and the "/" menu. `group`, `groupprofile`, `newgroup` and `botexchange` open a group chat, its details, the group picker and an exchange between two bots. `usage` opens the Plan usage sheet, `usagehot` with the session near its limit and `usageoff` with no plan limits to read. The pairing and connection states have their own: `pairconfirm` and `outdated` while unpaired, and `confirm`, `unrecognized`, `error` and `oldbridge` while paired. Sessions has `sessions` (the sidebar), `thread` (tool runs, a to-do list and a permission card), `workrun` (three subagents running, one failed, and a background command one of them started), `ask`, `plan`, `streaming`, `cloud`, `longthread` (500 items, the older ones a page away), `newsession`, `sessionsempty` and `sessionsoffline`. Add `-demoColumns` on an iPad to open with the sidebar beside the detail, as a landscape iPad shows it.

`scripts/screenshots.sh <udid> <path/to/ClaudioBot.app>` launches each screen and saves PNGs to `screenshots/`.

`scripts/avatar-sheet.sh <out.png>` builds the avatar code for macOS and renders all 13 shapes and 11 colors to one image. Use it to tune the shapes without a simulator.

The app icon is drawn by `ClaudioBot/Views/Brand.swift`, the same view the launch splash animates. Render it with:

```sh
ios/scripts/make-icon.sh ios/ClaudioBot/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```

## Pairing

1. On your Mac, run `bun run start` in the `bridge` folder. It prints a QR code, the bridge address and a one-time pairing code. A phone that is already paired can show a code too, under Settings, Pair another device.
2. In ClaudioBot, tap Scan QR code, or type the address (for example `ws://10.0.0.20:7878/ws`) and the code. A bare host and port gets the `/ws` path. Any other path must end in `/ws`.
3. Confirm the bridge's host and port. When the phone is already paired, the prompt also names the Mac it replaces. Nothing reaches the bridge before you tap **Pair**.
4. The app posts the code and the phone's name to `/pair` beside the socket path, so `wss://host/prefix/ws` pairs at `https://host/prefix/pair`. A link with several addresses is tried in order: the app moves to the next address only when one does not answer, and stops at a bridge that answered and refused the code. The bridge answers with a token for this phone only.
5. The app opens a socket with the new token and waits for the bridge's hello. Only then does it save the address that worked and the token in the Keychain and switch to the new Mac. If the code is refused or no hello arrives, the old pairing stays and the form shows why.

The QR code encodes `claudiobot://pair?url=<urlencoded ws url>&url=<another>&code=<code>`, one `url=` per address of the Mac, best first: its Tailscale name, its Bonjour `.local` name, then each LAN address. Opening that link shows the same confirmation, which names the addresses it falls back to. A link from a protocol 2 bridge carries `token=` instead of `code=`, and the app asks you to update the bridge.

The socket sends the token as `Authorization: Bearer <token>`. A phone paired before protocol 3 trades its shared token for its own on the first protocol 3 hello: it asks for a pairing code over its socket, redeems it at its own bridge, saves the new token and reconnects. Until that works it keeps the shared token in the URL and tries again every 10 minutes.

On a reconnect the app passes `epoch` and `after` from the last frame it applied, and the bridge replays what it missed. A broadcast whose `seq` is not the next one, or an undecodable frame that carries a `seq`, means frames were lost. The app then drops the socket and reconnects without `epoch` and `after` for a fresh hello.

Settings lists every paired phone. Revoking one closes its socket with code 4001, and that phone returns to the pairing screen. Only that close code unpairs. A 401 on connect may come from another server on the network the phone is on, so the app keeps the pairing and shows **Not recognized** with **Pair again** and **Retry**. Returning to the app retries too. **Unpair this Mac** revokes this phone on the bridge first when connected, then deletes the pairing and clears the app's notifications.

The phone and the Mac need to reach each other. The same Wi-Fi network works, and so does Tailscale from anywhere. Plain `ws://` is allowed for local addresses and `*.ts.net` names only. From the first failed connect the banner over either list names the address it tries and offers **Retry now**, **Edit address** and **Pair again**. Settings has **Change address** too. Edit address takes another address of the same Mac, such as the `ws://<name>.ts.net:<port>/ws` that `claudiobot doctor` prints. Before the token goes there, the app sends `GET /health` with this phone's device id and a fresh 256-bit nonce, and checks that the answer's `proof` is the HMAC-SHA256 of the nonce keyed by the SHA-256 of its token. Something that answers without that proof never sees the token, and the old address is kept. The new address is saved only once that Mac says hello. A phone paired with the protocol 2 shared token cannot prove the bridge this way and must pair again with a code.

A Stop tapped while offline is sent on reconnect only if it is under a minute old, so it never stops a later turn.

## Screens

**Home.** One row per bot, pinned bots first, then the newest activity. A blue dot means unread. An orange star badge on the avatar means the bot asked you something, and the row shows that question. Long-press a row to pin, mark as unread, rename, hide or delete the bot. Delete waits up to 3 s for the bot's details, then says the bot's folder moves to the bridge's trash folder and names any agent worktrees that stay on the Mac. When it lists worktrees it sends `force`, because the bridge refuses to delete a bot whose agents hold worktrees otherwise. Details that do not arrive in time give the dialog without worktrees. The initials button opens Settings, and an amber number on it counts facts bots proposed that wait for you. + opens the new chat picker. While the Mac is out of reach a banner says why, counts down to the next try and offers **Retry now**. VoiceOver hears the state, not the countdown, and one announcement when the Mac is lost or back.

**New chat.** Create new Bot comes first. The bridge makes the bot, and the app opens it as soon as it exists. Create group chat follows on a bridge with groups: tick 2 to 8 bots and name the group, or keep the name made of theirs (cut to 40 characters). Every bot follows, hidden ones included.

**Chat.** Bot messages are gray bubbles with markdown. Your messages use the bot's color. A centered time appears before the first message and after every gap of more than an hour. A question card lists lettered options. Tap one to answer, or tap X to dismiss it. You can also type a free answer while it is open. A question with a deadline closes as Expired when nobody answers in time.

A permission card holds a tool call the bot or one of its agents wants to run. It shows the rule that asked, the exact command in monospace and what Always would cover. Allow once, Always allow, Deny and Never are the only way a held call runs. Typing in the chat never approves one. An unanswered card expires at its deadline and the call does not run. Centered gray lines show what the bot did on its own, such as "Messaged standup notes" or "4 messages with Set up verification skill". Tap one to open that agent, bot or routine. While the bot works, its avatar bobs beside "Typing…", and the send button becomes Stop until you type something, which queues instead. A bot waiting on a permission card wears an Awaiting approval chip in the list and the chat. A bot paused by the usage limit or its daily cap wears Parked. A bar at the top says when the Mac is out of reach; what you send waits and goes on reconnect. When the bot has a cap and it and its agents have spent 80% of it today, a card says so with **Change the cap**. A fact the bot asked to remember shows as a card with **Confirm** (every bot then knows it) and **Forget**. The app finds a bot's proposals by `proposerBotId`, and by the bot's name from a bridge that does not send it.

The composer's + menu attaches a photo from the library, a new photo or a file. Each upload can be up to 10 MB. The mic dictates into the field with the Speech framework.

On a bridge with mentions, "@" at the start of a word opens a list above the composer: bots first (a group's members lead, and a chat's own bot is left out), then the bot's connectors that are on, with their state. What follows the "@" filters by any part of a name. Tap a row or press Return to pick it. A pick becomes "@name" in bold, in the bot's color (connectors in the link color), and a backspace into it removes it whole. Escape, or a space that leaves nothing matching, closes the list. The send keeps the text and lists what each token points to. On a bridge with commands, "/" as the first character lists the bot's skills and the built-in commands the bridge allows, and a pick leaves "/name " for the arguments. A group has no "/" list.

A message that mentions a bot shows "@name" bold in that bot's current color. Tap it to open that bot.

**Group chat.** On a bridge with groups, a group is a chat with several bots. Its row stacks its first members' avatars. Each member's messages carry its avatar and its name in its color, once per run. The typing line names the members at work. Its profile lists the members (tap one to open it), with Add members, a remove button per member (a group keeps at least 2), rename and Delete Group. A group has no routines, library, computer, skills, connectors or spending.

**Profile.** Tap the name pill at the top of a chat. You can edit the name and the label. The tabs are Info, Library (files the bot made), Agents (coding agents it started, with their status) and Links (every link in the conversation). On iPhone the profile is its own screen. On iPad it opens as a column beside the chat.

Info holds, in order:
- **Routines** with on and off switches. Tap one for its next run, its last runs and Run now. A webhook routine also makes a token, shown once, with its address and a **Copy** for a `curl` command to run in Terminal on the Mac (the address answers on the Mac only).
- **Character**, the avatar picker.
- **Spending**, today's spend, with a bar against the daily cap when the bot has one, and **Daily cap**: No cap (the default), $1 to $50, or Custom. Custom reads `$12.50`, `12,5`, `1,234.50` and `1.234,50` as dollars: a comma followed by exactly three digits groups thousands, and otherwise the last comma or dot is the decimal point.
- **Notifications**, the mute switch. Cards still notify.
- **Connectors**, the bot's MCP servers by name and status, each with a switch.
- **Skills** the bot saved, each with Delete.

A section whose feature the bridge does not list says "Update the bridge on your Mac to …" instead of disappearing.

**Exchange.** What a bot and one of its agents said to each other, with the agent's status and, for a Mac agent, its spend against its budget. A working agent has Stop. Cloud agents have Open in Claude. Below the thread, what the bridge read from git after the agent's last turn: branch, commits ahead, files changed, uncommitted work and a PR link, and the agent's own worktree with **Remove**, which the bridge refuses while the worktree holds uncommitted work.

On a bridge with exchanges, a line such as "2 messages with standup notes" opens what the two bots said: "bot maker ⇄ standup notes" on top, time separators, and each message in a gray bubble with its sender's avatar and name in the sender's color. A name on top opens that bot's chat. Close Chat goes back. On an older bridge the line opens the other bot's chat.

**Plan usage.** On a bridge with usage, the top of the bot list shows the current 5-hour session as a ring and a percentage, tinted by how close the server says it is to the limit (teal, amber, red). Tap it for the Plan usage sheet. It has one row per window, such as Current session, Weekly · all models and Weekly · Fable. Each row has the share used, a bar and when it resets: "Resets in 2 h 14 min" under a day, else the weekday and local time. The footer names the plan and when the Mac last read the numbers. When the last reads failed, it says so and dims the old numbers. Pull down, or tap the refresh button, to read again. A Mac whose Claude Code has no plan limits (an API key, another provider, logged out) gets one line on how to fix it. Settings shows the same section.

**Sessions.** On a bridge with sessions, a Bots | Sessions switch sits at the top of the sidebar, and the app remembers which you picked. Sessions lists the Claude Code sessions on the Mac, grouped by project like the Claude app's Code sidebar. Each project has a small gray header with its count and + for a new session there. A row shows where the session came from (the bot's avatar for a bot's agent, else a symbol for the Claude app, a terminal, an SDK script, the cloud or this phone), its title, its PR number tinted by state (open green, merged purple, closed red), its age, and one mark: an orange ! when it needs you, a turning ring while it works, an x when it failed, a pause when it is parked, a blue dot when it is unread. Sessions started from another nest under it with a thin guide. Each project shows 5, and Show more adds 10. Chips filter Working, Needs you, Unread and Hidden. The magnifying glass searches title, project and branch. Swipe a row to hide it or open it in the Claude app; long-press to rename, mark read, open its PR or copy its id. Offline, the list stays as the Mac last sent it: the banner says when that was, ages stop at that moment, a working ring turns gray and still, and the Working chip drops its count. Pulling the list down tries again at once and ends with a fresh list or "Still no answer".

A session's thread reads like the Claude app's. A finished turn folds its thinking and tool runs into one line, such as "Edited 2 files, ran 2 commands, 1 message +15 −7". Tap it to see the steps. Each run of tool calls opens to its steps, with diff counts, the end of each output and **Full output**. Permission cards are the same as a bot's chat. A plan has **Approve** and **Keep planning**. A question offers its options, several when it allows that, and a free answer. Text streams in as plain text and turns into markdown when the message lands. A banner says when the Claude app or a terminal is working in the session (read only), when it is also open in the Claude app, or that a cloud session continues on claude.ai. Scrolling to the top loads earlier messages and keeps your place.

The composer has the model and mode menus (the phone never offers bypassPermissions), how many messages are queued, and the plan usage ring. While Claude works, Send queues your message and shows it at once in a dashed bubble. Hold Send for **Stop and send**. An empty field offers Stop. **New Session** (the + in the sidebar or a project's header) takes a project, a prompt, an optional model and mode and **Work in a new worktree**, and opens the session as soon as the bridge names it. `claudiobot://session/<id>` opens a thread.

**Settings.** The Mac with **Change address**, **Plan usage**, on a bridge with sessions **Show agent sessions in the Claude app** (Automatically, When I tap, Never), the paired phones with Revoke, Pair another device (a code and its QR code), **Memory** (the facts bots know about you: tap to edit, swipe to forget, Confirm or Forget a bot's proposal), notifications and Unpair.

## Notifications

After pairing, ClaudioBot asks for permission to notify you. It posts a local notification when a bot sends a message, asks a question or needs an approval, unless that chat is on screen. Messages from one bot share a notification, so a newer one replaces the older. Each question and approval gets its own, so a later message cannot replace a card still waiting on you. An approval alert only opens the chat, so the decision is made with the exact command in view. `claudiobot://bot/<id>?message=<id>` opens that bot. A question notification offers its first two options as actions. Picking one sends the answer to the bridge.

These notifications need the socket to the Mac. When you leave the app, iOS gives ClaudioBot a short grace period, and the app keeps the socket open during it. After that iOS suspends the app, and alerts stop until you open it again. For alerts after that, the bridge can push through ntfy. Set `CLAUDIOBOT_PUSH_URL` on the Mac (see the bridge README) and subscribe to the same topic in the ntfy app. The ntfy alert names the bot, and tapping it opens ClaudioBot at that message through `claudiobot://bot/<id>?message=<id>`. Native alerts from ClaudioBot itself would need Apple Push Notification service and a relay server, which are out of scope for this version.

An app build from before protocol 3 still connects to a new bridge. It does not announce `?protocol=3`, so the bridge shows it each permission card as a question card with **Allow once** and **Deny**.

## Layout

| Path | Owns |
| --- | --- |
| `ClaudioBot/Model/Protocol.swift` | Codable mirror of the wire protocol |
| `ClaudioBot/Model/Store.swift` | `AppStore`, the reducer every server message goes through, and the alerts it returns |
| `ClaudioBot/Model/Display.swift` | Pure display rules: row badges, event line labels, time separators, time labels, library groups |
| `ClaudioBot/Model/Mentions.swift` | The composer's draft and its "@name" tokens, the "@" and "/" menus, and mentions split out of a sent message |
| `ClaudioBot/Model/Groups.swift` | Group rules: member count, suggested name, typing line, sender runs |
| `ClaudioBot/Model/Sessions.swift` | `SessionIndex`, the Sessions list as the bridge sent it, and the pure rule that groups, nests, filters and orders it; row marks and the words rows say |
| `ClaudioBot/Model/Threads.swift` | `ThreadModel` (one open thread: items by id, page cursor, controls, position), `LiveText` (streaming text, its own observable), the fold rule for finished turns, and the four most recent threads |
| `ClaudioBot/Model/Usage.swift` | How plan usage reads: share used, reset times, "Updated" lines, VoiceOver labels and the fix for each reason there are no limits |
| `ClaudioBot/Model/BridgeClient.swift` | The WebSocket, the stream cursor for replay, reconnect backoff, ping, outbox, revocation and reopening the visible bot |
| `ClaudioBot/Model/Pairing.swift` | Pairing codes, the per-device token, the socket request and Keychain storage |
| `ClaudioBot/Model/DeepLink.swift` | Every `claudiobot://` link the app opens |
| `ClaudioBot/Model/Dictation.swift` | Speech framework dictation |
| `ClaudioBot/App/` | App entry, routing, background grace period and notifications |
| `ClaudioBot/Views/Avatar.swift` | The 13 avatar shapes, the 11 colors and the character with its eyes |
| `ClaudioBot/Views/` | Screens, the chat items, the composer and the dark theme. `SessionsSidebar`, `SessionRowView`, `SessionThreadView`, `ThreadItems` and `SessionComposer` are the Sessions half |
| `ClaudioBot/Demo/` | Debug-only sample bots, and in `DemoSessions.swift` sample sessions with a stand-in for every session request |
| `ClaudioBotTests/` | Fixture round trips, reducer, permission cards, display rules, pairing, stream cursor, deep links and markdown tests |
| `ClaudioBotTests/FakeBridge.swift` | A loopback HTTP and WebSocket bridge that `BridgeClientTests` scripts to drive the real socket, pairing and close paths |
