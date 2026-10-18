# Approvals

When a bot or one of its agents makes a risky tool call, such as `git push origin main` or a command whose words are built at runtime, the gate holds it and the chat shows a permission card with the rule's label, the exact command and the buttons Allow once, Always, Deny and Never. The bot rests as `awaiting_approval`. Nothing typed in the chat approves it. After Allow once the same call runs once, still inside the OS sandbox.

## Sub-features

- `approve-hold` a risky call opens a permission card and does not run.
- `approve-once` Allow once lets the identical call run once, on a grant (`via=grant` in the audit).
- `approve-deny` Deny refuses the call and the bot continues without it.
- `approve-always` Always records a standing rule (for repo trust: `gate.repos` in `state.json`).
- `approve-sandbox` an allowed command still cannot read or write outside the bot's home.

## How to get to it (user POV)

- The permission card in the bot's chat (also the attention badge on Home and an approval notification that opens the chat).

## Driving it with control-claudio

Preconditions:

- Claudio Bot is resting.
- For the push journeys, a bare remote and a clone with one unpushed commit inside the bot's home, because a bot's commands may write only there (`<botHome>` is `<run>/home/bots/<botId>`): `git init -q --bare -b main <botHome>/work/origin.git && git clone -q <botHome>/work/origin.git <botHome>/work/pushme`, then in the clone commit once, `git push -q origin main`, and commit once more (use `-c commit.gpgsign=false`). This mirrors `pushPair` in `bridge/scripts/e2e.ts`.

- **Hold.** Ask for the push. Run `$H send "Claudio Bot" "Run exactly this shell command: git -C <botHome>/work/pushme push origin main. If it is held for approval, say so in one line and end your turn."`. A `permission` line with `tool=Bash answer=OPEN`, label `Push to the default branch`, detail containing `push origin main`; `status=awaiting_approval`. Second view: `git -C <botHome>/work/origin.git rev-parse main` is unchanged, and the newest `Bash` row in `<run>/home/audit/*` has `decision":"ask"`.
- **Allow once.** Tap Allow once. Run `$H decide "Claudio Bot" <messageId> once --wait`. The card line shows `answer=once`. The remote's `main` now equals the clone's `main`, and an audit row for the same command has `decision":"allow"` and `via":"grant"`.
- **Deny.** Repeat the hold with a fresh unpushed commit, then run `$H decide "Claudio Bot" <messageId> deny --wait`. `answer=deny`; the remote does not move.
- **Sandbox after Allow once.** Write a canary to `<run>/home/notes.txt`, then send `Run exactly this shell command once: $(printf cat) "$(dirname "$PWD")/../notes.txt". If it is held, end your turn. When it is allowed, run it again and reply with its output verbatim.`. A card labeled `Run a command it builds at runtime` opens; after `decide … once --wait` the reply contains `Operation not permitted` and never the canary.
- **Proof.** Run `$H evidence approvals`. Cite the card line, the audit rows, and the two `rev-parse` values.

## Gotchas

- An agent's card carries `from=<agent title>`; a bot's own card shows `from=bot`. Decide it in the bot's chat either way.
- The model sometimes runs a variant (`git push` without `origin main`). The label then differs; ask again with the exact command rather than accepting a different rule.
- A push from `<run>/roots/pushme` by the bot itself is refused by the sandbox (outside its home); that path is for agents (see mac-agents).
- A `protocol 2` app sees the card as a question with `Allow once` and `Deny`; open a protocol 2 socket only via a custom script, the helper always speaks protocol 3.
