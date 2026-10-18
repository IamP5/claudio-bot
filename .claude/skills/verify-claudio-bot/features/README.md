# ClaudioBot verification map

This directory is the maintained source for verifying ClaudioBot's user-facing behavior. Each file is one feature as the iPhone app user meets it, with the socket messages the app sends for each step. Read this index, then the feature file, before driving.

## Baseline preconditions

- A run started with `$H launch` (`H=.claude/skills/verify-claudio-bot/bin/control-claudio.ts`, from the repo root) printed `READY`.
- `$H doctor` exits 0, and `HEAD` is the build under test.
- The run's home starts empty apart from what first start makes: one bot, **Claudio Bot**, who greets the user (`CLAUDIOBOT_USER_NAME` is `Alex`).
- Seed projects in `<run>/roots/`: `demo` (one commit on `main`, `.env` ignored) and `pushme` (one commit ahead of the bare `<run>/origin.git`).
- Never drive the user's own bridge (port 7878, `~/.claudiobot`).

## Driving conventions

- Start each recipe from a resting bot. `send` waits for rest on its own.
- Note the `#index` of the last message before an action; read the outcome with `wait --since <index>` or `messages --since <index>`.
- Give the bot literal tool calls and arguments. Keep replies to one line to keep turns cheap.
- Address cards by their `messageId` from the printed line, never by position.
- Use `$H raw` for screens with no dedicated command; the frame types are in `bridge/src/protocol.ts`.

## Proof and skip reporting

- Pair every user action (the command and its printed lines) with an independent view of the effect: an audit row in `<run>/home/audit/`, a git fact in `<run>/roots/` or `<run>/origin.git`, a field of `<run>/home/state.json`, or a server frame from `raw`.
- Run `$H evidence <feature-id>` once the end state is reached, and cite the folder.
- Record the run id, build rev and spend (`$H doctor`) with every proof.
- If the classifier or the model refuses a step, record it, retry once with a plain user confirmation, and report the step failed if it refuses again.
- Cloud agents cannot run here (the wrapper refuses `--cloud`); report them as not verifiable, never as passed.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-claudio` (opening with `Preconditions:`, then labeled steps pairing a user action with a command and an observable result), and `Gotchas`.

## Features

- [Chat turn](./chat-turn.md): send a message, get a reply, resend safely, Stop a running turn. The cheapest proof.
- [Approvals](./approvals.md): a risky command waits on a permission card; Allow once, Deny, Always.
- [Mac agents](./mac-agents.md): a bot starts a coding agent in a repo, the bridge reports git's facts, worktrees.
- [Routines](./routines.md): scheduled and webhook routines, Run now, the on/off switch.
- [Memory](./memory.md): a bot's proposed fact, the user's confirm, edit and forget, recall in a later turn.
- [Pairing and devices](./pairing.md): pair a phone with a one-time code, list and revoke devices. No model turns.
- [Sessions](./sessions.md): every Claude Code session by project, a live thread, approvals, streaming, resume, Stop, new sessions.
