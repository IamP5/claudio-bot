# Chat turn

The user opens a bot's chat, types a message and gets the bot's reply as one or more bubbles; while the bot works its status is `working`, and Stop ends a running turn with a `Stopped by Alex` note instead of an error. A message the app resends after a dropped connection posts once.

## Sub-features

- `chat-greeting` a new bot greets the user unprompted on first start.
- `chat-reply` a sent message gets a reply and the bot returns to `idle`.
- `chat-resend` the same `clientId` sent twice posts one user message, echoed to both sends.
- `chat-activity` a protocol 3 phone receives `activity` frames naming what the bot does, cleared when the turn ends.
- `chat-stop` Stop ends a running turn, kills its command, and posts `Stopped by Alex`.

## How to get to it (user POV)

- Home, tap a bot, type in the composer, tap Send.
- The Stop button in the chat while the bot is working.
- A notification's reply (same `send` message).

## Driving it with control-claudio

Preconditions:

- Claudio Bot exists and its greeting turn has ended (`$H bots` shows `status=idle`).

- **Greeting.** Open the chat. Run `$H messages "Claudio Bot"`. Two or more `bot` lines greet Alex by name; `status=idle`.
- **Reply.** Send a message. Run `$H send "Claudio Bot" "Reply with exactly the word marigold and nothing else."`. A `user` line, then a `bot` line containing `marigold`, then `status=idle`. Second view: `grep '^result bot' <run>/bridge.log` shows one more `result` line for this bot.
- **Resend.** Send the same message twice with one `clientId`. Run `$H raw '{"type":"send","botId":"<id>","text":"Reply OK.","uploads":[],"clientId":"dup-1"}' --frames message --for 1` twice in a row. Then `$H wait "Claudio Bot"` and `$H messages "Claudio Bot" --json`: exactly one `user` message has `clientId` `dup-1`.
- **Activity.** Ask for a tool call. Write `lantern` to `<run>/home/bots/<id>/activity-check.txt`, then run `$H raw '{"type":"send","botId":"<id>","text":"Use the Read tool on activity-check.txt in your home folder and reply with only the word in it.","uploads":[]}' --frames activity --for 40`. At least one `activity` frame has a non-null `text`, and the last has `text: null`.
- **Stop.** Start a long command, then press Stop. Run `$H send "Claudio Bot" --no-wait 'Run this exact shell command in the foreground and wait for it: python3 -c "import time; time.sleep(61.5)"'`, wait until `pgrep -f sleep.61.5` prints a pid, then `$H stop "Claudio Bot" --wait`. A `note` line reads `Stopped by Alex`, no note says `crashed` or `stopped with an error`, and `pgrep -f sleep.61.5` prints nothing a second later.
- **Proof.** Run `$H evidence chat-turn`. `conversations.txt` shows the exchange; `audit/` holds the `Read` and `Bash` rows.

## Gotchas

- Right after launch the greeting is still running (`status=working`); `send` waits, but a `raw` send would queue behind it.
- A bot splits one reply into several `bot` bubbles by paragraph; join them before matching text.
- The greeting asks a question. Answering it is fine; it is not a card.
- `--wait` on `decide`, `answer` and `stop` takes an optional number of seconds; put it last.
