# ClaudeBot

A Grok Bot style iPhone app for Claude. Start coding tasks from your phone, approve Claude's edits and commands from cards in the chat, and choose where each task runs: Claude Code on your Mac, or a Claude Code cloud session.

- `bridge/` runs on your Mac. It is a Bun server that runs Claude Code through the Claude Agent SDK, using your own `claude` login. See `bridge/README.md`.
- `ios/` is the SwiftUI app. See `ios/README.md`.
- `bridge/src/protocol.ts` is the WebSocket contract. `fixtures/protocol.json` pins it on both sides.
- `decisions.tsv` logs the design decisions made while building it.

## Quick start

```bash
cd bridge && bun install && bun run start
```

Open `ios/ClaudeBot.xcodeproj`, run it on a simulator or your iPhone, and scan the QR code the bridge prints.
