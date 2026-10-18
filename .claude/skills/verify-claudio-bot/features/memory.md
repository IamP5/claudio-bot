# Memory

What a bot learns about the user becomes a proposal in `USER.md`; the user sees it under Settings, Memory, and once confirmed every bot knows it. The user can also add, edit and forget facts there, and a fact added by hand reaches the bot's next turn even though it was never said in chat.

## Sub-features

- `memory-propose` the bot's `remember` tool writes the fact marked `proposed:<botId>` and opens no card in a user turn.
- `memory-confirm` `confirm_fact` drops the proposal mark.
- `memory-set` `set_fact` with `factId: null` adds a confirmed fact by the user (`by: null`).
- `memory-recall` a set fact reaches the bot's next query.
- `memory-forget` `forget_fact` removes it from `USER.md` and the `memory` frame.

## How to get to it (user POV)

- Tell a bot something about yourself in chat.
- Settings, Memory: Confirm or Forget a proposal, tap to edit, swipe to forget, add a fact.

## Driving it with control-claudio

Preconditions:

- Claudio Bot is resting. `<run>/home/USER.md` exists.

- **Propose.** Run `$H send "Claudio Bot" "Remember with your remember tool that I prefer short answers. Then reply with just OK."`. No `permission` line. Second view: `grep -i 'short answers' <run>/home/USER.md` shows the fact with `proposed:<botId>`; the audit row for `mcp__claudio__remember` has `decision":"pass"`.
- **List.** Run `$H raw '{"type":"memory"}' --frames memory`. A fact with that text has `confirmed:false` and `proposerBotId` the bot's id.
- **Confirm.** Run `$H raw '{"type":"confirm_fact","factId":"<factId>"}' --frames memory`. The fact now has `confirmed:true`; its `USER.md` line no longer contains `proposed:`.
- **Set and recall.** Run `$H raw '{"type":"set_fact","factId":null,"text":"Alex'"'"'s favorite color is chartreuse-nine"}' --frames memory`, then `$H send "Claudio Bot" "Going only by what you know about me, what is my favorite color? Reply with only the color."`. The reply contains `chartreuse-nine`.
- **Forget.** Run `$H raw '{"type":"forget_fact","factId":"<factId>"}' --frames memory`. The fact is absent from the frame and from `USER.md`.
- **Proof.** Run `$H evidence memory`; `USER.md` and `audit/` are in it.

## Gotchas

- `USER.md` is shared by every bot of the run; facts from earlier journeys in the same run stay unless forgotten.
- A `remember` call in a routine or answer turn may be held for approval instead of passing (see routines).
- The model may paraphrase the fact; match loosely on `USER.md`, exactly on ids in frames.
