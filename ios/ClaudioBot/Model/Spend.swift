import Foundation

/// Spend against a limit: a bot's day against its daily cap, or an agent's lifetime against its budget.
/// The amounts are Claude Code's own cost estimates, as the bridge's ledger summed them.
struct Spend: Equatable, Sendable {
    let spentUsd: Double
    let limitUsd: Double

    /// The share at which the chat warns that background work will soon stop.
    static let warnAt = 0.8

    var fraction: Double {
        limitUsd > 0 ? spentUsd / limitUsd : 1
    }

    var reached: Bool { spentUsd >= limitUsd }
    var nearLimit: Bool { fraction >= Self.warnAt }

    /// "$8.40 of $10.00".
    var text: String { "\(Money.text(spentUsd)) of \(Money.text(limitUsd))" }
}

enum Money {
    static func text(_ usd: Double) -> String {
        usd.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")))
    }

    /// The caps the profile offers in one tap. Anything else goes through Custom.
    static let capChoices: [Double] = [1, 2, 5, 10, 20, 50]

    /// A typed cap: "$12.50", "12,5" and "12" all read as dollars. Nil for anything negative or unreadable.
    static func parse(_ text: String) -> Double? {
        let cleaned = text.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: ".")
        guard let value = Double(cleaned), value.isFinite, value >= 0 else { return nil }
        return value
    }
}

extension Bot {
    var spend: Spend? {
        guard let spentTodayUsd, let capUsd else { return nil }
        return Spend(spentUsd: spentTodayUsd, limitUsd: capUsd)
    }
}

extension Agent {
    var spend: Spend? {
        guard let spentUsd, let budgetUsd else { return nil }
        return Spend(spentUsd: spentUsd, limitUsd: budgetUsd)
    }
}
