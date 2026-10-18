# Mac agents

A bot hands repository work to a Claude Code agent on the Mac: the chat shows "Messaged ⚙ <title>" and later "Message from ⚙ <title>", and after each agent turn the bridge reads git (branch, commits ahead, dirty files, PR URL) so the bot reports facts, not the agent's claims. An agent can work in its own worktree on a `claudio/…` branch, which only the user removes, and never while it holds uncommitted work or an `.env`.

## Sub-features

- `agent-start` `start_agent` with `where "mac"` creates an agent on a project under the roots.
- `agent-report` the agent's report reaches the bot as an `exchange`, and the bot repeats the bridge's git line.
- `agent-evidence` `details` lists the agent with `evidence.branch`, `ahead`, `dirty`.
- `agent-worktree` `isolate "worktree"` puts the work under `CLAUDIOBOT_WORKTREES` on a `claudio/…` branch; the main checkout is untouched.
- `agent-remove-worktree` removal is refused while the worktree holds `.env`, and succeeds once it does not; the branch stays.
- `agent-stop` Stop on an agent (`stop_agent`) ends its turn with `Stopped by Alex.`.

## How to get to it (user POV)

- Ask a bot in chat to do work in a project "using an agent on the Mac".
- Tap the "Messaged ⚙ …" line to open the agent's thread; the bot's profile, Agents, to see status, spend and Remove worktree.

## Driving it with control-claudio

Preconditions:

- Claudio Bot is resting. `demo` exists under `<run>/roots/` with a clean `main`.

- **Start.** Ask for the agent. Run `$H send "Claudio Bot" 'Call start_agent now with where "mac", project "demo", title "Add hello file", and this prompt: "Create hello.txt in the repository root containing exactly the line: hello from agent. Commit it on a new branch named hello-branch. There is no remote: do not push and do not open a PR. Then reply DONE." When the agent reports, tell me in one line the branch and the number of commits ahead from the bridge'"'"'s Git line.'`. An `exchange` line with `peer=agent:Add hello file sent=1`.
- **Report.** Note the last index, then run `$H wait "Claudio Bot" --since <index> --timeout 300` until the exchange shows `received>=1` and a `bot` line names `hello-branch` and `1`. Second view: `git -C <run>/roots/demo log -1 --name-only --format=%s hello-branch` lists `hello.txt`.
- **Evidence.** Run `$H raw '{"type":"details","botId":"<id>"}' --frames details`. The agent `Add hello file` has `where":"mac"`, `status":"waiting"`, and `evidence` with `branch":"hello-branch"`, `ahead` ≥ 1, `dirty":false`.
- **Worktree.** Ask for a second agent with `, isolate "worktree"` after the title and a prompt to create and commit `wt.txt`. `state.json` `agents[].agent.worktree.path` is under `<run>/worktrees/demo/` and `branch` starts with `claudio/`; `<run>/roots/demo` has no `wt.txt` and its `HEAD` did not move.
- **Remove worktree.** Write `TOKEN=x` to `<worktree>/.env`, run `$H raw '{"type":"remove_worktree","agentId":"<agentId>"}' --frames error,agent --for 10`: an `error` frame names `.env` and the folder stays. Delete the `.env`, run it again: an `agent` frame with `worktree: null`; the folder is gone and `git -C <run>/roots/demo branch --list <branch>` still lists the branch.
- **Proof.** Run `$H evidence mac-agents`. `repos.txt` shows the commits; `conversations.txt` the exchange.

## Gotchas

- Claude Code's auto-mode classifier may refuse `start_agent`; the bot then ends its turn with no agent. Send one plain confirmation (see SKILL.md) and record it.
- Agent turns take minutes; use `--timeout 300` and `wait`, not repeated `send`s.
- The agent's own message saying "DONE" is not proof; the commit and `evidence` are.
- The agent cannot `git push` to anything but `<run>/origin.git` (no SSH agent, no token); a push to `main` opens a card in the bot's chat (see approvals).
- `where "cloud"` is refused by the wrapper (`<run>/cloud-attempt.txt` appears); it is not verifiable here.
