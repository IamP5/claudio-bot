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

Debug builds accept `-demo`. It loads sample bots into the store through the same reducer the bridge feeds, with no bridge running. Add `-demoScreen <name>` to open a screen directly. The names are `home`, `newchat`, `chat`, `profile`, `links`, `library`, `file`, `agent`, `digest`, `engineer`, `factory`, `pair`, `settings`, `routine` and `approval`. The pairing and connection states have their own: `pairconfirm` and `outdated` while unpaired, and `confirm`, `unrecognized`, `error` and `oldbridge` while paired.

`scripts/screenshots.sh <udid> <path/to/ClaudioBot.app>` launches each screen and saves PNGs to `screenshots/`.

`scripts/avatar-sheet.sh <out.png>` builds the avatar code for macOS and renders all 13 shapes and 11 colors to one image. Use it to tune the shapes without a simulator.

The app icon comes from `scripts/make-icon.swift`:

```sh
swift ios/scripts/make-icon.swift ios/ClaudioBot/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```

## Pairing

1. On your Mac, run `bun run start` in the `bridge` folder. It prints a QR code, the bridge address and a one-time pairing code. A phone that is already paired can show a code too, under Settings, Pair another device.
2. In ClaudioBot, tap Scan QR code, or type the address (for example `ws://10.0.0.20:7878/ws`) and the code. A bare host and port gets the `/ws` path. Any other path must end in `/ws`.
3. Confirm the bridge's host and port. When the phone is already paired, the prompt also names the Mac it replaces. Nothing reaches the bridge before you tap **Pair**.
4. The app posts the code and the phone's name to `/pair` beside the socket path, so `wss://host/prefix/ws` pairs at `https://host/prefix/pair`. The bridge answers with a token for this phone only.
5. The app opens a socket with the new token and waits for the bridge's hello. Only then does it save the address and token in the Keychain and switch to the new Mac. If the code is refused or no hello arrives, the old pairing stays and the form shows why.

The QR code encodes `claudiobot://pair?url=<urlencoded ws url>&code=<code>`. Opening that link shows the same confirmation. A link from a protocol 2 bridge carries `token=` instead of `code=`, and the app asks you to update the bridge.

The socket sends the token as `Authorization: Bearer <token>`. A phone paired before protocol 3 trades its shared token for its own on the first protocol 3 hello: it asks for a pairing code over its socket, redeems it at its own bridge, saves the new token and reconnects. Until that works it keeps the shared token in the URL and tries again every 10 minutes.

On a reconnect the app passes `epoch` and `after` from the last frame it applied, and the bridge replays what it missed. A broadcast whose `seq` is not the next one, or an undecodable frame that carries a `seq`, means frames were lost. The app then drops the socket and reconnects without `epoch` and `after` for a fresh hello.

Settings lists every paired phone. Revoking one closes its socket with code 4001, and that phone returns to the pairing screen. Only that close code unpairs. A 401 on connect may come from another server on the network the phone is on, so the app keeps the pairing and shows **Not recognized** with **Pair again** and **Retry**. Returning to the app retries too. **Unpair this Mac** revokes this phone on the bridge first when connected, then deletes the pairing and clears the app's notifications.

The phone and the Mac need to reach each other. The same Wi-Fi network works, and so does Tailscale from anywhere. Plain `ws://` is allowed for local addresses and `*.ts.net` names only.

## Screens

**Home.** One row per bot, pinned bots first, then the newest activity. A blue dot means unread. An orange star badge on the avatar means the bot asked you something, and the row shows that question. Long-press a row to pin, mark as unread, rename, hide or delete the bot. The initials button opens Settings, and + opens the new chat picker.

**New chat.** Create new Bot comes first. The bridge makes the bot, and the app opens it as soon as it exists. Every bot follows, hidden ones included.

**Chat.** Bot messages are gray bubbles with markdown. Your messages use the bot's color. A centered time appears before the first message and after every gap of more than an hour. A question card lists lettered options. Tap one to answer, or tap X to dismiss it. You can also type a free answer while it is open. A question with a deadline closes as Expired when nobody answers in time.

A permission card holds a tool call the bot or one of its agents wants to run. It shows the rule that asked, the exact command in monospace and what Always would cover. Allow once, Always allow, Deny and Never are the only way a held call runs. Typing in the chat never approves one. An unanswered card expires at its deadline and the call does not run. Centered gray lines show what the bot did on its own, such as "Messaged standup notes" or "4 messages with Set up verification skill". Tap one to open that agent, bot or routine. While the bot works, its avatar bobs beside "Typing…", and Stop ends the turn. A bot waiting on a permission card wears an Awaiting approval chip in the list and the chat. A bot paused by the usage limit or its daily cap wears Parked.

The composer's + menu attaches a photo from the library, a new photo or a file. Each upload can be up to 10 MB. The mic dictates into the field with the Speech framework.

**Profile.** Tap the name pill at the top of a chat. You can edit the name and the label. The tabs are Info (routines with on and off switches, and the avatar picker; tap a routine for its next run, its last runs and Run now), Library (files the bot made), Agents (coding agents it started, with their status) and Links (every link in the conversation). On iPhone the profile is its own screen. On iPad it opens as a column beside the chat.

**Exchange.** What a bot and one of its agents said to each other, with the agent's status. A working agent has Stop. Cloud agents have Open in Claude.

**Settings.** The Mac, the paired phones with Revoke, Pair another device (a code and its QR code), notifications and Unpair.

## Notifications

After pairing, ClaudioBot asks for permission to notify you. It posts a local notification when a bot sends a message, asks a question or needs an approval, unless that chat is on screen. Messages from one bot share a notification, so a newer one replaces the older. Each question and approval gets its own, so a later message cannot replace a card still waiting on you. An approval alert only opens the chat, so the decision is made with the exact command in view. `claudiobot://bot/<id>?message=<id>` opens that bot. A question notification offers its first two options as actions. Picking one sends the answer to the bridge.

These notifications need the socket to the Mac. When you leave the app, iOS gives ClaudioBot a short grace period, and the app keeps the socket open during it. After that iOS suspends the app, and alerts stop until you open it again. Alerts on a locked phone at any time would need Apple Push Notification service and a relay server. That is out of scope for this version.

## Layout

| Path | Owns |
| --- | --- |
| `ClaudioBot/Model/Protocol.swift` | Codable mirror of the wire protocol |
| `ClaudioBot/Model/Store.swift` | `AppStore`, the reducer every server message goes through, and the alerts it returns |
| `ClaudioBot/Model/Display.swift` | Pure display rules: row badges, event line labels, time separators, time labels, library groups |
| `ClaudioBot/Model/BridgeClient.swift` | The WebSocket, the stream cursor for replay, reconnect backoff, ping, outbox, revocation and reopening the visible bot |
| `ClaudioBot/Model/Pairing.swift` | Pairing codes, the per-device token, the socket request and Keychain storage |
| `ClaudioBot/Model/DeepLink.swift` | Every `claudiobot://` link the app opens |
| `ClaudioBot/Model/Dictation.swift` | Speech framework dictation |
| `ClaudioBot/App/` | App entry, routing, background grace period and notifications |
| `ClaudioBot/Views/Avatar.swift` | The 13 avatar shapes, the 11 colors and the character with its eyes |
| `ClaudioBot/Views/` | Screens, the chat items, the composer and the dark theme |
| `ClaudioBot/Demo/` | Debug-only sample bots |
| `ClaudioBotTests/` | Fixture round trips, reducer, permission cards, display rules, pairing, stream cursor, deep links and markdown tests |
| `ClaudioBotTests/FakeBridge.swift` | A loopback HTTP and WebSocket bridge that `BridgeClientTests` scripts to drive the real socket, pairing and close paths |
