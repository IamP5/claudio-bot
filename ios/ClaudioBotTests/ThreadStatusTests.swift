import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)
private let turnStart = "2026-10-21T12:00:00.000Z"
private let turnDate = Date(wire: turnStart)!

private func task(_ id: String, _ kind: SessionTaskKind = .command, _ label: String = "sleep 75", background: Bool = true, started: Date = at) -> SessionTask {
    SessionTask(id: TaskID(id), stepId: "step-\(id)", kind: kind, label: label, background: background, startedAt: started, owner: nil, progress: nil, waiting: nil)
}

private func controls(working: Bool = true, turn: Bool = true, tasks: [SessionTask] = []) -> SessionControls {
    SessionControls(
        canSend: true, reason: nil, working: working, queued: 0, model: nil, models: [], mode: .default, modes: [.default],
        turn: turn ? SessionTurn(startedAt: turnStart, wake: false) : nil, tasks: tasks
    )
}

private func permission(_ id: String, tool: String = "Bash", detail: String = "perl -e 'sleep 30'", subagent: String? = nil, answer: PermissionAnswer? = nil, expires: Date = at + 600) -> SessionItem {
    .permission(id: ItemID(id), at: at, permission: SessionPermission(
        cardId: MessageID("card-\(id)"), at: at,
        card: PermissionCard(from: nil, tool: tool, label: tool, detail: detail, always: "perl", answer: answer, expiresAt: expires),
        subagent: subagent
    ))
}

private func ask(_ id: String, _ questions: [String]) -> SessionItem {
    .ask(id: ItemID(id), at: at, questions: questions.map { AskQuestion(question: $0, header: "", options: [], multiSelect: false) }, answers: nil, cardId: MessageID("card-\(id)"))
}

private func status(
    reach: Reach = .connected(machine: "Mac"), quietSince: Date? = nil, lastUpdate: Date? = at, controls: SessionControls? = nil,
    card: OpenCard? = nil, since: Date? = nil, outcome: SessionOutcome? = nil
) -> ThreadStatus? {
    ThreadStatus.of(reach: reach, quietSince: quietSince, lastUpdate: lastUpdate, controls: controls, card: card, since: since, outcome: outcome)
}

private let card = OpenCard.waiting(in: [permission("p1", subagent: "sleeper two")], at: at)!
private let failed = SessionOutcome(kind: .failed, text: "Claude Code stopped unexpectedly (terminated by signal SIGKILL)", at: at)

@MainActor
@Suite struct ThreadStatusTests {
    @Test func eachLevelHidesTheOnesBelowIt() {
        let busy = controls(tasks: [task("t1")])
        #expect(status(reach: .unreachable(nextTry: at), quietSince: at, controls: busy, card: card, outcome: failed) == .offline(.unreachable(nextTry: at), lastUpdate: at, tasks: [task("t1")]))
        #expect(status(reach: .firstConnect, lastUpdate: nil) == .offline(.firstConnect, lastUpdate: nil, tasks: []))
        #expect(status(reach: .unrecognized, controls: busy) == .offline(.unrecognized, lastUpdate: at, tasks: [task("t1")]))
        #expect(status(quietSince: at - 50, controls: busy, card: card) == .quiet(since: at - 50, tasks: [task("t1")]))
        #expect(status(controls: busy, card: card, outcome: failed) == .needsYou(card, tasks: [task("t1")]))
        let outlived = controls(turn: false, tasks: [task("t1")])
        #expect(status(controls: outlived, card: card, since: at - 60, outcome: failed) == .needsYou(card, tasks: [task("t1")]))
        #expect(status(controls: outlived, since: at - 60, outcome: failed) == .orphaned(failed, tasks: [task("t1")]))
        #expect(status(controls: busy, since: at - 60, outcome: failed) == .working(since: turnDate, tasks: [task("t1")]), "a live turn means Claude Code runs")
        #expect(status(controls: outlived, since: at + 5, outcome: failed) == .background(since: at, tasks: [task("t1")]), "a failure from an earlier run")
        #expect(status(controls: controls(turn: false, tasks: [task("t1", started: at - 30), task("t2", started: at - 90)])) == .background(since: at - 90, tasks: [task("t1", started: at - 30), task("t2", started: at - 90)]))
        #expect(status(controls: controls(turn: false), since: at - 5) == .working(since: at - 5, tasks: []), "a bridge without tasks says only that work runs")
        #expect(status(controls: controls(working: false, turn: false), outcome: failed) == .ended(failed))
        #expect(status(controls: controls(working: false, turn: false)) == nil)
    }

    @Test func aQuietSocketCountsOnlyWhileThisThreadWorks() {
        #expect(status(quietSince: at, controls: controls(working: false, turn: false)) == nil)
        #expect(status(quietSince: at, controls: controls(working: false, turn: false), card: card) == .needsYou(card, tasks: []))
    }

    @Test func aFinishedRunLeavesTheLineEmptyButAStopOrFailureStays() {
        let finished = SessionOutcome(kind: .finished, text: "Finished", at: at)
        let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you", at: at)
        let lost = SessionOutcome(kind: .lost, text: "The bridge restarted", at: at)
        let resting = controls(working: false, turn: false)
        #expect(status(controls: resting, outcome: finished) == nil)
        #expect(status(controls: resting, outcome: stopped)?.text(now: at) == "Stopped by you")
        #expect(status(controls: resting, outcome: failed)?.text(now: at) == "Claude Code stopped unexpectedly (terminated by signal SIGKILL). Send a message to start it again.")
        #expect(status(controls: resting, outcome: lost)?.text(now: at) == "The bridge restarted. Send a message to start it again.")
    }

    @Test func onlyAnOutOfDateLineFreezesTheRun() {
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40, tasks: []).staleAt == at - 40)
        #expect(ThreadStatus.quiet(since: at - 50, tasks: []).staleAt == at - 50)
        #expect(ThreadStatus.working(since: at, tasks: []).staleAt == nil)
        #expect(ThreadStatus.background(since: at, tasks: [task("t1")]).staleAt == nil)
        #expect(ThreadStatus.needsYou(card, tasks: []).staleAt == nil)
    }

    @Test func theLineSaysWhatRunsAndForHowLong() {
        let three = (1...3).map { task("a\($0)", .agent, "agent \($0)", background: false) }
        #expect(ThreadStatus.working(since: at - 125, tasks: three).text(now: at) == "Working 2m 05s · 3 agents")
        #expect(ThreadStatus.working(since: at - 125, tasks: three).spoken(now: at) == "Working 2 minutes 5 seconds · 3 agents")
        #expect(ThreadStatus.working(since: nil, tasks: []).text(now: at) == "Working")
        #expect(ThreadStatus.working(since: at - 9, tasks: [task("a", .agent), task("c")]).text(now: at) == "Working 9s · 1 agent, 1 command")
        #expect(ThreadStatus.background(since: at - 72, tasks: [task("t1")]).text(now: at) == "Running in background: sleep 75 · 1m 12s")
        #expect(ThreadStatus.background(since: at - 72, tasks: [task("t1"), task("t2", .agent, "starter")]).text(now: at) == "Running in background: 1 command, 1 agent · 1m 12s")
        let long = task("t9", .command, "sleep 75 && echo bg-done > bg.txt && echo more > more.txt")
        #expect(ThreadStatus.background(since: at - 19, tasks: [long]).text(now: at) == "Running in background: sleep 75 && echo bg-done > bg.txt && ec… · 19s")
        #expect(ThreadStatus.quiet(since: at - 50, tasks: []).text(now: at) == "No word from your Mac for 50s")
        #expect(ThreadStatus.needsYou(card, tasks: []).text(now: at) == "Needs your approval: Bash in sleeper two")
    }

    @Test func offlineSaysTheCauseAndHowOldTheThreadIs() {
        let cause = "Your Mac isn't answering at 127.0.0.1."
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40, tasks: []).text(now: at, cause: cause) == "Your Mac isn't answering at 127.0.0.1. Last update 40s ago.")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: nil, tasks: []).text(now: at, cause: cause) == "Your Mac isn't answering at 127.0.0.1. This session loads when your Mac is back.")
        #expect(ThreadStatus.offline(.firstConnect, lastUpdate: nil, tasks: []).text(now: at, cause: cause) == "Connecting to your Mac… This session loads when your Mac is back.")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40, tasks: []).spoken(now: at, cause: cause).hasSuffix("Last update 40 seconds ago."))
    }

    @Test func theHeaderSpeaksTheStateInAWord() {
        #expect(ThreadStatus.working(since: nil, tasks: []).word == "Working")
        #expect(ThreadStatus.background(since: at, tasks: [task("t")]).word == "Running in background")
        #expect(ThreadStatus.needsYou(card, tasks: []).word == "Needs your approval")
        #expect(ThreadStatus.needsYou(OpenCard.waiting(in: [ask("q", ["Which?"])], at: at)!, tasks: []).word == "Needs your answer")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: nil, tasks: []).word == "Offline")
        #expect(ThreadStatus.ended(failed).word == "Failed")
    }
}

@MainActor
@Suite struct OpenCardTests {
    @Test func theNewestOpenCardWins() {
        let items = [permission("p1"), ask("q", ["Which?"]), permission("p2", answer: .chose(.deny))]
        #expect(OpenCard.waiting(in: items, at: at)?.id == ItemID("q"))
        let answeredElsewhere = SessionItem.ask(id: ItemID("q2"), at: at, questions: [], answers: nil, cardId: nil)
        #expect(OpenCard.waiting(in: [answeredElsewhere, permission("p2", answer: .chose(.once))], at: at) == nil)
    }

    @Test func aCardPastItsDeadlineNoLongerCounts() {
        let items = [permission("p1", expires: at + 30)]
        #expect(OpenCard.waiting(in: items, at: at) != nil)
        #expect(OpenCard.waiting(in: items, at: at + 30) == nil)
        #expect(status(controls: controls(), card: OpenCard.waiting(in: items, at: at + 31)) == .working(since: turnDate, tasks: []))
    }

    @Test func thePermissionAnnouncementNamesTheAskerAndTheCommand() {
        #expect(card.announcement == "Approval needed. sleeper two wants to run Bash: perl -e 'sleep 30'")
        let main = OpenCard.waiting(in: [permission("p", tool: "Write", detail: "notes/a.md\nsecond line")], at: at)
        #expect(main?.announcement == "Approval needed. Claude wants to run Write: notes/a.md")
        #expect(main?.line == "Needs your approval: Write")
    }

    @Test func aQuestionCardCountsItsQuestions() {
        #expect(OpenCard.waiting(in: [ask("q", ["Which branch?"])], at: at)?.announcement == "Question: Which branch?")
        let three = OpenCard.waiting(in: [ask("q", ["Which branch?", "Which age?", "Which order?"])], at: at)
        #expect(three?.announcement == "3 questions. First: Which branch?")
        #expect(three?.line == "Claude asks you 3 questions")
    }

    @Test func aPlanCardIsNamedByItsFirstHeading() {
        let plan = SessionItem.plan(id: ItemID("pl"), at: at, text: "Intro line\n\n## Import a Spotify playlist\n\n1. Page it", state: .proposed, cardId: MessageID("m"))
        #expect(OpenCard.waiting(in: [plan], at: at)?.announcement == "Plan ready for your approval: Import a Spotify playlist")
        let bare = SessionItem.plan(id: ItemID("pl"), at: at, text: "1. Do it", state: .proposed, cardId: MessageID("m"))
        #expect(OpenCard.waiting(in: [bare], at: at)?.announcement == "Plan ready for your approval: 1. Do it")
    }
}

@MainActor
@Suite struct ThreadAnnouncementTests {
    private let working = ThreadStatus.working(since: at, tasks: [])

    @Test func aThreadOpenedOnACardSaysSo() {
        #expect(ThreadAnnouncement.of(from: nil, to: .needsYou(card, tasks: []), first: true, heard: card.id) == card.announcement, "opened again, it is said again")
        #expect(ThreadAnnouncement.of(from: nil, to: working, first: true) == nil, "an open thread says nothing about a run already going")
    }

    @Test func aNewCardIsSpokenOnceAndTheSameOneNotAgain() {
        #expect(ThreadAnnouncement.of(from: working, to: .needsYou(card, tasks: [])) == card.announcement)
        #expect(ThreadAnnouncement.of(from: working, to: .needsYou(card, tasks: []), heard: card.id) == nil)
        let next = OpenCard.waiting(in: [permission("p9", subagent: "sleeper three")], at: at)!
        #expect(ThreadAnnouncement.of(from: .needsYou(card, tasks: []), to: .needsYou(next, tasks: []), heard: card.id) == next.announcement)
    }

    @Test func clocksAndProgressMoveWithoutAnythingToSay() {
        var agent = task("a1", .agent, "sleeper one", background: false)
        let before = ThreadAnnouncement.key(.working(since: at, tasks: [agent]))
        agent.progress = TaskProgress(tools: 3, last: "Bash", at: at + 5)
        #expect(ThreadAnnouncement.key(.working(since: at + 1, tasks: [agent])) == before)
        #expect(ThreadAnnouncement.key(.working(since: at, tasks: [])) != before)
        #expect(ThreadAnnouncement.key(.offline(.retrying, lastUpdate: at, tasks: [])) == ThreadAnnouncement.key(.offline(.unreachable(nextTry: at), lastUpdate: nil, tasks: [agent])))
    }

    @Test func theEndOfARunIsSpokenWithHowItEnded() {
        #expect(ThreadAnnouncement.of(from: working, to: nil) == "Claude finished.")
        #expect(ThreadAnnouncement.of(from: working, to: .ended(failed)) == "Claude Code stopped unexpectedly (terminated by signal SIGKILL). Send a message to start it again.")
        let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you: the turn", at: at)
        #expect(ThreadAnnouncement.of(from: working, to: .ended(stopped)) == "Stopped by you: the turn")
        #expect(ThreadAnnouncement.of(from: .needsYou(card, tasks: []), to: .ended(failed)) == ThreadStatus.outcome(failed))
        #expect(ThreadAnnouncement.of(from: nil, to: .ended(failed)) == ThreadStatus.outcome(failed), "an outcome that lands after the rest is still spoken")
    }

    @Test func aStopThatClosesTheOpenCardIsSpokenOnceByTheCard() {
        let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you: the turn", at: at)
        #expect(ThreadAnnouncement.of(from: .needsYou(card, tasks: []), to: .ended(stopped)) == nil)
        #expect(ThreadAnnouncement.of(from: nil, to: .ended(stopped), cardClosed: true) == nil, "the stop's row landed after the rest")
        #expect(ThreadAnnouncement.of(from: nil, to: .ended(failed), cardClosed: true) == ThreadStatus.outcome(failed), "a card does not speak a failure")
    }

    @Test func anOutcomeThatEndsWithAPeriodGetsNoSecondOne() {
        let lost = SessionOutcome(kind: .lost, text: "Background shell command didn't finish before the previous session ended in background.", at: at)
        #expect(ThreadStatus.outcome(lost) == "Background shell command didn't finish before the previous session ended in background. Send a message to start it again.")
        #expect(ThreadStatus.outcome(failed) == "Claude Code stopped unexpectedly (terminated by signal SIGKILL). Send a message to start it again.")
    }

    @Test func backgroundWorkIsSpokenWhenTheTurnEndsAndWhenItFinishes() {
        let sleeper = task("t1")
        let starter = task("t2", .agent, "starter")
        #expect(ThreadAnnouncement.of(from: .working(since: at, tasks: [sleeper]), to: .background(since: at, tasks: [sleeper]))
            == "Claude finished its turn. Still running in background: sleep 75.")
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper, starter]), to: .background(since: at, tasks: [starter])) == "Ended in background. sleep 75.")
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper]), to: nil) == "Background work ended. sleep 75.")
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper]), to: .working(since: at, tasks: [])) == "Ended in background. sleep 75.")
    }

    @Test func subagentsOfTheTurnComeAndGoQuietly() {
        let agent = task("a1", .agent, "sleeper one", background: false)
        #expect(ThreadAnnouncement.of(from: .working(since: at, tasks: [agent]), to: .working(since: at, tasks: [])) == nil)
    }

    @Test func whatTheMacSaysOnReturnIsNotNews() {
        #expect(ThreadAnnouncement.of(from: .offline(.retrying, lastUpdate: at, tasks: []), to: nil) == nil)
        #expect(ThreadAnnouncement.of(from: .quiet(since: at, tasks: []), to: .ended(failed)) == nil)
        #expect(ThreadAnnouncement.of(from: .offline(.retrying, lastUpdate: at, tasks: []), to: .needsYou(card, tasks: []), heard: card.id) == nil, "the card was spoken before the drop")
        #expect(ThreadAnnouncement.of(from: .offline(.retrying, lastUpdate: at, tasks: []), to: .needsYou(card, tasks: [])) == card.announcement, "a card raised while away is news")
        #expect(ThreadAnnouncement.of(from: working, to: .offline(.retrying, lastUpdate: at, tasks: [])) == nil, "the app says the connection dropped once, for every screen")
    }
}

@MainActor
@Suite struct AnnouncerTests {
    @Test func announcementsCloserThanTheGapJoinTheNextOne() async throws {
        var spoken: [String] = []
        let announcer = Announcer(gap: 0.3) { spoken.append($0) }
        announcer.post("Claude finished.")
        try await Task.sleep(for: .milliseconds(50))
        #expect(spoken == ["Claude finished."])
        announcer.post("Approval needed.")
        announcer.post("Ended in background: sleep 75.")
        try await Task.sleep(for: .milliseconds(100))
        #expect(spoken == ["Claude finished."], "the second waits out the gap")
        try await Task.sleep(for: .milliseconds(900))
        #expect(spoken == ["Claude finished.", "Approval needed. Ended in background: sleep 75."])
    }
}

@MainActor
@Suite struct ThreadStatusModelTests {
    @Test func everyFrameMovesWhenTheAppLastHeardFromTheMac() {
        let store = AppStore()
        #expect(store.heardAt == nil)
        store.apply(.error(message: "That card already closed."), at: at)
        #expect(store.heardAt == at)
        store.apply(.sessions(.list(projects: [], rows: [], mirror: .auto)), at: at + 3)
        #expect(store.heardAt == at + 3, "a frame about another screen still says the socket was alive")
    }

    @Test func aBannerSpeaksWhatItShows() {
        #expect(ThreadBanner.cloud(nil).spoken == "Cloud session. Continue it on claude.ai.")
        #expect(ThreadBanner.waiting("Waiting for the terminal to finish. Your message runs next.").spoken == "Waiting for the terminal to finish. Your message runs next.")
        #expect(ThreadBanner.alsoInDesktop.spoken == "Also open in the Claude app.")
    }

    @Test func aTaskInTheSheetSaysWhatItIsAndWhoStartedIt() {
        var command = task("t1", started: at - 72)
        #expect(BackgroundWorkSheet.status(command, now: at, owner: "sleeper one") == "Background command · 1m 12s · started by sleeper one")
        command.waiting = MessageID("card")
        #expect(BackgroundWorkSheet.status(command, now: at, owner: nil, spoken: true) == "Background command, 1 minute 12 seconds, waiting for your approval")
        var agent = task("a1", .agent, "starter", background: false, started: at - 43)
        agent.progress = TaskProgress(tools: 7, last: "Read", at: at)
        #expect(BackgroundWorkSheet.status(agent, now: at, owner: nil) == "Subagent · 43s · 7 tools, last Read")
    }
}

@MainActor
@Suite(.serialized) struct StatusAnnouncerTests {
    private let working = ThreadStatus.working(since: at, tasks: [])

    private func announcer(_ spoken: @escaping (String) -> Void) -> StatusAnnouncer {
        StatusAnnouncer(settle: .milliseconds(50), rest: .milliseconds(400)) { text, _ in spoken(text) }
    }

    @Test func aFailureWhoseRowLandsLateIsSpokenAsAFailureAndNeverAsFinished() async throws {
        var spoken: [String] = []
        let statuses = announcer { spoken.append($0) }
        statuses.update(working)
        try await Task.sleep(for: .milliseconds(150))
        statuses.update(nil)
        try await Task.sleep(for: .milliseconds(160))
        statuses.update(.ended(failed))
        try await Task.sleep(for: .milliseconds(600))
        #expect(spoken == [ThreadStatus.outcome(failed)])
    }

    /// Runs steps (ms after the previous one, status) and returns what was spoken from step `from` on.
    private func run(_ steps: [(Int, ThreadStatus?)], from start: Int) async throws -> [String] {
        var spoken: [String] = []
        let statuses = announcer { spoken.append($0) }
        for (index, (wait, status)) in steps.enumerated() {
            try await Task.sleep(for: .milliseconds(wait))
            if index == start { spoken = [] }
            statuses.update(status)
        }
        try await Task.sleep(for: .milliseconds(700))
        return spoken
    }

    private let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you: the turn", at: at)

    @Test(arguments: [60, 120, 240])
    func aLateRowIsSpokenAsTheRunsOutcomeOnly(delay: Int) async throws {
        #expect(try await run([(0, working), (150, nil), (delay, .ended(failed))], from: 1) == [ThreadStatus.outcome(failed)])
        #expect(try await run([(0, working), (150, nil), (delay, .ended(stopped))], from: 1) == ["Stopped by you: the turn"])
    }

    @Test(arguments: [20, 60, 120, 240, 600])
    func aStopThatClosesAnOpenCardLeavesTheSpeakingToTheCard(delay: Int) async throws {
        let spoken = try await run([(0, working), (150, .needsYou(card, tasks: [])), (150, nil), (delay, .ended(stopped))], from: 2)
        #expect(spoken.isEmpty, "\(delay) ms: \(spoken)")
    }

    @Test(arguments: [60, 120])
    func aStopThatClosesAnOpenCardAFrameBeforeTheRestIsTheCardsToo(delay: Int) async throws {
        let spoken = try await run([(0, working), (150, .needsYou(card, tasks: [])), (150, working), (20, nil), (delay, .ended(stopped))], from: 2)
        #expect(spoken.isEmpty, "\(delay) ms: \(spoken)")
    }

    @Test func aStopAfterTheCardWasAnsweredAndTheRunWentOnIsSpoken() async throws {
        let spoken = try await run([(0, working), (150, .needsYou(card, tasks: [])), (150, working), (150, nil), (120, .ended(stopped))], from: 3)
        #expect(spoken == ["Stopped by you: the turn"])
    }

    @Test func aRunThatRestsWithNoOutcomeIsSpokenFinishedOnceTheRowHadItsChance() async throws {
        var spoken: [String] = []
        let statuses = announcer { spoken.append($0) }
        statuses.update(working)
        try await Task.sleep(for: .milliseconds(150))
        statuses.update(nil)
        try await Task.sleep(for: .milliseconds(200))
        #expect(spoken.isEmpty, "the rest waits for the row")
        try await Task.sleep(for: .milliseconds(500))
        #expect(spoken == ["Claude finished."])
    }
}

@MainActor
@Suite struct ThreadRetryTests {
    @Test func retryFromTheThreadRestartsAnAttemptThatHangs() async throws {
        let hello = #"{"type":"hello","protocol":3,"machine":"Mac","userName":"Alex","bots":[],"epoch":"e1","seq":0,"resumed":false}"#
        let bridge = try FakeBridge(onUpgrade: { _ in .accept }, onOpen: { socket in if socket.index > 0 { socket.send(hello) } })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let timing = BridgeClient.Timing(greeting: .seconds(30), reply: .seconds(1), legacyRetry: .milliseconds(300))
        let client = BridgeClient(store: AppStore(), vault: PairingVault(service: "dev.claudiobot.tests.\(UUID().uuidString)"), timing: timing)
        client.start(pairing)
        for _ in 0..<50 where bridge.upgrades.isEmpty { try await Task.sleep(for: .milliseconds(100)) }
        #expect(client.store.connection == .connecting, "the first socket opens and the bridge never says hello")

        let started = ContinuousClock.now
        #expect(await client.retryNowAndWait(within: .seconds(5), restartingAttempt: true))
        #expect(ContinuousClock.now - started < .seconds(5), "a new attempt, not the 30 s greeting deadline")
        #expect(bridge.upgrades.count == 2)
        client.stop()
    }
}

@Suite struct LinkedCardTests {
    private let link = LinkedCard(sessionId: SessionID("s1"), cardId: MessageID("card-p1"))

    private func note(_ items: [SessionItem], decidedHere: Set<MessageID> = []) -> String? {
        link.note(in: items, decidedHere: decidedHere, at: at)
    }

    @Test func aCardClosedElsewhereSaysNothingWaits() {
        #expect(note([permission("p1", answer: .chose(.once))]) == "Already answered. Nothing here waits on you now.")
        #expect(note([permission("p1", answer: .closed)]) == "That request is no longer open. Nothing here waits on you now.")
        #expect(note([permission("p1", answer: .stopped)]) == "That request closed when the turn was stopped.")
    }

    @Test func anExpiredCardSaysItExpired() {
        #expect(note([permission("p1", answer: .expired)]) == "That request expired.")
        #expect(note([permission("p1", expires: at - 1)]) == "That request expired.")
    }

    @Test func nothingIsSaidWhileTheCardWaits() {
        #expect(note([permission("p1")]) == nil)
    }

    @Test func aClosedCardIsNamedEvenWhenAnotherOneWaits() {
        #expect(note([permission("p1", answer: .chose(.deny)), ask("a2", ["Which branch?"])]) == "That request was answered. Another one waits on you.")
        #expect(note([permission("p1", answer: .expired), permission("p2")]) == "That request expired. Another one waits on you.")
        #expect(note([permission("p1", answer: .closed), permission("p2")]) == "That request is no longer open. Another one waits on you.")
        #expect(note([permission("p1", answer: .stopped), permission("p2")]) == "That request closed when the turn was stopped. Another one waits on you.")
    }

    @Test func nothingIsSaidForACardNotLoadedOrAnsweredOnThisPhone() {
        #expect(note([permission("p2", answer: .chose(.once))]) == nil)
        #expect(note([permission("p1", answer: .chose(.once))], decidedHere: [MessageID("card-p1")]) == nil)
    }

    @Test func aPlanFoundByItsCardSaysHowItClosed() {
        let plan = LinkedCard(sessionId: SessionID("s1"), cardId: MessageID("card-plan"))
        let rejected = SessionItem.plan(id: ItemID("pl"), at: at, text: "# Plan", state: .rejected, cardId: MessageID("card-plan"))
        let proposed = SessionItem.plan(id: ItemID("pl"), at: at, text: "# Plan", state: .proposed, cardId: MessageID("card-plan"))
        #expect(plan.note(in: [rejected], decidedHere: [], at: at) == "Already answered. Nothing here waits on you now.")
        #expect(plan.note(in: [proposed], decidedHere: [], at: at) == nil)
    }
}

private func owned(_ id: String, by agent: String, _ label: String = "sleep 30") -> SessionTask {
    var command = task(id, .command, label, background: false)
    command.owner = "step-\(agent)"
    return command
}

private let sleepers = (1...3).map { task("a\($0)", .agent, "sleeper \($0)", background: false) }
private let sleeperCommands = (1...3).map { owned("c\($0)", by: "a\($0)") }

@MainActor
@Suite struct ThreadStatusReachTests {
    @Test func everyLevelThatMayHaveWorkKeepsItsTasks() {
        let tasks = [task("t1")]
        let levels: [ThreadStatus] = [
            .offline(.retrying, lastUpdate: at, tasks: tasks), .catchingUp(lastUpdate: at, tasks: tasks), .quiet(since: at, tasks: tasks),
            .needsYou(card, tasks: tasks), .orphaned(failed, tasks: tasks), .working(since: at, tasks: tasks), .background(since: at, tasks: tasks),
        ]
        #expect(levels.allSatisfy { $0.tasks == tasks })
        #expect(ThreadStatus.ended(failed).tasks.isEmpty)
    }

    @Test func aNeedsYouLineCountsEveryOpenCardAndWhatStillRuns() throws {
        let items = [
            permission("p1", subagent: "sleeper one"), permission("p2", subagent: "sleeper two"),
            permission("p3", detail: "perl -e 'sleep 40'", subagent: "sleeper three"),
        ]
        let three = try #require(OpenCard.waiting(in: items, at: at))
        #expect(three.id == ItemID("p3") && three.count == 3)
        var held = sleepers
        held[0].waiting = MessageID("card-p1")
        let line = ThreadStatus.needsYou(three, tasks: held + [task("t9")])
        #expect(line.text(now: at + 130) == "Needs your approval: 3 requests (sleeper one, sleeper two, sleeper three) · 3 still running · 2m")
        #expect(line.spoken(now: at + 130) == "Needs your approval: 3 requests (sleeper one, sleeper two, sleeper three) · 3 still running · waiting 2 minutes")
        #expect(three.announcement == "3 requests wait on you. Newest: Approval needed. sleeper three wants to run Bash: perl -e 'sleep 40'")
        let mixed = try #require(OpenCard.waiting(in: [permission("p1"), ask("q", ["Which?"])], at: at))
        #expect(mixed.line == "Needs you: 2 requests (Bash, a question)")
    }

    @Test func theOldestOpenCardSetsTheWaitAndTheFirstDeadlineCounts() throws {
        let early = SessionItem.permission(id: ItemID("p0"), at: at - 300, permission: SessionPermission(
            cardId: MessageID("card-p0"), at: at - 300,
            card: PermissionCard(from: nil, tool: "Bash", label: "Bash", detail: "ls", always: "ls", answer: nil, expiresAt: at + 20),
            subagent: nil
        ))
        let open = try #require(OpenCard.waiting(in: [early, permission("p1")], at: at))
        #expect(open.since == at - 300)
        #expect(open.expiresAt == at + 20)
    }

    @Test func offlineAndQuietSayWhatWasRunning() {
        let cause = "Your Mac isn't answering."
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40, tasks: sleepers).text(now: at, cause: cause)
            == "Your Mac isn't answering. 3 agents were running when your Mac last answered 40s ago.")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40, tasks: [task("t1")]).spoken(now: at, cause: cause)
            == "Your Mac isn't answering. 1 command was running when your Mac last answered 40 seconds ago.")
        #expect(ThreadStatus.quiet(since: at - 50, tasks: sleepers).text(now: at) == "No word from your Mac for 50s · 3 agents were running then")
        #expect(ThreadStatus.catchingUp(lastUpdate: at, tasks: [task("t1")]).text(now: at) == "Catching up… 1 command was running at the last update.")
        #expect(ThreadStatus.offline(.reconnecting, lastUpdate: at - 1, tasks: []).text(now: at, cause: ConnectionBanner.cause(.reconnecting, address: nil, lastRetryFailed: false))
            == "Reconnecting… Last update 1s ago.")
    }

    @Test func workThatOutlivesClaudeCodeKeepsTheCrashInView() {
        let line = ThreadStatus.orphaned(failed, tasks: [task("t1")])
        #expect(line.text(now: at) == "Claude Code stopped unexpectedly (terminated by signal SIGKILL) · 1 command still runs · Stop ends it")
        #expect(line.word == "Failed")
        #expect(ThreadStatus.orphaned(failed, tasks: [task("t1"), task("t2")]).text(now: at).hasSuffix("· 2 commands still run · Stop ends them"))
        let dotted = SessionOutcome(kind: .lost, text: "The bridge restarted.", at: at)
        #expect(ThreadStatus.orphaned(dotted, tasks: [task("t1")]).text(now: at) == "The bridge restarted · 1 command still runs · Stop ends it")
    }

    @Test func aSubagentsOwnCommandIsNamedUnderItNotCountedAgain() {
        #expect(TaskCount(sleepers + sleeperCommands).text == "3 agents (each running a command)")
        #expect(ThreadStatus.working(since: at - 9, tasks: [sleepers[0], sleeperCommands[0], task("t9")]).spoken(now: at) == "Working 9 seconds · 1 agent (running a command), 1 command")
        #expect(ThreadStatus.working(since: at - 9, tasks: [sleepers[0], sleeperCommands[0], task("t9")]).text(now: at) == "Working 9s · 1 agent, 1 command", "shown, Running now has what runs under each agent")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40, tasks: sleepers + sleeperCommands).text(now: at, cause: "Your Mac isn't answering.")
            == "Your Mac isn't answering. 3 agents were running when your Mac last answered 40s ago.")
        #expect(TaskCount(sleepers + [sleeperCommands[0]]).text == "3 agents (1 running a command)")
        #expect(TaskCount(sleepers + [sleeperCommands[0], owned("c4", by: "a1")]).text == "3 agents (1 running 2 commands)")
        #expect(TaskCount([sleeperCommands[0]]).text == "1 command", "a command whose agent ended counts on its own")
        var nested = task("a9", .agent, "helper", background: false)
        nested.owner = "step-a1"
        #expect(TaskCount([sleepers[0], nested, owned("c9", by: "a9")]).text == "1 agent (running a task)", "only work a top-level agent started is named under it")
        let stop = StopScope(controls(tasks: sleepers + sleeperCommands))
        #expect(stop.label == "Stop the turn and 3 agents (each running a command)")
    }

    @Test func runningNowSaysHowManyAndWhatStopAllEnds() {
        #expect(BackgroundWorkSheet.title(count: 6, stale: false) == "6 running")
        #expect(BackgroundWorkSheet.title(count: 6, stale: true) == "6 were running")
        #expect(BackgroundWorkSheet.title(count: 0, stale: false) == "Running now")
        #expect(BackgroundWorkSheet.stopAll(count: 6, turn: true, phase: .ready) == "Stop all 6 and the current turn")
        #expect(BackgroundWorkSheet.stopAll(count: 2, turn: false, phase: .stopping) == "Stopping all 2…")
        #expect(BackgroundWorkSheet.stopAll(count: 6, turn: true, phase: .unconfirmed) == "Not stopped yet. Stop all 6 and the current turn again")
        #expect(BackgroundWorkSheet.stopAll(count: 1, turn: false, phase: .refused("No.")) == "Not stopped yet. Stop the 1 task again")
    }
}

@MainActor
@Suite struct ThreadStatusSpeechTests {
    private let working = ThreadStatus.working(since: at, tasks: [])

    @Test func goingQuietIsSpokenOnce() {
        #expect(ThreadAnnouncement.of(from: working, to: .quiet(since: at - 45, tasks: []), now: at) == "No word from your Mac for 45 seconds. The thread may be out of date.")
        #expect(ThreadAnnouncement.of(from: .needsYou(card, tasks: []), to: .quiet(since: at - 46, tasks: []), now: at) == "No word from your Mac for 46 seconds. The thread may be out of date.")
        #expect(ThreadAnnouncement.of(from: .quiet(since: at - 45, tasks: []), to: .quiet(since: at - 45, tasks: [task("t1")]), now: at) == nil)
        #expect(ThreadAnnouncement.of(from: nil, to: .quiet(since: at - 45, tasks: []), first: true, now: at) == nil)
    }

    @Test func aCrashThatLeavesWorkRunningIsSpoken() {
        let orphan = ThreadStatus.orphaned(failed, tasks: [task("t1")])
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [task("t1")]), to: orphan, now: at)
            == "Claude Code stopped unexpectedly (terminated by signal SIGKILL) · 1 command still runs · Stop ends it")
        #expect(ThreadAnnouncement.of(from: orphan, to: .ended(failed)) == "Background work ended. sleep 75.", "the crash was already spoken")
    }

    @Test func endedWorkIsNamedByItsStepAndHowItEnded() {
        let sleeper = task("t1", .command, "sleep 75 && echo bg-done")
        let work = SessionItem.work(id: ItemID("w"), at: at, steps: [
            ToolStep(id: "step-t1", tool: "Bash", label: "Sleep 75 seconds", state: .ok, diff: nil, output: nil, detail: "sleep 75 && echo bg-done"),
        ])
        #expect(ThreadAnnouncement.name(sleeper, in: [work]).spoken == "Sleep 75 seconds, done.")
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper]), to: nil) { ThreadAnnouncement.name($0, in: [work]) }
            == "Background work ended. Sleep 75 seconds, done.")
        let running = SessionItem.work(id: ItemID("w"), at: at, steps: [
            ToolStep(id: "step-t1", tool: "Bash", label: "Sleep 75 seconds", state: .running, diff: nil, output: nil, detail: nil),
        ])
        #expect(ThreadAnnouncement.name(sleeper, in: [running]).spoken == "Sleep 75 seconds.", "no outcome the thread has not shown")
        #expect(ThreadAnnouncement.name(sleeper, in: []).spoken == "sleep 75 && echo bg-done.")
        let unsure = SessionItem.work(id: ItemID("w"), at: at, steps: [
            ToolStep(id: "step-t1", tool: "Bash", label: "Sleep 75 seconds", state: .unsure, diff: nil, output: nil, detail: nil),
        ])
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper, task("t2")]), to: nil) { ThreadAnnouncement.name($0, in: [unsure]) }
            == "Background work ended. sleep 75. Sleep 75 seconds may still run on your Mac.", "work the bridge lost track of is never called ended")
    }

    @Test func aStopThatClosesAPlanOrQuestionIsStillSpoken() {
        let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you", at: at)
        let plan = OpenCard.waiting(in: [.plan(id: ItemID("pl"), at: at, text: "# Plan", state: .proposed, cardId: MessageID("m"))], at: at)!
        #expect(ThreadAnnouncement.of(from: .needsYou(plan, tasks: []), to: .ended(stopped)) == "Stopped by you")
        let question = OpenCard.waiting(in: [ask("q", ["Which?"])], at: at)!
        #expect(ThreadAnnouncement.of(from: .needsYou(question, tasks: []), to: .ended(stopped)) == "Stopped by you")
        let mixed = OpenCard.waiting(in: [ask("q", ["Which?"]), permission("p1")], at: at)!
        #expect(mixed.kind == .permission)
        #expect(ThreadAnnouncement.of(from: .needsYou(mixed, tasks: []), to: .ended(stopped)) == "Stopped by you", "the question's close does not say stopped")
        let permissions = OpenCard.waiting(in: [permission("p1"), permission("p2")], at: at)!
        #expect(ThreadAnnouncement.of(from: .needsYou(permissions, tasks: []), to: .ended(stopped)) == nil)
    }

    @Test func plansAndQuestionsSayHowTheyClosed() {
        #expect(PlanCard.closing(.proposed) == nil)
        #expect(PlanCard.closing(.approved) == "Plan approved.")
        #expect(PlanCard.closing(.rejected) == "Plan not approved. Kept planning.")
        #expect(PlanCard.closing(.expired) == "The plan closed without an answer.")
        #expect(AskCard.closing(nil, count: 1) == nil)
        #expect(AskCard.closing(.answered(["Which?": "A"]), count: 1) == "Question answered.")
        #expect(AskCard.closing(.dismissed, count: 2) == "Question dismissed.")
        #expect(AskCard.closing(.expired, count: 1) == "The question closed without an answer.")
    }

    @Test func sendAnswersSaysWhichQuestionIsLeft() {
        let questions = ["Which branch?", "Which age?", "Which order?"].map { AskQuestion(question: $0, header: "", options: [], multiSelect: false) }
        #expect(AskCard.unanswered(questions, answered: ["Which branch?"]) == "Still to answer: Which age? and Which order?")
        #expect(AskCard.unanswered(questions, answered: ["Which branch?", "Which order?"]) == "Still to answer: Which age?")
        #expect(AskCard.unanswered(questions, answered: Set(questions.map(\.question))) == nil)
        #expect(AskCard.unanswered(Array(questions.prefix(1)), answered: []) == "Pick or type an answer to send it.")
    }
}

@MainActor
@Suite(.serialized) struct StatusAnnouncerPlanTests {
    @Test func aCrashThatLeavesWorkRunningIsNeverFirstSpokenAsAFinishedTurn() async throws {
        var spoken: [String] = []
        let statuses = StatusAnnouncer(settle: .milliseconds(50), rest: .milliseconds(400)) { text, _ in spoken.append(text) }
        statuses.update(.working(since: at, tasks: [task("t1")]))
        try await Task.sleep(for: .milliseconds(150))
        statuses.update(.background(since: at, tasks: [task("t1")]))
        try await Task.sleep(for: .milliseconds(200))
        statuses.update(.orphaned(failed, tasks: [task("t1")]))
        try await Task.sleep(for: .milliseconds(300))
        #expect(spoken == ["Claude Code stopped unexpectedly (terminated by signal SIGKILL) · 1 command still runs · Stop ends it"])
    }

    @Test func aTurnThatEndsWithWorkLeftIsSpokenOnceTheRowHadItsChance() async throws {
        var spoken: [String] = []
        let statuses = StatusAnnouncer(settle: .milliseconds(50), rest: .milliseconds(400)) { text, _ in spoken.append(text) }
        statuses.update(.working(since: at, tasks: [task("t1")]))
        try await Task.sleep(for: .milliseconds(150))
        statuses.update(.background(since: at, tasks: [task("t1")]))
        try await Task.sleep(for: .milliseconds(600))
        #expect(spoken == ["Claude finished its turn. Still running in background: sleep 75."])
    }

    @Test func aStopThatClosesAPlanIsSpokenAfterThePlanSaysItClosed() async throws {
        var spoken: [String] = []
        let statuses = StatusAnnouncer(settle: .milliseconds(50), rest: .milliseconds(400)) { text, _ in spoken.append(text) }
        let plan = OpenCard.waiting(in: [.plan(id: ItemID("pl"), at: at, text: "# Plan", state: .proposed, cardId: MessageID("m"))], at: at)!
        statuses.update(.working(since: at, tasks: []))
        try await Task.sleep(for: .milliseconds(150))
        statuses.update(.needsYou(plan, tasks: []))
        try await Task.sleep(for: .milliseconds(150))
        spoken = []
        statuses.update(nil)
        try await Task.sleep(for: .milliseconds(120))
        statuses.update(.ended(SessionOutcome(kind: .stopped, text: "Stopped by you", at: at)))
        try await Task.sleep(for: .milliseconds(700))
        #expect(spoken == ["Stopped by you"])
    }
}
