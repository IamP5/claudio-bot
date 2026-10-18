import Foundation

/// Spend, against a limit when there is one: a bot's day against its daily cap, or an agent's lifetime against its
/// budget. The amounts are Claude Code's own cost estimates, as the bridge's ledger summed them.
struct Spend: Equatable, Sendable {
    let spentUsd: Double
    /// nil: no limit, so nothing waits on spend.
    let limitUsd: Double?

    /// The share at which the chat warns that background work will soon stop.
    static let warnAt = 0.8

    var fraction: Double? {
        limitUsd.map { $0 > 0 ? spentUsd / $0 : 1 }
    }

    var reached: Bool { limitUsd.map { spentUsd >= $0 } ?? false }
    var nearLimit: Bool { (fraction ?? 0) >= Self.warnAt }

    var text: String { limitUsd.map { "\(Money.text(spentUsd)) of \(Money.text($0))" } ?? Money.text(spentUsd) }
}

enum Money {
    static func text(_ usd: Double) -> String {
        usd.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")))
    }

    /// The caps the profile offers in one tap. Anything else goes through Custom.
    static let capChoices: [Double] = [1, 2, 5, 10, 20, 50]

    /// A typed cap: "$12.50", "12,5", "1,234.50", "1.234,50" and "12" all read as dollars. A comma followed by exactly
    /// three digits groups thousands; otherwise the last comma or dot is the decimal point. Nil for anything negative
    /// or unreadable.
    static func parse(_ text: String) -> Double? {
        let cleaned = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "$", with: "")
        var whole = Substring(cleaned)
        var fraction = Substring("")
        var grouping: Character = ","
        if let last = cleaned.lastIndex(where: { $0 == "," || $0 == "." }) {
            let mark = cleaned[last]
            let tail = cleaned[cleaned.index(after: last)...]
            let groupsOnly = cleaned.count(where: { $0 == mark }) > 1 || (mark == "," && tail.count == 3 && !cleaned.contains("."))
            if groupsOnly {
                grouping = mark
            } else {
                whole = cleaned[..<last]
                fraction = tail
                grouping = mark == "," ? "." : ","
            }
        }
        let groups = whole.split(separator: grouping, omittingEmptySubsequences: false)
        let digits = { (part: Substring) in part.allSatisfy { ("0"..."9").contains($0) } }
        guard groups.allSatisfy(digits), digits(fraction),
              groups.count == 1 || ((1...3).contains(groups[0].count) && groups.dropFirst().allSatisfy { $0.count == 3 }),
              let value = Double(fraction.isEmpty ? groups.joined() : groups.joined() + "." + fraction), value.isFinite
        else { return nil }
        return value
    }
}

extension Bot {
    /// nil only from a bridge that predates spend. A bot with no cap still has today's spend.
    var spend: Spend? {
        spentTodayUsd.map { Spend(spentUsd: $0, limitUsd: capUsd) }
    }
}

extension Agent {
    /// nil for a cloud agent, which the bridge does not meter.
    var spend: Spend? {
        spentUsd.map { Spend(spentUsd: $0, limitUsd: budgetUsd) }
    }
}
