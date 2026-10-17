import SwiftUI

enum MarkdownBlock: Equatable {
    case prose(String)
    case heading(String)
    /// A numbered or bulleted line, drawn with a hanging indent.
    case item(marker: String, String)
    case code(language: String?, String)

    /// Splits assistant text into prose, headings, and fenced code. An unclosed fence runs to the end,
    /// which is what a still-streaming reply looks like.
    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var prose: [Substring] = []
        var code: [Substring]?
        var language: String?

        func flushProse() {
            let joined = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { blocks.append(.prose(joined)) }
            prose.removeAll()
        }

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(language: language, open.joined(separator: "\n")))
                    code = nil
                } else {
                    flushProse()
                    let tag = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    language = tag.isEmpty ? nil : tag
                    code = []
                }
            } else if code != nil {
                code?.append(line)
            } else if let item = Self.listItem(trimmed) {
                flushProse()
                blocks.append(.item(marker: item.marker, item.text))
            } else if let hashes = trimmed.firstIndex(where: { $0 != "#" }), trimmed.hasPrefix("#"),
                      trimmed[hashes] == " " {
                flushProse()
                blocks.append(.heading(String(trimmed[hashes...]).trimmingCharacters(in: .whitespaces)))
            } else {
                prose.append(line)
            }
        }
        if let open = code { blocks.append(.code(language: language, open.joined(separator: "\n"))) }
        flushProse()
        return blocks
    }

    private static func listItem(_ line: String) -> (marker: String, text: String)? {
        if line.hasPrefix("- ") || line.hasPrefix("* ") {
            return ("•", String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3, line.dropFirst(digits.count).hasPrefix(". ") else { return nil }
        return ("\(digits).", String(line.dropFirst(digits.count + 2)))
    }
}

struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(Self.inline(s))
                        .textSelection(.enabled)
                case let .item(marker, s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).monospacedDigit().frame(minWidth: 16, alignment: .trailing)
                        Text(Self.inline(s)).textSelection(.enabled)
                    }
                case .heading(let s):
                    Text(Self.inline(s))
                        .font(.headline)
                case .code(let language, let s):
                    CodeBlock(language: language, code: s)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Inline-only keeps line breaks and list markers as written; full block parsing would merge them.
    static func inline(_ s: String) -> AttributedString {
        var text = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        for run in text.runs where run.link != nil {
            text[run.range].underlineStyle = .single
        }
        return text
    }
}

struct CodeBlock: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language {
                Text(language)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator.opacity(0.6)))
    }
}
