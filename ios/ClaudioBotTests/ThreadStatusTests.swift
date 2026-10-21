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

private let card = OpenCard.newest(in: [permission("p1", subagent: "sleeper two")], at: at)!
private let failed = SessionOutcome(kind: .failed, text: "Claude Code stopped unexpectedly (terminated by signal SIGKILL)", at: at)

@MainActor
@Suite struct ThreadStatusTests {
    @Test func eachLevelHidesTheOnesBelowIt() {
        let busy = controls(tasks: [task("t1")])
        #expect(status(reach: .unreachable(nextTry: at), quietSince: at, controls: busy, card: card, outcome: failed) == .offline(.unreachable(nextTry: at), lastUpdate: at))
        #expect(status(reach: .firstConnect, lastUpdate: nil) == .offline(.firstConnect, lastUpdate: nil))
        #expect(status(reach: .unrecognized, controls: busy) == .offline(.unrecognized, lastUpdate: at))
        #expect(status(quietSince: at - 50, controls: busy, card: card) == .quiet(since: at - 50))
        #expect(status(controls: busy, card: card) == .needsYou(card))
        #expect(status(controls: busy, outcome: failed) == .working(since: turnDate, tasks: [task("t1")]))
        #expect(status(controls: controls(turn: false, tasks: [task("t1", started: at - 30), task("t2", started: at - 90)])) == .background(since: at - 90, tasks: [task("t1", started: at - 30), task("t2", started: at - 90)]))
        #expect(status(controls: controls(turn: false), since: at - 5) == .working(since: at - 5, tasks: []), "a bridge without tasks says only that work runs")
        #expect(status(controls: controls(working: false, turn: false), outcome: failed) == .ended(failed))
        #expect(status(controls: controls(working: false, turn: false)) == nil)
    }

    @Test func aQuietSocketCountsOnlyWhileThisThreadWorks() {
        #expect(status(quietSince: at, controls: controls(working: false, turn: false)) == nil)
        #expect(status(quietSince: at, controls: controls(working: false, turn: false), card: card) == .needsYou(card))
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
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40).staleAt == at - 40)
        #expect(ThreadStatus.quiet(since: at - 50).staleAt == at - 50)
        #expect(ThreadStatus.working(since: at, tasks: []).staleAt == nil)
        #expect(ThreadStatus.background(since: at, tasks: [task("t1")]).staleAt == nil)
        #expect(ThreadStatus.needsYou(card).staleAt == nil)
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
        #expect(ThreadStatus.quiet(since: at - 50).text(now: at) == "No word from your Mac for 50s")
        #expect(ThreadStatus.needsYou(card).text(now: at) == "Needs your approval: Bash in sleeper two")
    }

    @Test func offlineSaysTheCauseAndHowOldTheThreadIs() {
        let cause = "Your Mac isn't answering at 127.0.0.1."
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40).text(now: at, cause: cause) == "Your Mac isn't answering at 127.0.0.1. Last update 40s ago.")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: nil).text(now: at, cause: cause) == "Your Mac isn't answering at 127.0.0.1. This session loads when your Mac is back.")
        #expect(ThreadStatus.offline(.firstConnect, lastUpdate: nil).text(now: at, cause: cause) == "Connecting to your Mac… This session loads when your Mac is back.")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: at - 40).spoken(now: at, cause: cause).hasSuffix("Last update 40 seconds ago."))
    }

    @Test func theHeaderSpeaksTheStateInAWord() {
        #expect(ThreadStatus.working(since: nil, tasks: []).word == "Working")
        #expect(ThreadStatus.background(since: at, tasks: [task("t")]).word == "Running in background")
        #expect(ThreadStatus.needsYou(card).word == "Needs your approval")
        #expect(ThreadStatus.needsYou(OpenCard.newest(in: [ask("q", ["Which?"])], at: at)!).word == "Needs your answer")
        #expect(ThreadStatus.offline(.retrying, lastUpdate: nil).word == "Offline")
        #expect(ThreadStatus.ended(failed).word == "Failed")
    }
}

@MainActor
@Suite struct OpenCardTests {
    @Test func theNewestOpenCardWins() {
        let items = [permission("p1"), ask("q", ["Which?"]), permission("p2", answer: .chose(.deny))]
        #expect(OpenCard.newest(in: items, at: at)?.id == ItemID("q"))
        let answeredElsewhere = SessionItem.ask(id: ItemID("q2"), at: at, questions: [], answers: nil, cardId: nil)
        #expect(OpenCard.newest(in: [answeredElsewhere, permission("p2", answer: .chose(.once))], at: at) == nil)
    }

    @Test func aCardPastItsDeadlineNoLongerCounts() {
        let items = [permission("p1", expires: at + 30)]
        #expect(OpenCard.newest(in: items, at: at) != nil)
        #expect(OpenCard.newest(in: items, at: at + 30) == nil)
        #expect(status(controls: controls(), card: OpenCard.newest(in: items, at: at + 31)) == .working(since: turnDate, tasks: []))
    }

    @Test func thePermissionAnnouncementNamesTheAskerAndTheCommand() {
        #expect(card.announcement == "Approval needed. sleeper two wants to run Bash: perl -e 'sleep 30'")
        let main = OpenCard.newest(in: [permission("p", tool: "Write", detail: "notes/a.md\nsecond line")], at: at)
        #expect(main?.announcement == "Approval needed. Claude wants to run Write: notes/a.md")
        #expect(main?.line == "Needs your approval: Write")
    }

    @Test func aQuestionCardCountsItsQuestions() {
        #expect(OpenCard.newest(in: [ask("q", ["Which branch?"])], at: at)?.announcement == "Question: Which branch?")
        let three = OpenCard.newest(in: [ask("q", ["Which branch?", "Which age?", "Which order?"])], at: at)
        #expect(three?.announcement == "3 questions. First: Which branch?")
        #expect(three?.line == "Claude asks you 3 questions")
    }

    @Test func aPlanCardIsNamedByItsFirstHeading() {
        let plan = SessionItem.plan(id: ItemID("pl"), at: at, text: "Intro line\n\n## Import a Spotify playlist\n\n1. Page it", state: .proposed, cardId: MessageID("m"))
        #expect(OpenCard.newest(in: [plan], at: at)?.announcement == "Plan ready for your approval: Import a Spotify playlist")
        let bare = SessionItem.plan(id: ItemID("pl"), at: at, text: "1. Do it", state: .proposed, cardId: MessageID("m"))
        #expect(OpenCard.newest(in: [bare], at: at)?.announcement == "Plan ready for your approval: 1. Do it")
    }
}

@MainActor
@Suite struct ThreadAnnouncementTests {
    private let working = ThreadStatus.working(since: at, tasks: [])

    @Test func aThreadOpenedOnACardSaysSo() {
        #expect(ThreadAnnouncement.of(from: nil, to: .needsYou(card), first: true, heard: card.id) == card.announcement, "opened again, it is said again")
        #expect(ThreadAnnouncement.of(from: nil, to: working, first: true) == nil, "an open thread says nothing about a run already going")
    }

    @Test func aNewCardIsSpokenOnceAndTheSameOneNotAgain() {
        #expect(ThreadAnnouncement.of(from: working, to: .needsYou(card)) == card.announcement)
        #expect(ThreadAnnouncement.of(from: working, to: .needsYou(card), heard: card.id) == nil)
        let next = OpenCard.newest(in: [permission("p9", subagent: "sleeper three")], at: at)!
        #expect(ThreadAnnouncement.of(from: .needsYou(card), to: .needsYou(next), heard: card.id) == next.announcement)
    }

    @Test func clocksAndProgressMoveWithoutAnythingToSay() {
        var agent = task("a1", .agent, "sleeper one", background: false)
        let before = ThreadAnnouncement.key(.working(since: at, tasks: [agent]))
        agent.progress = TaskProgress(tools: 3, last: "Bash", at: at + 5)
        #expect(ThreadAnnouncement.key(.working(since: at + 1, tasks: [agent])) == before)
        #expect(ThreadAnnouncement.key(.working(since: at, tasks: [])) != before)
        #expect(ThreadAnnouncement.key(.offline(.retrying, lastUpdate: at)) == ThreadAnnouncement.key(.offline(.unreachable(nextTry: at), lastUpdate: nil)))
    }

    @Test func theEndOfARunIsSpokenWithHowItEnded() {
        #expect(ThreadAnnouncement.of(from: working, to: nil) == "Claude finished.")
        #expect(ThreadAnnouncement.of(from: working, to: .ended(failed)) == "Claude Code stopped unexpectedly (terminated by signal SIGKILL). Send a message to start it again.")
        let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you: the turn", at: at)
        #expect(ThreadAnnouncement.of(from: working, to: .ended(stopped)) == "Stopped by you: the turn")
        #expect(ThreadAnnouncement.of(from: .needsYou(card), to: .ended(failed)) == ThreadStatus.outcome(failed))
        #expect(ThreadAnnouncement.of(from: nil, to: .ended(failed)) == ThreadStatus.outcome(failed), "an outcome that lands after the rest is still spoken")
    }

    @Test func aStopThatClosesTheOpenCardIsSpokenOnceByTheCard() {
        let stopped = SessionOutcome(kind: .stopped, text: "Stopped by you: the turn", at: at)
        #expect(ThreadAnnouncement.of(from: .needsYou(card), to: .ended(stopped)) == nil)
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
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper, starter]), to: .background(since: at, tasks: [starter])) == "Ended in background: sleep 75.")
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper]), to: nil) == "Background work ended: sleep 75.")
        #expect(ThreadAnnouncement.of(from: .background(since: at, tasks: [sleeper]), to: .working(since: at, tasks: [])) == "Ended in background: sleep 75.")
    }

    @Test func subagentsOfTheTurnComeAndGoQuietly() {
        let agent = task("a1", .agent, "sleeper one", background: false)
        #expect(ThreadAnnouncement.of(from: .working(since: at, tasks: [agent]), to: .working(since: at, tasks: [])) == nil)
    }

    @Test func whatTheMacSaysOnReturnIsNotNews() {
        #expect(ThreadAnnouncement.of(from: .offline(.retrying, lastUpdate: at), to: nil) == nil)
        #expect(ThreadAnnouncement.of(from: .quiet(since: at), to: .ended(failed)) == nil)
        #expect(ThreadAnnouncement.of(from: .offline(.retrying, lastUpdate: at), to: .needsYou(card), heard: card.id) == nil, "the card was spoken before the drop")
        #expect(ThreadAnnouncement.of(from: .offline(.retrying, lastUpdate: at), to: .needsYou(card)) == card.announcement, "a card raised while away is news")
        #expect(ThreadAnnouncement.of(from: working, to: .offline(.retrying, lastUpdate: at)) == nil, "the app says the connection dropped once, for every screen")
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

    @Test func theDetailPaneCountsTheOtherSessionsAtWork() {
        func row(_ id: String, _ status: SessionStatus, hidden: Bool = false) -> SessionRow {
            SessionRow(
                id: SessionID(id), projectId: ProjectID("p"), parentId: nil, title: id, origin: .phone, agent: nil, status: status, holder: .claudio,
                unread: false, branch: nil, worktree: false, pr: nil, mirror: .notMirrored, hidden: hidden, url: nil, createdAt: at, lastAt: at
            )
        }
        let rows = [row("a", .working), row("b", .working), row("c", .awaitingApproval), row("d", .idle), row("e", .working, hidden: true), row("f", .working)]
        #expect(SessionsAtWork(rows, excluding: SessionID("f")).summary == "2 working · 1 needs you")
        #expect(SessionsAtWork([row("a", .awaitingInput), row("b", .awaitingApproval)]).summary == "2 need you")
        #expect(SessionsAtWork([row("d", .idle)]).summary == nil)
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
@Suite struct StatusAnnouncerTests {
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
