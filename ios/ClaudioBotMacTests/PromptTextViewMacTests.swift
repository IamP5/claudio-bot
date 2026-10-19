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
        _ field: Field, maxLines: Int? = nil, onReturn: @escaping () -> Bool = { false }, submits: Bool = true
    ) throws -> (NSWindow, NSTextView) {
        let view = PromptTextView(
            draft: Binding(get: { field.draft }, set: { field.draft = $0 }),
            caret: Binding(get: { field.caret }, set: { field.caret = $0 }),
            placeholder: "Message", maxLines: maxLines, tokenColor: { _ in .orange }, onReturn: onReturn,
            onSubmit: submits ? {
                field.sent.append(field.draft.text)
                field.draft = ComposerDraft()
                field.caret = 0
            } : nil
        )
        // The composer's shape: a field as wide as its row that sizes its own height, pinned to the top.
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 360, height: 400), styleMask: [.titled], backing: .buffered, defer: false
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

    @Test func aLongDraftWrapsAtTheFieldsWidthGrowsToItsMaxLinesThenScrolls() throws {
        let field = Field()
        let (window, text) = try mount(field, maxLines: 4)
        let scroll = try #require(text.enclosingScrollView)
        let layout = try #require(text.layoutManager)
        let container = try #require(text.textContainer)
        let font = try #require(text.font)
        let line = layout.defaultLineHeight(for: font)
        let lines = { () -> Int in
            var count = 0
            layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { _, _, _, _, _ in count += 1 }
            return count
        }
        settle(window)
        #expect(abs(scroll.frame.height - line) < 1, "an empty field is one line tall")

        text.insertText(String(repeating: "wrap me ", count: 12), replacementRange: text.selectedRange())
        // SwiftUI measures with probe proposals of other widths. None of them may stick to the field.
        _ = window.contentView?.fittingSize
        settle(window)
        #expect(scroll.frame.width > 300, "the field fills its row")
        #expect(abs(container.size.width - scroll.contentSize.width) < 1, "text wraps at the width the field shows")
        #expect(layout.usedRect(for: container).width > scroll.contentSize.width * 0.8, "lines run across the whole field")
        #expect(lines() >= 2 && lines() <= 4)
        #expect(abs(scroll.frame.height - CGFloat(lines()) * line) < 1, "the field grows to show every line")

        text.insertText(String(repeating: "and more ", count: 40), replacementRange: text.selectedRange())
        _ = window.contentView?.fittingSize
        settle(window)
        #expect(lines() > 4)
        #expect(abs(scroll.frame.height - 4 * line) < 1, "past its max lines the field stops growing")
        #expect(text.frame.height > scroll.frame.height + line, "and the rest scrolls")
        #expect(scroll.contentView.bounds.maxY >= text.frame.height - 1, "the end of the draft, where the caret is, stays in view")
        #expect(abs(container.size.width - scroll.contentSize.width) < 1)
    }

    @Test func anAutofocusedFieldTakesTheKeyboardWhenItsWindowShows() throws {
        let field = Field()
        let view = PromptTextView(
            draft: Binding(get: { field.draft }, set: { field.draft = $0 }),
            caret: Binding(get: { field.caret }, set: { field.caret = $0 }),
            placeholder: "Message", autofocus: true
        )
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 360, height: 200), styleMask: [.titled], backing: .buffered, defer: false
        )
        window.contentView = NSHostingView(rootView: view)
        settle(window)
        let content = try #require(window.contentView)
        let text = try #require(Self.textView(in: content))
        #expect(window.firstResponder === text)
    }

    @Test func pastedFilesAndALoneImageBecomeAttachmentsWhileTextStillPastes() throws {
        let field = Field()
        let (_, text) = try mount(field)
        let prompt = try #require(text as? PromptNSTextView)
        var files: [URL] = []
        var images: [Data] = []
        prompt.onAttachFiles = { files += $0 }
        prompt.onAttachImage = { images.append($0) }
        let board = NSPasteboard(name: NSPasteboard.Name("PromptTextViewMacTests.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }

        let file = URL(fileURLWithPath: "/tmp/notes.txt")
        board.clearContents()
        board.writeObjects([file as NSURL])
        #expect(text.readSelection(from: board))
        #expect(files == [file])
        #expect(text.string.isEmpty, "a file attaches instead of pasting its path")

        let png = try #require(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )?.representation(using: .png, properties: [:]))
        board.clearContents()
        board.setData(png, forType: .png)
        #expect(text.readSelection(from: board))
        #expect(images == [png])

        board.clearContents()
        board.setString("hello", forType: .string)
        board.setData(png, forType: .png)
        #expect(text.readSelection(from: board))
        #expect(images.count == 1, "text beside an image pastes as text")
        #expect(field.draft.text == "hello")
    }
}

