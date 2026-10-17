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

private func question(_ id: String, answer: Answer? = nil) -> Message {
    .question(id: MessageID(id), at: at, card: QuestionCard(question: "Merge?", options: ["Yes", "Not yet"], answer: answer))
}

@MainActor
@Suite struct StoreTests {
    private func store(with bots: [Bot] = [bot("b1")]) -> AppStore {
        let store = AppStore()
        store.apply(.hello(machine: "Mac", userName: "Bruno", bots: bots))
        return store
    }

    @Test func helloMeansConnected() {
        let store = store()
        #expect(store.connection == .connected(machine: "Mac"))
        #expect(store.userName == "Bruno")
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
        store.apply(.details(botId: BotID("b1"), library: [], links: [], agents: [agent]))
        var waiting = agent
        waiting.status = .waiting
        store.apply(.agent(waiting, messages: []))
        #expect(store.details[BotID("b1")]?.agents.map(\.status) == [.waiting])
        #expect(store.agents[AgentID("a1")]?.agent.status == .waiting)
    }

    @Test func aPushedNewAgentJoinsTheCachedDetails() {
        let store = store()
        store.apply(.details(botId: BotID("b1"), library: [], links: [], agents: []))
        let agent = Agent(
            id: AgentID("a2"), botId: BotID("b1"), title: "Fix tests", where: .cloud, projectName: "app",
            status: .inCloud, url: URL(string: "https://claude.ai/code/s"), createdAt: at, updatedAt: at
        )
        store.apply(.agent(agent, messages: []))
        store.apply(.agent(agent, messages: []))
        #expect(store.details[BotID("b1")]?.agents.map(\.id) == [AgentID("a2")])
    }

    @Test func unpairingForgetsTheMac() {
        let store = store()
        store.setConnection(.unpaired)
        #expect(store.bots.isEmpty)
        #expect(store.userName.isEmpty)
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

    @Test func initials() {
        #expect(Initials.of("Bruno Gabriel") == "BG")
        #expect(Initials.of("bruno") == "B")
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
