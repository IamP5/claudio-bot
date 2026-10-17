import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func bot(
    _ id: String, minutesAgo: Double = 0, pinned: Bool = false, hidden: Bool = false,
    unread: Int = 0, question: String? = nil, preview: String = "Last thing said"
) -> Bot {
    Bot(
        id: BotID(id), name: "bot \(id)", title: nil, avatar: .standard, pinned: pinned, hidden: hidden,
        status: .idle, unread: unread, question: question, preview: preview,
        lastAt: at - minutesAgo * 60, createdAt: at - 86_400, routines: []
    )
}

private func botMessage(_ id: String, _ text: String) -> Message {
    .bot(id: MessageID(id), at: at, text: text)
}

private func question(_ id: String, answer: Answer? = nil, expiresAt: Date? = nil) -> Message {
    .question(id: MessageID(id), at: at, card: QuestionCard(question: "Merge?", options: ["Yes", "Not yet"], answer: answer, expiresAt: expiresAt))
}

private let deadline = at + 2 * 3600

private func permission(_ id: String, answer: PermissionAnswer? = nil) -> Message {
    .permission(id: MessageID(id), at: at, card: PermissionCard(
        from: nil, tool: "Bash", label: "Push to the default branch", detail: "git push origin main",
        always: "git push to main from engineer", answer: answer, expiresAt: deadline
    ))
}

private func hello(_ bots: [Bot], protocol version: Int = 3) -> ServerMessage {
    .hello(Hello(protocol: version, machine: "Mac", userName: "Alex", bots: bots))
}

@MainActor
@Suite struct StoreTests {
    private func store(with bots: [Bot] = [bot("b1")]) -> AppStore {
        let store = AppStore()
        store.apply(hello(bots))
        return store
    }

    @Test func helloSetsTheFeaturesAndClearsLiveActivity() {
        let store = store()
        #expect(!store.has(.memory))
        store.apply(.activity(botId: BotID("b1"), agentId: nil, text: "Reading hub.ts", at: at))
        store.apply(.activity(botId: BotID("b1"), agentId: AgentID("a1"), text: "Running tests", at: at))
        #expect(store.activity[ActivityKey(botId: BotID("b1"), agentId: nil)] == "Reading hub.ts")
        #expect(store.activity[ActivityKey(botId: BotID("b1"), agentId: AgentID("a1"))] == "Running tests")
        store.apply(.activity(botId: BotID("b1"), agentId: AgentID("a1"), text: nil, at: at))
        #expect(store.activity[ActivityKey(botId: BotID("b1"), agentId: AgentID("a1"))] == nil)

        store.apply(.hello(Hello(features: [.memory, .skills], machine: "Mac", userName: "Alex", bots: [bot("b1")])))
        #expect(store.has(.memory) && store.has(.skills) && !store.has(.connectors))
        #expect(store.activity.isEmpty)
    }

    @Test func theActivityLineShowsTheStoresTextForItsKeyOnlyWhenTheBridgeBacksActivity() {
        let store = store()
        let b1 = BotID("b1")
        store.apply(.activity(botId: b1, agentId: nil, text: "Reading hub.ts", at: at))
        #expect(ActivityLine.text(in: store, botId: b1) == nil)

        store.apply(.hello(Hello(features: [.activity], machine: "Mac", userName: "Alex", bots: [bot("b1")])))
        store.apply(.activity(botId: b1, agentId: nil, text: "Reading hub.ts", at: at))
        store.apply(.activity(botId: b1, agentId: AgentID("a1"), text: "Running the tests", at: at))
        #expect(ActivityLine.text(in: store, botId: b1) == "Reading hub.ts")
        #expect(ActivityLine.text(in: store, botId: b1, agentId: AgentID("a1")) == "Running the tests")
        #expect(ActivityLine.text(in: store, botId: b1, agentId: AgentID("a2")) == nil)
        store.apply(.activity(botId: b1, agentId: nil, text: nil, at: at))
        #expect(ActivityLine.text(in: store, botId: b1) == nil)
    }

    @Test func memoryConnectorsSkillsAndWebhookTokensLandInTheStoreAndGoWithTheirBot() {
        let store = store()
        let b1 = BotID("b1")
        store.apply(.memory([Fact(id: FactID("f_1"), text: "Prefers short answers", at: at, by: nil)]))
        store.apply(.connectors(botId: b1, connectors: [Connector(name: "github", status: .connected, enabled: true)]))
        store.apply(.skills(botId: b1, skills: [Skill(name: "release-notes", description: "d", updatedAt: at)]))
        let token = WebhookToken(routineId: RoutineID("r2"), url: URL(string: "http://127.0.0.1:7879/hook/r2")!, token: "whk_1")
        store.apply(.webhookToken(botId: b1, token: token))
        #expect(store.facts?.map(\.text) == ["Prefers short answers"])
        #expect(store.connectors[b1]?.map(\.name) == ["github"])
        #expect(store.skills[b1]?.map(\.name) == ["release-notes"])
        #expect(store.webhookToken == token)
        store.dismissWebhookToken()
        #expect(store.webhookToken == nil)

        store.apply(.botRemoved(b1))
        #expect(store.connectors[b1] == nil && store.skills[b1] == nil)
        #expect(store.facts != nil)
    }

    @Test func theWebhookTokenSectionShowsOnlyForWebhookRoutinesOnABridgeWithWebhooks() {
        let hook = Routine(
            id: RoutineID("r2"), name: "deploys", schedule: "", describe: "When its webhook is called",
            prompt: "Summarize it.", enabled: true, lastRunAt: nil, trigger: .webhook
        )
        var cron = hook
        cron.trigger = .cron
        #expect(WebhookTokenSection.shows(hook, features: [.webhooks]))
        #expect(!WebhookTokenSection.shows(hook, features: [.memory, .skills]))
        #expect(!WebhookTokenSection.shows(cron, features: [.webhooks]))
        #expect(!WebhookTokenSection.shows(Routine(
            id: RoutineID("r3"), name: "x", schedule: "", describe: "", prompt: "", enabled: true, lastRunAt: nil, trigger: .unknown("email")
        ), features: [.webhooks]))
    }

    @Test func helloMeansConnected() {
        let store = store()
        #expect(store.connection == .connected(machine: "Mac"))
        #expect(store.userName == "Alex")
    }

    @Test func homeListsPinnedFirstThenNewestActivity() {
        let store = store(with: [
            bot("old", minutesAgo: 90),
            bot("new", minutesAgo: 1),
            bot("pinnedOld", minutesAgo: 500, pinned: true),
            bot("mid", minutesAgo: 30),
        ])
        #expect(store.homeBots.map(\.id.rawValue) == ["pinnedOld", "new", "mid", "old"])
    }

    @Test func aBotUpdateResortsTheHomeList() {
        let store = store(with: [bot("a", minutesAgo: 5), bot("b", minutesAgo: 10)])
        store.apply(.bot(bot("b", minutesAgo: 0)))
        #expect(store.homeBots.map(\.id.rawValue) == ["b", "a"])
    }

    @Test func hiddenBotsLeaveTheHomeListButStayInSearch() {
        let store = store(with: [bot("shown"), bot("secret", hidden: true)])
        #expect(store.homeBots.map(\.id.rawValue) == ["shown"])
        #expect(store.bots(matching: "secret").map(\.id.rawValue) == ["secret"])
        #expect(Set(store.bots(matching: "").map(\.id.rawValue)) == ["shown", "secret"])
    }

    @Test func replayingAMessageIsANoOp() {
        let store = store()
        let first = store.apply(.message(botId: BotID("b1"), message: botMessage("m1", "Hi")))
        let again = store.apply(.message(botId: BotID("b1"), message: botMessage("m1", "Hi")))
        #expect(first.count == 1)
        #expect(again.isEmpty)
        #expect(store.conversations[BotID("b1")]?.messages.count == 1)
    }

    @Test func upsertReplacesInPlaceAndKeepsOrder() {
        let store = store()
        store.apply(.conversation(botId: BotID("b1"), messages: [question("q1"), botMessage("m2", "Waiting")]))
        let alerts = store.apply(.message(botId: BotID("b1"), message: question("q1", answer: .option(1))))
        #expect(alerts.isEmpty)
        let messages = store.conversations[BotID("b1")]?.messages
        #expect(messages?.map(\.id.rawValue) == ["q1", "m2"])
        #expect(messages?.first == question("q1", answer: .option(1)))
    }

    @Test func aNewBotMessageOrOpenQuestionAlertsAndNothingElseDoes() {
        let store = store()
        let b1 = BotID("b1")
        #expect(store.apply(.message(botId: b1, message: botMessage("m1", "Done"))).map(\.reason) == [.message("Done")])
        #expect(store.apply(.message(botId: b1, message: question("q1"))).map(\.reason)
            == [.question(id: MessageID("q1"), question: "Merge?", options: ["Yes", "Not yet"])])
        #expect(store.apply(.message(botId: b1, message: question("q2", answer: .dismissed))).isEmpty)
        #expect(store.apply(.message(botId: b1, message: .user(id: MessageID("u1"), at: at, text: "ok", attachments: []))).isEmpty)
        #expect(store.apply(.message(botId: b1, message: botMessage("m1", "Done, edited"))).isEmpty)
    }

    @Test func openQuestionIsTheNewestUnansweredCard() {
        let store = store()
        store.apply(.conversation(botId: BotID("b1"), messages: [question("q1"), question("q2", answer: .option(0))]))
        #expect(store.openQuestion(in: BotID("b1"))?.id == MessageID("q1"))
        store.apply(.message(botId: BotID("b1"), message: question("q1", answer: .dismissed)))
        #expect(store.openQuestion(in: BotID("b1")) == nil)
    }

    @Test func removingABotForgetsItsConversation() {
        let store = store()
        store.apply(.conversation(botId: BotID("b1"), messages: [botMessage("m1", "Hi")]))
        store.apply(.botRemoved(BotID("b1")))
        #expect(store.homeBots.isEmpty)
        #expect(store.conversations[BotID("b1")] == nil)
    }

    @Test func createdRecordsWhichBotARefBecame() {
        let store = store()
        store.apply(.created(ref: "c1", botId: BotID("b9")))
        #expect(store.created["c1"] == BotID("b9"))
    }

    @Test func anAgentUpdateRefreshesTheDetailsList() {
        let store = store()
        let agent = Agent(
            id: AgentID("a1"), botId: BotID("b1"), title: "Fix login", where: .mac, projectName: "app",
            status: .working, url: nil, createdAt: at, updatedAt: at
        )
        store.apply(.details(botId: BotID("b1"), library: [], links: [], agents: [agent], routines: []))
        var waiting = agent
        waiting.status = .waiting
        store.apply(.agent(waiting, messages: []))
        #expect(store.details[BotID("b1")]?.agents.map(\.status) == [.waiting])
        #expect(store.agents[AgentID("a1")]?.agent.status == .waiting)
    }

    @Test func aPushedNewAgentJoinsTheCachedDetails() {
        let store = store()
        store.apply(.details(botId: BotID("b1"), library: [], links: [], agents: [], routines: []))
        let agent = Agent(
            id: AgentID("a2"), botId: BotID("b1"), title: "Fix tests", where: .cloud, projectName: "app",
            status: .inCloud, url: URL(string: "https://claude.ai/code/s"), createdAt: at, updatedAt: at
        )
        store.apply(.agent(agent, messages: []))
        store.apply(.agent(agent, messages: []))
        #expect(store.details[BotID("b1")]?.agents.map(\.id) == [AgentID("a2")])
    }

    @Test func aRoutineShowsLiveRunsFromItsBotAndOlderKeptRunsFromDetails() {
        func run(_ id: String, daysAgo: Double, _ status: RunStatus) -> RoutineRun {
            RoutineRun(id: RunID(id), at: at - daysAgo * 86_400, status: status, late: false, manual: false, note: nil)
        }
        func routine(_ runs: [RoutineRun]) -> Routine {
            Routine(id: RoutineID("r1"), name: "digest", schedule: "0 9 * * *", describe: "Daily", prompt: "p", enabled: true, lastRunAt: nil, runs: runs)
        }
        var b1 = bot("b1")
        b1.routines = [routine([run("run7", daysAgo: 0, .running), run("run6", daysAgo: 1, .ok)])]
        let store = store(with: [b1])
        #expect(store.runs(of: RoutineID("r1"), in: BotID("b1")).map(\.id) == [RunID("run7"), RunID("run6")])

        store.apply(.details(botId: BotID("b1"), library: [], links: [], agents: [], routines: [
            routine([run("run6", daysAgo: 1, .running), run("run5", daysAgo: 2, .ok), run("run4", daysAgo: 3, .failed)]),
        ]))
        let runs = store.runs(of: RoutineID("r1"), in: BotID("b1"))
        #expect(runs.map(\.id) == ["run7", "run6", "run5", "run4"].map { RunID($0) })
        #expect(runs.map(\.status) == [.running, .ok, .ok, .failed])
    }

    @Test func unpairingForgetsTheMac() {
        let store = store()
        store.apply(.devices([Device(id: DeviceID("d1"), name: "iPhone", createdAt: at, lastSeenAt: nil, legacy: false, current: true)]))
        store.apply(.pairCode(PairCode(code: "K7QD-M2XP", expiresAt: deadline)))
        store.setConnection(.unpaired)
        #expect(store.bots.isEmpty)
        #expect(store.userName.isEmpty)
        #expect(store.devices == nil)
        #expect(store.pairCode == nil)
    }

    @Test func aNewPermissionCardAlertsOnceWithItsLabel() {
        let store = store()
        let alerts = store.apply(.message(botId: BotID("b1"), message: permission("p1")))
        #expect(alerts.map(\.reason) == [.permission(id: MessageID("p1"), label: "Push to the default branch")])
        #expect(store.apply(.message(botId: BotID("b1"), message: permission("p1"))).isEmpty)
        guard case .permission(_, _, let card)? = store.conversations[BotID("b1")]?[MessageID("p1")] else {
            Issue.record("card missing"); return
        }
        #expect(card.answer(at: at) == nil)
    }

    @Test func aDecidedCardReplacesTheOpenOneInPlaceWithoutAlerting() {
        let store = store()
        store.apply(.conversation(botId: BotID("b1"), messages: [permission("p1"), botMessage("m2", "Waiting on you")]))
        let alerts = store.apply(.message(botId: BotID("b1"), message: permission("p1", answer: .chose(.once))))
        #expect(alerts.isEmpty)
        let messages = store.conversations[BotID("b1")]?.messages
        #expect(messages?.map(\.id.rawValue) == ["p1", "m2"])
        #expect(messages?.first == permission("p1", answer: .chose(.once)))
    }

    @Test func aCardDecidedBeforeTheAppSawItDoesNotAlert() {
        let store = store()
        #expect(store.apply(.message(botId: BotID("b1"), message: permission("p1", answer: .chose(.deny)))).isEmpty)
        #expect(store.apply(.message(botId: BotID("b1"), message: permission("p2", answer: .expired))).isEmpty)
    }

    @Test func aPermissionCardReadsExpiredOnceItsDeadlinePasses() {
        let store = store()
        store.apply(.message(botId: BotID("b1"), message: permission("p1")))
        guard case .permission(_, _, let card)? = store.conversations[BotID("b1")]?[MessageID("p1")] else {
            Issue.record("card missing"); return
        }
        #expect(card.answer(at: deadline - 1) == nil)
        #expect(card.answer(at: deadline) == .expired)
        store.apply(.message(botId: BotID("b1"), message: permission("p1", answer: .expired)))
        guard case .permission(_, _, let closed)? = store.conversations[BotID("b1")]?[MessageID("p1")] else {
            Issue.record("card missing"); return
        }
        #expect(closed.answer(at: at) == .expired)
    }

    @Test func aDecisionStandsAfterTheDeadline() {
        guard case .permission(_, _, let card) = permission("p1", answer: .chose(.always)) else { return }
        #expect(card.answer(at: deadline + 3600) == .chose(.always))
    }

    @Test func anExpiredQuestionIsNoLongerTheOpenOne() {
        let store = store()
        store.apply(.conversation(botId: BotID("b1"), messages: [question("q1", expiresAt: deadline)]))
        #expect(store.openQuestion(in: BotID("b1"), now: deadline - 1)?.id == MessageID("q1"))
        #expect(store.openQuestion(in: BotID("b1"), now: deadline) == nil)
        store.apply(.conversation(botId: BotID("b1"), messages: [question("q2")]))
        #expect(store.openQuestion(in: BotID("b1"), now: .distantFuture)?.id == MessageID("q2"))
    }

    @Test func helloOutsideTheSupportedProtocolsAsksForAnUpdate() {
        let store = AppStore()
        store.apply(hello([], protocol: 2))
        #expect(store.protocolMismatch == .updateBridge)
        store.apply(hello([], protocol: 4))
        #expect(store.protocolMismatch == .updateApp)
        store.apply(hello([], protocol: 3))
        #expect(store.protocolMismatch == nil)
    }

    @Test func aDecisionStaysPendingUntilItsCardIsAnswered() {
        let store = store()
        store.apply(.message(botId: BotID("b1"), message: permission("p1")))
        store.apply(.message(botId: BotID("b1"), message: permission("p2")))
        store.decisionSent(.once, for: MessageID("p1"))
        store.decisionSent(.deny, for: MessageID("p2"))
        store.apply(.message(botId: BotID("b1"), message: permission("p1")))
        #expect(store.pendingDecisions[MessageID("p1")] == .once)
        store.apply(.message(botId: BotID("b1"), message: permission("p1", answer: .chose(.once))))
        #expect(store.pendingDecisions[MessageID("p1")] == nil)
        #expect(store.pendingDecisions[MessageID("p2")] == .deny)
        store.apply(.conversation(botId: BotID("b1"), messages: [permission("p2", answer: .expired)]))
        #expect(store.pendingDecisions.isEmpty)
    }

    @Test func aReconnectOrASendFailureReleasesTheButtons() {
        let store = store()
        store.decisionSent(.once, for: MessageID("p1"))
        store.apply(hello([bot("b1")]))
        #expect(store.pendingDecisions.isEmpty)
        store.decisionSent(.always, for: MessageID("p1"))
        store.decisionFailed(for: MessageID("p1"))
        #expect(store.pendingDecisions.isEmpty)
        #expect(store.lastError?.message == "Your decision did not reach your Mac. Try again.")
    }

    @Test func anErrorIsDismissedOnlyByItsOwnNotice() throws {
        let store = store()
        store.apply(.error(message: "Unknown bot"))
        let first = try #require(store.lastError)
        store.apply(.error(message: "Unknown bot"))
        let second = try #require(store.lastError)
        store.dismissError(first)
        #expect(store.lastError == second)
        store.dismissError(second)
        #expect(store.lastError == nil)
    }

    @Test func deviceControlsWaitForAProtocol3Hello() {
        let store = AppStore()
        #expect(!store.bridgeManagesDevices)
        store.apply(hello([], protocol: 2))
        #expect(!store.bridgeManagesDevices)
        store.apply(hello([], protocol: 3))
        #expect(store.bridgeManagesDevices)
        store.setConnection(.unpaired)
        #expect(store.bridgeProtocol == nil)
    }

    @Test func devicesAndPairCodesAreKeptForSettings() {
        let store = store()
        let device = Device(id: DeviceID("d1"), name: "iPhone", createdAt: at, lastSeenAt: nil, legacy: false, current: true)
        store.apply(.devices([device]))
        store.apply(.pairCode(PairCode(code: "K7QD-M2XP", expiresAt: deadline)))
        #expect(store.devices == [device])
        #expect(store.pairCode == PairCode(code: "K7QD-M2XP", expiresAt: deadline))
        store.discardPairCode()
        #expect(store.pairCode == nil)
    }
}

@Suite struct DisplayTests {
    private let peer = Peer.agent(id: AgentID("a1"), title: "Set up verification skill")

    @Test func exchangeLabels() {
        #expect(EventLine.exchange(peer: peer, sent: 1, received: 0) == [.text("Messaged "), .chip(peer)])
        #expect(EventLine.exchange(peer: peer, sent: 0, received: 1) == [.text("Message from "), .chip(peer)])
        #expect(EventLine.exchange(peer: peer, sent: 1, received: 3) == [.text("4 messages with "), .chip(peer)])
        #expect(EventLine.exchange(peer: peer, sent: 2, received: 0) == [.text("2 messages with "), .chip(peer)])
    }

    @Test func notePlaceholdersBecomeChips() {
        let r1 = Peer.routine(id: RoutineID("r1"), name: "transcript-healthcheck")
        let r2 = Peer.routine(id: RoutineID("r2"), name: "routine-healthcheck")
        #expect(EventLine.note("Created routines {0} and {1}", refs: [r1, r2])
            == [.text("Created routines "), .chip(r1), .text(" and "), .chip(r2)])
        #expect(EventLine.note("Kept {3} and {x}", refs: [r1]) == [.text("Kept {3} and {x}")])
    }

    @Test func aBotWithAnOpenQuestionShowsTheBadgeAndTheQuestion() {
        let display = RowDisplay(bot("b1", unread: 0, question: "Want me to merge?", preview: "Earlier text"))
        #expect(display.preview == "Want me to merge?")
        #expect(display.previewIsQuestion)
        #expect(display.needsAttention)
        #expect(!display.unreadDot)
    }

    @Test func unreadShowsTheDotAndThePreview() {
        let display = RowDisplay(bot("b1", unread: 2))
        #expect(display.preview == "Last thing said")
        #expect(!display.previewIsQuestion)
        #expect(!display.needsAttention)
        #expect(display.unreadDot)
    }

    @Test func separatorsOpenTheChatAndEveryGapOverAnHour() {
        let messages: [Message] = [0, 10, 70 + 10 + 1, 82].map { minutes in
            .bot(id: MessageID("m\(Int(minutes))"), at: at + minutes * 60, text: "x")
        }
        let shape = Timeline.rows(messages).map { row -> String in
            if case .message(let m) = row { m.id.rawValue } else { "|" }
        }
        #expect(shape == ["|", "m0", "m10", "|", "m81", "m82"])
    }

    @Test func homeTimesReadLikeAMessagesApp() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US")
        let now = at // Fri, Oct 16 2026, 12:00 UTC
        #expect(TimeLabel.home(now - 3600, now: now, calendar: calendar).contains("11:00"))
        #expect(TimeLabel.home(now - 86_400, now: now, calendar: calendar) == "Yesterday")
        #expect(TimeLabel.home(now - 2 * 86_400, now: now, calendar: calendar) == "Wednesday")
        #expect(TimeLabel.home(now - 7 * 86_400, now: now, calendar: calendar) == "Oct 9")
    }

    @Test func onlyApprovalParkedAndUnavailableWearAChip() {
        #expect(BotStatus.allCases.map(\.chip) == [nil, nil, "Awaiting approval", "Parked", "Unavailable"])
        #expect(BotStatus.unknown("sleeping").chip == nil)
    }

    @Test func onlyOnceAndAlwaysLetTheCallRun() {
        #expect(PermissionChoice.allCases.filter(\.allows) == [.once, .always])
    }

    @Test func runTagsSayLateAndRunNow() {
        let run = { (late: Bool, manual: Bool) in
            RoutineRun(id: RunID("r"), at: at, status: .ok, late: late, manual: manual, note: nil).tags
        }
        #expect(run(false, false) == [])
        #expect(run(true, false) == ["Late"])
        #expect(run(true, true) == ["Late", "Run now"])
    }

    @Test func initials() {
        #expect(Initials.of("Alex Rivera") == "AR")
        #expect(Initials.of("alex") == "A")
        #expect(Initials.of("Ana Maria Souza") == "AM")
    }

    @Test func libraryGroupsByWeek() {
        let fresh = LibraryFile(path: "plan.md", size: 1, modifiedAt: at - 3600)
        let old = LibraryFile(path: "old.md", size: 1, modifiedAt: at - 30 * 86_400)
        #expect(Library.groups([old, fresh], now: at).map(\.title) == ["This week", "Earlier"])
        #expect(Library.groups([old], now: at).map(\.title) == ["Earlier"])
    }
}

@Suite struct MarkdownTests {
    @Test func fencesSplitProseFromCode() {
        let blocks = MarkdownBlock.parse("Found it:\n\n```ts\nconst a = 1\n```\nDone.")
        #expect(blocks == [.prose("Found it:"), .code(language: "ts", "const a = 1"), .prose("Done.")])
    }

    @Test func anUnclosedFenceRunsToTheEnd() {
        #expect(MarkdownBlock.parse("```\nstreaming") == [.code(language: nil, "streaming")])
    }

    @Test func listLinesBecomeItemsWithTheirMarkers() {
        #expect(MarkdownBlock.parse("Today:\n1. **One** thing\n12. Twelve\n- dash") == [
            .prose("Today:"), .item(marker: "1.", "**One** thing"), .item(marker: "12.", "Twelve"), .item(marker: "•", "dash"),
        ])
        #expect(MarkdownBlock.parse("2026 was a year.") == [.prose("2026 was a year.")])
    }

    @Test func headingsAreTheirOwnBlock() {
        #expect(MarkdownBlock.parse("## Plan\nstep one") == [.heading("Plan"), .prose("step one")])
    }
}

@MainActor
@Suite struct SkillsSectionTests {
    @Test func skillsShowOnlyWithTheFeatureAndFollowTheBridgesList() {
        let b1 = BotID("b1")
        let store = AppStore()
        store.apply(hello([bot("b1")]))
        store.apply(.skills(botId: b1, skills: [Skill(name: "greet", description: "d", updatedAt: at)]))
        #expect(SkillsSection.content(store, bot: b1) == .hidden)

        store.apply(.hello(Hello(features: [.skills], machine: "Mac", userName: "Alex", bots: [bot("b1")])))
        #expect(SkillsSection.content(store, bot: b1) == .loading)
        let greet = Skill(name: "greet", description: "Greet the user", updatedAt: at)
        let notes = Skill(name: "notes", description: "Take notes", updatedAt: at)
        store.apply(.skills(botId: b1, skills: [greet, notes]))
        #expect(SkillsSection.content(store, bot: b1) == .skills([greet, notes]))

        store.apply(.skills(botId: b1, skills: [notes]))
        #expect(SkillsSection.content(store, bot: b1) == .skills([notes]))
    }
}

@MainActor
@Suite struct ConnectorsSectionTests {
    private let b1 = BotID("b1")
    private let gmail = Connector(name: "claude.ai Gmail", status: .needsAuth, enabled: true)

    private func store(_ features: [Feature]) -> AppStore {
        let store = AppStore()
        store.apply(.hello(Hello(features: features, machine: "Mac", userName: "Alex", bots: [bot("b1")])))
        return store
    }

    @Test func theSectionHidesWithoutTheConnectorsFeature() {
        let store = store([.memory])
        store.apply(.connectors(botId: b1, connectors: [gmail]))
        #expect(ConnectorsSection.rows(store, b1) == .hidden)
    }

    @Test func theSectionLoadsUntilTheBridgeListsThenShowsTheList() {
        let store = store([.connectors])
        #expect(ConnectorsSection.rows(store, b1) == .loading)
        store.apply(.connectors(botId: b1, connectors: [gmail]))
        #expect(ConnectorsSection.rows(store, b1) == .shown([gmail]))
        #expect(ConnectorsSection.detail(gmail) == "Needs sign-in on your Mac")
        #expect(ConnectorsSection.detail(Connector(name: "x", status: .connected, enabled: false)) == "Off for this Bot and its agents")
    }

    @Test func theSwitchSendsSetConnector() throws {
        let message = ConnectorsSection.toggle(b1, gmail, enabled: false)
        #expect(message == .setConnector(botId: b1, name: "claude.ai Gmail", enabled: false))
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
        #expect(json["type"] as? String == "set_connector")
        #expect(json["botId"] as? String == "b1")
        #expect(json["name"] as? String == "claude.ai Gmail")
        #expect(json["enabled"] as? Bool == false)
    }
}
