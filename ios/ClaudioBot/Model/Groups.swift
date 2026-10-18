import Foundation

enum GroupRules {
    /// How many bots a group holds, as the bridge checks it.
    static let members = 2...8
    static let nameLimit = 40

    /// The name a new group gets when the user types none: its members' names, cut to fit.
    static func suggestedName(_ names: [String]) -> String {
        let joined = names.joined(separator: ", ")
        guard joined.count > nameLimit else { return joined }
        return String(joined.prefix(nameLimit - 1)).trimmingCharacters(in: CharacterSet(charactersIn: ", ")) + "…"
    }

    /// "Typing…" for a bot, and who is typing in a group.
    static func typing(_ names: [String]) -> String {
        switch names.count {
        case 0: "Typing…"
        case 1: "\(names[0]) is typing…"
        case 2: "\(names[0]) and \(names[1]) are typing…"
        default: "\(names[0]), \(names[1]) and \(names.count - 2) more are typing…"
        }
    }
}

extension Bot {
    var isGroup: Bool { kind == .group }
}

extension ExchangeMessage {
    /// An exchange reads like a group chat: each message is a bot bubble from its sender.
    var asMessage: Message {
        .bot(id: id, at: at, text: text, from: from)
    }
}

extension ChatRow {
    var isSeparator: Bool {
        if case .separator = self { true } else { false }
    }
}

extension Timeline {
    /// Whether this row opens a run of messages from one sender, so it carries the sender's avatar and name.
    static func opensRun(_ rows: [ChatRow], at index: Int) -> Bool {
        guard case .message(.bot(_, _, _, let from?)) = rows[index] else { return false }
        guard index > 0, case .message(.bot(_, _, _, let previous?)) = rows[index - 1] else { return true }
        return previous != from
    }
}
