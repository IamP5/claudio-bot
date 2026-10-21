#if DEBUG
import Foundation

@MainActor
enum DemoSessions {
    static let fade = SessionID("6b1f3c2a-8d4e-4f7a-9c1b-2e5d7a9f0c31")
    static let sidebar = SessionID("2c7e9a41-5d3b-4f8e-9a1c-7b2d4e6f8a10")
    static let playlist = SessionID("9e4b2d71-3a6c-4b8e-8f1d-5c2a7e9b3d40")
    static let parity = SessionID("4f1a8c3e-7b2d-4e9a-b5c6-1d8e3f7a2b90")
    static let catalog = SessionID("7d3e1b9c-2a4f-4c8e-9b1d-6e5f3a2c8d70")
    static let changelog = SessionID("session_01Hq7vXk3mRt9wYpL2nB5cDe")
    static let audit = SessionID("5a9c3e71-1b4d-4f2a-8e6c-3d7b9f1a2c50")
    static let sleepers = SessionID("5e2c8a14-9b3d-4f6e-8a1c-3d7b9e2f4a60")
    /// The approvalsanswered screen: sleeper two's card is answered too, so every card is folded.
    static var sleepersAnswered = false
    /// The approvalsexpiring screen sets sleeper two's deadline once, so it expires while the thread is open however often
    /// the thread is rebuilt.
    static var sleeperTwoDeadline: Date?
    /// The background screen: the audit's turn is over, and one subagent and its command still run.
    static var backgroundOnly = false

    static let soltaOSom = ProjectID("3f9a1c7e2b4d6a80")
    static let claudioBot = ProjectID("9c2e5b7a1d3f4e60")
    static let specSync = ProjectID("5b8d2f4a6c1e3a90")
    static let dotfiles = ProjectID("1a2b3c4d5e6f7a80")

    private static func ago(_ minutes: Double) -> Date { .now - minutes * 60 }

    static let projects: [SessionProject] = [
        SessionProject(id: soltaOSom, name: "solta-o-som", path: "/Users/alex/Dev/projects/br-soundless", githubRepo: "IamP5/solta-o-som", lastAt: ago(1), canCloud: false),
        SessionProject(id: claudioBot, name: "claudio-bot", path: "/Users/alex/Dev/projects/claudio-bot", githubRepo: "alex/claudio-bot", lastAt: ago(4), canCloud: false),
        SessionProject(id: specSync, name: "spec-sync", path: "/Users/alex/Dev/projects/spec-sync", githubRepo: "alex/spec-sync", lastAt: ago(9), canCloud: false),
        SessionProject(id: dotfiles, name: "dotfiles", path: "/Users/alex/dotfiles", githubRepo: nil, lastAt: ago(60 * 30), canCloud: false),
    ]

    private static func row(
        _ id: SessionID, _ project: ProjectID, _ title: String, origin: SessionOrigin, minutes: Double,
        status: SessionStatus = .idle, holder: SessionHolder = .nobody, unread: Bool = false, parent: SessionID? = nil,
        agent: SessionAgentLink? = nil, branch: String? = nil, worktree: Bool = false, pr: (Int, PullRequestState?)? = nil,
        mirror: SessionMirror = .imported, url: URL? = nil, hidden: Bool = false,
        since: Double? = nil, running: (agents: Int, commands: Int)? = nil, activity: String? = nil, outcome: (SessionOutcomeKind, String)? = nil
    ) -> SessionRow {
        SessionRow(
            id: id, projectId: project, parentId: parent, title: title, origin: origin, agent: agent, status: status,
            holder: holder, unread: unread, branch: branch, worktree: worktree,
            pr: pr.map { SessionPullRequest(number: $0.0, url: URL(string: "https://github.com/alex/repo/pull/\($0.0)")!, state: $0.1) },
            mirror: mirror, hidden: hidden, url: url, createdAt: ago(minutes + 90), lastAt: ago(minutes),
            since: since.map(ago), running: running.map { SessionRunning(agents: $0.agents, commands: $0.commands) }, activity: activity,
            outcome: outcome.map { SessionOutcome(kind: $0.0, text: $0.1, at: ago(minutes)) }
        )
    }

    private static func id(_ n: Int) -> SessionID {
        SessionID(String(format: "00000000-0000-4000-8000-%012d", n))
    }

    static let rows: [SessionRow] = [
        row(fade, soltaOSom, "Smooth the audio fade on iOS Safari", origin: .agent, minutes: 1, status: .awaitingApproval, holder: .claudio,
            agent: SessionAgentLink(botId: BotID("engineer"), agentId: AgentID("a1")), branch: "claudio/6b1f3c2a", worktree: true, mirror: .pending,
            since: 3, activity: "Waiting for approval: Bash"),
        row(playlist, soltaOSom, "Plan the playlist import", origin: .phone, minutes: 6, status: .awaitingApproval, holder: .claudio, branch: "main"),
        row(sleepers, soltaOSom, "Sleepers in parallel", origin: .phone, minutes: 2, status: .awaitingApproval, holder: .claudio, branch: "main"),
        row(id(11), soltaOSom, "Bridge with Tailscale for iPhone", origin: .desktop, minutes: 50, unread: true, branch: "main",
            outcome: (.finished, "Background command finished: tailscale serve")),
        row(id(12), soltaOSom, "Song of the day genre misses", origin: .terminal, minutes: 180, branch: "fix/genre"),
        row(id(13), soltaOSom, "PR #34 merge to main", origin: .desktop, minutes: 60 * 20, branch: "main", pr: (34, .merged)),
        row(id(14), soltaOSom, "Songs catalog admin page", origin: .desktop, minutes: 60 * 26, branch: "feat/admin", pr: (13, .open)),
        row(id(15), soltaOSom, "PStack setup", origin: .terminal, minutes: 60 * 30, branch: "main"),
        row(id(16), soltaOSom, "Trim verify feature files into batch recipes", origin: .sdk, minutes: 60 * 29, parent: id(15)),
        row(id(17), soltaOSom, "Fix flaky nickname-dialog specs in account.spec", origin: .sdk, minutes: 60 * 28, parent: id(15)),
        row(id(18), soltaOSom, "Trial e2e explore as a bug-bash layer", origin: .sdk, minutes: 60 * 27, status: .failed, parent: id(15),
            outcome: (.failed, "Exit code 1: playwright timed out after 30 s")),
        row(id(19), soltaOSom, "Volume slider on the mini player", origin: .desktop, minutes: 60 * 50, pr: (41, .closed)),
        row(id(20), soltaOSom, "Upgrade Expo to SDK 54", origin: .terminal, minutes: 60 * 70),

        row(sidebar, claudioBot, "Sessions sidebar for iOS", origin: .desktop, minutes: 4, status: .awaitingInput, holder: .desktop,
            branch: "feat/sessions-ios", pr: (52, .open)),
        row(audit, claudioBot, "Audit the session code in parallel", origin: .phone, minutes: 0.5, status: .working, holder: .claudio, branch: "main",
            since: 4, running: (3, 0), activity: "Agent: audit the bridge"),
        row(catalog, claudioBot, "Close all emulators", origin: .terminal, minutes: 35, branch: "main"),
        row(id(21), claudioBot, "Grokbot UI/UX polish", origin: .agent, minutes: 75, unread: true,
            agent: SessionAgentLink(botId: BotID("claude"), agentId: AgentID("a2")), branch: "claudio/polish", worktree: true, pr: (49, .open)),
        row(changelog, claudioBot, "Add a changelog", origin: .cloud, minutes: 140, status: .working, holder: .other,
            url: URL(string: "https://claude.ai/code/session_01Hq7vXk3mRt9wYpL2nB5cDe")),
        row(id(22), claudioBot, "Git worktree conflict on main", origin: .terminal, minutes: 60 * 6, status: .parked),
        row(id(23), claudioBot, "Usage limits in the composer", origin: .phone, minutes: 60 * 9, branch: "feat/usage", pr: (47, .merged)),

        row(parity, specSync, "Mobile app feature parity with web", origin: .terminal, minutes: 9, status: .working, holder: .terminal,
            branch: "feat/parity", pr: (2, .open), since: 12, activity: "Run npm test"),
        row(id(31), specSync, "API e arquitetura, Sprint 3", origin: .desktop, minutes: 60 * 3, pr: (7, .closed)),
        row(id(32), specSync, "Catalog gap audit", origin: .desktop, minutes: 60 * 5, unread: true, pr: (9, nil)),
        row(id(33), specSync, "Jev System One model introduction", origin: .desktop, minutes: 60 * 24 * 3),
        row(id(34), specSync, "Old spike, kept for reference", origin: .terminal, minutes: 60 * 24 * 9, hidden: true),

        row(id(41), dotfiles, "Move zsh config to XDG paths", origin: .terminal, minutes: 60 * 30),
    ]

    static var models: [SessionModelOption] {
        [SessionModelOption(id: "default", label: "Default (Opus 5.5)"), SessionModelOption(id: "opus", label: "Opus"),
         SessionModelOption(id: "sonnet", label: "Sonnet"), SessionModelOption(id: "haiku", label: "Haiku")]
    }

    static func controls(working: Bool = false, canSend: Bool = true, reason: String? = nil, queued: Int = 0, mode: PermissionMode = .default) -> SessionControls {
        SessionControls(
            canSend: canSend, reason: reason, working: working, queued: queued, model: nil, models: models, mode: mode,
            modes: SessionText.phoneModes
        )
    }

    private static func step(_ id: String, _ tool: String, _ label: String, _ state: ToolStepState = .ok, diff: (String, Int, Int)? = nil, output: String? = nil) -> ToolStep {
        ToolStep(id: id, tool: tool, label: label, state: state, diff: diff.map { ToolDiff(path: $0.0, added: $0.1, removed: $0.2) }, output: output)
    }

    private static func user(_ id: String, _ minutes: Double, _ text: String, from: SessionAuthor = .user) -> SessionItem {
        .user(id: ItemID(id), at: ago(minutes), text: text, from: from, queued: false)
    }

    private static func say(_ id: String, _ minutes: Double, _ text: String) -> SessionItem {
        .assistant(id: ItemID(id), at: ago(minutes), text: text)
    }

    private static func think(_ id: String, _ minutes: Double, _ text: String, ms: Int) -> SessionItem {
        .thinking(id: ItemID(id), at: ago(minutes), text: text, ms: ms)
    }

    private static func work(_ id: String, _ minutes: Double, _ steps: [ToolStep]) -> SessionItem {
        .work(id: ItemID(id), at: ago(minutes), steps: steps)
    }

    static func fadeItems() -> [SessionItem] {
        [
            user("u1", 24, "Make the fade on iOS Safari smooth, then open a PR.", from: .bot),
            think("t1", 23.8, "The fade calls linearRampToValueAtTime down to 0, which Safari renders as a click near the end.", ms: 2400),
            say("m1:1", 23.5, "The fade is **linear**, so it sounds abrupt near zero. I'll make it exponential with `setTargetAtTime`."),
            work("w1", 23, [
                step("w1", "Read", "Read src/audio/fade.ts"),
                step("w1b", "Grep", "Search \"linearRamp\" in src"),
                step("w1c", "Edit", "Edit src/audio/fade.ts", diff: ("src/audio/fade.ts", 12, 4)),
                step("w1d", "Bash", "Run bun test", .error, output: "bun test v1.3.0\n\nsrc/audio/fade.test.ts:\n(fail) fades to silence in 40 ms\n  expected 0, got 0.018\n\n 13 pass\n 1 fail"),
            ]),
            say("m2:1", 21, "One test still expects the old curve. I'll update it to check the level after five time constants."),
            work("w2", 20, [
                step("w2", "Edit", "Edit src/audio/fade.test.ts", diff: ("src/audio/fade.test.ts", 3, 3)),
                step("w2b", "Bash", "Run bun test", output: " 14 pass\n 0 fail\nRan 14 tests across 3 files. [212.00ms]"),
            ]),
            say("m3:1", 19, "All 14 tests pass. The fade now uses `setTargetAtTime` with a 12 ms time constant, so it reaches silence without the click.\n\n- `src/audio/fade.ts`: exponential approach instead of a linear ramp\n- `src/audio/fade.test.ts`: checks the level after five time constants"),
            user("u2", 3, "Nice. Safari picked up a stale build though. Clear node_modules and reinstall before the PR."),
            think("t2", 2.8, "A stale bundle means the dev server cached the old module. Reinstalling is the blunt fix; I'll ask first since it deletes files.", ms: 1100),
            .todo(id: ItemID("todo1"), at: ago(2.6), todos: [
                SessionTodo(text: "Replace the linear ramp", state: .done),
                SessionTodo(text: "Fix the failing fade test", state: .done),
                SessionTodo(text: "Reinstall dependencies", state: .inProgress),
                SessionTodo(text: "Open a PR", state: .pending),
            ]),
            work("w3", 2.4, [step("w3", "Bash", "Run du -sh node_modules", output: "412M\tnode_modules")]),
            .permission(id: ItemID("p1"), at: ago(1), permission: SessionPermission(cardId: MessageID("card-fade"), at: ago(1), card: PermissionCard(
                from: nil, tool: "Bash", label: "Delete node_modules and reinstall", detail: "rm -rf node_modules && bun install",
                always: "Bash: rm -rf node_modules · bun install", answer: nil, expiresAt: .now + 2 * 3600
            ))),
        ]
    }

    static func sidebarItems() -> [SessionItem] {
        [
            user("s-u1", 30, "Design the Sessions sidebar for iOS. Match the Claude app's Code sidebar, but native."),
            think("s-t1", 29, "Projects as sections, titles in regular weight, PR badges on the right, nested sub-sessions with a guide.", ms: 3200),
            work("s-w1", 28, [
                step("s-w1", "Read", "Read ios/ClaudioBot/Views/HomeView.swift"),
                step("s-w1b", "Read", "Read docs/sessions-design.md"),
                step("s-w1c", "Write", "Write ios/ClaudioBot/Views/SessionsSidebar.swift", diff: ("ios/ClaudioBot/Views/SessionsSidebar.swift", 312, 0)),
                step("s-w1d", "Edit", "Edit ios/ClaudioBot/Views/MainView.swift", diff: ("ios/ClaudioBot/Views/MainView.swift", 24, 9)),
                step("s-w1e", "Bash", "Run xcodebuild build test", output: "Test run with 239 tests in 29 suites passed after 11.010 seconds."),
            ]),
            say("s-m1", 8, "The sidebar builds and all 239 tests pass. Two choices are yours before I polish it."),
            .ask(id: ItemID("s-ask"), at: ago(4), questions: [
                AskQuestion(question: "Where should the Bots | Sessions switch live?", header: "Switch", options: [
                    AskOption(label: "Under the navigation bar", description: "A segmented control pinned above the list"),
                    AskOption(label: "In the toolbar", description: "Replaces the plan usage ring in the middle"),
                ], multiSelect: false),
                AskQuestion(question: "Which details should a row show?", header: "Row", options: [
                    AskOption(label: "PR number", description: "Tinted by its state"),
                    AskOption(label: "Branch", description: "The checked-out branch"),
                    AskOption(label: "Age", description: "5m, 3h, 2d"),
                ], multiSelect: true),
            ], answers: nil, cardId: MessageID("card-ask")),
        ]
    }

    /// The main thread writes a note, then four subagents each ask to run a command: one allowed, one allowed and then
    /// stopped, one stopped before anyone answered, and one still waiting.
    static func sleeperItems() -> [SessionItem] {
        func sleeper(_ n: Int, _ name: String, _ state: ToolStepState, cause: String? = nil) -> ToolStep {
            ToolStep(id: "sl-a\(n)", tool: "Agent", label: name, state: state, diff: nil, output: nil, detail: "general-purpose",
                     startedAt: ago(1.8), cause: cause)
        }
        func call(_ n: Int, _ command: String, _ state: ToolStepState, cause: String? = nil) -> ToolStep {
            ToolStep(id: "sl-b\(n)", tool: "Bash", label: "Run \(command)", state: state, diff: nil, output: nil, detail: command,
                     startedAt: state == .waiting ? nil : ago(1.5), owner: "sl-a\(n)", cause: cause)
        }
        func card(_ n: Int, _ name: String, _ command: String, _ answer: PermissionAnswer?) -> SessionItem {
            .permission(id: ItemID("sl-p\(n)"), at: ago(1.6), permission: SessionPermission(
                cardId: MessageID("card-sleeper-\(n)"), at: ago(1.6), card: PermissionCard(
                    from: nil, tool: "Bash", label: "Bash", detail: command, always: "Bash: \(command)",
                    answer: answer, expiresAt: (n == 2 ? sleeperTwoDeadline : nil) ?? .now + 2 * 3600
                ), stepId: "sl-b\(n)", subagent: name
            ))
        }
        return [
            user("sl-u1", 2, "Start three subagents. Each one runs perl -e 'sleep 30' and reports back."),
            .permission(id: ItemID("sl-p0"), at: ago(1.9), permission: SessionPermission(
                cardId: MessageID("card-sleeper-0"), at: ago(1.9), card: PermissionCard(
                    from: nil, tool: "Write", label: "Write notes/sleepers.md", detail: "notes/sleepers.md",
                    always: "Write", answer: .chose(.once), expiresAt: .now + 2 * 3600
                )
            )),
            work("sl-w1", 1.8, [
                sleeper(1, "sleeper one", .running), sleeper(2, "sleeper two", .running),
                sleeper(3, "sleeper three", .stopped, cause: "Stopped by you"), sleeper(4, "sleeper four", .stopped, cause: "Stopped by you"),
                call(1, "perl -e 'sleep 30'", .running), call(2, "perl -e 'sleep 30'", sleepersAnswered ? .running : .waiting),
                call(3, "perl -e 'sleep 45' && echo late > late.txt", .stopped, cause: "Stopped by you"),
                call(4, "perl -e 'sleep 60'", .stopped, cause: "Stopped by you"),
            ]),
            card(1, "sleeper one", "perl -e 'sleep 30'", .chose(.once)),
            card(3, "sleeper three", "perl -e 'sleep 45' && echo late > late.txt", .chose(.once)),
            card(4, "sleeper four", "perl -e 'sleep 60'", .stopped),
            card(2, "sleeper two", "perl -e 'sleep 30'", sleepersAnswered ? .chose(.once) : nil),
        ]
    }

    static func playlistItems() -> [SessionItem] {
        [
            user("pl-u1", 14, "Plan how we import a Spotify playlist into the catalog. Don't write code yet."),
            think("pl-t1", 13, "Read the catalog schema and the Spotify client before proposing anything.", ms: 4100),
            work("pl-w1", 12, [
                step("pl-w1", "Read", "Read src/catalog/schema.ts"),
                step("pl-w1b", "Read", "Read src/spotify/client.ts"),
                step("pl-w1c", "Grep", "Search \"isrc\" in src"),
            ]),
            .plan(id: ItemID("pl-plan"), at: ago(6), text: """
            ## Import a Spotify playlist

            1. Add `importPlaylist(url)` to `src/spotify/client.ts`, paging 100 tracks at a time.
            2. Match each track to the catalog by **ISRC**, then by title and artist.
            3. Write unmatched tracks to `imports/unmatched.csv` for review.
            4. Add an admin button that runs the import and shows matched / unmatched counts.

            Tests: a recorded playlist fixture with 3 matches and 1 miss.
            """, state: .proposed, cardId: MessageID("card-plan")),
        ]
    }

    static func parityItems() -> [SessionItem] {
        [
            user("pa-u1", 12, "Bring the mobile app to parity with the web checkout."),
            work("pa-w1", 11, [
                step("pa-w1", "Read", "Read web/src/checkout/Checkout.tsx"),
                step("pa-w1b", "Edit", "Edit mobile/src/checkout/Checkout.tsx", diff: ("mobile/src/checkout/Checkout.tsx", 48, 12)),
                step("pa-w1c", "Bash", "Run pnpm test checkout", .running),
            ]),
        ]
    }

    private static func secondsAgo(_ seconds: Double) -> Date { .now - seconds }

    /// Three subagents in flight: one busy, one quiet for over a minute, one blocked on approval for its command. A
    /// background command one of them started, a helper that failed at once, and a finished run with a failed write.
    /// The approval card itself is left out, so the whole run fits on one screen.
    static func auditItems() -> [SessionItem] {
        let agent = { (id: String, label: String, started: Double) in
            ToolStep(id: id, tool: "Agent", label: label, state: .running, diff: nil, output: nil, detail: "general-purpose",
                     startedAt: secondsAgo(started), background: true)
        }
        return [
            user("au-u1", 4, "Audit the session code with three agents in parallel, and fix the summary count first."),
            think("au-t1", 3.9, "Fix the count, then fan out one agent per file.", ms: 1800),
            work("au-w1", 3.8, [
                ToolStep(id: "au-r1", tool: "Read", label: "Read ios/ClaudioBot/Model/Threads.swift", state: .ok, diff: nil, output: nil,
                         startedAt: secondsAgo(228), endedAt: secondsAgo(227)),
                ToolStep(id: "au-e1", tool: "Edit", label: "Edit ios/ClaudioBot/Model/Threads.swift", state: .ok,
                         diff: ToolDiff(path: "ios/ClaudioBot/Model/Threads.swift", added: 6, removed: 2), output: nil,
                         startedAt: secondsAgo(220), endedAt: secondsAgo(219)),
                ToolStep(id: "au-e2", tool: "Write", label: "Write ios/ClaudioBotTests/ThreadWorkTests.swift", state: .error,
                         diff: ToolDiff(path: "ios/ClaudioBotTests/ThreadWorkTests.swift", added: 40, removed: 0), output: nil,
                         startedAt: secondsAgo(212), endedAt: secondsAgo(211), cause: "File has not been read yet. Read it first before writing to it."),
                ToolStep(id: "au-b0", tool: "Bash", label: "Run the thread tests", state: .ok, diff: nil, output: " 12 pass\n 0 fail",
                         detail: "xcodebuild test -only-testing:ClaudioBotTests/ThreadWorkTests", startedAt: secondsAgo(205), endedAt: secondsAgo(163)),
            ]),
            say("au-m1", 2.7, "The count is fixed. Starting one agent per file."),
            work("au-w2", 2.2, [
                agent("au-a1", "Audit session.ts for stale working flags", 127),
                agent("au-a2", "Audit threads.ts for overlay order", 126),
                agent("au-a3", "Audit catalog.ts for row status", 126),
                ToolStep(id: "au-a4", tool: "Agent", label: "broken helper", state: .error, diff: nil, output: nil, detail: "no-such-agent-type",
                         startedAt: secondsAgo(126), endedAt: secondsAgo(125), cause: "Agent type 'no-such-agent-type' not found"),
                ToolStep(id: "au-b1", tool: "Bash", label: "Run in background: sleep 75", state: .running, diff: nil, output: nil, detail: "sleep 75",
                         startedAt: secondsAgo(41), background: true, owner: "au-a1"),
                ToolStep(id: "au-b2", tool: "Bash", label: "Remove the build folder", state: .waiting, diff: nil, output: nil, detail: "rm -rf build",
                         owner: "au-a3"),
            ]),
        ]
    }

    static func auditControls() -> SessionControls {
        let task = { (id: String, step: String, kind: SessionTaskKind, label: String, started: Double, owner: String?, tools: Int?, last: String?, quiet: Double, waiting: MessageID?) in
            SessionTask(id: TaskID(id), stepId: step, kind: kind, label: label, background: true, startedAt: secondsAgo(started), owner: owner,
                        progress: tools.map { TaskProgress(tools: $0, last: last, at: secondsAgo(quiet)) }, waiting: waiting)
        }
        var c = controls(working: true)
        c.turn = SessionTurn(startedAt: ISO8601DateFormatter().string(from: secondsAgo(240)), wake: false)
        c.heardAt = secondsAgo(2)
        c.tasks = [
            task("t-a1", "au-a1", .agent, "Audit session.ts for stale working flags", 127, nil, 7, "Read", 4, nil),
            task("t-a2", "au-a2", .agent, "Audit threads.ts for overlay order", 126, nil, 3, "Bash", 95, nil),
            task("t-a3", "au-a3", .agent, "Audit catalog.ts for row status", 126, nil, 2, "Bash", 30, MessageID("card-audit")),
            task("t-b1", "au-b1", .command, "sleep 75", 41, "au-a1", nil, nil, 0, nil),
        ]
        if backgroundOnly {
            c.turn = nil
            c.tasks = c.tasks?.filter { $0.id == TaskID("t-a1") || $0.id == TaskID("t-b1") }
        }
        return c
    }

    static func cloudItems() -> [SessionItem] {
        [
            user("c-u1", 150, "Add a CHANGELOG.md that follows Keep a Changelog, from the git history."),
            say("c-m1", 141, "I'm reading the tags and merged PRs since v0.1.0 and grouping them under Added, Changed and Fixed."),
        ]
    }

    static func catalogItems() -> [SessionItem] {
        (0..<125).flatMap { turn -> [SessionItem] in
            let minutes = Double(125 - turn) * 6 + 35
            return [
                user("lt-u\(turn)", minutes, "Step \(turn + 1): check the emulator list and close what's left."),
                think("lt-t\(turn)", minutes - 0.5, "List the running simulators, then shut down any not in use.", ms: 900),
                work("lt-w\(turn)", minutes - 1, [
                    step("lt-w\(turn)", "Bash", "Run xcrun simctl list devices booted", output: "iPhone 17 Pro (Booted)"),
                    step("lt-w\(turn)b", "Bash", "Run xcrun simctl shutdown all"),
                ]),
                say("lt-m\(turn)", minutes - 2, "Pass \(turn + 1) done: **\(turn % 3) simulators** were still booted, and now none are. The next pass checks Android emulators with `adb devices`."),
            ]
        }
    }

    static func snapshot(for id: SessionID) -> SessionSnapshot {
        let row = rows.first { $0.id == id }
        switch id {
        case fade:
            return SessionSnapshot(epoch: "demo", rev: 1, items: fadeItems(), before: nil, controls: controls(working: true, mode: .acceptEdits), live: nil)
        case sidebar:
            return SessionSnapshot(epoch: "demo", rev: 1, items: sidebarItems(), before: nil, controls: controls(), live: nil)
        case playlist:
            return SessionSnapshot(epoch: "demo", rev: 1, items: playlistItems(), before: nil, controls: controls(working: true, mode: .plan), live: nil)
        case sleepers:
            return SessionSnapshot(epoch: "demo", rev: 1, items: sleeperItems(), before: nil, controls: controls(working: true), live: nil)
        case parity:
            return SessionSnapshot(
                epoch: "demo", rev: 1, items: parityItems(), before: nil,
                controls: controls(working: true, canSend: false, reason: "Working in a terminal. You can send once it stops."),
                live: ThreadLive(itemId: ItemID("pa-live"), text: "The checkout form now validates the postal code the way the web does. ")
            )
        case changelog:
            return SessionSnapshot(
                epoch: "demo", rev: 1, items: cloudItems(), before: nil,
                controls: controls(working: true, canSend: false, reason: "This session runs on claude.ai."), live: nil
            )
        case audit:
            return SessionSnapshot(epoch: "demo", rev: 1, items: auditItems(), before: nil, controls: auditControls(), live: nil)
        case catalog:
            let items = catalogItems()
            return SessionSnapshot(epoch: "demo", rev: 1, items: Array(items.suffix(120)), before: Cursor("demo-page"), controls: controls(), live: nil)
        default:
            let title = row?.title ?? "A session"
            return SessionSnapshot(epoch: "demo", rev: 1, items: [
                user("\(id.rawValue)-u", 60, title + "."),
                say("\(id.rawValue)-m", 58, "Done. I kept the change small and the tests pass."),
            ], before: nil, controls: controls(), live: nil)
        }
    }

    static func load(into store: AppStore, empty: Bool = false) {
        store.apply(.sessions(.list(projects: projects, rows: empty ? [] : rows, mirror: .auto)))
    }

    /// Streams the parity thread's tail forever, so screenshots and reviewers see text arriving.
    static func streamParity(into store: AppStore) {
        Task {
            let words = "It also formats the card number in groups of four and keeps the pay button disabled until every field is valid. I'm running the checkout tests now.".split(separator: " ")
            var sent = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(140))
                guard let model = store.threads[parity], model.live.itemId == ItemID("pa-live") else { continue }
                let chunk = String(words[sent % words.count]) + " "
                store.apply(.thread(sessionId: parity, .delta(itemId: ItemID("pa-live"), offset: model.live.text.utf16.count, text: chunk)))
                sent += 1
                if sent % words.count == 0 {
                    store.apply(.thread(sessionId: parity, .snapshot(snapshot(for: parity))))
                }
            }
        }
    }

    private static func update(_ store: AppStore, _ id: SessionID, _ change: (inout SessionRow) -> Void) {
        guard var row = store.sessions.rows[id] else { return }
        change(&row)
        row.lastAt = .now
        store.apply(.sessions(.changed(rows: [row], removed: [], projects: [])))
    }

    private static func items(_ store: AppStore, _ id: SessionID, _ items: [SessionItem], removed: [ItemID] = [], controls: SessionControls? = nil) {
        let rev = (store.threads[id]?.position?.rev ?? 0) + 1
        store.apply(.thread(sessionId: id, .items(rev: rev, items: items, removed: removed, controls: controls)))
    }

    /// Answers a session request the way the bridge would. Returns false for anything that is not one.
    static func respond(to msg: ClientMessage, store: AppStore) -> Bool {
        switch msg {
        case .watchSessions:
            store.apply(.sessions(.list(projects: projects, rows: Array(store.sessions.rows.values), mirror: store.sessions.mirror ?? .auto)))
        case .unwatchSessions:
            break
        case let .watchSession(id, _):
            guard case .connected = store.connection else { break }
            if store.threads[id]?.phase != .ready { store.apply(.thread(sessionId: id, .snapshot(snapshot(for: id)))) }
            update(store, id) { $0.unread = false }
        case let .unwatchSession(id):
            if store.sessions.rows[id]?.unread == true { update(store, id) { $0.unread = false } }
        case let .sessionPage(id, _):
            let older = Array(catalogItems().dropLast(120))
            Task {
                try? await Task.sleep(for: .milliseconds(500))
                store.apply(.thread(sessionId: id, .page(items: id == catalog ? older : [], before: nil)))
            }
        case let .sessionSend(id, text, clientId, _):
            reply(to: text, clientId: clientId, in: id, store: store)
        case let .sessionStop(id, target, _):
            var c = store.threads[id]?.controls ?? controls()
            if case .task(let task) = target {
                c.tasks = c.tasks?.filter { $0.id != task }
                c.working = c.turn != nil || c.tasks?.isEmpty == false
                items(store, id, [], controls: c)
                break
            }
            c.working = false
            c.turn = nil
            c.tasks = []
            let closed = (store.threads[id]?.items ?? []).compactMap { item -> SessionItem? in
                guard case .permission(let itemId, let at, var permission) = item, permission.card.answer == nil else { return nil }
                permission.card.answer = .stopped
                return .permission(id: itemId, at: at, permission: permission)
            }
            items(store, id, closed, controls: c)
            update(store, id) { $0.status = .idle }
        case let .sessionDecide(id, cardId, choice):
            decide(cardId, choice, in: id, store: store)
        case let .sessionAnswer(id, cardId, answers):
            guard let model = store.threads[id] else { break }
            for case let .ask(itemId, at, questions, _, card) in model.items where card == cardId {
                items(store, id, [.ask(id: itemId, at: at, questions: questions, answers: answers.map(AskAnswers.answered) ?? .dismissed, cardId: nil)])
            }
            update(store, id) { $0.status = .working }
        case let .sessionCreate(ref, projectId, text, _, _, _):
            let new = SessionID(UUID().uuidString.lowercased())
            let title = text.split(separator: "\n").first.map(String.init) ?? "New session"
            store.apply(.sessions(.changed(rows: [row(new, projectId, String(title.prefix(60)), origin: .phone, minutes: 0, status: .working, holder: .claudio, mirror: .notMirrored)], removed: [], projects: [])))
            store.apply(.sessionCreated(ref: ref, sessionId: new))
            store.apply(.thread(sessionId: new, .snapshot(SessionSnapshot(epoch: "demo", rev: 1, items: [], before: nil, controls: controls(working: true), live: nil))))
            reply(to: text, clientId: "first-\(new.rawValue)", in: new, store: store)
        case let .sessionSet(id, patch):
            update(store, id) { row in
                if let title = patch.title { row.title = title }
                if let hidden = patch.hidden { row.hidden = hidden }
            }
            if var c = store.threads[id]?.controls, patch.model != nil || patch.mode != nil {
                if let model = patch.model { c.model = model }
                if let mode = patch.mode { c.mode = mode }
                items(store, id, [], controls: c)
            }
        case let .sessionOpenDesktop(id):
            update(store, id) { $0.mirror = .imported }
        case let .sessionTool(id, toolUseId):
            let lines = (1...60).map { "  \($0 == 14 ? "✗" : "✓") fade.test.ts > case \($0)" }.joined(separator: "\n")
            store.apply(.thread(sessionId: id, .toolOutput(toolUseId: toolUseId, output: "bun test v1.3.0\n\n\(lines)\n\n 59 pass\n 1 fail\nRan 60 tests across 3 files. [1.21s]")))
        case let .sessionPrefs(mirror):
            store.apply(.sessions(.list(projects: projects, rows: Array(store.sessions.rows.values), mirror: mirror)))
        default:
            return false
        }
        return true
    }

    /// The approvalselsewhere screen: another device denies sleeper two's card while the thread is open.
    static func denyElsewhere(store: AppStore) {
        decide(MessageID("card-sleeper-2"), .deny, in: sleepers, store: store)
    }

    private static func decide(_ cardId: MessageID, _ choice: PermissionChoice, in id: SessionID, store: AppStore) {
        guard let model = store.threads[id] else { return }
        for item in model.items {
            switch item {
            case .permission(let itemId, let at, var permission) where permission.cardId == cardId:
                permission.card.answer = .chose(choice)
                items(store, id, [.permission(id: itemId, at: at, permission: permission)])
            case let .plan(itemId, at, text, _, card) where card == cardId:
                items(store, id, [.plan(id: itemId, at: at, text: text, state: choice.allows ? .approved : .rejected, cardId: nil)])
            default:
                continue
            }
        }
        update(store, id) { $0.status = choice.allows ? .working : .idle }
    }

    private static func reply(to text: String, clientId: String, in id: SessionID, store: AppStore) {
        Task {
            items(store, id, [.user(id: ItemID(clientId), at: .now, text: text, from: .user, queued: true)])
            try? await Task.sleep(for: .milliseconds(700))
            var c = store.threads[id]?.controls ?? controls()
            c.working = true
            items(store, id, [.user(id: ItemID("t-\(clientId)"), at: .now, text: text, from: .user, queued: false)], removed: [ItemID(clientId)], controls: c)
            update(store, id) { $0.status = .working }
            let answer = "On it. I'll keep the change small, run the tests, and tell you what I changed."
            let itemId = ItemID("a-\(clientId)")
            var offset = 0
            for word in answer.split(separator: " ") {
                try? await Task.sleep(for: .milliseconds(90))
                let chunk = (offset == 0 ? "" : " ") + word
                store.apply(.thread(sessionId: id, .delta(itemId: itemId, offset: offset, text: chunk)))
                offset += chunk.utf16.count
            }
            try? await Task.sleep(for: .milliseconds(300))
            c.working = false
            items(store, id, [.assistant(id: itemId, at: .now, text: answer)], controls: c)
            update(store, id) { $0.status = .idle }
        }
    }
}
#endif
