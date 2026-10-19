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
    /// Files pasted or dropped on the field. Without it they paste as their paths.
    var onAttachFiles: (([URL]) -> Void)? = nil
    /// An image pasted with no text beside it, such as a screenshot. Without it the paste is ignored.
    var onAttachImage: ((Data) -> Void)? = nil

    var body: some View {
        Representable(
            draft: $draft, caret: $caret, minLines: minLines, maxLines: maxLines, autofocus: autofocus,
            tokenColor: tokenColor, onReturn: onReturn, onEscape: onEscape, onSubmit: onSubmit,
            onAttachFiles: onAttachFiles, onAttachImage: onAttachImage
        )
        .overlay(alignment: .topLeading) {
            // Hidden with no animation, so a menu opening on the first "@" never fades it under the typed text.
            Text(placeholder)
                .font(Font(Representable.font))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .opacity(draft.text.isEmpty ? 1 : 0)
                .animation(nil, value: draft.text.isEmpty)
                .accessibilityHidden(!draft.text.isEmpty)
                .allowsHitTesting(false)
        }
    }
}

/// Remembers the modifiers of the key being handled, so Return can tell ⇧↩ and ⌥↩ from a plain Return. Files and
/// images pasted or dropped on it become attachments.
final class PromptNSTextView: NSTextView {
    private(set) var keyModifiers: NSEvent.ModifierFlags = []
    var onAttachFiles: (([URL]) -> Void)?
    var onAttachImage: ((Data) -> Void)?
    /// Set before the view has a window: it takes the keyboard once it lands in one.
    var focusOnWindow = false

    override func keyDown(with event: NSEvent) {
        keyModifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        defer { keyModifiers = [] }
        super.keyDown(with: event)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard focusOnWindow, let window else { return }
        focusOnWindow = false
        window.makeFirstResponder(self)
    }

    override func readSelection(from pasteboard: NSPasteboard) -> Bool {
        attach(from: pasteboard) || super.readSelection(from: pasteboard)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        attach(from: sender.draggingPasteboard) || super.performDragOperation(sender)
    }

    /// Text on the pasteboard pastes as text, even beside an image of it, the way rich editors copy.
    func attach(from pasteboard: NSPasteboard) -> Bool {
        if let onAttachFiles,
           let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !urls.isEmpty {
            onAttachFiles(urls)
            return true
        }
        if let onAttachImage, pasteboard.string(forType: .string) == nil,
           let image = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) {
            onAttachImage(image)
            return true
        }
        return false
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
    let onAttachFiles: (([URL]) -> Void)?
    let onAttachImage: ((Data) -> Void)?

    /// The size the transcript's bubbles draw at on the Mac, so a sent message keeps the size it was typed in.
    static var font: NSFont { .systemFont(ofSize: 14) }

    func makeNSView(context: Context) -> NSScrollView {
        let view = PromptNSTextView(usingTextLayoutManager: false)
        view.minSize = .zero
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
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
        view.focusOnWindow = autofocus
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? PromptNSTextView else { return }
        view.onAttachFiles = onAttachFiles
        view.onAttachImage = onAttachImage
        guard !view.hasMarkedText() else { return }
        context.coordinator.applying = true
        defer { context.coordinator.applying = false }
        if view.string != draft.text {
            view.string = draft.text
            view.setSelectedRange(NSRange(location: min(caret, (draft.text as NSString).length), length: 0))
        }
        context.coordinator.restyle(view)
    }

    /// Measures on a copy of the text. SwiftUI also proposes widths it only probes, so laying out the live container
    /// at them would leave the text wrapping at a width the field never takes. The live container tracks the view.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, let view = scroll.documentView as? NSTextView,
              let line = view.layoutManager?.defaultLineHeight(for: Self.font)
        else { return nil }
        let content = max(Self.height(of: view.attributedString(), width: width), line)
        let upper = maxLines.map { CGFloat($0) * line } ?? .greatestFiniteMagnitude
        let height = min(max(content, CGFloat(minLines) * line), upper)
        return CGSize(width: width, height: height.rounded(.up))
    }

    static func height(of text: NSAttributedString, width: CGFloat) -> CGFloat {
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        return layout.usedRect(for: container).height
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
