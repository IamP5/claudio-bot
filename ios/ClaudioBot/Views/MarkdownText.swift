import SwiftUI

/// A reply's blocks, over raw text while parsing and over styled runs once drawn.
enum MarkdownBlocks {
    enum Block<Inline: Equatable>: Equatable {
        case prose(Inline)
        case heading(Inline)
        /// A numbered or bulleted line, drawn with a hanging indent one step in per level.
        case item(level: Int, marker: String, Inline)
        case quote(Inline)
        case rule
        case table(header: [Inline], rows: [[Inline]])
        case code(language: String?, String)

        func map<T: Equatable>(_ f: (Inline) -> T) -> Block<T> {
            switch self {
            case .prose(let s): .prose(f(s))
            case .heading(let s): .heading(f(s))
            case let .item(level, marker, s): .item(level: level, marker: marker, f(s))
            case .quote(let s): .quote(f(s))
            case .rule: .rule
            case let .table(header, rows): .table(header: header.map(f), rows: rows.map { $0.map(f) })
            case let .code(language, s): .code(language: language, s)
            }
        }
    }
}

typealias MarkdownBlock = MarkdownBlocks.Block<String>

extension MarkdownBlocks.Block where Inline == String {
    /// Splits assistant text into blocks. An unclosed fence runs to the end, which is what a still-streaming reply looks
    /// like; a table shows as text until its divider row arrives.
    static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [MarkdownBlock] = []
        var prose: [String] = []
        var quote: [String] = []
        var code: [String]?
        var language: String?
        /// The indents of the open list items, outermost first.
        var indents: [Int] = []

        func flush() {
            let joined = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { blocks.append(.prose(joined)) }
            prose.removeAll()
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))) }
            quote.removeAll()
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            i += 1
            if trimmed.hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(language: language, open.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    let tag = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    language = tag.isEmpty ? nil : tag
                    code = []
                }
                continue
            }
            if code != nil {
                code?.append(line)
                continue
            }
            if trimmed.hasPrefix(">") {
                if !prose.isEmpty { flush() }
                quote.append(String(trimmed.drop { $0 == ">" || $0 == " " }))
                continue
            }
            if !quote.isEmpty { flush() }
            if trimmed.isEmpty {
                prose.append(line)
                continue
            }
            if isRule(trimmed) {
                flush()
                indents.removeAll()
                blocks.append(.rule)
            } else if let item = listItem(trimmed) {
                flush()
                let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
                while let last = indents.last, last >= indent { indents.removeLast() }
                blocks.append(.item(level: indents.count, marker: indents.isEmpty || item.marker != "•" ? item.marker : "◦", item.text))
                indents.append(indent)
            } else if trimmed.contains("|"), i < lines.count, isDivider(lines[i], columns: cells(trimmed).count) {
                flush()
                let header = cells(trimmed)
                indents.removeAll()
                i += 1
                var rows: [[String]] = []
                while i < lines.count, case let row = lines[i].trimmingCharacters(in: .whitespaces), row.hasPrefix("|") || row.hasSuffix("|") {
                    let row = cells(lines[i].trimmingCharacters(in: .whitespaces))
                    rows.append(Array((row + Array(repeating: "", count: header.count)).prefix(header.count)))
                    i += 1
                }
                blocks.append(.table(header: header, rows: rows))
            } else if let hashes = trimmed.firstIndex(where: { $0 != "#" }), trimmed.hasPrefix("#"), trimmed[hashes] == " " {
                flush()
                indents.removeAll()
                blocks.append(.heading(String(trimmed[hashes...]).trimmingCharacters(in: .whitespaces)))
            } else {
                if line.first != " " && line.first != "\t" { indents.removeAll() }
                prose.append(line)
            }
        }
        if let open = code { blocks.append(.code(language: language, open.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func listItem(_ line: String) -> (marker: String, text: String)? {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return ("•", String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3, line.dropFirst(digits.count).hasPrefix(". ") else { return nil }
        return ("\(digits).", String(line.dropFirst(digits.count + 2)))
    }

    /// "---", "***", "___" and spaced forms such as "* * *".
    private static func isRule(_ line: String) -> Bool {
        let marks = line.filter { $0 != " " }
        guard marks.count >= 3, let first = marks.first, "-*_".contains(first) else { return false }
        return marks.allSatisfy { $0 == first }
    }

    /// "| --- | :-: |" under a header with as many columns.
    private static func isDivider(_ line: String, columns: Int) -> Bool {
        let parts = cells(line.trimmingCharacters(in: .whitespaces))
        return line.contains("-") && parts.count == columns && parts.allSatisfy { cell in
            !cell.isEmpty && cell.allSatisfy { "-:".contains($0) } && cell.contains("-")
        }
    }

    /// A row's cells: outer pipes dropped, "\|" kept as a pipe.
    private static func cells(_ row: String) -> [String] {
        var row = Substring(row)
        if row.hasPrefix("|") { row = row.dropFirst() }
        if row.hasSuffix("|") && !row.hasSuffix("\\|") { row = row.dropLast() }
        var cells = [""]
        var escaped = false
        for c in row {
            if escaped { cells[cells.count - 1].append(c); escaped = false; continue }
            if c == "\\" { escaped = true; continue }
            if c == "|" { cells.append("") } else { cells[cells.count - 1].append(c) }
        }
        if escaped { cells[cells.count - 1].append("\\") }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

extension MarkdownBlocks.Block where Inline == AttributedString {
    /// What VoiceOver reads for the blocks: no bullets, pipes or rules, a table row by row under its column names.
    static func spoken(_ blocks: [Self]) -> String {
        var out: [String] = []
        func plain(_ s: AttributedString) -> String { String(s.characters).trimmingCharacters(in: .whitespacesAndNewlines) }
        for block in blocks {
            switch block {
            case .prose(let s), .heading(let s): out.append(plain(s))
            case let .item(_, marker, s): out.append(marker.first?.isNumber == true ? "\(marker) \(plain(s))" : plain(s))
            case .quote(let s): out.append("Quote: " + plain(s))
            case .rule: break
            case let .table(header, rows):
                let names = header.map(plain)
                out.append("Table, \(names.count) columns: " + names.joined(separator: ", "))
                out += rows.map { Self.spokenRow($0.map(plain), names: names) }
            case .code(_, let s): out.append(s)
            }
        }
        return out.filter { !$0.isEmpty }
            .map { $0.last.map { ".!?:".contains($0) } == true ? $0 : $0 + "." }
            .joined(separator: " ")
    }

    static func spokenRow(_ cells: [String], names: [String]) -> String {
        zip(names, cells).map { $0.isEmpty ? $1 : "\($0): \($1)" }.joined(separator: ", ")
    }
}

struct MarkdownText: View {
    let text: String
    /// A group's members, whose "@name" reads bold in their color. Code blocks keep their text as written.
    var members: [Bot] = []
    /// False hugs the text, for a bubble that should be no wider than what it says.
    var fillsWidth = true

    var body: some View {
        MarkdownBlocksView(blocks: MarkdownBlock.parse(text).map { $0.map(inline) }, fillsWidth: fillsWidth)
    }

    private func inline(_ s: String) -> AttributedString {
        var text = Self.inline(s)
        guard !members.isEmpty else { return text }
        let plain = String(text.characters)
        for (range, member) in MentionText.memberMentions(in: plain, members: members).reversed() {
            let lower = text.characters.index(text.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
            let upper = text.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
            var run = AttributedString(text[lower..<upper])
            MentionText.Style.grayBubble.mark(&run, color: member.avatar.color.accent, bubbleText: .white)
            text.replaceSubrange(lower..<upper, with: run)
        }
        return text
    }

    // Inline-only keeps line breaks and list markers as written; full block parsing would merge them.
    nonisolated static func inline(_ s: String) -> AttributedString {
        var text = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
        for run in text.runs where run.link != nil {
            text[run.range].underlineStyle = .single
        }
        return text
    }
}

/// Markdown parsed once into the runs MarkdownText draws. A thread keeps one per item, so a row's body only lays out.
struct RenderedMarkdown: Equatable, Sendable {
    typealias Block = MarkdownBlocks.Block<AttributedString>

    let blocks: [Block]

    init(_ text: String) {
        blocks = MarkdownBlock.parse(text).map { $0.map(MarkdownText.inline) }
    }

    var spoken: String { Block.spoken(blocks) }

    /// The text of each link, in order.
    var links: [String] {
        func links(_ s: AttributedString) -> [String] { s.runs.filter { $0.link != nil }.map { String(s[$0.range].characters) } }
        return blocks.flatMap { block -> [String] in
            switch block {
            case .prose(let s), .heading(let s), .item(_, _, let s), .quote(let s): links(s)
            case let .table(header, rows): (header + rows.joined()).flatMap(links)
            case .rule, .code: []
            }
        }
    }
}

extension MarkdownBlocks.Block: Sendable where Inline: Sendable {}

struct RenderedMarkdownView: View, Equatable {
    let markdown: RenderedMarkdown

    var body: some View {
        MarkdownBlocksView(blocks: markdown.blocks)
    }
}

struct MarkdownBlocksView: View {
    let blocks: [RenderedMarkdown.Block]
    var fillsWidth = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let s):
                    Text(s).textSelection(.enabled)
                case let .item(level, marker, s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).monospacedDigit().frame(minWidth: 16, alignment: .trailing)
                            .accessibilityHidden(!(marker.first?.isNumber ?? false))
                        Text(s).textSelection(.enabled)
                    }
                    .padding(.leading, CGFloat(level) * 20)
                case .heading(let s):
                    Text(s).font(.headline).accessibilityAddTraits(.isHeader)
                case .quote(let s):
                    Text(s)
                        .textSelection(.enabled)
                        .opacity(0.8)
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) { Capsule().fill(.secondary).frame(width: 3) }
                        .accessibilityLabel("Quote: " + String(s.characters))
                case .rule:
                    Rectangle().fill(.secondary.opacity(0.5)).frame(height: 1).accessibilityHidden(true)
                case let .table(header, rows):
                    MarkdownTable(header: header, rows: rows)
                case .code(let language, let s):
                    CodeBlock(language: language, code: s)
                }
            }
        }
        .frame(maxWidth: fillsWidth ? .infinity : nil, alignment: .leading)
    }
}

/// Columns aligned in a grid that scrolls sideways when wide. VoiceOver reads each cell under its column's name.
struct MarkdownTable: View {
    let header: [AttributedString]
    let rows: [[AttributedString]]

    var body: some View {
        let names = header.map { String($0.characters) }
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, name in
                        Text(name).fontWeight(.semibold).accessibilityAddTraits(.isHeader)
                    }
                }
                Rectangle().fill(.secondary.opacity(0.5)).frame(height: 1).accessibilityHidden(true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            Text(cell)
                                .textSelection(.enabled)
                                .accessibilityLabel(RenderedMarkdown.Block.spokenRow([String(cell.characters)], names: [names[column]]))
                        }
                    }
                }
            }
            .fixedSize()
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
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
