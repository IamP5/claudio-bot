# Grok Bot, as observed

Observed on 2026-10-17 in the user's Grok Bot app on macOS and on their iPhone through iPhone Mirroring. Screenshots are in `reference/grok/` (gitignored, local only, they contain personal chats).

ClaudeBot copies this product. It is not a remote control for one Claude Code session. The Claude iOS app already does that.

## The model

A **Bot** is a persistent assistant with one long-running conversation. It is not a task. The user keeps a handful of bots, each with one job ("tech news", "engineer", "linkedin coach"). A bot remembers the user across days, does real work on its own computer, runs on a schedule, delegates coding to agents, and talks to other bots.

## Home (sidebar on Mac, root list on iPhone)

- Top bar: account avatar (initials), search, `+` (new chat).
- One row per bot, newest activity first. Row: avatar, bot name, one-line preview of the last message, relative time on iPhone ("00:14", "Ontem", "quinta-feira", "9 de out.").
- A blue dot on the right means unread.
- A small orange badge on the avatar means the bot is waiting on the user. The preview then starts with a list icon and the open question ("☷ Want me to merge any of these now?").
- Right-click (Mac) on a row: Pin, Move to new section, Mark as Unread, Rename Bot, Copy conversation ID, Hide from sidebar, Delete. Delete confirms: "This permanently deletes the Bot and its chat history. This can't be undone."
- Bottom of the Mac sidebar: account menu, "Connect apps" (integrations catalog).

## Avatar

A flat blob character with two eyes. 13 shapes (circle, cloud, rounded diamond, four-point star, flower, lumpy cloud, scalloped circle, teardrop, pill, rounded triangle, rounded pentagon, six-point star, hexagon) and 11 colors (white, brown, red, orange, amber, green, teal, blue, purple, pink, gray). "Restore default" resets it. The bot's color tints the user's own bubbles in that chat, the answered-option letter and the voice button.

## Conversation

- Header: centered pill with avatar and bot name. Tapping it opens the profile/details. iPhone adds back and a `…` menu (View Profile, Share as template).
- Bot messages are short gray bubbles, left aligned, markdown (bold, numbered lists, inline code, links with a site icon such as a GitHub mark before "#19").
- A bot often sends several bubbles in a row. A last short bubble restates the question.
- User messages are right aligned in the bot's color.
- Centered day/time separators ("Thu, Oct 15 3:08 PM").
- While the bot works, its avatar animates and a "Typing…" row shows.
- Composer: `+` (Attach image, Take photo, Choose file), text field, mic (dictation), a voice-mode button tinted with the bot color. The placeholder is "Message <bot>". It changes to "Type your answer, or talk about something else" while a question card is open.

### Question card

- A card with the question in bold and lettered options (A, B, C, D). Tapping an option answers it. iPhone adds an X to dismiss without answering.
- Once answered, the card dims: the question is gray and only the chosen option remains, its letter in the bot color.
- Typing a free-text reply is allowed while the card is open.
- Bots ask before risky actions this way ("Should I add the CRON_SECRET in production and start merging from #18?"). Permission is a conversation, not a modal.

### Event lines (centered, small, gray)

- "Created routines ⏱ transcript-healthcheck and ⏱ routine-healthcheck". The names are tappable.
- "Messaged 🔴 linkedin coach" (this bot sent a message to another bot).
- "4 messages with ⚙ Set up pstack verification skill for solta-o-som" (an exchange with an agent this bot started).
- "Message from ⚙ Set up pstack verification skill for solta-o-som" (the agent reported back).
- Tapping an exchange opens it in place. A breadcrumb reads "engineer ⇄ Set up pstack verification skill…", with a "Close Chat" button at the bottom.

## Details panel (Mac right panel, iPhone profile screen)

Avatar, name, "Add a label" (optional title), then tabs:

- **Details / Info.** Routines: rows with name, human schedule ("Weekdays at 7:57 AM", "Every hour at :19 and :49") and a toggle (Paused when off). When there are none: "Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up." The iPhone Info tab also holds the avatar picker.
- **Library / Documents.** Files the bot made, grouped by time ("This week": `comment-prune-plan.md`). When empty: "Pages, files, and apps this Bot makes show up here."
- **Computer.** The bot's own cloud machine. "Computer is asleep" with a "Wake" button, and a live view titled "Grok Bot's screen".
- **Links** (iPhone). Every link the conversation produced, as host plus URL rows (GitHub PRs, agent pages).

## Creating bots

- `+` opens a "To: Start a chat with…" picker listing: Create new Bot, Create group chat, then every bot.
- "Create new Bot" makes a bot named "New Bot" at once. It greets the user by name ("Hey Bruno, I'm New Bot. I'm here to take real work off your plate…"), then asks a question card: "What would you most like help with first?" The options come from what it already knows about the user, plus generic ones (Coding / building an app; Inbox, calendar and scheduling; Research and staying informed).
- The user also made a bot-factory bot ("dr eggbot") that designs bots from a description. It creates them, messages them their brief, and reports: "I made 🔴 linkedin coach. Its one job is…". It says "If you hate it, right-click it in the sidebar and choose Delete."

## Behaviour seen in the user's bots

- **tech news.** A weekday 7:57 AM routine posts a numbered digest where every item links its source, and says which sources failed.
- **engineer.** Coordinates engineering by spawning a cloud agent per piece of repo work. It supervises the agent until the change is verified and reports PR status. It does not write code itself. It has a weekday upkeep routine.
- **Grok Bot** (the default bot). Tracks a stack of PRs, refuses to merge without a yes, and asks with question cards.
- **Engineering Lead.** Runs production chores on request ("give X premium") and reports what it changed.
- Bots never take outward actions (post, merge, set secrets) without an explicit yes in chat.
