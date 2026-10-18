import Foundation

extension Mention {
    /// The name the "@name" token spells. nil for a kind this app does not know.
    var name: String? {
        switch self {
        case .bot(_, let name), .connector(let name): name
        case .unknown: nil
        }
    }

    var label: String? { name.map { "@" + $0 } }
}

/// One "@name" in the composer: the text it spans and what it points to. Ranges are UTF-16, like UITextView's.
struct MentionToken: Equatable, Sendable {
    var range: NSRange
    let mention: Mention
}

/// What the composer is completing: "@query" before the caret, or a "/" command as the first word.
struct ComposerTrigger: Equatable, Sendable {
    enum Kind: Sendable { case mention, command }

    let kind: Kind
    /// What a pick replaces: from the "@" to the caret, or the whole first word for a command.
    let range: NSRange
    let query: String
}

/// The composer's text and the mention tokens in it.
struct ComposerDraft: Equatable, Sendable {
    private(set) var text: String
    /// Sorted by location. They never overlap.
    private(set) var tokens: [MentionToken] = []

    /// How far back from the caret an "@" still opens the menu.
    static let longestQuery = 40
    /// The bridge takes at most this many mentions on a send.
    static let mentionLimit = 10

    init(text: String = "") {
        self.text = text
    }

    var isBlank: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What the tokens still in the text point to, in order, each once.
    var mentions: [Mention] {
        var seen: [Mention] = []
        for token in tokens where !seen.contains(token.mention) { seen.append(token.mention) }
        return Array(seen.prefix(Self.mentionLimit))
    }

    /// The send for this draft. The text keeps each "@name"; mentions say what they point to.
    func send(to botId: BotID, uploads: [Upload], clientId: String) -> ClientMessage {
        .send(
            botId: botId, text: text.trimmingCharacters(in: .whitespacesAndNewlines), uploads: uploads,
            clientId: clientId, mentions: mentions
        )
    }

    /// Applies an edit and returns the range it actually replaced. A deletion that reaches into a token takes the whole
    /// token. Typing inside a token leaves its text as plain text.
    @discardableResult
    mutating func replace(_ range: NSRange, with replacement: String) -> NSRange {
        var range = range
        if replacement.isEmpty && range.length > 0 {
            for token in tokens where NSIntersectionRange(token.range, range).length > 0 {
                range = NSUnionRange(range, token.range)
            }
        }
        let delta = replacement.utf16.count - range.length
        tokens = tokens.compactMap { token in
            if NSMaxRange(token.range) <= range.location { return token }
            guard token.range.location >= NSMaxRange(range) else { return nil }
            var moved = token
            moved.range.location += delta
            return moved
        }
        text = (text as NSString).replacingCharacters(in: range, with: replacement)
        return range
    }

    /// Applies the edit that turned the text into newText, with the caret just after what was typed, and returns where
    /// the caret goes. UIKit reports only the result of some edits, so the edit is read from what stayed the same on
    /// either side of the caret. A backspace into a token still takes the whole token.
    mutating func edit(to newText: String, caret: Int) -> Int {
        let old = Array(text.utf16)
        let new = Array(newText.utf16)
        guard old != new else { return caret }
        let caret = min(max(caret, 0), new.count)
        var suffix = 0
        while suffix < min(old.count, new.count - caret), old[old.count - 1 - suffix] == new[new.count - 1 - suffix] {
            suffix += 1
        }
        var prefix = 0
        while prefix < min(old.count, new.count) - suffix, old[prefix] == new[prefix] {
            prefix += 1
        }
        let range = NSRange(location: prefix, length: old.count - suffix - prefix)
        let inserted = String(decoding: new[prefix..<(new.count - suffix)], as: UTF16.self)
        let replaced = replace(range, with: inserted)
        if replaced == range && text != newText { sync(to: newText) }
        return replaced.location + (new.count - suffix - prefix)
    }

    /// Puts a token where the trigger was, followed by a space, and returns where the caret goes.
    mutating func pick(_ mention: Mention, replacing range: NSRange) -> Int {
        guard let label = mention.label else { return range.location }
        let caret = insert(label, replacing: range)
        tokens.append(MentionToken(range: NSRange(location: range.location, length: label.utf16.count), mention: mention))
        tokens.sort { $0.range.location < $1.range.location }
        return caret
    }

    /// Replaces the trigger with a command and a space for its arguments, and returns where the caret goes.
    mutating func pick(command name: String, replacing range: NSRange) -> Int {
        insert("/" + name, replacing: range)
    }

    /// Adds plain text at the end, such as dictation.
    mutating func append(_ string: String) {
        replace(NSRange(location: (text as NSString).length, length: 0), with: string)
    }

    /// The text view changed in a way the draft did not see, such as committed marked text. Keeps each token whose
    /// text still reads "@name" where it was.
    mutating func sync(to newText: String) {
        guard newText != text else { return }
        text = newText
        let ns = newText as NSString
        tokens = tokens.filter { token in
            NSMaxRange(token.range) <= ns.length && ns.substring(with: token.range) == token.mention.label
        }
    }

    private mutating func insert(_ string: String, replacing range: NSRange) -> Int {
        let ns = text as NSString
        let end = NSMaxRange(range)
        let spaced = end < ns.length && Self.isSpace(ns.character(at: end))
        replace(range, with: spaced ? string : string + " ")
        return range.location + string.utf16.count + 1
    }

    /// The menu the caret is in, if any. A command is the first word when the text starts with "/". A mention starts at
    /// an "@" that begins a word, on the caret's line, outside any token.
    func trigger(caret: Int) -> ComposerTrigger? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }
        if ns.hasPrefix("/") && caret >= 1 {
            let space = ns.rangeOfCharacter(from: .whitespacesAndNewlines)
            let wordEnd = space.location == NSNotFound ? ns.length : space.location
            if caret <= wordEnd {
                return ComposerTrigger(
                    kind: .command, range: NSRange(location: 0, length: wordEnd),
                    query: ns.substring(with: NSRange(location: 1, length: caret - 1))
                )
            }
        }
        var at = caret
        while at > 0 && caret - at <= Self.longestQuery {
            at -= 1
            if tokens.contains(where: { NSLocationInRange(at, $0.range) }) { return nil }
            let c = ns.character(at: at)
            if Self.isNewline(c) { return nil }
            guard c == 0x40 else { continue }
            guard at == 0 || Self.isSpace(ns.character(at: at - 1)) else { return nil }
            return ComposerTrigger(
                kind: .mention, range: NSRange(location: at, length: caret - at),
                query: ns.substring(with: NSRange(location: at + 1, length: caret - at - 1))
            )
        }
        return nil
    }

    private static func isSpace(_ c: unichar) -> Bool {
        Unicode.Scalar(c).map(CharacterSet.whitespacesAndNewlines.contains) ?? false
    }

    private static func isNewline(_ c: unichar) -> Bool {
        Unicode.Scalar(c).map(CharacterSet.newlines.contains) ?? false
    }
}

/// A row of the "@" menu.
enum MentionCandidate: Equatable, Identifiable {
    case bot(Bot)
    case connector(Connector)

    var id: String {
        switch self {
        case .bot(let bot): "bot:\(bot.id.rawValue)"
        case .connector(let connector): "connector:\(connector.name)"
        }
    }

    var name: String {
        switch self {
        case .bot(let bot): bot.name
        case .connector(let connector): connector.name
        }
    }

    var mention: Mention {
        switch self {
        case .bot(let bot): .bot(id: bot.id, name: bot.name)
        case .connector(let connector): .connector(name: connector.name)
        }
    }
}

enum MentionMenu {
    /// Bots first, then the chat's connectors that are on, each kept when its name contains the query. A 1:1 chat leaves
    /// out its own bot. A group's members lead, in the order the user picked them. Groups are not mentionable.
    static func candidates(_ query: String, in chat: Bot, bots: [Bot], connectors: [Connector]) -> [MentionCandidate] {
        let plain = bots.filter { $0.kind != .group && $0.id != chat.id }
        let members = chat.members.compactMap { id in plain.first { $0.id == id } }
        let others = plain.filter { !chat.members.contains($0.id) }.sorted(by: Bot.homeOrder)
        let matches = { (name: String) in query.isEmpty || name.localizedCaseInsensitiveContains(query) }
        return (members + others).filter { matches($0.name) }.map(MentionCandidate.bot)
            + connectors.filter { $0.enabled && matches($0.name) }.map(MentionCandidate.connector)
    }
}

/// The list above the composer, for the trigger at the caret. It shows only while something matches.
enum ComposerMenu: Equatable {
    case mentions(ComposerTrigger, [MentionCandidate])
    case commands(ComposerTrigger, [Command])

    var trigger: ComposerTrigger {
        switch self {
        case .mentions(let trigger, _), .commands(let trigger, _): trigger
        }
    }

    /// "@" needs a bridge with mentions. "/" needs commands, and a group has none: its members answer, not a session.
    static func at(
        _ caret: Int, in draft: ComposerDraft, chat: Bot, features: Set<Feature>,
        bots: [Bot], connectors: [Connector], commands: [Command]
    ) -> ComposerMenu? {
        guard let trigger = draft.trigger(caret: caret) else { return nil }
        switch trigger.kind {
        case .mention:
            guard features.contains(.mentions) else { return nil }
            let found = MentionMenu.candidates(trigger.query, in: chat, bots: bots, connectors: chat.isGroup ? [] : connectors)
            return found.isEmpty ? nil : .mentions(trigger, found)
        case .command:
            guard features.contains(.commands), !chat.isGroup else { return nil }
            let found = CommandMenu.matches(commands, query: trigger.query)
            return found.isEmpty ? nil : .commands(trigger, found)
        }
    }
}

extension Connector {
    /// The gray state beside a connector in the "@" menu.
    var mentionState: String {
        switch status {
        case .connected: "connected"
        case .pending: "connecting"
        case .failed: "error"
        case .needsAuth: "needs auth"
        case .unchecked: "not checked"
        case .unknown(let raw): raw.replacingOccurrences(of: "_", with: " ")
        }
    }
}

enum CommandMenu {
    /// The commands whose name contains the query, in the bridge's order.
    static func matches(_ commands: [Command], query: String) -> [Command] {
        commands.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }

    /// "plugin:skill" names a plugin's skill. A plain name has no plugin.
    static func parts(_ name: String) -> (plugin: String?, command: String) {
        guard let colon = name.firstIndex(of: ":") else { return (nil, name) }
        return (String(name[..<colon]), String(name[name.index(after: colon)...]))
    }
}

/// A user message's text split at its "@name" tokens, so a bubble can draw each in its bot's color.
enum MentionText {
    enum Segment: Equatable {
        case text(String)
        case mention(Mention, label: String)
    }

    /// How a mention reads in a bubble. In a filled bubble the bot's own color would vanish into the fill, so the
    /// name takes the bubble's text color over a faint tint. In a gray bubble it keeps the bot's color, bare.
    enum Style: Equatable {
        case filledBubble, grayBubble

        var usesBubbleTextColor: Bool { self == .filledBubble }
        var tintOpacity: Double { self == .filledBubble ? 0.22 : 0 }
    }

    /// Each "@name" a mention names, at the start of a word, becomes a segment. Longer names win, so "@news digest"
    /// is not cut to "@news".
    static func segments(_ text: String, mentions: [Mention]) -> [Segment] {
        let labels = mentions.compactMap { m in m.label.map { (m, $0) } }.sorted { $0.1.count > $1.1.count }
        guard !labels.isEmpty else { return text.isEmpty ? [] : [.text(text)] }
        var segments: [Segment] = []
        var pending = ""
        var index = text.startIndex
        while index < text.endIndex {
            let wordStart = index == text.startIndex || text[text.index(before: index)].isWhitespace
            if wordStart, text[index] == "@", let (mention, label) = labels.first(where: { label in
                guard text[index...].hasPrefix(label.1) else { return false }
                let end = text.index(index, offsetBy: label.1.count)
                return end == text.endIndex || !(text[end].isLetter || text[end].isNumber)
            }) {
                if !pending.isEmpty { segments.append(.text(pending)) }
                pending = ""
                segments.append(.mention(mention, label: label))
                index = text.index(index, offsetBy: label.count)
                continue
            }
            pending.append(text[index])
            index = text.index(after: index)
        }
        if !pending.isEmpty { segments.append(.text(pending)) }
        return segments
    }
}
