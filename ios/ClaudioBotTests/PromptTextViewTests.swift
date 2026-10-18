import SwiftUI
import Testing
import UIKit
@testable import ClaudioBot

/// Drives the composer's real UITextView with the keyboard's own calls, insertText and deleteBackward.
@MainActor
@Suite struct PromptTextViewTests {
    @Observable final class Field {
        var draft = ComposerDraft()
        var caret = 0
    }

    private func mount(_ field: Field, onReturn: @escaping () -> Bool = { false }) throws -> (UIHostingController<PromptTextView>, UITextView) {
        let view = PromptTextView(
            draft: Binding(get: { field.draft }, set: { field.draft = $0 }),
            caret: Binding(get: { field.caret }, set: { field.caret = $0 }),
            placeholder: "Message", tokenColor: { _ in .orange }, onReturn: onReturn
        )
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 360, height: 200))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        let text = try #require(Self.textView(in: host.view))
        #expect(text.becomeFirstResponder())
        return (host, text)
    }

    private static func textView(in view: UIView) -> UITextView? {
        if let text = view as? UITextView { return text }
        return view.subviews.lazy.compactMap(textView(in:)).first
    }

    private func settle(_ host: UIHostingController<PromptTextView>) {
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: .now + 0.05)
    }

    private let engineer = Mention.bot(id: BotID("b1"), name: "engineer")

    @Test func typedTextReachesTheDraftAndAPickedTokenIsDrawnAndDeletedWhole() throws {
        let field = Field()
        let (host, text) = try mount(field)
        text.insertText("ask @eng")
        #expect(field.draft.text == "ask @eng")
        #expect(field.caret == 8)
        #expect(field.draft.trigger(caret: field.caret)?.query == "eng")

        field.caret = field.draft.pick(engineer, replacing: field.draft.trigger(caret: field.caret)!.range)
        settle(host)
        #expect(text.text == "ask @engineer ")
        #expect(text.selectedRange.location == 14)
        let color = text.textStorage.attribute(.foregroundColor, at: 6, effectiveRange: nil) as? UIColor
        #expect(color == UIColor(Color.orange))
        let font = text.textStorage.attribute(.font, at: 6, effectiveRange: nil) as? UIFont
        #expect(font?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)

        text.insertText("hi")
        #expect(field.draft.mentions == [engineer])
        let typed = text.textStorage.attribute(.foregroundColor, at: 15, effectiveRange: nil) as? UIColor
        #expect(typed != UIColor(Color.orange))

        for _ in 0..<3 { text.deleteBackward() }
        #expect(text.text == "ask @engineer")
        #expect(field.draft.mentions == [engineer])
        text.deleteBackward()
        #expect(text.text == "ask ")
        #expect(field.draft.text == "ask ")
        #expect(field.draft.mentions.isEmpty)
        #expect(field.caret == 4)
    }

    @Test func returnPicksFromAnOpenMenuAndIsANewlineOtherwise() throws {
        let field = Field()
        let (_, text) = try mount(field) {
            guard let trigger = field.draft.trigger(caret: field.caret) else { return false }
            field.caret = field.draft.pick(self.engineer, replacing: trigger.range)
            return true
        }
        text.insertText("@eng")
        text.insertText("\n")
        #expect(field.draft.text == "@engineer ")
        #expect(text.text == "@engineer ")
        #expect(field.draft.mentions == [engineer])
        text.insertText("go")
        text.insertText("\n")
        #expect(field.draft.text == "@engineer go\n")
    }
}
