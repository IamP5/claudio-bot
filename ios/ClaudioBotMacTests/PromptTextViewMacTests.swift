import AppKit
import SwiftUI
import Testing
@testable import ClaudioBot

/// Drives the Mac composer's real NSTextView with the calls typing makes: insertText, deleteBackward and key events.
@MainActor
@Suite struct PromptTextViewMacTests {
    @Observable final class Field {
        var draft = ComposerDraft()
        var caret = 0
        var sent: [String] = []
    }

    private func mount(
        _ field: Field, onReturn: @escaping () -> Bool = { false }, submits: Bool = true
    ) throws -> (NSWindow, NSTextView) {
        let view = PromptTextView(
            draft: Binding(get: { field.draft }, set: { field.draft = $0 }),
            caret: Binding(get: { field.caret }, set: { field.caret = $0 }),
            placeholder: "Message", tokenColor: { _ in .orange }, onReturn: onReturn,
            onSubmit: submits ? {
                field.sent.append(field.draft.text)
                field.draft = ComposerDraft()
                field.caret = 0
            } : nil
        )
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 360, height: 200), styleMask: [.titled], backing: .buffered, defer: false
        )
        window.contentView = NSHostingView(rootView: view)
        window.contentView?.layoutSubtreeIfNeeded()
        let content = try #require(window.contentView)
        let text = try #require(Self.textView(in: content))
        #expect(window.makeFirstResponder(text))
        return (window, text)
    }

    private static func textView(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        return view.subviews.lazy.compactMap(textView(in:)).first
    }

    private func settle(_ window: NSWindow) {
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: .now + 0.05)
    }

    private func press(_ text: NSTextView, _ modifiers: NSEvent.ModifierFlags = []) throws {
        let event = try #require(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
            windowNumber: text.window?.windowNumber ?? 0, context: nil,
            characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36
        ))
        text.keyDown(with: event)
    }

    private let engineer = Mention.bot(id: BotID("b1"), name: "engineer")

    @Test func typedTextReachesTheDraftAndAPickedTokenIsDrawnAndDeletedWhole() throws {
        let field = Field()
        let (window, text) = try mount(field)
        text.insertText("ask @eng", replacementRange: text.selectedRange())
        #expect(field.draft.text == "ask @eng")
        #expect(field.caret == 8)

        field.caret = field.draft.pick(engineer, replacing: field.draft.trigger(caret: field.caret)!.range)
        settle(window)
        #expect(text.string == "ask @engineer ")
        #expect(text.selectedRange().location == 14)
        let color = text.textStorage?.attribute(.foregroundColor, at: 6, effectiveRange: nil) as? NSColor
        #expect(color == NSColor(Color.orange))
        let font = text.textStorage?.attribute(.font, at: 6, effectiveRange: nil) as? NSFont
        #expect(font?.fontDescriptor.symbolicTraits.contains(.bold) == true)

        text.insertText("hi", replacementRange: text.selectedRange())
        #expect(field.draft.mentions == [engineer])
        for _ in 0..<3 { text.deleteBackward(nil) }
        #expect(text.string == "ask @engineer")
        text.deleteBackward(nil)
        #expect(text.string == "ask ")
        #expect(field.draft.mentions.isEmpty)
        #expect(field.caret == 4)
    }

    @Test func returnPicksFromAnOpenMenuThenSendsAndShiftOrOptionReturnAddsANewline() throws {
        let field = Field()
        let (window, text) = try mount(field) {
            guard let trigger = field.draft.trigger(caret: field.caret) else { return false }
            field.caret = field.draft.pick(self.engineer, replacing: trigger.range)
            return true
        }
        text.insertText("@eng", replacementRange: text.selectedRange())
        try press(text)
        settle(window)
        #expect(field.draft.text == "@engineer ")
        #expect(field.sent.isEmpty, "the menu took the Return")

        text.insertText("go", replacementRange: text.selectedRange())
        try press(text, .shift)
        try press(text, .option)
        #expect(field.draft.text == "@engineer go\n\n")
        #expect(field.sent.isEmpty)

        try press(text)
        settle(window)
        #expect(field.sent == ["@engineer go\n\n"])
        #expect(text.string == "")
    }

    @Test func returnWhileAnInputMethodComposesNeverSends() throws {
        let field = Field()
        let (_, text) = try mount(field)
        text.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0), replacementRange: text.selectedRange())
        #expect(text.hasMarkedText())
        try press(text)
        #expect(field.sent.isEmpty)
    }

    @Test func withoutASubmitActionReturnIsANewlineAndQuotesStayStraight() throws {
        let field = Field()
        let (window, text) = try mount(field, submits: false)
        text.insertText("say \"hi\" -- now", replacementRange: text.selectedRange())
        try press(text)
        settle(window)
        #expect(field.draft.text == "say \"hi\" -- now\n")
    }
}
