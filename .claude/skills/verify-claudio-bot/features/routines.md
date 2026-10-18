# Routines

A bot can schedule its own work: a cron routine in local time shown as "Every day at 3:00 AM", or a webhook routine shown as "When its webhook is called" that a program on the Mac fires with a token. The bot's profile lists routines with an on/off switch, Run now and the last runs. A run with nothing to report posts nothing.

## Sub-features

- `routine-create` `set_routine` from chat adds a routine to the bot frame with a human `describe` and posts a `Created routine {0}` note.
- `routine-run-now` Run now (`run_routine`) starts a run whose status settles in `runs[0]`.
- `routine-toggle` the switch (`set_routine` client message with `enabled`) turns it off and `nextRunAt` clears.
- `routine-quiet` a run with nothing worth reporting posts no bot message.
- `routine-webhook` a webhook routine fires once per call (202), throttles a second call (429), refuses a browser `Origin` (403) and a rotated token (401).

## How to get to it (user POV)

- Ask a bot in chat ("every weekday at 9, check my repo").
- The bot's profile, Routines: switch, Run now, run history; a webhook routine's Copy URL and token.

## Driving it with control-claudio

Preconditions:

- Claudio Bot is resting and has no routines (`$H bots` shows `routines=0`).

- **Create.** Run `$H send "Claudio Bot" 'Call set_routine now with name "ping", schedule "0 4 * * *", prompt "Tell Alex the single word pong. That is always worth telling." Then confirm in one line.'`. A `note` line `Created routine {0}`. Second view: `$H raw '{"type":"details","botId":"<id>"}' --frames details` lists `ping` with `describe` `Every day at 4:00 AM` and a `nextRunAt`.
- **Run now.** Run `$H raw '{"type":"run_routine","botId":"<id>","routineId":"<routineId>"}' --frames bot --for 2`, then `$H wait "Claudio Bot" --timeout 240`. A `bot` line says `pong`, and `details` shows `runs[0].status` `ok`.
- **Toggle.** Run `$H raw '{"type":"set_routine","botId":"<id>","routineId":"<routineId>","enabled":false}' --frames bot`. The bot frame's routine has `enabled:false` and `nextRunAt:null`; `state.json` agrees.
- **Webhook.** Ask for `set_routine` with `trigger "webhook"` and no schedule, then mint a token with `$H raw '{"type":"webhook_token","botId":"<id>","routineId":"<routineId>"}' --frames webhook_token`. `curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"sha":"abc"}' <url>` prints `202`; a second call inside a minute prints `429`; adding `-H 'origin: https://evil.example'` prints `403`. The bot then posts a line with `abc`.
- **Proof.** Run `$H evidence routines`; cite the `details` frame and the curl codes.

## Gotchas

- Do not wait for a cron time; use Run now. Schedules are local time on the Mac.
- `set_routine` is both a bot tool (create, with schedule and prompt) and a client message (the switch, with `enabled`); they are different shapes.
- A routine that asks a question keeps the routine as the turn's initiator, so a follow-up tool call may open a card a user turn would not.
- The webhook URL is loopback only (`127.0.0.1:<webhookPort>`); the token is shown once, never logged.
- The daily cap holds routine runs once reached; a run that never starts may be the cap, check `$H doctor` spend and the bot's `spentTodayUsd`.
