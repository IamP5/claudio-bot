# ClaudeBot for iPhone

ClaudeBot lets you hand coding tasks to Claude from your phone. You chat with each task, approve tool calls from cards, answer Claude's questions with a tap, and get a notification when Claude needs you or finishes. Each task runs either in Claude Code on your Mac or in a Claude Code cloud session.

The app talks to one thing only: the bridge in `../bridge`, over a single WebSocket. The wire contract is `../bridge/src/protocol.ts`, and `../fixtures/protocol.json` holds a sample of every message. `ClaudeBot/Model/Protocol.swift` mirrors that file, and the tests decode every fixture.

## Build and run

Requirements are Xcode 26 and an iOS 18.0 or later simulator or device. There are no package dependencies.

```sh
open ios/ClaudeBot.xcodeproj
```

The generated project is committed. After you add or move files, regenerate it from `project.yml`:

```sh
cd ios && xcodegen generate
```

Build and test from the command line:

```sh
xcodebuild -project ios/ClaudeBot.xcodeproj -scheme ClaudeBot \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' build test
```

To run on your own iPhone, pick your team under Signing & Capabilities for the ClaudeBot target.

### Demo mode and screenshots

Debug builds accept `-demo`, which loads sample tasks into the store without a bridge. Add `-demoScreen home|new|task|cloud|pair|settings` to open a screen directly. `scripts/screenshots.sh <udid> <path/to/ClaudeBot.app>` launches each screen and saves PNGs to `screenshots/`.

The app icon comes from `scripts/make-icon.swift`:

```sh
swift ios/scripts/make-icon.swift ios/ClaudeBot/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```

## Pairing

1. On your Mac, run `bun run start` in the `bridge` folder. It prints a QR code, the bridge address and a token.
2. In ClaudeBot, tap Scan QR code, or type the address (for example `ws://192.168.1.20:7878/ws`) and the token.
3. The app connects once to check the pair before it saves anything. The address and token live in the Keychain on this device.

The QR code encodes `claudebot://pair?url=<urlencoded ws url>&token=<hex>`. Opening that link on the phone pairs it the same way.

The phone and the Mac need to reach each other. The same Wi-Fi network works, and so does Tailscale from anywhere. Plain `ws://` is allowed for local addresses and `*.ts.net` names only.

## Mac tasks and cloud tasks

When you start a task you choose where it runs.

**Mac.** The bridge runs Claude Code in the project folder on your Mac, with your own Claude login. Every message, tool call and result streams into the chat. When Claude wants to edit a file or run a command, the bridge holds the call and the app shows an approval card with Deny, Always allow and Allow. Questions from Claude appear as tappable options.

**Cloud.** The bridge starts a Claude Code cloud session on the project's GitHub repository, so only projects with a GitHub remote are listed. The session runs on Anthropic's infrastructure and keeps going when your Mac sleeps. Its live output streams in the Claude app rather than in ClaudeBot. The task screen shows a banner and an Open in Claude button that hands the claude.ai/code link to the Claude app. Follow-ups you send from ClaudeBot are queued to the session by the bridge.

## Notifications

After pairing, ClaudeBot asks for permission to notify you. It posts a local notification when an approval or question arrives, or when a task finishes or fails, unless you are looking at that task. Approval notifications have Allow and Deny actions that send the decision straight to the bridge.

These notifications need the socket to the Mac. When you leave the app, iOS gives ClaudeBot a short grace period, and the app keeps the socket open during it. After that iOS suspends the app and alerts stop until you open it again. Alerts that reach a locked phone at any time would need Apple Push Notification service and a relay server that the bridge can post to. That is out of scope for this version.

## Layout

| Path | Owns |
| --- | --- |
| `ClaudeBot/Model/Protocol.swift` | Codable mirror of the wire protocol |
| `ClaudeBot/Model/Store.swift` | `AppStore`, the reducer every server message goes through, and home list grouping |
| `ClaudeBot/Model/BridgeClient.swift` | The WebSocket, reconnect backoff, ping and resubscribe |
| `ClaudeBot/Model/Pairing.swift` | Pairing parsing and Keychain storage |
| `ClaudeBot/App/` | App entry, routing, background grace period and notifications |
| `ClaudeBot/Views/` | Screens and transcript item views |
| `ClaudeBot/Demo/` | Debug-only sample data |
| `ClaudeBotTests/` | Fixture decoding, reducer, pairing and markdown tests |
