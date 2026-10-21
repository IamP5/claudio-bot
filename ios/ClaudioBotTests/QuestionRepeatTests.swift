import Foundation
import Testing
@testable import ClaudioBot

@Suite struct QuestionRepeatTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let ask = "Want me to merge any of these now?"

    private func bot(_ id: String, _ text: String, minutes: Double = 0, from: BotID? = nil) -> Message {
        .bot(id: MessageID(id), at: start + minutes * 60, text: text, from: from)
    }

    private func card(_ id: String, minutes: Double = 0) -> Message {
        .question(id: MessageID(id), at: start + minutes * 60, card: QuestionCard(question: ask, options: ["Yes", "No"], answer: nil))
    }

    private func ids(_ messages: [Message], hides: Bool) -> [String] {
        Timeline.rows(messages, hidesRepeatedQuestion: hides).compactMap { if case .message(let m) = $0 { m.id.rawValue } else { nil } }
    }

    @Test func iPhoneHidesTheExactRepeat() {
        #expect(ids([bot("a", "Here is the stack."), bot("b", ask), card("q")], hides: true) == ["a", "q"])
    }

    @Test func iPhoneHidesCaseWhitespaceAndBoldVariants() {
        for variant in ["  want me to MERGE any of these now?\n", "**\(ask)**", "_\(ask)_"] {
            #expect(ids([bot("b", variant), card("q")], hides: true) == ["q"], "\(variant)")
        }
    }

    @Test func aDifferentBubbleStays() {
        #expect(ids([bot("b", "Two PRs are green."), card("q")], hides: true) == ["b", "q"])
    }

    @Test func aBubbleStaysWhenTheCardIsNotNext() {
        #expect(ids([bot("b", ask), bot("c", "Hold on."), card("q")], hides: true) == ["b", "c", "q"])
    }

    @Test func aMemberBubbleStays() {
        #expect(ids([bot("b", ask, from: BotID("x")), card("q")], hides: true) == ["b", "q"])
    }

    @Test func theMacKeepsTheRepeat() {
        #expect(ids([bot("b", ask), card("q")], hides: false) == ["b", "q"])
    }

    @Test func aHiddenBubbleLeavesNoOrphanSeparator() {
        let rows = Timeline.rows([bot("a", "Hi"), bot("b", ask, minutes: 120), card("q", minutes: 121)], hidesRepeatedQuestion: true)
        #expect(rows.map(\.isSeparator) == [true, false, true, false])
        #expect(rows.map(\.id).last == "q")
        let first = Timeline.rows([bot("b", ask), card("q", minutes: 1)], hidesRepeatedQuestion: true)
        #expect(first.map(\.isSeparator) == [true, false])
    }
}
