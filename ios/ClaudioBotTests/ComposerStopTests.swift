import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)
private let turnStart = "2026-10-21T12:00:00.000Z"
private let sid = SessionID("s1")

private func task(_ id: String, _ kind: SessionTaskKind, _ label: String, background: Bool) -> SessionTask {
    SessionTask(id: TaskID(id), stepId: "step-\(id)", kind: kind, label: label, background: background, startedAt: at, owner: nil, progress: nil, waiting: nil)
}

private let sleeper = task("t1", .agent, "sleeper one", background: false)
private let sleep75 = task("t2", .command, "sleep 75", background: true)

private func controls(
    working: Bool = true, turn: Bool = true, tasks: [SessionTask]? = [], queued: Int = 0, mode: PermissionMode = .default, canSend: Bool = true,
    turnAt: String = turnStart
) -> SessionControls {
    SessionControls(
        canSend: canSend, reason: canSend ? nil : "Working in a terminal. Your messages wait.", working: working, queued: queued,
        model: "sonnet", models: [SessionModelOption(id: "sonnet", label: "Sonnet (4.5)"), SessionModelOption(id: "opus", label: "Opus (5.5)")],
        mode: mode, modes: [.default, .acceptEdits, .plan], turn: turn ? SessionTurn(startedAt: turnAt, wake: turnAt != turnStart) : nil, tasks: tasks
    )
}

private func state(
    _ controls: SessionControls?, text: Bool = false, sent: (at: Date, queued: Bool)? = nil, stop: StopRequest? = nil, now: Date = at
) -> ComposerState {
    ComposerState(controls: controls, hasText: text, canStop: true, lastSend: sent, stop: stop, now: now)
}

private func user(_ id: String, _ text: String = "Run the tests", queued: Bool = false, from: SessionAuthor = .user) -> SessionItem {
    .user(id: ItemID(id), at: at, text: text, from: from, queued: queued)
}

private func stopNotice(_ id: String, _ text: String = "Stopped by you before Claude replied.", tone: NoticeTone = .info) -> SessionItem {
    .notice(id: ItemID(id), at: at, text: text, tone: tone, reason: .stop)
}

/// A store with the session's thread open at `controls`, on a bridge with the run-state features.
@MainActor
private func store(_ controls: SessionControls, items: [SessionItem] = []) -> AppStore {
    let store = AppStore()
    store.apply(.hello(Hello(features: [.sessions, .sessionTasks, .sessionUnqueue], machine: "Mac", userName: "Alex", bots: [])))
    store.threads.open(sid)
    store.apply(.thread(sessionId: sid, .snapshot(SessionSnapshot(epoch: "e1", rev: 1, items: items, before: nil, controls: controls, live: nil))))
    return store
}

@MainActor
private func frame(_ store: AppStore, rev: Int, items: [SessionItem] = [], controls: SessionControls?, at now: Date = at) {
    store.apply(.thread(sessionId: sid, .items(rev: rev, items: items, removed: [], controls: controls)), at: now)
}

@MainActor
@Suite struct ComposerStopTests {
    @Test func stopNamesWhatItEnds() {
        #expect(StopScope(controls()).label == "Stop the turn")
        #expect(StopScope(controls(tasks: [sleeper, sleep75])).label == "Stop the turn, 1 agent and 1 command")
        #expect(StopScope(controls(turn: false, tasks: [sleep75])).label == "Stop 1 command")
        #expect(StopScope(controls(tasks: nil)).label == "Stop the turn", "a bridge without tasks: working is the turn")
    }

    @Test func onlyAStopThatEndsBackgroundWorkAsksFirst() {
        #expect(!StopScope(controls(tasks: [sleeper])).asks, "a turn and its subagents stop at once")
        let both = StopScope(controls(tasks: [sleeper, sleep75]))
        #expect(both.asks && both.confirmAll == "Stop everything")
        #expect(both.confirmMessage(queued: 2) == "sleep 75 keeps running in the background unless you stop everything. Your 2 queued messages still run.")
        let background = StopScope(controls(turn: false, tasks: [sleep75]))
        #expect(background.asks && background.confirmAll == "Stop sleep 75" && background.confirmMessage(queued: 0) == "This stops sleep 75.")
    }

    @Test func stopStaysInReachWhileADraftIsTyped() {
        let typing = state(controls(tasks: [sleep75]), text: true)
        #expect(typing.slot == .send(.queue))
        #expect(typing.stopBeside?.scope.label == "Stop the turn and 1 command", "F-SES-093")
        let idle = state(controls(working: false, turn: false), text: true)
        #expect(idle.slot == .send(.now) && idle.stopBeside == nil)
    }

    @Test func backgroundWorkAloneDoesNotHoldAMessage() {
        let background = controls(turn: false, tasks: [sleep75])
        #expect(state(background, text: true).slot == .send(.now))
        #expect(ComposerState.placeholder(background) == "Message Claude")
        #expect(ComposerState.fieldLabel(background) == "Message")
        #expect(ComposerState.placeholder(controls()) == "Queue a message")
        #expect(ComposerState.fieldLabel(controls()) == "Message, waits for the current turn", "F-SES-088: the mode is in the label, not only the placeholder")
        #expect(ComposerState.queues(controls(turn: false, tasks: nil)), "a bridge without tasks: working means a turn")
    }

    @Test func theSlotIsAlwaysThereAndReadsSentAfterSend() {
        let resting = controls(working: false, turn: false)
        let empty = state(resting).slot
        #expect(empty == .send(.empty) && !empty.acts && empty.label == "Send", "drawn but dimmed, so focus has a place to stay")
        let sent = state(resting, sent: (at, false), now: at + 1).slot
        #expect(sent == .send(.sent(queued: false)) && sent.label == "Sent")
        #expect(state(resting, sent: (at, false), now: at + 5).slot == .send(.empty), "Sent fades once no work starts")
        #expect(state(controls(), sent: (at, true), now: at + 1).slot == .stop(StopScope(controls()), .ready), "work started: the same slot is Stop")
        #expect(ComposerState.sentAnnouncement(queued: false) == "Sent.")
        #expect(ComposerState.sentAnnouncement(queued: true) == "Queued behind the current turn.")
    }

    @Test func aStopShowsStoppingThenEitherLandsOrOffersToTryAgain() {
        let request = StopRequest(target: .all, turnStartedAt: turnStart, at: at)
        let busy = controls(tasks: [sleeper])
        let stopping = state(busy, stop: request, now: at + 2).slot
        #expect(stopping == .stop(StopScope(busy), .stopping) && !stopping.acts && stopping.label == "Stopping the turn and 1 agent")
        let late = state(busy, stop: request, now: at + 10).slot
        #expect(late == .stop(StopScope(busy), .unconfirmed) && late.acts && late.hint == "Your Mac has not confirmed the stop.")
        var refused = request
        refused.state = .refused("Claude Code did not stop sleeper one.")
        #expect(state(busy, stop: refused, now: at + 1).slot.hint == "Claude Code did not stop sleeper one.")
        #expect(ComposerState.announcement(.stopping, StopScope(busy)) == "Stopping the turn and 1 agent.")
        #expect(ComposerState.announcement(.ready, StopScope(busy)) == nil, "the status line speaks the outcome")
    }

    @Test func theStoreConfirmsAStopOnceTheWorkItWasAimedAtIsGone() {
        let store = store(controls(tasks: [sleeper, sleep75]))
        store.sessionRequestSent(.sessionStop(sessionId: sid, target: .turn, turnStartedAt: turnStart), at: at)
        #expect(store.latestStop(in: sid, [.all, .turn])?.state == .pending)
        frame(store, rev: 2, controls: controls(turn: false, tasks: [sleep75]))
        #expect(store.latestStop(in: sid, [.all, .turn])?.state == .confirmed, "the turn ended; the background command still runs")

        store.sessionRequestSent(.sessionStop(sessionId: sid, target: .all, turnStartedAt: nil), at: at + 1)
        frame(store, rev: 3, items: [stopNotice("n1", "Claude Code has not confirmed the stop of command \"sleep 75\" yet.")], controls: controls(turn: false, tasks: [sleep75]))
        #expect(store.latestStop(in: sid, [.all])?.state == .pending, "a stop notice is not the stop: sleep 75 still runs")
        frame(store, rev: 4, controls: controls(tasks: [], turnAt: "2026-10-21T12:05:00.000Z"))
        #expect(store.latestStop(in: sid, [.all])?.state == .confirmed, "sleep 75 is gone; the wake turn after it is new work")
        frame(store, rev: 5, controls: controls(working: false, turn: false))
        #expect(store.latestStop(in: sid, [.all, .turn]) == nil, "nothing runs, so nothing is left to stop")
    }

    @Test func aTaskStopIsNotConfirmedByAnotherTasksNotice() {
        let store = store(controls(turn: false, tasks: [sleeper, sleep75]))
        store.sessionRequestSent(.sessionStop(sessionId: sid, target: .task(sleep75.id), turnStartedAt: nil), at: at)
        frame(store, rev: 2, items: [stopNotice("n1", "Stopped by you: agent \"sleeper one\".")], controls: controls(turn: false, tasks: [sleep75]))
        #expect(store.stops[sid]?[.task(sleep75.id)]?.state == .pending)
        frame(store, rev: 3, controls: controls(turn: false, tasks: [sleeper]))
        #expect(store.stops[sid]?[.task(sleep75.id)]?.state == .confirmed)
    }

    @Test func aRefusedStopShowsUnderTheComposerNotAsAToastWhicheverFrameComesFirst() {
        let store = store(controls(tasks: [sleep75]))
        store.sessionRequestSent(.sessionStop(sessionId: sid, target: .all, turnStartedAt: turnStart), at: at)
        frame(store, rev: 2, items: [stopNotice("n1", "Couldn't stop sleep 75. It may still be running.", tone: .error)], controls: controls(turn: false, tasks: [sleep75]))
        store.apply(.error(message: "Claude Code did not stop sleep 75.", about: .stop(sessionId: sid)))
        #expect(store.latestStop(in: sid, [.all])?.state == .refused("Claude Code did not stop sleep 75."))
        #expect(store.sessionErrors[sid]?.text == "Couldn't stop. Claude Code did not stop sleep 75.")
        #expect(store.lastError == nil, "F-SES-002: a session's error is not a five-second toast")
        store.sessionRequestSent(.sessionSend(sessionId: sid, text: "next", clientId: "c9", interrupt: false), at: at + 2)
        #expect(store.sessionErrors[sid]?.kind == .stop, "a send keeps the reason Stop again offers")
        store.sessionRequestSent(.sessionStop(sessionId: sid, target: .all, turnStartedAt: nil), at: at + 3)
        #expect(store.sessionErrors[sid] == nil && store.latestStop(in: sid, [.all])?.state == .pending, "trying again clears the refusal")

        store.apply(.error(message: "Claude Code has not confirmed the stop of sleep 75 yet.", about: .stop(sessionId: sid)))
        frame(store, rev: 3, controls: controls(working: false, turn: false))
        #expect(store.sessionErrors[sid] == nil, "Claude Code took the stop late: once nothing runs, the refusal is no longer true")
    }

    @Test func theWorkSheetsTaskStopReadsTheRefusalToo() {
        let store = store(controls(turn: false, tasks: [sleep75]))
        store.sessionRequestSent(.sessionStop(sessionId: sid, target: .task(sleep75.id), turnStartedAt: nil), at: at)
        store.apply(.error(message: "Claude Code has not confirmed the stop of sleep 75 yet.", about: .stop(sessionId: sid)))
        #expect(StopPhase(store.stops[sid]?[.task(sleep75.id)], at: at + 1) == .refused("Claude Code has not confirmed the stop of sleep 75 yet."))
    }

    @Test func aModelOrModeChangeShowsTheValueThatRunsUntilClaudeCodeTakesIt() {
        let store = store(controls())
        store.sessionRequestSent(.sessionSet(sessionId: sid, patch: SessionPatch(mode: .acceptEdits)), at: at)
        let c = store.threads[sid]?.controls
        let note = ComposerNote.of(error: store.sessionErrors[sid], stop: nil, set: store.sets[sid], controls: c, now: at + 1)
        #expect(note?.text == "Changing the mode to Accept edits…" && note?.announced == false)
        #expect(store.threads[sid]?.controls?.mode == .default, "the chip keeps the old value until controls change")
        let lapsed = ComposerNote.of(error: nil, stop: nil, set: store.sets[sid], controls: c, now: at + 16)
        #expect(lapsed?.text == "Claude Code has not taken the change to Accept edits yet. The mode stays Ask before edits.")
        #expect(lapsed?.announced == true, "a change that goes quiet says so")
        #expect(store.sets[sid] != nil, "it stays until it lands, is refused or put away")
        store.apply(.error(message: "Claude Code did not take the change: busy", about: .set(sessionId: sid)))
        #expect(store.sets[sid] == nil)
        #expect(store.sessionErrors[sid]?.text == "The mode stays Ask before edits. Claude Code did not take the change: busy", "F-SES-140")
        #expect(ComposerNote.error(store.sessionErrors[sid]!).spoken.hasPrefix("Error: "))

        store.sessionRequestSent(.sessionSet(sessionId: sid, patch: SessionPatch(model: .some("opus"))), at: at + 2)
        #expect(store.sets[sid]?.line == "Changing the model to Opus (5.5)…")
        var opus = controls()
        opus.model = "opus"
        let asked = store.sets[sid]
        frame(store, rev: 2, controls: opus, at: at + 30)
        #expect(store.sets[sid] == nil, "landed: the controls carry the new model")
        #expect(asked?.landedLine == "The model is now Opus (5.5).")
    }

    @Test func aPromptAStopCutOffBeforeAnyReplyCanBeEditedAndSentAgain() {
        let reply = SessionItem.assistant(id: ItemID("a1"), at: at, text: "PONGMARK")
        #expect(UnansweredPrompts.of([user("u1"), stopNotice("n1")], turnRuns: false) == [ItemID("u1")], "F-SES-143")
        #expect(UnansweredPrompts.of([user("u1"), user("i1", "[Request interrupted by user]", from: .system), stopNotice("n1")], turnRuns: false) == [ItemID("u1")])
        #expect(UnansweredPrompts.of([user("u1"), reply, stopNotice("n1")], turnRuns: false).isEmpty)
        #expect(UnansweredPrompts.of([user("u1"), stopNotice("n1", "Stopped by you: command \"sleep 300\"."), reply], turnRuns: false).isEmpty, "a task stop, then the reply")
        #expect(UnansweredPrompts.of([user("u1"), stopNotice("n1", "Stopped by you: command \"sleep 300\".")], turnRuns: true).isEmpty, "its turn still runs")
        #expect(UnansweredPrompts.of([user("u1"), stopNotice("n1", "Couldn't stop sleep 300.", tone: .error)], turnRuns: false).isEmpty, "a refusal is not a stop")
        #expect(UnansweredPrompts.of([user("u1"), stopNotice("n1"), user("u2"), reply], turnRuns: false) == [ItemID("u1")])
        #expect(UnansweredPrompts.of([user("u1"), user("q1", queued: true), stopNotice("n1")], turnRuns: false).isEmpty, "a queued message still runs after a stop")

        let model = ThreadModel(id: sid)
        model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: 1, items: [user("u1"), stopNotice("n1")], before: nil, controls: controls(working: false, turn: false), live: nil)))
        #expect(model.unanswered == [ItemID("u1")])
        model.draft = ComposerDraft(text: "and lint")
        model.resend(ItemID("u1"), text: "Run the tests")
        model.resend(ItemID("u1"), text: "Run the tests")
        #expect(model.draft.text == "and lint\n\nRun the tests", "a typed draft is kept, and the prompt goes back once")
        #expect(model.unanswered.isEmpty, "the offer goes away once taken")
    }

    @Test func queuedMessagesCanBeTakenBackOneByOne() {
        let model = ThreadModel(id: sid)
        model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: 1, items: [user("u1"), user("c1", "second", queued: true)], before: nil, controls: controls(queued: 1), live: nil)))
        #expect(model.queuedMessages.map(\.id) == [ItemID("c1")])
        #expect(ComposerState.queuedLabel(1) == "1 message queued", "F-SES-083")
        #expect(ComposerState.queuedLabel(2) == "2 messages queued")
    }

    @Test func anUnqueueRefusalIsTheSessionsNotTheToasts() {
        let store = store(controls(queued: 1))
        store.apply(.error(message: "That message is no longer queued: it already went to Claude.", about: .send(sessionId: sid, clientId: "c1")))
        #expect(store.sessionErrors[sid]?.text == "That message is no longer queued: it already went to Claude.")
        #expect(store.lastError == nil)
        store.apply(.error(message: "That output is no longer on the Mac.", about: .tool(sessionId: sid, toolUseId: "t")))
        #expect(store.lastError?.message == "That output is no longer on the Mac.", "the tool sheet is not the composer")
    }

    @Test func aSentMessageIsSpokenAsItReadsNotAsItsMarkup() {
        let rendered = MarkdownText.inline("Fix **the** build, see [the docs](https://example.com/very/long/path)")
        #expect(SessionUserBubble.spoken(rendered, from: .user, botName: nil, queued: true) == "You: Fix the build, see the docs. Queued", "F-SES-168")
        #expect(SessionUserBubble.spoken(MarkdownText.inline("Reply MARKER."), from: .user, botName: nil, queued: true) == "You: Reply MARKER. Queued")
    }
}
