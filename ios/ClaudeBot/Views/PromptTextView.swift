import SwiftUI
import UIKit

/// A text input that leaves what you type alone. SwiftUI's TextField and TextEditor have no modifier
/// for smart punctuation, which turns straight quotes in code into curly ones, so this wraps UITextView.
struct PromptTextView: View {
    @Binding var text: String
    var placeholder: String
    var minLines = 1
    var maxLines: Int?
    var autofocus = false

    var body: some View {
        Representable(text: $text, minLines: minLines, maxLines: maxLines, autofocus: autofocus)
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder)
                        .foregroundStyle(.tertiary)
                        .allowsHitTesting(false)
                }
            }
    }
}

private struct Representable: UIViewRepresentable {
    @Binding var text: String
    let minLines: Int
    let maxLines: Int?
    let autofocus: Bool

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
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
        if view.text != text { view.text = text }
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

        init(_ parent: Representable) {
            self.parent = parent
        }

        func textViewDidChange(_ view: UITextView) {
            parent.text = view.text
        }
    }
}
