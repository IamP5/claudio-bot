#if DEBUG
import Foundation

/// `-demo` fills the store with sample bots through the reducer, without a bridge.
/// `-demoScreen home|newchat|chat|profile|links|library|file|agent|digest|engineer|factory|pair|settings|routine|approval`
/// opens a screen directly for screenshots, and `engineerprofile` engineer's chat with the profile beside it. `burst` has
/// a bot finish a turn with three bubbles at once.
/// `mention|chip|command` open a chat with the composer mid-sentence, and
/// `group|groupprofile|newgroup|botexchange` the group and bot exchange screens. `usage` opens Plan usage over the bot list,
/// `usagehot` with the session near its limit and `usageoff` with no plan limits to read. The pairing and connection states have their own:
/// `pairconfirm|outdated` (unpaired), `confirm|unrecognized|error|oldbridge` (paired). Sessions: `sessions` (the sidebar),
/// `thread` (work runs and a permission card), `workrun` (subagents running, one failed, a background command), `ask`,
/// `plan`, `approvals` (subagents' cards, open and answered), `approvalsanswered` (all answered), `approvalsexpiring` (the open
/// card expires 20 s in), `approvalselsewhere` (another device denies it 15 s in), `streaming`, `cloud`,
/// `longthread` (500 items), `newsession`, `background` (the turn over, a subagent and its command still running),
/// `threadoffline` (the Mac lost after the thread loaded), `threadwaiting` (a thread opened with the Mac out of reach),
/// `composerdraft`, `composerlong`, `composerlapse`, `composerrefused`, `composermode`, `composerqueued`, `stoppedearly` (DemoSessions.stageComposer;
/// add "kb" for the same with the keyboard up),
/// `sessionsempty` and `sessionsoffline`.
@MainActor
enum Demo {
    private static let arguments = ProcessInfo.processInfo.arguments
    static let isEnabled = arguments.contains("-demo")
    private static let screen = arguments.firstIndex(of: "-demoScreen").flatMap { at in
        arguments.indices.contains(at + 1) ? arguments[at + 1] : nil
    }

    static func load(into app: AppModel) {
        let store = app.store
        let router = app.router
        let invite = PairInvite(url: URL(string: "ws://10.0.0.20:7878/ws")!, code: "K7QD-M2XP")
        switch screen {
        case "pair": return
        case "pairconfirm": return app.propose(invite)
        case "outdated": return app.showPairingFailure(DeepLink.outdatedBridgeMessage)
        default: break
        }
        let oldBridge = screen == "oldbridge"
        let features: [Feature] = switch screen {
        case "live": [.activity]
        case "oldbridge": []
        default: [.mentions, .commands, .exchanges, .groups, .connectors, .usage, .sessions, .memory, .mute, .skills, .spend, .sessionTasks, .sessionUnqueue]
        }
        store.apply(.hello(Hello(protocol: oldBridge ? 2 : Wire.protocolVersion, features: features, machine: "MacBook Pro", userName: "Alex", bots: bots)))
        if !oldBridge { store.apply(.usage(usage(screen))) }
        if !oldBridge { store.apply(.devices(devices)) }
        for (bot, messages) in conversations {
            store.apply(.conversation(botId: BotID(bot), messages: messages))
        }
        store.apply(.details(botId: BotID("claude"), library: library, links: links, agents: [], routines: []))
        store.apply(.details(botId: BotID("engineer"), library: [], links: [], agents: agents, routines: []))
        store.apply(.agent(agents[0], messages: agentMessages))
        store.apply(.file(botId: BotID("claude"), path: "library/merge-plan.md", file: BotFile(mime: "text/markdown", content: plan, data: nil)))
        if features.contains(.sessions) {
            DemoSessions.load(into: store, empty: screen == "sessionsempty")
            DemoSessions.streamParity(into: store)
        }

        router.sidebar = .bots
        if showsAllColumns { router.columns = .all }
        switch screen {
        case "newchat": router.showingNewChat = true
        case "usage", "usagehot", "usageoff": router.showingUsage = true
        case "settings": router.showingSettings = true
        case "chat":
            router.selection = .bot(BotID("claude"))
            router.showingInspector = true
        case "digest": router.selection = .bot(BotID("news"))
        case "engineer": router.selection = .bot(BotID("engineer"))
        case "engineerprofile":
            router.selection = .bot(BotID("engineer"))
            router.showingInspector = true
        case "factory": router.selection = .bot(BotID("maker"))
        case "profile":
            router.selection = .bot(BotID("claude"))
            router.path = [.profile(BotID("claude"))]
        case "links", "library":
            router.selection = .bot(BotID("claude"))
            router.path = [.profile(BotID("claude"), tab: screen == "links" ? .links : .library)]
        case "file":
            router.selection = .bot(BotID("claude"))
            router.path = [.profile(BotID("claude"), tab: .library), .file(BotID("claude"), path: "library/merge-plan.md")]
        case "agent":
            router.selection = .bot(BotID("engineer"))
            router.path = [.exchange(AgentID("a1"))]
        case "routine":
            router.selection = .bot(BotID("news"))
            router.path = [.routine(BotID("news"), RoutineID("r1"))]
        case "approval", "live": router.selection = .bot(BotID("release"))
        case "burst":
            // The bot works, then three bubbles land in one tick as the turn ends, the way the bridge releases held ones.
            router.selection = .bot(BotID("claude"))
            Task {
                try? await Task.sleep(for: .seconds(2))
                guard var bot = store.bots[BotID("claude")] else { return }
                bot.status = .working
                store.apply(.bot(bot))
                try? await Task.sleep(for: .seconds(2))
                let replies = [
                    "Checked the stack against main. Two of the three PRs are ready.",
                    "#141 still fails the checkout smoke test on Safari, so I left it out.",
                    "Want me to merge #142 and #143 now?",
                ]
                for reply in replies {
                    store.apply(.message(botId: bot.id, message: say(UUID().uuidString, .now, reply)))
                }
                bot.status = .idle
                bot.preview = replies[2]
                store.apply(.bot(bot))
            }
        case "mention", "chip", "command": router.selection = .bot(BotID("claude"))
        case "group": router.selection = .bot(BotID("crew"))
        case "groupprofile":
            router.selection = .bot(BotID("crew"))
            router.path = [.profile(BotID("crew"))]
        case "newgroup": router.showingNewChat = true
        case "botexchange":
            router.selection = .bot(BotID("maker"))
            router.path = [.botExchange(BotID("maker"), peer: BotID("standup"))]
        case "homelive":
            // A bot further down posts a question, so Home moves it to the top with the dot and badge.
            Task {
                try? await Task.sleep(for: .seconds(6))
                guard var bot = store.bots[BotID("standup")] else { return }
                bot.unread = 1
                bot.question = "Post the notes to #team now?"
                bot.preview = "Post the notes to #team now?"
                bot.lastAt = .now
                bot.status = .idle
                store.apply(.bot(bot))
            }
        case "confirm": app.propose(invite)
        case "unrecognized": store.setConnection(.unrecognized)
        case "error":
            router.selection = .bot(BotID("release"))
            store.apply(.error(message: "That card already closed."))
        case "oldbridge": router.showingSettings = true
        case "sessions", "sessionsempty": router.sidebar = .sessions
        case "thread": router.open(.session(DemoSessions.fade))
        case "workrun": router.open(.session(DemoSessions.audit))
        case "ask": router.open(.session(DemoSessions.sidebar))
        case "plan": router.open(.session(DemoSessions.playlist))
        case "approvals": router.open(.session(DemoSessions.sleepers))
        case "approvalsexpiring":
            DemoSessions.sleeperTwoDeadline = .now + 20
            router.open(.session(DemoSessions.sleepers))
        case "approvalselsewhere":
            router.open(.session(DemoSessions.sleepers))
            Task {
                try? await Task.sleep(for: .seconds(15))
                DemoSessions.denyElsewhere(store: store)
            }
        case "approvalsanswered":
            DemoSessions.sleepersAnswered = true
            router.open(.session(DemoSessions.sleepers))
        case "streaming": router.open(.session(DemoSessions.parity))
        case "cloud": router.open(.session(DemoSessions.changelog))
        case "longthread": router.open(.session(DemoSessions.catalog))
        case "newsession":
            router.sidebar = .sessions
            router.newSession = NewSessionRequest(projectId: DemoSessions.soltaOSom)
        case "sessionsoffline":
            router.sidebar = .sessions
            store.setConnection(.disconnected(retryAt: .now + 25))
        case "background":
            DemoSessions.backgroundOnly = true
            router.open(.session(DemoSessions.audit))
        case "threadoffline":
            router.open(.session(DemoSessions.audit))
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                store.setConnection(.disconnected(retryAt: .now + 25))
            }
        case "threadwaiting":
            store.setConnection(.disconnected(retryAt: .now + 25))
            router.open(.session(DemoSessions.audit))
        case let composer? where DemoSessions.composerScreens.contains(composer.replacing(/kb$/, with: "")):
            let staged = composer.replacing(/kb$/, with: "")
            DemoSessions.backgroundOnly = staged == "composerlong"
            router.open(.session(DemoSessions.audit))
            DemoSessions.stageComposer(staged, in: store)
        default: break
        }
    }

    /// `-demoColumns` opens the iPad with the sidebar beside the detail. A simulator in portrait cannot be turned from
    /// inside the app, and this is the split view a landscape iPad shows.
    static let showsAllColumns = arguments.contains("-demoColumns")

    /// The bots already ticked when `newgroup` opens the group picker.
    static var groupPick: [BotID]? {
        screen == "newgroup" ? [BotID("engineer"), BotID("news")] : nil
    }

    /// A composer screen whose name ends in "kb" opens with the field focused, so the keyboard is up.
    static var focusesComposer: Bool {
        screen.map { $0.hasSuffix("kb") && DemoSessions.composerScreens.contains(String($0.dropLast(2))) } ?? false
    }

    /// What the composer holds when a screen opens mid-sentence: the "@" menu, a picked token, or the "/" menu.
    static var draft: (draft: ComposerDraft, caret: Int)? {
        switch screen {
        case "mention":
            return (ComposerDraft(text: "Ask @n"), 6)
        case "chip":
            var draft = ComposerDraft(text: "@")
            var caret = draft.pick(.bot(id: BotID("engineer"), name: "engineer"), replacing: NSRange(location: 0, length: 1))
            draft.append("check PR #148 with @")
            caret = draft.pick(.connector(name: "github"), replacing: NSRange(location: (draft.text as NSString).length - 1, length: 1))
            draft.append("before the release")
            return (draft, (draft.text as NSString).length)
        case "command":
            return (ComposerDraft(text: "/"), 1)
        default:
            return nil
        }
    }

    /// Stands in for the bridge: answers devices and pair_code, settles question and permission cards, and replies to a send.
    static func respond(to msg: ClientMessage, store: AppStore) {
        if DemoSessions.respond(to: msg, store: store) { return }
        switch msg {
        case .devices:
            store.apply(.devices(devices))
            return
        case .pairCode:
            store.apply(.pairCode(PairCode(
                code: "K7QD-M2XP", expiresAt: .now + 600,
                urls: ["ws://mac.tail1234.ts.net:7878/ws", "ws://Mac.local:7878/ws", "ws://192.168.1.20:7878/ws"]
            )))
            return
        case .refreshUsage:
            store.apply(.usage(usage(screen, ago: 0)))
            return
        case let .decide(botId, messageId, choice):
            guard case let .permission(id, at, card)? = store.conversations[botId]?[messageId] else { return }
            var decided = card
            decided.answer = .chose(choice)
            store.apply(.message(botId: botId, message: .permission(id: id, at: at, card: decided)))
            settleCard(botId, store: store)
            return
        case let .answer(botId, messageId, option):
            guard case let .question(id, at, card)? = store.conversations[botId]?[messageId] else { return }
            var answered = card
            answered.answer = .option(option)
            store.apply(.message(botId: botId, message: .question(id: id, at: at, card: answered)))
            settleCard(botId, store: store)
            return
        case let .open(botId):
            guard var bot = store.bots[botId], bot.unread > 0 else { return }
            bot.unread = 0
            store.apply(.bot(bot))
            return
        case let .commands(botId):
            store.apply(.commands(botId: botId, commands: commands))
            return
        case .memory:
            store.apply(.memory(facts))
            return
        case let .skills(botId):
            store.apply(.skills(botId: botId, skills: botId == BotID("engineer") ? skills : []))
            return
        case let .connectors(botId):
            store.apply(.connectors(botId: botId, connectors: connectors))
            return
        case let .exchange(botId, peer):
            let messages = botId == BotID("maker") && peer == BotID("standup") ? makerExchange : []
            store.apply(.exchange(botId: botId, peer: peer, messages: messages))
            return
        case let .createGroup(ref, name, members):
            let id = BotID("group-\(ref.prefix(8))")
            store.apply(.bot(Bot(
                id: id, name: name, title: nil, avatar: Avatar(shape: .circle, color: .gray), pinned: false, hidden: false,
                status: .idle, unread: 0, question: nil, preview: "", lastAt: .now, createdAt: .now, routines: [],
                kind: .group, members: members
            )))
            store.apply(.conversation(botId: id, messages: []))
            store.apply(.created(ref: ref, botId: id))
            return
        case let .updateBot(botId, patch):
            guard var bot = store.bots[botId] else { return }
            if let name = patch.name { bot.name = name }
            if let title = patch.title { bot.title = title }
            if let avatar = patch.avatar { bot.avatar = avatar }
            if let pinned = patch.pinned { bot.pinned = pinned }
            if let hidden = patch.hidden { bot.hidden = hidden }
            if let members = patch.members { bot.members = members }
            if let muted = patch.muted { bot.muted = muted }
            if let cap = patch.dailyCapUsd {
                bot.dailyCapUsd = cap
                bot.capUsd = cap
            }
            store.apply(.bot(bot))
            return
        case let .deleteBot(botId, _):
            store.apply(.botRemoved(botId))
            return
        case let .stop(botId):
            guard var bot = store.bots[botId] else { return }
            bot.status = .idle
            store.apply(.bot(bot))
            return
        default: break
        }
        guard case let .send(botId, text, _, _, mentions) = msg, var bot = store.bots[botId] else { return }
        store.apply(.message(botId: botId, message: .user(id: MessageID(UUID().uuidString), at: .now, text: text, attachments: [], mentions: mentions)))
        if bot.isGroup { return answerInGroup(bot, mentions: mentions, store: store) }
        bot.status = .working
        bot.lastAt = .now
        store.apply(.bot(bot))
        Task {
            try? await Task.sleep(for: .seconds(1))
            store.apply(.activity(botId: botId, agentId: nil, text: "Reading CHANGELOG.md", at: .now))
            try? await Task.sleep(for: .seconds(3))
            store.apply(.activity(botId: botId, agentId: nil, text: nil, at: .now))
            let reply = "On it. I'll check it against main and report back with anything that blocks a merge."
            store.apply(.message(botId: botId, message: say(UUID().uuidString, .now, reply)))
            guard var bot = store.bots[botId] else { return }
            bot.status = .idle
            bot.preview = reply
            bot.lastAt = .now
            store.apply(.bot(bot))
        }
    }

    /// The bridge sends the bot again once its open card is answered: no question, and no longer awaiting approval.
    private static func settleCard(_ botId: BotID, store: AppStore) {
        guard var bot = store.bots[botId] else { return }
        bot.question = nil
        if bot.status == .awaitingApproval { bot.status = .idle }
        store.apply(.bot(bot))
    }

    /// The first member the user mentioned, or the first member, types for a moment and answers in the group.
    private static func answerInGroup(_ group: Bot, mentions: [Mention], store: AppStore) {
        let mentioned = mentions.compactMap { if case .bot(let id, _) = $0, group.members.contains(id) { id } else { nil } }.first
        guard var member = (mentioned ?? group.members.first).flatMap({ store.bots[$0] }) else { return }
        let before = member.status
        member.status = .working
        store.apply(.bot(member))
        Task {
            try? await Task.sleep(for: .seconds(3))
            store.apply(.message(botId: group.id, message: .bot(
                id: MessageID(UUID().uuidString), at: .now, text: "On it. I'll post here when it's done.", from: member.id
            )))
            member.status = before
            store.apply(.bot(member))
        }
    }

    /// A time `days` ago at the given clock time.
    private static func at(_ days: Int, _ hour: Int, _ minute: Int) -> Date {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: -days, to: .now) ?? .now
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    private static func ago(minutes: Double) -> Date { .now - minutes * 60 }

    private static func bot(
        _ id: String, _ name: String, _ shape: AvatarShape, _ color: AvatarColor, last: Date,
        preview: String, unread: Int = 0, question: String? = nil, status: BotStatus = .idle,
        pinned: Bool = false, routines: [Routine] = [], spent: Double = 0, cap: Double? = nil
    ) -> Bot {
        Bot(
            id: BotID(id), name: name, title: nil, avatar: Avatar(shape: shape, color: color), pinned: pinned, hidden: false,
            status: status, unread: unread, question: question, preview: preview, lastAt: last,
            createdAt: at(30, 9, 0), routines: routines, dailyCapUsd: cap, spentTodayUsd: spent, capUsd: cap
        )
    }

    private static func routine(
        _ id: String, _ name: String, _ schedule: String, _ describe: String, enabled: Bool = true, runs: [RoutineRun] = []
    ) -> Routine {
        Routine(
            id: RoutineID(id), name: name, schedule: schedule, describe: describe, prompt: "Run \(name).", enabled: enabled,
            lastRunAt: runs.first?.at, nextRunAt: enabled ? at(-1, 7, 30) : nil, runs: runs
        )
    }

    private static let digestRuns: [RoutineRun] = [
        RoutineRun(id: RunID("run4"), at: at(1, 7, 30), status: .ok, late: false, manual: false, note: nil),
        RoutineRun(id: RunID("run3"), at: at(2, 9, 12), status: .quiet, late: true, manual: false, note: nil),
        RoutineRun(id: RunID("run2"), at: at(3, 14, 2), status: .ok, late: false, manual: true, note: nil),
        RoutineRun(id: RunID("run1"), at: at(4, 7, 30), status: .failed, late: false, manual: false, note: "The forum timed out twice."),
    ]

    private static func usage(_ screen: String?, ago: TimeInterval = 60) -> PlanUsage {
        let now = Date.now
        if screen == "usageoff" { return .unavailable(reason: .loggedOut, fetchedAt: now - ago) }
        let hot = screen == "usagehot"
        return .ok(plan: "max", fetchedAt: now - ago, stale: false, windows: [
            UsageWindow(id: "session", kind: .session, label: "Current session", utilization: hot ? 0.94 : 0.37,
                        resetsAt: now + 2 * 3600 + 14 * 60, severity: hot ? .critical : .normal),
            UsageWindow(id: "weekly", kind: .weekly, label: "Weekly · all models", utilization: 0.82,
                        resetsAt: now + 3 * 86_400 + 5 * 3600, severity: .warning),
            UsageWindow(id: "weekly:fable", kind: .weeklyModel, label: "Weekly · Fable", utilization: 0.12,
                        resetsAt: now + 3 * 86_400 + 5 * 3600, severity: .normal),
        ])
    }

    /// The current device is the one the demo runs on.
    static let devices: [Device] = {
        #if os(macOS)
        let this = "ClaudioBot on Alex's MacBook Pro", other = "Alex's iPhone"
        #else
        let this = "Alex's iPhone", other = "ClaudioBot on Alex's MacBook Pro"
        #endif
        return [
            Device(id: DeviceID("d1"), name: this, createdAt: at(30, 9, 0), lastSeenAt: .now, legacy: false, current: true),
            Device(id: DeviceID("d2"), name: "Alex's iPad", createdAt: at(12, 9, 0), lastSeenAt: at(1, 21, 4), legacy: false, current: false),
            Device(id: DeviceID("d3"), name: other, createdAt: at(20, 9, 0), lastSeenAt: at(0, 8, 12), legacy: false, current: false),
        ]
    }()

    static let facts: [Fact] = [
        Fact(id: FactID("f1"), text: "Works on acme/web, a Next.js storefront.", at: at(20, 10, 0), by: "you"),
        Fact(id: FactID("f2"), text: "Prefers small PRs that each pass CI on their own.", at: at(12, 9, 30), by: "engineer"),
        Fact(id: FactID("f3"), text: "Releases ship on Fridays after 4 PM.", at: at(2, 16, 5), by: "release captain",
             confirmed: false, proposerBotId: BotID("release")),
    ]

    static let skills: [Skill] = [
        Skill(name: "smoke-tests", description: "Add and run checkout smoke tests in the headless browser.", updatedAt: at(5, 11, 0)),
        Skill(name: "flaky-triage", description: "Rerun a failing test three times, then mark it skipped and say why.", updatedAt: at(1, 17, 20)),
    ]

    static let bots: [Bot] = [
        bot("news", "news digest", .pentagon, .teal, last: at(1, 7, 31),
            preview: "Morning, Alex. Here's what changed overnight.", unread: 1,
            routines: [routine("r1", "morning-digest", "30 7 * * 1-5", "Weekdays at 7:30 AM", runs: digestRuns)], spent: 0.21),
        bot("claude", "Claudio Bot", .circle, .white, last: at(2, 15, 9),
            preview: "Want me to merge any of these now?", question: "Want me to merge any of these now?", spent: 1.84),
        bot("release", "release captain", .drop, .purple, last: at(3, 16, 4),
            preview: "v2.4.0 is tagged and the changelog is up.",
            question: "Push to the default branch: git push origin main", status: .awaitingApproval,
            routines: [routine("r2", "release-train", "0 16 * * 5", "Fridays at 4:00 PM")]),
        bot("engineer", "engineer", .hexagon, .orange, last: ago(minutes: 2),
            preview: "The checkout smoke tests are in PR #148.", status: .working,
            routines: [routine("r3", "ci-upkeep", "30 8 * * 1-5", "Weekdays at 8:30 AM")], spent: 6.4, cap: 10),
        bot("standup", "standup notes", .star4, .blue, last: at(8, 9, 2),
            preview: "Yesterday: 3 PRs merged, 1 bug filed, release on track.", status: .parked),
        bot("maker", "bot maker", .flower, .pink, last: at(9, 18, 40),
            preview: "I made standup notes. Its one job is your daily summary.",
            routines: [
                routine("r4", "bot-checkup", "0 9 * * 1", "Mondays at 9:00 AM", enabled: false),
                routine("r5", "weekly-review", "0 17 * * 5", "Fridays at 5:00 PM", enabled: false),
            ]),
        Bot(
            id: BotID("crew"), name: "launch crew", title: nil, avatar: Avatar(shape: .circle, color: .blue), pinned: false,
            hidden: false, status: .idle, unread: 0, question: nil,
            preview: "Got it. I'll tag v2.5.0 as soon as engineer says CI is green.", lastAt: ago(minutes: 20),
            createdAt: at(1, 9, 0), routines: [], kind: .group, members: [BotID("engineer"), BotID("release"), BotID("news")]
        ),
    ]

    private static func say(_ id: String, _ date: Date, _ text: String) -> Message {
        .bot(id: MessageID(id), at: date, text: text)
    }

    private static func me(_ id: String, _ date: Date, _ text: String) -> Message {
        .user(id: MessageID(id), at: date, text: text, attachments: [])
    }

    private static let pr = "https://github.com/acme/web/pull/"
    private static let cloudURL = "https://claude.ai/code/session_7fK2pQx9LmV4"

    static let conversations: [(String, [Message])] = [
        ("claude", [
            me("c1", at(3, 21, 2), "Merge the payments stack when it's green, but ask me before anything touches production."),
            say("c2", at(2, 7, 40), "The payments PRs on acme/web (#139 through #143) all finished overnight and are green. One thing has to happen in production before that stack can ship: the database migration from #141."),
            say("c3", at(2, 7, 40), "Should I run the migration in production and start merging from #139?"),
            .question(id: MessageID("c4"), at: at(2, 7, 41), card: QuestionCard(
                question: "Should I run the migration in production and start merging from #139?",
                options: ["Yes, run it and merge", "Not yet"], answer: .option(1)
            )),
            say("c5", at(2, 8, 50), "Got it. I won't touch production or merge anything. #139 through #143 stay open until you say go."),
            say("c6", at(2, 15, 8), "Quick update on the stack. [#139](\(pr)139) is clean against main, and the retry fix in [#142](\(pr)142) can merge on its own. [#141](\(pr)141) still waits on the production migration, and [#143](\(pr)143) stacks on top of it."),
            say("c7", at(2, 15, 8), "Want me to merge any of these now?"),
            .question(id: MessageID("c8"), at: at(2, 15, 9), card: QuestionCard(
                question: "Want me to merge any of these now?",
                options: ["Merge only #142", "Merge #139 and #142", "Keep holding everything"], answer: nil
            )),
        ]),
        ("news", [
            .note(id: MessageID("n0"), at: at(12, 9, 3), text: "Created routine {0}", refs: [.routine(id: RoutineID("r1"), name: "morning-digest")]),
            say("n1", at(1, 7, 31), """
            Morning, Alex. Here's what changed overnight.

            1. **acme/web merged 3 PRs.** The new checkout page is behind a flag, and the retry fix closed two open bugs. [Pull requests](https://github.com/acme/web/pulls)
            2. **A security advisory landed for an image library you depend on.** The fix is a patch release, and nothing in your code calls the affected API. [Advisory](https://github.com/advisories)
            3. **Your CI runner image updates on Monday.** The new image drops an old Node version that two of your workflows still pin. [Changelog](https://github.blog/changelog)
            4. **The design team shared the new onboarding flow.** It touches three screens you own. [Design review](https://example.com/design/onboarding)
            """),
            say("n2", at(1, 7, 31), "I skipped the forum roundup today because the site timed out twice. Everything else came from GitHub and your team's feeds."),
        ]),
        ("engineer", [
            me("e0", at(5, 21, 58), "Checkout keeps breaking without anyone noticing. Can you get smoke tests on it?"),
            say("e1", at(5, 22, 10), "Yes. I started an agent on acme/web for it, on your default model. Once the tests are merged, I can add a daily run to my upkeep routine."),
            .exchange(id: MessageID("e2"), at: at(5, 22, 26), peer: .agent(id: AgentID("a1"), title: "Add checkout smoke tests"), sent: 2, received: 2),
            say("e3", at(5, 23, 10), "Not done yet. The agent got the tests passing, but the payment step timed out twice in the headless browser. I told it to open the PR first, then look at the timeout."),
            .exchange(id: MessageID("e4"), at: at(5, 23, 49), peer: .agent(id: AgentID("a1"), title: "Add checkout smoke tests"), sent: 0, received: 1),
            say("e5", at(5, 23, 49), "The checkout smoke tests are in [PR #148](\(pr)148). It's open and I haven't merged it. It adds 6 tests that cover cart, address, payment and the receipt, and all of them pass."),
            me("e6", ago(minutes: 3), "Nice. Also fix the flaky login test, in the cloud this time."),
            .exchange(id: MessageID("e7"), at: ago(minutes: 2), peer: .agent(id: AgentID("a2"), title: "Fix flaky login e2e test"), sent: 1, received: 0),
        ]),
        ("maker", [
            say("g1", at(13, 10, 33), "Setting things up, then I'll ask what bot you want."),
            .note(id: MessageID("g2"), at: at(13, 10, 33), text: "Created routines {0} and {1}", refs: [
                .routine(id: RoutineID("r4"), name: "bot-checkup"),
                .routine(id: RoutineID("r5"), name: "weekly-review"),
            ]),
            say("g3", at(13, 10, 34), "I design Claudio Bots. What's the one job this one should do every time it wakes?"),
            me("g4", at(9, 18, 30), "make a bot that writes my standup notes every morning"),
            say("g5", at(9, 18, 31), "Looking at what you worked on this week, then I'll build it."),
            .note(id: MessageID("g6"), at: at(9, 18, 38), text: "Created {0}", refs: [
                .bot(id: BotID("standup"), name: "standup notes", avatar: Avatar(shape: .star4, color: .blue)),
            ]),
            .exchange(id: MessageID("g7"), at: at(9, 18, 39), peer: .bot(id: BotID("standup"), name: "standup notes", avatar: Avatar(shape: .star4, color: .blue)), sent: 1, received: 1),
            say("g8", at(9, 18, 40), "I made standup notes. Its one job is your daily summary: what you shipped yesterday, what's next, and what's blocking you."),
            say("g9", at(9, 18, 40), "If you hate it, long-press it in the list and choose Delete."),
        ]),
        ("release", [
            me("l1", at(3, 15, 50), "cut the release when CI is green"),
            say("l2", at(3, 16, 4), "v2.4.0 is tagged and the changelog is up. CI was green on all 412 tests, and I checked the deploy preview before tagging."),
            me("l3", ago(minutes: 6), "Push the changelog fix straight to main."),
            .permission(id: MessageID("l4"), at: ago(minutes: 5), card: PermissionCard(
                from: nil, tool: "Bash", label: "Push to the default branch", detail: "git push origin main",
                always: "Push to the default branch, without asking, in turns you start", answer: nil, expiresAt: .now + 100 * 60
            )),
        ]),
        ("standup", [
            say("k1", at(8, 9, 2), "Yesterday: 3 PRs merged, 1 bug filed, release on track. Today: review the checkout tests and pair on the login fix."),
        ]),
        ("crew", [
            .user(
                id: MessageID("t1"), at: ago(minutes: 26),
                text: "@engineer what's left before Friday's release? @release captain cut it once CI is green.", attachments: [],
                mentions: [.bot(id: BotID("engineer"), name: "engineer"), .bot(id: BotID("release"), name: "release captain")]
            ),
            .bot(id: MessageID("t2"), at: ago(minutes: 24), text: "Two things. The checkout smoke tests in [PR #148](\(pr)148) need your review, and the flaky login test is still running in the cloud.", from: BotID("engineer")),
            .bot(id: MessageID("t3"), at: ago(minutes: 24), text: "I'll say here when both are green.", from: BotID("engineer")),
            .bot(id: MessageID("t4"), at: ago(minutes: 20), text: "Got it. I'll tag v2.5.0 as soon as engineer says CI is green, and I'll post the changelog here first.", from: BotID("release")),
        ]),
    ]

    static let makerExchange: [ExchangeMessage] = [
        ExchangeMessage(
            id: MessageID("x1"), at: at(9, 18, 39), from: BotID("maker"),
            text: "Hi standup notes. I made you for Alex. Each weekday at 9:00, post what Alex shipped yesterday, what's next and what's blocking, in three short lines."
        ),
        ExchangeMessage(
            id: MessageID("x2"), at: at(9, 18, 40), from: BotID("standup"),
            text: "Got it. I'll read yesterday's merged PRs and the open issues, and keep it to three lines."
        ),
    ]

    static let agents: [Agent] = [
        Agent(id: AgentID("a1"), botId: BotID("engineer"), title: "Add checkout smoke tests", where: .mac,
              projectName: "web", status: .waiting, url: nil, createdAt: at(5, 22, 26), updatedAt: at(5, 23, 49)),
        Agent(id: AgentID("a2"), botId: BotID("engineer"), title: "Fix flaky login e2e test", where: .cloud,
              projectName: "web", status: .inCloud, url: URL(string: cloudURL),
              createdAt: ago(minutes: 2), updatedAt: ago(minutes: 2)),
    ]

    static let agentMessages: [AgentMessage] = [
        AgentMessage(id: MessageID("am1"), at: at(5, 22, 26), from: .bot, text: "Add smoke tests for the checkout flow in acme/web. Work on a branch, run them against the dev server, and open a PR."),
        AgentMessage(id: MessageID("am2"), at: at(5, 23, 0), from: .agent, text: "The tests pass locally, but the payment step timed out twice in the headless browser."),
        AgentMessage(id: MessageID("am3"), at: at(5, 23, 2), from: .bot, text: "Commit, push and open the PR first. Then look at the timeout. If it fails a third time, mark that test as skipped and say why in the PR."),
        AgentMessage(id: MessageID("am4"), at: at(5, 23, 49), from: .agent, text: "PR #148 is open with 6 tests for cart, address, payment and the receipt. All pass. The payment timeout was a missing wait on the card form."),
    ]

    static let commands: [Command] = [
        Command(name: "review", description: "Review the open pull request and list what blocks a merge", argumentHint: "[pr]", source: .skill),
        Command(name: "release-notes", description: "Draft release notes from the commits since the last tag", argumentHint: "<version>", source: .skill),
        Command(name: "superpowers:brainstorm", description: "Explore an idea with questions before any code", argumentHint: "", source: .skill),
        Command(name: "compact", description: "Summarize the conversation so far to free up context", argumentHint: "[instructions]", source: .builtin),
        Command(name: "clear", description: "Start a fresh session. The bot keeps its notes and memory", argumentHint: "", source: .builtin),
    ]

    static let connectors: [Connector] = [
        Connector(name: "github", status: .connected, enabled: true),
        Connector(name: "linear", status: .needsAuth, enabled: true),
        Connector(name: "sentry", status: .failed, enabled: true),
    ]

    static let library: [LibraryFile] = [
        LibraryFile(path: "library/merge-plan.md", size: 2048, modifiedAt: at(2, 9, 0)),
        LibraryFile(path: "library/release-checklist.md", size: 1200, modifiedAt: at(20, 9, 0)),
    ]

    static let links: [BotLink] = [143, 142, 141, 139].map { number in
        BotLink(url: URL(string: "\(pr)\(number)")!, host: "github.com", at: at(2, 15, 8))
    } + [BotLink(url: URL(string: cloudURL)!, host: "claude.ai", at: at(4, 10, 0))]

    static let plan = """
    # Payments stack merge plan

    Land the payments PRs on acme/web in order, and stop before production changes.

    1. Merge #139 once CI is green.
    2. Merge #142 on its own. It only touches the retry logic.
    3. Run the #141 migration in production, after Alex says yes.
    4. Merge #141, then #143.
    """
}
#endif
