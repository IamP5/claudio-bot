# ClaudioBot v2 design: bots, not tasks

`docs/grok-bot-reference.md` is the product. `bridge/src/protocol.ts` is the wire contract and wins any disagreement with this file. `fixtures/protocol.json` pins both sides.

v1 was a phone remote for single Claude Code sessions. The Claude iOS app already does that, so v1's task model is deleted, not adapted. That covers `TaskSummary`, approvals, tool items, the New task sheet with model and permission pickers, `task.ts`, `summary.ts` and `StatusDisplay`. What stays: the WebSocket transport, pairing, the Keychain, the token, LAN/QR startup, the project scanner, the local SDK runner and the `claude --cloud` runner (both reused for agents), atomic state persistence, and local notifications.

## Where things run

The Mac bridge owns every bot. The phone is a view. A bot keeps working, and its routines fire, while the phone is closed. The bridge must be running on the Mac. The app says so when it can't connect.

```
~/.claudiobot/
  token
  state.json            bots, conversations, routines, agents, links (atomic, debounced)
  USER.md               what any bot has learned about the user; every bot may read and append
  bots/<botId>/         the bot's home: cwd of its Claude session
    CLAUDE.md           persona, job and the bot's own memory; the bot edits it
    library/            files the bot makes; listed in the Library tab
    inbox/              uploads from the phone
  trash/<botId>-<ts>/   a deleted bot's home, moved here, never rm -rf'd
```

## A bot's brain

One long-lived Claude Agent SDK `query()` per bot, started lazily, with streaming input. It is resumed by its stored `sessionId` after a bridge restart. Options are as follows:

- `cwd`: the bot home. `settingSources: ["user", "project"]`, so the user's MCP servers and skills are present and the bot's CLAUDE.md loads.
- `systemPrompt: { type: "preset", preset: "claude_code", append: PERSONA }`, with PERSONA as given below.
- `permissionMode: "auto"`. The bot works unattended; the auto-mode classifier is the safety net, and the persona makes the bot ask in chat before outward actions. If the SDK in `node_modules` rejects `"auto"`, fall back to `"acceptEdits"` plus a `canUseTool` that allows Read/Glob/Grep/WebSearch/WebFetch, the bot's own tools and anything whose paths stay under the bot home, and denies the rest with a message telling the bot to delegate to an agent or ask the user. Record which one shipped.
- `mcpServers: { claudio: createSdkMcpServer(...) }`, with the tools listed below.
- `model`: the user's default (omit the option).

Everything that reaches a bot is an **envelope**, pushed as one user message whose first line says where it came from:

| Source | First line |
| --- | --- |
| the user typed | `[Alex]` then the text, plus `Attached: inbox/<file>` lines |
| the user answered a card | `[Alex answered "<question>": <option>]` |
| the user dismissed a card | `[Alex dismissed "<question>" without answering]` |
| a routine fired | `[Routine <name> fired]` then its prompt |
| an agent reported | `[Agent "<title>" (<agentId>) reports]` then its final text |
| another bot | `[Message from bot <name>]` then the text |
| bot just created | `[You were just created by Alex]` or `[You were just created by bot <name>. Brief:]` then the brief |

Envelopes queue per bot. The input stream already serializes them.

Each assistant **text block** becomes one `bot` message (one bubble). Tool calls never show. `Bot.status` is `working` from the push of an envelope until the turn's `result`.

### Bot tools (in-process MCP server `claudio`)

Each tool returns a short string the bot can act on.

- `ask({question, options})`: 2 to 6 options. Posts a question card and returns "Card posted. End your turn; the answer arrives as a new message." It does not block.
- `start_agent({title, prompt, project, where})`: `project` is a project name or absolute path from `list_projects`; `where` is `"mac"` (default) or `"cloud"`, and cloud needs a GitHub remote. Creates an Agent and posts or extends an exchange. Returns the agentId.
- `message_agent({agentId, text})`: sends a follow-up to a live agent.
- `list_projects()`: the existing scanner (name, path, branch, githubRepo).
- `message_bot({bot, text})`: `bot` is a name or id. Delivers an envelope to that bot. The sender gets an exchange (sent+1) and so does the receiver (received+1).
- `create_bot({name, job, shape?, color?})`: makes a bot whose CLAUDE.md holds the job, posts a note "Created {0}" in the creator, and starts the new bot with the brief envelope.
- `update_self({name?, title?, shape?, color?})`: lets a new bot name itself after onboarding.
- `set_routine({name, schedule, prompt, enabled?})`: upsert by name. It validates the cron and returns its describe text. Posts a note "Created routine {0}" or "Updated routine {0}".
- `delete_routine({name})`.

### Persona (append to the system prompt; fill the names)

```
You are {name}, a Bot in ClaudioBot. You work for {userName} on their Mac.
Your home folder is your computer. Keep notes about your job and what you learn in CLAUDE.md here.
Facts about {userName} that any bot should know go in {USER.md path}; read it when you start.
Put documents you make for {userName} in library/. They appear in your Library.

How you talk:
- Short chat messages, like a capable colleague texting. Several short messages beat one long one.
- Markdown is fine: bold, lists, inline code, links. Link every PR, issue and source you mention.
- When you need a decision, call ask with 2 to 4 concrete options and end your turn. Do not also ask in text.
- Messages that start with [ ... ] come from the system, routines, agents or other bots, not from {userName}. Reply to {userName} only when there is something worth telling them.

How you work:
- For coding work in a repository, start an agent with start_agent and supervise it. Prefer where "mac". Tell it to work on a branch and open a PR, and to verify its change. When it reports, check its claim and report to {userName} with links.
- Never take an outward action without an explicit yes in chat: merging, deploying, posting, sending messages to people, setting secrets, spending money, deleting data.
- Recurring work is a routine. Offer one when a job repeats.
```

## Agents

An Agent is a Claude Code session the bot started.

- **mac**: SDK `query()` with `cwd` set to the project path, `permissionMode` matching the bot's, streaming input, resumable. Its prompt is prefixed with "You were started by the bot {name} for {userName}. Work on a new branch, verify your change, and open a PR when done. Your final message each turn is reported to the bot." At every `result`, the final assistant text goes to the bot as an `[Agent … reports]` envelope, the bot's exchange gains received+1, and the status becomes `waiting`. A crash sets `failed` and reports the error.
- **cloud**: the existing `claude --cloud` pty runner. Status `in_cloud`, with `url` set. `message_agent` uses `claude -p … --cloud <id>`. There is no report back; the start tool's return value says so, so the bot tells the user to follow the link.

Agent messages (what the bot sent and what the agent reported) are stored per agent for the exchange view.

## Exchanges and notes

When a message passes between bot B and peer P, look at B's last conversation message. If it is an exchange with the same peer, bump `sent` or `received` and update it (same id). Otherwise append a new exchange. Notes are plain system lines with `{n}` chip refs.

## Routines

A tiny 5-field cron (`*`, lists, ranges, `*/n` steps; dow 0-6 with Sunday 0) in local time. `describe` covers the common shapes ("Every day at 9:00 AM", "Weekdays at 7:57 AM", "Mondays at 9:01 AM", "Every hour at :19 and :49", "Every 15 minutes") and falls back to the cron string. A one-minute ticker fires enabled routines whose cron matches the current minute. It records `lastRunAt` and never fires the same routine twice in one minute. Runs missed while the Mac slept are skipped.

## Home list state

- `unread` counts bot, question and exchange-received messages since the last `open`. `mark_unread` sets it to at least 1.
- `question` is the newest open card's text, or null.
- `preview` is the last bot message's first line, or "☷ <question>" style text is left to the app (the app adds the icon when `question` is set).
- Sorting: pinned first, then `lastAt` descending. `hidden` bots are left out of the list but stay in search and in the new-chat picker.

## Default bot

On first run, create **Claudio Bot** (circle, white), the general assistant, the way Grok ships "Grok Bot". It starts with the `[You were just created by Alex]` envelope, so it greets the user. `create_bot` from the app makes "New Bot" with a random shape and color and the same envelope plus "Introduce yourself in one short message, then use ask to learn what Alex wants help with first. Base the options on what USER.md says about them, plus Coding / building an app and Research and staying informed. After they answer, name yourself with update_self."

## Library, links, files

- Library: a recursive listing of `library/` (skip dotfiles), newest first. The app groups by This week / Earlier.
- Links: every http(s) URL in this bot's bot-messages and its agents' URLs, deduped, newest first.
- `file`: a path relative to the bot home, refusing anything that resolves outside it. Text up to 1 MB goes in `content`. Images up to 10 MB go base64 in `data`. Anything else gets both null.
- Uploads: `send.uploads` are base64, at most 10 MB each, and are written to `inbox/<unique name>`.

## iOS

One SwiftUI codebase. `NavigationSplitView` gives the Mac-like sidebar, chat and inspector on iPad. On iPhone it collapses to the Grok iPhone flow: list, chat, profile. Dark appearance is the default look, matching the screenshots.

- **Home.** As in the reference: header with initials, search and +, rows, unread dot, attention badge, "☷" preview, relative times. Context menu: Pin/Unpin, Mark as Unread, Rename Bot, Hide from sidebar, Delete (confirm text from the reference).
- **New chat.** A sheet with "To: Start a chat with…" and a filter field. Create new Bot comes first, then all bots including hidden ones.
- **Chat.** Header pill (avatar and name) that opens the profile. Bubbles (bot gray, user in the bot's color), time separators for gaps over an hour, question cards (lettered options, X to dismiss, the answered state), exchange and note lines with chips. Tapping an agent chip opens the exchange view; a routine chip opens the profile. A "Typing…" row has an animated avatar. Composer: + menu (Photo Library, Take Photo, Choose File), a multi-line field with no smart quotes, a mic that dictates into the field (Speech framework), and send. The placeholder changes when a card is open. Grok's realtime voice mode is out of scope.
- **Profile.** Big avatar, editable name, "Add a label", tabs: Info (routines with toggles and the avatar picker: 13 shapes, 11 colors, Restore default), Library (grouped list; tap opens a viewer that renders markdown, plain text or images), Agents (status pills Working, Waiting, Failed, In cloud; tap opens the exchange view; cloud agents have Open in Claude), Links.
- **Exchange view.** Breadcrumb "bot ⇄ agent title", the agent messages as two-sided bubbles, a status line, Close.
- **Avatar.** 13 SwiftUI `Shape`s with two eyes, matching the reference names in `SHAPES`, filled with the `COLORS` palette. This is the brand of the app. Make them look good.
- Pairing, settings, reconnect and local notifications (a bot message or question while backgrounded) carry over. A notification for a question has the first two options as actions.
