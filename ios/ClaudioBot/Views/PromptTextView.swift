import SwiftUI
import UIKit

/// A text input that leaves what you type alone and draws mention tokens. SwiftUI's TextField and TextEditor have no
/// modifier for smart punctuation, which turns straight quotes in code into curly ones, so this wraps UITextView.
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
    /// Return sends on the Mac twin. A phone's Return adds a newline, so it is unused here.
    var onSubmit: (() -> Void)? = nil

    var body: some View {
        Representable(
            draft: $draft, caret: $caret, minLines: minLines, maxLines: maxLines, autofocus: autofocus,
            tokenColor: tokenColor, onReturn: onReturn, onEscape: onEscape
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

/// Escape closes the composer's menu from a hardware keyboard.
private final class PromptUITextView: UITextView {
    var onEscape: () -> Void = {}

    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escape))]
    }

    @objc private func escape() { onEscape() }
}

private struct Representable: UIViewRepresentable {
    @Binding var draft: ComposerDraft
    @Binding var caret: Int
    let minLines: Int
    let maxLines: Int?
    let autofocus: Bool
    let tokenColor: (Mention) -> Color
    let onReturn: () -> Bool
    let onEscape: () -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = PromptUITextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.autocapitalizationType = .none
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if autofocus { DispatchQueue.main.async { view.becomeFirstResponder() } }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        (view as? PromptUITextView)?.onEscape = onEscape
        guard view.markedTextRange == nil else { return }
        context.coordinator.applying = true
        defer { context.coordinator.applying = false }
        if view.text != draft.text {
            view.text = draft.text
            view.selectedRange = NSRange(location: min(caret, (draft.text as NSString).length), length: 0)
        }
        context.coordinator.restyle(view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let line = view.font?.lineHeight ?? 17
        let content = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let upper = maxLines.map { CGFloat($0) * line } ?? .greatestFiniteMagnitude
        let height = min(max(content, CGFloat(minLines) * line), upper)
        view.isScrollEnabled = content > upper
        return CGSize(width: width, height: height.rounded(.up))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: Representable
        /// Set while the coordinator writes to the view, so the selection it sets is not reported back mid-update.
        var applying = false

        init(_ parent: Representable) {
            self.parent = parent
        }

        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            !(text == "\n" && parent.onReturn())
        }

        /// The draft reads the edit from the new text, because UIKit skips the delegate's shouldChangeTextIn for some
        /// edits. When a backspace reached into a token, the view drops the rest of the token too.
        func textViewDidChange(_ view: UITextView) {
            if returnPicked(view) { return }
            var draft = parent.draft
            let caret = draft.edit(to: view.text, caret: view.selectedRange.location)
            if draft.text != view.text {
                applying = true
                view.text = draft.text
                view.selectedRange = NSRange(location: caret, length: 0)
                applying = false
            }
            parent.draft = draft
            parent.caret = view.selectedRange.location
            if view.markedTextRange == nil { restyle(view, draft) }
        }

        /// A Return that reached the text without the delegate: when a menu takes it, the newline comes back out.
        private func returnPicked(_ view: UITextView) -> Bool {
            let typed = view.text as NSString
            let at = view.selectedRange.location - 1
            guard at >= 0, typed.length == (parent.draft.text as NSString).length + 1,
                  typed.substring(with: NSRange(location: at, length: 1)) == "\n",
                  typed.replacingCharacters(in: NSRange(location: at, length: 1), with: "") == parent.draft.text
            else { return false }
            parent.caret = at
            guard parent.onReturn() else { return false }
            applying = true
            view.text = parent.draft.text
            view.selectedRange = NSRange(location: min(parent.caret, (parent.draft.text as NSString).length), length: 0)
            applying = false
            restyle(view)
            return true
        }

        func textViewDidChangeSelection(_ view: UITextView) {
            guard !applying, parent.caret != view.selectedRange.location else { return }
            parent.caret = view.selectedRange.location
        }

        func restyle(_ view: UITextView, _ draft: ComposerDraft? = nil) {
            let draft = draft ?? parent.draft
            let font = UIFont.preferredFont(forTextStyle: .body)
            let bold = font.fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: 0) } ?? font
            let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.label]
            let storage = view.textStorage
            let selection = view.selectedRange
            storage.beginEditing()
            storage.setAttributes(plain, range: NSRange(location: 0, length: storage.length))
            for token in draft.tokens where NSMaxRange(token.range) <= storage.length {
                let color = UIColor(parent.tokenColor(token.mention))
                storage.addAttributes(
                    [.font: bold, .foregroundColor: color, .backgroundColor: color.withAlphaComponent(0.16)],
                    range: token.range
                )
            }
            storage.endEditing()
            view.selectedRange = selection
            view.typingAttributes = plain
        }
    }
}
