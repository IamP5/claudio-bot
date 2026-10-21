import Foundation
import Testing
@testable import ClaudioBot

private func at(_ second: Int) -> String { "2026-10-21T10:00:\(String(format: "%02d", second)).000Z" }

private func decoded(_ json: String) -> SessionItem {
    try! Wire.decoder().decode(SessionItem.self, from: Data(json.utf8))
}

private func user(_ id: String, _ second: Int, queued: Bool = false) -> SessionItem {
    decoded(#"{"kind":"user","id":"\#(id)","at":"\#(at(second))","text":"\#(id)","from":"user","queued":\#(queued)}"#)
}

private func work(_ id: String, _ second: Int, state: String = "ok") -> SessionItem {
    decoded(#"{"kind":"work","id":"\#(id)","at":"\#(at(second))","steps":[{"id":"\#(id)","tool":"Bash","label":"Run ls","state":"\#(state)","diff":null,"output":null}]}"#)
}

private func card(_ id: String, _ second: Int, answer: String = "null") -> SessionItem {
    decoded(
        #"{"kind":"permission","id":"\#(id)","at":"\#(at(second))","card":{"kind":"permission","id":"m_\#(id)","at":"\#(at(second))","from":null,"tool":"Bash","label":"Bash","detail":"ls","always":"ls","answer":\#(answer),"expiresAt":"2026-10-21T12:00:00.000Z"}}"#
    )
}

private func reply(_ id: String, _ second: Int) -> SessionItem {
    decoded(#"{"kind":"assistant","id":"\#(id)","at":"\#(at(second))","text":"Done."}"#)
}

private func notice(_ id: String, _ second: Int) -> SessionItem {
    decoded(#"{"kind":"notice","id":"\#(id)","at":"\#(at(second))","text":"Claude Code stopped unexpectedly.","tone":"error","reason":"failure"}"#)
}

private let resting = SessionControls(canSend: true, reason: nil, working: false, queued: 0, model: nil, models: [], mode: .default, modes: [.default])

@MainActor
private func opened(_ items: [SessionItem], rev: Int = 1) -> ThreadModel {
    let model = ThreadModel(id: SessionID("s1"))
    model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: rev, items: items, before: nil, controls: resting, live: nil)))
    return model
}

@MainActor
private func ids(_ model: ThreadModel) -> [String] { model.items.map(\.id.rawValue) }

@MainActor
@Suite struct ThreadOrderTests {
    @Test func aThreadWatchedLiveResumedOrOpenedFreshListsItsItemsInOneOrder() {
        let fresh = opened([user("u1", 0), work("toolu_1", 1), card("toolu_c", 2, answer: #""once""#), reply("r1", 30)], rev: 4)

        let live = opened([user("u1", 0)])
        live.apply(.items(rev: 2, items: [card("toolu_c", 2)], removed: [], controls: nil))
        live.apply(.items(rev: 3, items: [work("toolu_1", 1, state: "running"), card("toolu_c", 2, answer: #""once""#)], removed: [], controls: nil))
        live.apply(.items(rev: 4, items: [work("toolu_1", 1), reply("r1", 30)], removed: [], controls: nil))

        let resumed = opened([user("u1", 0)])
        #expect(resumed.willWatch() == ThreadPosition(epoch: "e1", rev: 1))
        resumed.apply(.items(rev: 4, items: [work("toolu_1", 1), reply("r1", 30), card("toolu_c", 2, answer: #""once""#)], removed: [], controls: nil))

        #expect(ids(fresh) == ["u1", "toolu_1", "toolu_c", "r1"], "the answered card stays where it was raised")
        #expect(live.items == fresh.items)
        #expect(resumed.items == fresh.items)
        #expect(resumed.position == ThreadPosition(epoch: "e1", rev: 4))
    }

    @Test func aFailureArrivingLateSitsAtItsTimeAboveTheTurnAfterIt() {
        let model = opened([user("u1", 0), reply("r1", 5), user("u2", 20), reply("r2", 25)])
        model.apply(.items(rev: 2, items: [notice("n1", 10)], removed: [], controls: nil))
        #expect(ids(model) == ["u1", "r1", "n1", "u2", "r2"])
    }

    @Test func aMessageWaitingToBeTakenStaysLastThenMovesToWhenItsTurnStarted() {
        let model = opened([user("u1", 0), work("toolu_1", 10, state: "running")])
        model.echo(clientId: "c2", text: "Next", at: Date(timeIntervalSince1970: 0))
        model.apply(.items(rev: 2, items: [user("c2", 5, queued: true), reply("r1", 20)], removed: [], controls: nil))
        #expect(ids(model) == ["u1", "toolu_1", "r1", "c2"], "a queued message follows everything, whatever its send time")
        model.apply(.items(rev: 3, items: [user("c2", 21)], removed: [], controls: nil))
        #expect(ids(model) == ["u1", "toolu_1", "r1", "c2"])
        model.apply(.items(rev: 4, items: [notice("n1", 22), user("c2", 21)], removed: [], controls: nil))
        #expect(ids(model) == ["u1", "toolu_1", "r1", "c2", "n1"])
    }

    @Test func anEarlierPageGoesInByTime() {
        let model = opened([user("u3", 30), reply("r3", 31)])
        model.apply(.page(items: [user("u1", 0), reply("r1", 1), user("u2", 10)], before: nil))
        #expect(ids(model) == ["u1", "r1", "u2", "u3", "r3"])
    }

    @Test func aSkippedRevDropsThePositionAndTheFrameSoTheNextWatchIsASnapshot() {
        let model = opened([user("u1", 0)], rev: 3)
        model.apply(.items(rev: 4, items: [work("toolu_1", 1, state: "running")], removed: [], controls: nil))
        model.apply(.items(rev: 4, items: [work("toolu_1", 1, state: "running")], removed: [], controls: nil))
        #expect(model.position?.rev == 4 && !model.lost, "the same rev again is the same state")

        model.apply(.items(rev: 6, items: [reply("r1", 9)], removed: [], controls: nil))
        #expect(model.position == nil)
        #expect(ids(model) == ["u1", "toolu_1"], "a frame after a gap is not applied over what is missing")
        #expect(model.takeLost())
        #expect(!model.takeLost(), "one watch per loss")
        #expect(model.willWatch() == nil, "the watch asks for a snapshot")
    }

    @Test func onlyAWatchReplyMayJumpAheadAndAnOlderRevIsAGap() {
        let model = opened([user("u1", 0)], rev: 3)
        _ = model.willWatch()
        model.apply(.items(rev: 9, items: [reply("r1", 9)], removed: [], controls: nil))
        model.apply(.items(rev: 10, items: [], removed: [], controls: resting))
        #expect(model.position?.rev == 10 && !model.lost)
        model.apply(.items(rev: 12, items: [], removed: [], controls: nil))
        #expect(model.lost)

        let raced = opened([user("u1", 0)], rev: 3)
        _ = raced.willWatch()
        raced.apply(.items(rev: 8, items: [reply("r1", 9)], removed: [], controls: nil))
        raced.apply(.items(rev: 7, items: [], removed: [], controls: nil))
        #expect(raced.lost, "a reply older than a live frame that beat it is repaired by a snapshot")
    }

    @Test func aRepairWhoseReplyIsAlsoLostAsksOnceMoreThenWaitsForTheNextWatch() {
        let model = opened([user("u1", 0)])
        model.lose()
        #expect(model.takeLost())
        model.lose()
        #expect(!model.takeLost(), "the repair's own reply could not be read; asking again at once could loop")
        #expect(model.retryRepair(), "a repair with no snapshot back is asked once more, later")
        #expect(!model.retryRepair(), "and only once")
        model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: 5, items: [user("u1", 0)], before: nil, controls: resting, live: nil)))
        #expect(!model.retryRepair(), "a snapshot that lands ends the repair")
        model.lose()
        #expect(model.takeLost())
        #expect(model.retryRepair(), "a new loss gets its own retry")
    }

    @Test func aRepairSnapshotOvertakenByANewerLiveFrameIsALossNotAnErasure() {
        let model = opened([user("u1", 0)])
        model.lose()
        #expect(model.takeLost())
        #expect(model.willWatch() == nil)
        model.apply(.items(rev: 3, items: [reply("r1", 5)], removed: [], controls: nil))
        model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: 2, items: [user("u1", 0)], before: nil, controls: resting, live: nil)))
        #expect(ids(model) == ["u1", "r1"], "the reply rev 3 brought stays")
        #expect(model.takeLost(), "and the thread asks again")
    }

    @Test func aFirstOpenSnapshotOvertakenByANewerLiveFrameAsksAgain() {
        let model = ThreadModel(id: SessionID("s1"))
        #expect(model.willWatch() == nil)
        model.apply(.items(rev: 3, items: [reply("r1", 5)], removed: [], controls: nil))
        model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: 2, items: [user("u1", 0)], before: nil, controls: resting, live: nil)))
        #expect(ids(model) == ["r1"])
        #expect(model.takeLost())
        #expect(model.willWatch() == nil)
        model.apply(.snapshot(SessionSnapshot(epoch: "e1", rev: 3, items: [user("u1", 0), reply("r1", 5)], before: nil, controls: resting, live: nil)))
        #expect(ids(model) == ["u1", "r1"] && model.position?.rev == 3)
    }

    @Test func anItemThatMovesToTieAnotherKeepsTheOrderTheyWereFirstSeenIn() {
        let todo = { (second: Int) in decoded(#"{"kind":"todo","id":"toolu_todo","at":"\#(at(second))","todos":[{"text":"x","state":"pending"}]}"#) }
        let fresh = opened([todo(5), reply("r1", 5)], rev: 3)
        let live = opened([todo(1)])
        live.apply(.items(rev: 2, items: [reply("r1", 5)], removed: [], controls: nil))
        live.apply(.items(rev: 3, items: [todo(5)], removed: [], controls: nil))
        #expect(live.items == fresh.items)
    }
}
