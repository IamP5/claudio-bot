import AppKit
import SwiftUI

/// The Mac twin of the iOS PromptTextView, with the same name and parameters. It wraps NSTextView so quotes, dashes and
/// text replacements stay as typed, and draws mention tokens the same way. Return sends, ⇧↩ and ⌥↩ add a newline.
struct PromptTextView: View {
    @Binding var draft: ComposerDraft
    /// The caret, in UTF-16 units, so the composer can find the "@" or "/" it sits in.
    @Binding var caret: Int
    var placeholder: String
    var minLines = 1
    var maxLines: Int?
    var autofocus = false
    var tokenColor: (Mention) -> Color = { _ in .white }
    /// Return while a menu is open picks its row. Answering true keeps the newline out.
    var onReturn: () -> Bool = { false }
    var onEscape: () -> Void = {}
    /// What a plain Return does when no menu took it. Without one, Return adds a newline.
    var onSubmit: (() -> Void)? = nil

    var body: some View {
        Representable(
            draft: $draft, caret: $caret, minLines: minLines, maxLines: maxLines, autofocus: autofocus,
            tokenColor: tokenColor, onReturn: onReturn, onEscape: onEscape, onSubmit: onSubmit
        )
        .overlay(alignment: .topLeading) {
            if draft.text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .allowsHitTesting(false)
            }
        }
    }
}

/// Remembers the modifiers of the key being handled, so Return can tell ⇧↩ and ⌥↩ from a plain Return.
final class PromptNSTextView: NSTextView {
    private(set) var keyModifiers: NSEvent.ModifierFlags = []

    override func keyDown(with event: NSEvent) {
        keyModifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        defer { keyModifiers = [] }
        super.keyDown(with: event)
    }
}

private struct Representable: NSViewRepresentable {
    @Binding var draft: ComposerDraft
    @Binding var caret: Int
    let minLines: Int
    let maxLines: Int?
    let autofocus: Bool
    let tokenColor: (Mention) -> Color
    let onReturn: () -> Bool
    let onEscape: () -> Void
    let onSubmit: (() -> Void)?

    static var font: NSFont { .preferredFont(forTextStyle: .body) }

    func makeNSView(context: Context) -> NSScrollView {
        let view = PromptNSTextView(usingTextLayoutManager: false)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.documentView = view
        view.delegate = context.coordinator
        view.font = Self.font
        view.textColor = .labelColor
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isAutomaticLinkDetectionEnabled = false
        view.isAutomaticDataDetectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.isGrammarCheckingEnabled = false
        view.smartInsertDeleteEnabled = false
        view.insertionPointColor = .labelColor
        if autofocus { DispatchQueue.main.async { view.window?.makeFirstResponder(view) } }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView, !view.hasMarkedText() else { return }
        context.coordinator.applying = true
        defer { context.coordinator.applying = false }
        if view.string != draft.text {
            view.string = draft.text
            view.setSelectedRange(NSRange(location: min(caret, (draft.text as NSString).length), length: 0))
        }
        context.coordinator.restyle(view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, let view = scroll.documentView as? NSTextView,
              let layout = view.layoutManager, let container = view.textContainer
        else { return nil }
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let line = layout.defaultLineHeight(for: Self.font)
        let content = max(layout.usedRect(for: container).height, line)
        let upper = maxLines.map { CGFloat($0) * line } ?? .greatestFiniteMagnitude
        let height = min(max(content, CGFloat(minLines) * line), upper)
        scroll.hasVerticalScroller = content > upper
        return CGSize(width: width, height: height.rounded(.up))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: Representable
        /// Set while the coordinator writes to the view, so the selection it sets is not reported back mid-update.
        var applying = false

        init(_ parent: Representable) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            var draft = parent.draft
            let caret = draft.edit(to: view.string, caret: view.selectedRange().location)
            if draft.text != view.string {
                applying = true
                view.string = draft.text
                view.setSelectedRange(NSRange(location: caret, length: 0))
                applying = false
            }
            parent.draft = draft
            parent.caret = view.selectedRange().location
            if !view.hasMarkedText() { restyle(view, draft) }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !applying, let view = notification.object as? NSTextView,
                  parent.caret != view.selectedRange().location
            else { return }
            parent.caret = view.selectedRange().location
        }

        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                // Return while an input method composes commits the composition; it never sends.
                if view.hasMarkedText() { return false }
                if parent.onReturn() { return true }
                let modifiers = (view as? PromptNSTextView)?.keyModifiers ?? []
                guard let submit = parent.onSubmit, modifiers.isDisjoint(with: [.shift, .option]) else { return false }
                submit()
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                parent.onEscape()
                return true
            default:
                return false
            }
        }

        func restyle(_ view: NSTextView, _ draft: ComposerDraft? = nil) {
            guard let storage = view.textStorage else { return }
            let draft = draft ?? parent.draft
            let font = Representable.font
            let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
            let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor]
            let selection = view.selectedRange()
            storage.beginEditing()
            storage.setAttributes(plain, range: NSRange(location: 0, length: storage.length))
            for token in draft.tokens where NSMaxRange(token.range) <= storage.length {
                let color = NSColor(parent.tokenColor(token.mention))
                storage.addAttributes(
                    [.font: bold, .foregroundColor: color, .backgroundColor: color.withAlphaComponent(0.16)],
                    range: token.range
                )
            }
            storage.endEditing()
            view.setSelectedRange(selection)
            view.typingAttributes = plain
        }
    }
}
