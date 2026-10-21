import Foundation
import Testing
@testable import ClaudioBot

@Suite struct RevealTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func bot(_ id: String, minutes: Double = 0) -> Message {
        .bot(id: MessageID(id), at: start + minutes * 60, text: id)
    }

    private func user(_ id: String) -> Message {
        .user(id: MessageID(id), at: start, text: id, attachments: [])
    }

    private func shown(_ reveal: Reveal, _ messages: [Message]) -> [String] {
        reveal.visible(Timeline.rows(messages)).compactMap { if case .message(let m) = $0 { m.id.rawValue } else { nil } }
    }

    /// A chat that already shows `a`.
    private func opened() -> Reveal {
        var reveal = Reveal()
        reveal.update(Timeline.rows([bot("a")]))
        return reveal
    }

    @Test func theFirstTimelineShowsAtOnce() {
        var reveal = Reveal()
        let messages = [bot("a"), bot("b"), bot("c")]
        reveal.update(Timeline.rows(messages))
        #expect(shown(reveal, messages) == ["a", "b", "c"])
        #expect(reveal.isCaughtUp)
    }

    @Test func aHistoryArrivingInAnEmptyChatShowsAtOnce() {
        var reveal = Reveal()
        reveal.update([])
        let messages = [bot("a"), bot("b"), bot("c")]
        reveal.update(Timeline.rows(messages))
        #expect(shown(reveal, messages) == ["a", "b", "c"])
    }

    @Test func oneNewMessageShowsAtOnce() {
        var reveal = opened()
        let messages = [bot("a"), bot("b")]
        reveal.update(Timeline.rows(messages))
        #expect(shown(reveal, messages) == ["a", "b"])
        #expect(reveal.isCaughtUp)
    }

    @Test func aBurstLandsOneAtATime() {
        var reveal = opened()
        let messages = [bot("a"), bot("b"), bot("c"), bot("d")]
        reveal.update(Timeline.rows(messages))
        #expect(shown(reveal, messages) == ["a", "b"])
        #expect(!reveal.isCaughtUp)
        reveal.step()
        #expect(shown(reveal, messages) == ["a", "b", "c"])
        reveal.step()
        #expect(shown(reveal, messages) == ["a", "b", "c", "d"])
        #expect(reveal.isCaughtUp)
    }

    @Test func takingInTheSameRowsAgainChangesNothing() {
        var reveal = opened()
        let rows = Timeline.rows([bot("a"), bot("b"), bot("c")])
        reveal.update(rows)
        let once = reveal
        reveal.update(rows)
        #expect(reveal == once)
        reveal.step()
        reveal.update(rows)
        #expect(reveal.isCaughtUp, "a shown row is never held back again")
    }

    @Test func rowsArrivingMidRevealJoinTheQueue() {
        var reveal = opened()
        reveal.update(Timeline.rows([bot("a"), bot("b"), bot("c")]))
        let messages = [bot("a"), bot("b"), bot("c"), bot("d")]
        reveal.update(Timeline.rows(messages))
        #expect(shown(reveal, messages) == ["a", "b"], "a single row waits behind the burst")
        reveal.step()
        reveal.step()
        #expect(shown(reveal, messages) == ["a", "b", "c", "d"])
        #expect(reveal.isCaughtUp)
    }

    @Test func aRemovedRowLeavesTheQueue() {
        var reveal = opened()
        reveal.update(Timeline.rows([bot("a"), bot("b"), bot("c")]))
        reveal.update(Timeline.rows([bot("a"), bot("b")]))
        #expect(reveal.isCaughtUp)
    }

    @Test func aMessageTheUserSentShowsEverything() {
        var reveal = opened()
        reveal.update(Timeline.rows([bot("a"), bot("b"), bot("c")]))
        let messages = [bot("a"), bot("b"), bot("c"), user("u")]
        reveal.update(Timeline.rows(messages))
        #expect(shown(reveal, messages) == ["a", "b", "c", "u"])
        #expect(reveal.isCaughtUp)
    }

    @Test func flushingShowsEverything() {
        var reveal = opened()
        let messages = [bot("a"), bot("b"), bot("c")]
        reveal.update(Timeline.rows(messages), flush: true)
        #expect(shown(reveal, messages) == ["a", "b", "c"])
        reveal = opened()
        reveal.update(Timeline.rows(messages))
        reveal.flush()
        #expect(shown(reveal, messages) == ["a", "b", "c"])
    }

    @Test func aSeparatorLandsWithTheMessageAfterIt() {
        var reveal = opened()
        let messages = [bot("a"), bot("b", minutes: 120), bot("c", minutes: 121)]
        let rows = Timeline.rows(messages)
        reveal.update(rows)
        #expect(reveal.visible(rows).count == rows.count - 1, "the separator and b show together, c waits")
        reveal.step()
        #expect(reveal.visible(rows) == rows)
    }

    @Test func aLongBacklogShowsAtOnce() {
        var reveal = opened()
        let messages = [bot("a")] + (1...Reveal.longest + 1).map { bot("m\($0)") }
        reveal.update(Timeline.rows(messages))
        #expect(reveal.isCaughtUp)
    }
}
