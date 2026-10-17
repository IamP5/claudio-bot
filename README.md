# ClaudeBot

Grok Bot for Claude. You keep a few bots, each with one job. A bot remembers you, runs routines on a schedule, starts Claude Code agents on your Mac or in the cloud and checks their work, and asks you with question cards before it does anything risky. The bots live on your Mac and keep working while your phone is closed.

- `bridge/` runs on your Mac. It is a Bun server that runs every bot and agent through the Claude Agent SDK on your own `claude` login. See `bridge/README.md`.
- `ios/` is the SwiftUI app for iPhone and iPad. See `ios/README.md`.
- `docs/grok-bot-reference.md` describes the Grok Bot behaviour this copies. `docs/design.md` describes how ClaudeBot does it.
- `bridge/src/protocol.ts` is the WebSocket contract. `fixtures/protocol.json` pins it on both sides.
- `decisions.tsv` logs the design decisions made while building it.

## Quick start

```bash
cd bridge && bun install && bun run start
```

Open `ios/ClaudeBot.xcodeproj`, run it on a simulator or your iPhone, and scan the QR code the bridge prints. Claude Bot greets you. Tap + and choose Create new Bot to make another one.
