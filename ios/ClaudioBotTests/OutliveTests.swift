import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)
private let sid = SessionID("s1")

private func controls(working: Bool = false, turn: String? = nil) -> SessionControls {
    SessionControls(
        canSend: true, reason: nil, working: working, queued: 0, model: nil, models: [], mode: .default, modes: [.default],
        turn: turn.map { SessionTurn(startedAt: $0, wake: false) }, tasks: turn == nil ? nil : []
    )
}

private func user(_ id: String, _ text: String = "Run the tests", queued: Bool = false, clientId: String? = nil) -> SessionItem {
    .user(id: ItemID(id), at: at, text: text, from: .user, queued: queued, clientId: clientId)
}

private func ask(_ id: String, answers: AskAnswers? = nil, cardId: String) -> SessionItem {
    .ask(
        id: ItemID(id), at: at, questions: [AskQuestion(question: "Which library?", header: "", options: [AskOption(label: "Howler", description: "")], multiSelect: false)],
        answers: answers, cardId: MessageID(cardId)
    )
}

private func plan(_ id: String, _ state: PlanState, cardId: String) -> SessionItem {
    .plan(id: ItemID(id), at: at, text: "# Fade the audio", state: state, cardId: MessageID(cardId))
}

/// A store said hello with `features` and holds thread s1 at rev 1.
@MainActor
private func store(_ features: [Feature] = [.sessions], items: [SessionItem] = [], controls c: SessionControls = controls()) -> AppStore {
    let store = AppStore()
    store.apply(.hello(Hello(features: features, machine: "Mac", userName: "Alex", bots: [])))
    store.threads.open(sid)
    store.apply(.thread(sessionId: sid, .snapshot(SessionSnapshot(epoch: "e1", rev: 1, items: items, before: nil, controls: c, live: nil))))
    return store
}

@MainActor
private func items(_ store: AppStore, rev: Int, _ items: [SessionItem] = [], removed: [String] = []) {
    store.apply(.thread(sessionId: sid, .items(rev: rev, items: items, removed: removed.map { ItemID($0) }, controls: nil)))
}

private func send(_ clientId: String, _ text: String = "Run the tests") -> ClientMessage {
    .sessionSend(sessionId: sid, text: text, clientId: clientId, interrupt: false)
}

/// F-SES-070: a session send outlives the socket it went on.
@MainActor
@Suite struct SessionSendTests {
    @Test func aSendTheSocketTookIsResentAfterHelloUntilAFrameShowsItBack() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        store.sendStarted(send("c1"))
        #expect(model.pendingSends[ItemID("c1")]?.state == .waiting)
        store.sendTransmitted(send("c1"), at: at)
        #expect(model.pendingSends[ItemID("c1")]?.state == .sending(since: at))

        store.apply(.hello(Hello(features: [.sessions], machine: "Mac", userName: "Alex", bots: [])))
        #expect(store.resendsAfterHello() == [send("c1")], "the same clientId, so the bridge runs it once")

        items(store, rev: 2, [user("c1", queued: true)])
        #expect(store.resendsAfterHello().isEmpty)
        #expect(model.pendingSends.isEmpty)
    }

    @Test func aSendASocketTookWithNoEchoInTenSecondsMayHaveGoneThroughAndDiscardForgetsIt() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        store.sendStarted(send("c1"), at: at)
        store.sendTransmitted(send("c1"), at: at)
        model.lapseSends(at: at + 9)
        #expect(model.pendingSends[ItemID("c1")]?.state == .sending(since: at))
        model.lapseSends(at: at + 10)
        #expect(model.pendingSends[ItemID("c1")]?.state == .unechoed, "a socket took it, so it is never called not sent")
        #expect(SessionUserBubble.words(.unechoed) == "No word from your Mac yet. It may have gone through.")
        #expect(SessionUserBubble.words(.sending(since: at)) == "Sending…")
        #expect(SessionUserBubble.words(.notSent(nil)) == "Not sent")
        #expect(SessionUserBubble.words(.notSent("This session's transcript is gone.")) == "Not sent: This session's transcript is gone.")
        #expect(model.items.map(\.id) == [ItemID("c1")])

        store.discardSend(sessionId: sid, clientId: "c1")
        #expect(store.unechoedSends.isEmpty)
        #expect(model.pendingSends.isEmpty)
        #expect(model.items.isEmpty, "its echo leaves the thread")
        #expect(store.resendsAfterHello(now: at + 1).isEmpty)
    }

    @Test func aSessionSendIsResentAfterHelloOnlyWithinAMinuteOfTheTap() {
        let store = store()
        store.sendStarted(send("c1"), at: at)
        #expect(store.resendsAfterHello(now: at + 59) == [send("c1")])
        #expect(store.resendsAfterHello(now: at + 61).isEmpty)
        #expect(store.unechoedSends.isEmpty, "no longer owed: only Retry sends it now")
        store.sendStarted(send("c2"), at: at)
        store.sendStarted(send("c2"), at: at + 100)
        #expect(store.resendsAfterHello(now: at + 130) == [send("c2")], "Retry starts its age again")
    }

    @Test func aSendHeldOfflinePastItsAgeReadsNotSent() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        store.sendStarted(send("c1"), at: at)
        store.requestDropped(send("c1"))
        #expect(model.pendingSends[ItemID("c1")]?.state == .notSent(nil))
        #expect(store.unechoedSends.isEmpty)
    }

    @Test func aRetryOfASendThatMayHaveGoneThroughNeverReadsNotSent() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        store.sendStarted(send("c1"), at: at)
        store.sendTransmitted(send("c1"), at: at)
        model.lapseSends(at: at + 10)
        store.sendStarted(send("c1"), at: at + 20)
        #expect(model.pendingSends[ItemID("c1")]?.state == .unechoed, "retried offline: the first copy may have arrived")
        store.requestDropped(send("c1"))
        #expect(model.pendingSends[ItemID("c1")]?.state == .unechoed)
    }

    @Test func aSendIsSpokenAsSendingThenSentOnlyOnceTheMacShowsItBack() {
        #expect(ComposerState.sentAnnouncement(offline: false) == "Sending.")
        #expect(ComposerState.sentAnnouncement(offline: true) == "Not sent yet. It goes if your Mac is back within a minute.")
        #expect(PendingSend.announcement(old: .sending(since: at), new: nil, echoedQueued: false) == "Sent.")
        #expect(PendingSend.announcement(old: .sending(since: at), new: nil, echoedQueued: true) == "Queued behind the current turn.")
        #expect(PendingSend.announcement(old: .unechoed, new: nil, echoedQueued: nil) == nil, "discarded: nothing to say")
        #expect(PendingSend.announcement(old: .sending(since: at), new: .unechoed, echoedQueued: nil) == "No word from your Mac yet. Your message may not have arrived.")
        #expect(PendingSend.announcement(old: .waiting, new: .notSent(nil), echoedQueued: nil) == "Your message was not sent. Your Mac was unreachable.")
        #expect(PendingSend.announcement(old: .waiting, new: .notSent("This session's transcript is gone."), echoedQueued: nil) == nil)
        #expect(PendingSend.announcement(old: .waiting, new: .sending(since: at), echoedQueued: nil) == nil)
    }

    @Test func theEchoTellsWhetherTheMessageQueued() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        items(store, rev: 2, [user("t-9", queued: true, clientId: "c1")], removed: ["c1"])
        #expect(model.shownBehindTurn(ItemID("c1")) == false, "queued until Claude Code takes it, with no turn to wait behind")
        #expect(model.shownBehindTurn(ItemID("c2")) == nil)
        store.apply(.thread(sessionId: sid, .items(rev: 3, items: [], removed: [], controls: controls(working: true, turn: "2026-10-16T12:00:00.000Z"))))
        #expect(model.shownBehindTurn(ItemID("c1")) == true)
    }

    @Test func aSendOfflineIsNeverCalledSent() {
        #expect(SessionUserBubble.words(.waiting) == "Not sent yet · Goes if your Mac is back within a minute")
    }

    @Test func aSnapshotThatDoesNotHaveThePendingMessageYetKeepsItsEcho() throws {
        let store = store(items: [user("u0", "Earlier")])
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at + 5)
        store.apply(.thread(sessionId: sid, .snapshot(SessionSnapshot(epoch: "e2", rev: 9, items: [user("u0", "Earlier")], before: nil, controls: controls(), live: nil))))
        #expect(model.items.map(\.id) == [ItemID("u0"), ItemID("c1")])
        #expect(model.pendingSends[ItemID("c1")] != nil)
    }

    @Test func aRefusedSendReadsNotSentInTheMacsWordsAndIsNotResent() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        store.sendStarted(send("c1"))
        store.apply(.error(message: "This session's transcript is gone.", about: .send(sessionId: sid, clientId: "c1")))
        #expect(model.pendingSends[ItemID("c1")]?.state == .notSent("This session's transcript is gone."))
        #expect(store.resendsAfterHello().isEmpty)
    }

    @Test func theTranscriptsCopyNamingTheClientIdShowsTheSendBack() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.echo(clientId: "c1", text: "Run the tests", at: at)
        store.sendStarted(send("c1"))
        items(store, rev: 2, [user("t-9", clientId: "c1")], removed: ["c1"])
        #expect(model.pendingSends.isEmpty)
        #expect(store.resendsAfterHello().isEmpty)
    }

    @Test func aSendGivenUpAfterThreeSocketsIsNotResentAgain() {
        let store = store()
        store.sendStarted(send("c1"))
        for _ in 0..<3 { store.sendTransmitted(send("c1"), at: at) }
        #expect(store.resendsAfterHello().isEmpty)
    }
}

/// The withdraw note survives the bridge re-keying the message to its transcript id.
@MainActor
@Suite struct WithdrawRekeyTests {
    @Test func aWithdrawnMessageThatRanKeepsItsNoteOnceTheTranscriptRenamesIt() throws {
        let store = store(items: [user("c1", queued: true)])
        let model = try #require(store.threads[sid])
        model.withdraw(ItemID("c1"), edited: true, at: at)
        items(store, rev: 2, [user("c1", queued: false)])
        #expect(model.sentAnyway == [ItemID("c1"): true])
        items(store, rev: 3, [user("t-9", clientId: "c1")], removed: ["c1"])
        #expect(model.sentAnyway == [ItemID("t-9"): true])
    }

    @Test func oneReplacementFrameReadsAsSentNotAsADrop() throws {
        let store = store(items: [user("c1", queued: true)])
        let model = try #require(store.threads[sid])
        model.withdraw(ItemID("c1"), edited: false, at: at)
        items(store, rev: 2, [user("t-9", clientId: "c1")], removed: ["c1"])
        #expect(model.withdrawals.isEmpty)
        #expect(model.sentAnyway == [ItemID("t-9"): false])
    }

    @Test func aWithdrawalTheMacDroppedLeavesNoNote() throws {
        let store = store(items: [user("c1", queued: true)])
        let model = try #require(store.threads[sid])
        model.withdraw(ItemID("c1"), edited: false, at: at)
        items(store, rev: 2, removed: ["c1"])
        #expect(model.withdrawals.isEmpty)
        #expect(model.sentAnyway.isEmpty)
    }

    @Test func theNoteGoesWithItsMessage() throws {
        let store = store(items: [user("c1", queued: true)])
        let model = try #require(store.threads[sid])
        model.withdraw(ItemID("c1"), edited: false, at: at)
        items(store, rev: 2, [user("c1", queued: false)])
        #expect(model.sentAnyway.count == 1)
        items(store, rev: 3, removed: ["c1"])
        #expect(model.sentAnyway.isEmpty, "pruned once the message is gone")
    }
}

/// F-SES-014, F-SES-094: requests held offline that no longer mean what the user meant.
@MainActor
@Suite struct StaleRequestTests {
    @Test func stopsAndDecisionsHeldPastAMinuteAreNotWanted() {
        let stop = ClientMessage.sessionStop(sessionId: sid, target: .all, turnStartedAt: "2026-10-16T12:00:00.000Z")
        #expect(BridgeClient.stillWanted(stop, queuedAt: at, now: at + 60, maxAge: 60))
        #expect(!BridgeClient.stillWanted(stop, queuedAt: at, now: at + 61, maxAge: 60))
        #expect(!BridgeClient.stillWanted(.sessionDecide(sessionId: sid, cardId: MessageID("m1"), choice: .once), queuedAt: at, now: at + 61, maxAge: 60))
        #expect(!BridgeClient.stillWanted(.sessionAnswer(sessionId: sid, cardId: MessageID("m1"), answers: nil), queuedAt: at, now: at + 61, maxAge: 60))
    }

    @Test func everySessionRequestHeldPastAMinuteIsNotWantedWhileABotMessageStillIs() {
        let requests: [ClientMessage] = [
            .sessionSet(sessionId: sid, patch: SessionPatch(mode: .plan)), .sessionSet(sessionId: sid, patch: SessionPatch(hidden: true)),
            .sessionOpenDesktop(sessionId: sid), .sessionPrefs(mirror: .never), send("c1"),
            .sessionSend(sessionId: sid, text: "Do this instead", clientId: "c2", interrupt: true, turnStartedAt: "2026-10-16T12:00:00.000Z"),
        ]
        for msg in requests {
            #expect(OutboxRule.of(msg) == .expires)
            #expect(BridgeClient.stillWanted(msg, queuedAt: at, now: at + 60, maxAge: OutboxRule.maxAge))
            #expect(!BridgeClient.stillWanted(msg, queuedAt: at, now: at + 61, maxAge: OutboxRule.maxAge))
        }
        let botSend = ClientMessage.send(botId: BotID("b1"), text: "hi", uploads: [])
        #expect(OutboxRule.of(botSend) == .waits)
        #expect(BridgeClient.stillWanted(botSend, queuedAt: at, now: at + 3600, maxAge: OutboxRule.maxAge))
        #expect(OutboxRule.maxAge == 60)
    }

    @Test func eachDroppedRequestSaysWhatWasNotSent() {
        let store = store()
        store.sessionRequestSent(.sessionSet(sessionId: sid, patch: SessionPatch(mode: .plan)), at: at)
        store.requestDropped(.sessionSet(sessionId: sid, patch: SessionPatch(mode: .plan)))
        #expect(store.sets[sid] == nil)
        #expect(store.sessionErrors[sid]?.kind == .set)
        #expect(store.sessionErrors[sid]?.text == "Mode change not sent: your Mac was unreachable.")
        store.requestDropped(.sessionSet(sessionId: sid, patch: SessionPatch(model: .some("opus"))))
        #expect(store.sessionErrors[sid]?.text == "Model change not sent: your Mac was unreachable.")
        store.requestDropped(.sessionSet(sessionId: sid, patch: SessionPatch(hidden: true)))
        #expect(store.lastError?.message == "Hide not sent: your Mac was unreachable.")
        store.requestDropped(.sessionSet(sessionId: sid, patch: SessionPatch(hidden: false)))
        #expect(store.lastError?.message == "Show not sent: your Mac was unreachable.")
        store.requestDropped(.sessionSet(sessionId: sid, patch: SessionPatch(title: "Fix the build")))
        #expect(store.lastError?.message == "Rename not sent: your Mac was unreachable.")
        store.requestDropped(.sessionOpenDesktop(sessionId: sid))
        #expect(store.lastError?.message == "Open in the Claude app not sent: your Mac was unreachable.")
        store.requestDropped(.stopAgent(agentId: AgentID("a1")))
        #expect(store.lastError?.message == "Stop not sent: your Mac was unreachable.")
    }

    @Test func aMirrorSettingThatNeverWentPutsThePickerBack() {
        let store = store()
        store.apply(.sessions(.list(projects: [], rows: [], mirror: .auto)))
        store.sessionRequestSent(.sessionPrefs(mirror: .tap))
        store.sessionRequestSent(.sessionPrefs(mirror: .never))
        #expect(store.sessions.mirror == .never, "shown at once")
        store.requestDropped(.sessionPrefs(mirror: .tap))
        #expect(store.sessions.mirror == .auto, "back to the value before the first change")
        #expect(store.mirrorNote == "Not changed: your Mac was unreachable.")
        store.sessionRequestSent(.sessionPrefs(mirror: .never))
        #expect(store.mirrorNote == nil, "the next change clears it")
    }

    @Test func aMirrorSettingThatNeverWentIsToastedOnlyWhenSettingsIsClosed() {
        let store = store()
        store.apply(.sessions(.list(projects: [], rows: [], mirror: .auto)))
        store.settingsShown = true
        store.sessionRequestSent(.sessionPrefs(mirror: .never))
        store.requestDropped(.sessionPrefs(mirror: .never))
        #expect(store.mirrorNote == "Not changed: your Mac was unreachable.")
        #expect(store.lastError == nil, "Settings shows and speaks it beside the picker")

        store.settingsShown = false
        store.sessionRequestSent(.sessionPrefs(mirror: .tap))
        store.requestDropped(.sessionPrefs(mirror: .tap))
        #expect(store.sessions.mirror == .auto)
        #expect(store.lastError?.message == "The Claude app setting was not changed: your Mac was unreachable.", "Settings was closed, so a toast says it")
        #expect(store.mirrorNote == "Not changed: your Mac was unreachable.", "and the note waits for the next look")
    }

    @Test func aDroppedStopSaysSoUnderTheComposer() {
        let store = store(controls: controls(working: true, turn: "2026-10-16T12:00:00.000Z"))
        let stop = ClientMessage.sessionStop(sessionId: sid, target: .all, turnStartedAt: "2026-10-16T12:00:00.000Z")
        store.sessionRequestSent(stop, at: at)
        #expect(store.latestStop(in: sid, [.all]) != nil)
        store.requestDropped(stop)
        #expect(store.latestStop(in: sid, [.all]) == nil)
        #expect(store.sessionErrors[sid]?.text == "Stop not sent: your Mac was unreachable.")
    }

    @Test func aStopTappedOfflineSaysItWaitsNotThatItStops() {
        let c = controls(working: true, turn: "2026-10-16T12:00:00.000Z")
        let stop = (scope: StopScope(c), phase: StopPhase.stopping)
        #expect(ComposerNote.of(error: nil, stop: stop, set: nil, controls: c, now: at, offline: true) == .stopWaits)
        #expect(ComposerNote.stopWaits.text == "Stop waits for your Mac. It goes if the connection is back within a minute.")
        #expect(ComposerNote.of(error: nil, stop: stop, set: nil, controls: c, now: at) == .stopping(StopScope(c)))
    }

    @Test func onlyTheNewestDecisionsAreKept() {
        let store = store()
        for n in 0...AppStore.decisionsKept { store.decisionSent(.once, for: MessageID("m\(n)")) }
        #expect(store.decisions.count == AppStore.decisionsKept)
        #expect(store.decisions[MessageID("m0")] == nil)
        #expect(store.decisions[MessageID("m\(AppStore.decisionsKept)")] != nil)
    }

    @Test func aDroppedDecisionFreesTheCardAndSaysWhy() {
        let store = store()
        store.decisionSent(.once, for: MessageID("m1"))
        store.requestDropped(.sessionDecide(sessionId: sid, cardId: MessageID("m1"), choice: .once))
        #expect(store.pendingDecisions.isEmpty)
        #expect(store.decisionNote(MessageID("m1"))?.text == "Not sent: your Mac was unreachable · Try again")
    }
}

/// F-SES-142 and the per-decision ack.
@MainActor
@Suite struct CardDecisionTests {
    @Test func aPlanOrQuestionAnswerThatFailsFreesTheCardAndSaysNotSent() {
        let store = store()
        store.decisionSent(nil, for: MessageID("ask1"))
        #expect(store.holds(MessageID("ask1")))
        store.decisionFailed(for: MessageID("ask1"))
        #expect(!store.holds(MessageID("ask1")))
        #expect(store.decisionNote(MessageID("ask1"))?.text == "Not sent · Try again")
    }

    @Test func aRefusedAnswerFreesTheCardAndSaysAlreadyAnswered() {
        let store = store()
        store.decisionSent(.once, for: MessageID("plan1"))
        #expect(store.pendingDecisions[MessageID("plan1")] == .once)
        store.apply(.error(message: "That card was already answered", about: .decide(sessionId: sid, cardId: MessageID("plan1"))))
        #expect(store.pendingDecisions.isEmpty)
        #expect(store.decisionNote(MessageID("plan1"))?.text == "Already answered")
        #expect(store.lastError == nil, "said on the card, not as a toast")
        store.apply(.error(message: "Unknown card", about: .decide(sessionId: sid, cardId: MessageID("plan1"))))
        #expect(store.decisionNote(MessageID("plan1"))?.text == "Unknown card.")
    }

    @Test func aClosedQuestionOrPlanReleasesItsButtons() {
        let store = store(items: [ask("a1", cardId: "ask1"), plan("p1", .proposed, cardId: "plan1")])
        store.decisionSent(nil, for: MessageID("ask1"))
        store.decisionSent(.once, for: MessageID("plan1"))
        items(store, rev: 2, [ask("a1", answers: .answered(["Which library?": "Howler"]), cardId: "ask1"), plan("p1", .approved, cardId: "plan1")])
        #expect(!store.holds(MessageID("ask1")))
        #expect(!store.holds(MessageID("plan1")))
    }

    @Test func onABridgeThatAcksOnlyTheAckMakesADecisionThisPhones() {
        let store = store([.sessions, .decideAck])
        store.decisionSent(.once, for: MessageID("m1"))
        #expect(store.decidedHere(MessageID("m1")) == nil, "not known until the ack")
        store.apply(.decided(cardId: MessageID("m1")))
        #expect(store.decidedHere(MessageID("m1")) == true)
        #expect(store.decidedHere(MessageID("other")) == false)
    }

    @Test func aDecisionWhoseSocketDroppedBeforeItsAckIsNobodysToClaim() {
        let store = store([.sessions, .decideAck])
        store.decisionSent(.once, for: MessageID("m1"))
        store.apply(.hello(Hello(features: [.sessions, .decideAck], machine: "Mac", userName: "Alex", bots: [])))
        #expect(store.decidedHere(MessageID("m1")) == nil)
        #expect(!store.holds(MessageID("m1")), "an open card takes a tap again")
        let card = PermissionCard(from: nil, tool: "Bash", label: "Run a command", detail: "ls", always: "", answer: nil, expiresAt: at + 600)
        #expect(PermissionAnswer.chose(.once).announcement(card: card, here: nil) == "Allowed once. Bash: ls")
        #expect(PermissionAnswer.chose(.once).announcement(card: card, here: false) == "Answered on another device. Allowed once. Bash: ls")
    }

    @Test func aDecisionWhoseFateIsUnknownAfterAReconnectSaysSoAndTakesATapAgain() {
        let store = store([.sessions, .decideAck])
        store.decisionSent(.once, for: MessageID("m1"), at: at)
        #expect(store.decisionNote(MessageID("m1")) == nil, "on its way: the spinner says it")
        store.apply(.hello(Hello(features: [.sessions, .decideAck], machine: "Mac", userName: "Alex", bots: [])))
        #expect(store.decisionNote(MessageID("m1"))?.text == "Your answer may not have reached your Mac · Tap again")
    }

    @Test func aDecisionWithNoAckInTenSecondsOnALiveSocketBecomesUnsure() {
        let store = store([.sessions, .decideAck])
        store.decisionSent(.once, for: MessageID("m1"), at: at)
        store.lapseDecisions(at: at + 9)
        #expect(store.holds(MessageID("m1")) && store.decisionNote(MessageID("m1")) == nil)
        store.lapseDecisions(at: at + 10)
        #expect(!store.holds(MessageID("m1")))
        #expect(store.decisionNote(MessageID("m1"))?.text == "Your answer may not have reached your Mac · Tap again")
        #expect(store.decidedHere(MessageID("m1")) == nil)
        store.decisionSent(.once, for: MessageID("m2"), at: at)
        store.apply(.decided(cardId: MessageID("m2")))
        store.lapseDecisions(at: at + 60)
        #expect(store.decisionNote(MessageID("m2")) == nil, "acked in time")
    }

    @Test func aRetapRefusedAsAlreadyAnsweredAfterAnUnsureAnswerNeverClaimsAnotherDevice() {
        let store = store([.sessions, .decideAck])
        store.decisionSent(.once, for: MessageID("m1"))
        store.apply(.hello(Hello(features: [.sessions, .decideAck], machine: "Mac", userName: "Alex", bots: [])))
        store.decisionSent(.once, for: MessageID("m1"))
        store.apply(.error(message: "That card was already answered", about: .decide(sessionId: sid, cardId: MessageID("m1"))))
        #expect(store.decidedHere(MessageID("m1")) == nil, "the first tap may be the answer")
        let card = PermissionCard(from: nil, tool: "Bash", label: "Run a command", detail: "ls", always: "", answer: nil, expiresAt: at + 600)
        #expect(PermissionAnswer.chose(.once).announcement(card: card, here: store.decidedHere(MessageID("m1"))) == "Allowed once. Bash: ls")

        store.decisionSent(.once, for: MessageID("m2"))
        store.apply(.error(message: "That card was already answered", about: .decide(sessionId: sid, cardId: MessageID("m2"))))
        #expect(store.decidedHere(MessageID("m2")) == false, "with no earlier tap in doubt, another device answered")
    }

    @Test func onABridgeWithoutAcksTheSocketTakingItIsEnough() {
        let store = store()
        store.decisionSent(.once, for: MessageID("m1"))
        #expect(store.decidedHere(MessageID("m1")) == true)
    }

    @Test func aLinkToAQuestionAnsweredElsewhereSaysSo() {
        let link = LinkedCard(sessionId: sid, cardId: MessageID("ask1"))
        let answered = ask("a1", answers: .answered(["Which library?": "Howler"]), cardId: "ask1")
        #expect(link.note(in: [answered], decidedHere: [], at: at) == "Already answered. Nothing here waits on you now.")
        #expect(link.note(in: [answered], decidedHere: [MessageID("ask1")], at: at) == nil)
        #expect(link.note(in: [plan("p1", .approved, cardId: "ask1")], decidedHere: [], at: at) == "Already answered. Nothing here waits on you now.")
    }
}

/// A card the user's stop closed says so, never that it was answered (G25's wire value "stopped").
@MainActor
@Suite struct StoppedCardTests {
    @Test func aStoppedQuestionOrPlanDecodesAsStopped() throws {
        #expect(try Wire.decoder().decode(AskAnswers.self, from: Data(#""stopped""#.utf8)) == .stopped)
        #expect(String(decoding: try Wire.encoder().encode(AskAnswers.stopped), as: UTF8.self) == #""stopped""#)
        #expect(try Wire.decoder().decode(PlanState.self, from: Data(#""stopped""#.utf8)) == .stopped)
        #expect(PlanState.stopped.rawValue == "stopped")
    }

    @Test func aStoppedCardSaysItClosedWithTheTurn() {
        #expect(PlanCard.stoppedLine == "Closed when the turn was stopped.")
        #expect(PlanCard.closing(.stopped) == "The plan closed when the turn was stopped.")
        #expect(AskCard.closing(.stopped, count: 1) == "The question closed when the turn was stopped.")
        #expect(PlanCard.closing(.expired) == "The plan closed without an answer.")
    }

    @Test func aLinkToAStoppedCardSaysItClosedWithTheTurnNeverAnswered() {
        let link = LinkedCard(sessionId: sid, cardId: MessageID("c1"))
        let card = PermissionCard(from: nil, tool: "Bash", label: "Run a command", detail: "ls", always: "", answer: .stopped, expiresAt: at + 600)
        let permission = SessionItem.permission(id: ItemID("p1"), at: at, permission: SessionPermission(cardId: MessageID("c1"), at: at, card: card))
        let open = ask("a2", cardId: "other")
        for item in [permission, ask("a1", answers: .stopped, cardId: "c1"), plan("p1", .stopped, cardId: "c1")] {
            #expect(link.note(in: [item], decidedHere: [], at: at) == "That request closed when the turn was stopped.")
            #expect(link.note(in: [item, open], decidedHere: [], at: at) == "That request closed when the turn was stopped. Another one waits on you.")
        }
    }
}

/// F-SES-073, F-SES-127, F-SES-128: replies that may never come.
@MainActor
@Suite struct UnansweredRequestTests {
    @Test func theToolSheetEndsWithAReasonOrWaitsForTheMacNeverSpinsForever() {
        #expect(ToolOutputState(output: .missing("That tool call's output is not in the transcript."), askedAt: at, online: true, now: at) == .failed("That tool call's output is not in the transcript."))
        #expect(ToolOutputState(output: nil, askedAt: at, online: true, now: at + 14) == .reading)
        #expect(ToolOutputState(output: nil, askedAt: at, online: true, now: at + 15) == .failed("Your Mac didn't send the output."))
        #expect(ToolOutputState(output: nil, askedAt: at, online: false, now: at + 99) == .waitingForMac)
        #expect(ToolOutputState(output: .text("ok"), askedAt: nil, online: false, now: at) == .text("ok"))
    }

    @Test func anOlderBridgesToolErrorEndsTheSheetToo() throws {
        let store = store()
        let model = try #require(store.threads[sid])
        model.askTool("toolu_1", at: at)
        store.apply(.error(message: "That tool call's output is not in the transcript.", about: .tool(sessionId: sid, toolUseId: "toolu_1")))
        #expect(model.toolOutputs["toolu_1"] == .missing("That tool call's output is not in the transcript."))
        #expect(model.toolAsked["toolu_1"] == nil)
        model.askTool("toolu_1", at: at + 1)
        #expect(model.toolOutputs["toolu_1"] == nil, "a retry reads again")
    }

    @Test func theLoadEarlierRowSaysWhatIsHappening() throws {
        #expect(LoadEarlierRow.State(loading: false, online: true) == .idle)
        #expect(LoadEarlierRow.State(loading: true, online: true) == .loading)
        #expect(LoadEarlierRow.State(loading: true, online: false) == .offline)
        #expect(LoadEarlierRow.State.idle.text == "Load earlier messages")
        #expect(LoadEarlierRow.State.offline.text == "Earlier messages: waiting for your Mac")

        let store = AppStore()
        store.apply(.hello(Hello(features: [.sessions], machine: "Mac", userName: "Alex", bots: [])))
        let model = store.threads.open(sid)
        store.apply(.thread(sessionId: sid, .snapshot(SessionSnapshot(epoch: "e1", rev: 1, items: [], before: Cursor("u0"), controls: controls(), live: nil))))
        #expect(model.requestEarlier() == Cursor("u0"))
        store.apply(.error(message: "That part of the thread changed. Reopen the session to load it again.", about: .page(sessionId: sid)))
        #expect(!model.loadingEarlier)
        _ = model.requestEarlier()
        _ = model.willWatch()
        #expect(!model.loadingEarlier, "a page asked for on the old socket is not waited for")
    }

    @Test func aThreadReopenedFromCacheCatchesUpWithoutStop() throws {
        let store = store(controls: controls(working: true, turn: "2026-10-16T12:00:00.000Z"))
        let model = try #require(store.threads[sid])
        _ = model.willWatch()
        #expect(model.catchingUp)
        let status = ThreadStatus.of(
            reach: .connected(machine: "Mac"), quietSince: nil, lastUpdate: at, controls: model.controls, card: nil, since: nil, outcome: nil,
            catchingUp: model.catchingUp
        )
        #expect(status == .catchingUp(lastUpdate: at, tasks: []))
        #expect(status?.text(now: at) == "Catching up…")
        #expect(status?.word == "Catching up")
        #expect(status?.staleAt == at, "clocks stop while the state may be old")
        items(store, rev: 2)
        #expect(!model.catchingUp)
    }
}

/// F-SES-036, F-SES-154 and the card kind in local notifications.
@MainActor
@Suite struct StartAndAlertTests {
    @Test func aRefusedStartIsKeptByItsRef() {
        let store = store()
        store.apply(.error(message: "demo's folder is gone from this Mac.", about: .create(ref: "r1")))
        #expect(store.createRefusals["r1"] == "demo's folder is gone from this Mac.")
        #expect(store.lastError == nil)
        #expect(StartPhase.unconfirmedLine == "Couldn't confirm. Check the list or retry.")
        #expect(StartPhase.offlineLabel == "Start (your Mac is unreachable)")
        #expect(StartPhase.patience == 20)
    }

    @Test func aSessionAlertNamesWhatItsCardsAskFor() {
        #expect(Notifier.cards(1, .permission) == "Needs your approval")
        #expect(Notifier.cards(1, .ask) == "Has a question for you")
        #expect(Notifier.cards(1, .plan) == "Has a plan for you to review")
        #expect(Notifier.cards(3, nil) == "Needs you: 3 requests")
        #expect(Notifier.reminder(1, .ask) == "Still waiting for your answer")
        #expect(Notifier.reminder(2, .permission) == "Still waiting for 2 approvals")
    }
}

/// The wire shapes G11 adds.
@Suite struct OutliveWireTests {
    private func server(_ json: String) throws -> ServerMessage {
        try Wire.decoder().decode(ServerFrame.self, from: Data(json.utf8)).message
    }

    @Test func theNewFramesDecode() throws {
        if case .thread(sid, .toolOutput("t1", let output)) = try server(#"{"type":"session_tool_output","sessionId":"s1","toolUseId":"t1","output":null,"error":"That tool call's output is not in the transcript."}"#) {
            #expect(output == .missing("That tool call's output is not in the transcript."))
        } else { Issue.record("a missing tool output") }
        if case .thread(sid, .toolOutput("t1", let output)) = try server(#"{"type":"session_tool_output","sessionId":"s1","toolUseId":"t1","output":"ok"}"#) {
            #expect(output == .text("ok"))
        } else { Issue.record("a tool output") }
        if case .decided(let card) = try server(#"{"type":"decided","cardId":"m1"}"#) { #expect(card == MessageID("m1")) } else { Issue.record("an ack") }
        if case .error(_, let about) = try server(#"{"type":"error","message":"Unknown card","about":{"kind":"decide","sessionId":"s1","cardId":"m1"}}"#) {
            #expect(about == .decide(sessionId: sid, cardId: MessageID("m1")))
        } else { Issue.record("a decide refusal") }
        if case .error(_, let about) = try server(#"{"type":"error","message":"x","about":{"kind":"page","sessionId":"s1"}}"#) {
            #expect(about == .page(sessionId: sid))
        } else { Issue.record("a page refusal") }
        if case .sessionAlert(let alert) = try server(#"{"type":"session_alert","sessionId":"s1","reason":"card","count":1,"title":"T","cardId":"m1","cardKind":"ask"}"#) {
            #expect(alert.cardKind == .ask)
        } else { Issue.record("a session alert") }
        let item = try Wire.decoder().decode(SessionItem.self, from: Data(#"{"kind":"user","id":"t-9","at":"2026-10-16T12:00:00.000Z","text":"hi","from":"user","queued":false,"clientId":"c1"}"#.utf8))
        if case .user(_, _, _, _, _, let clientId) = item { #expect(clientId == "c1") } else { Issue.record("a user item") }
    }
}
