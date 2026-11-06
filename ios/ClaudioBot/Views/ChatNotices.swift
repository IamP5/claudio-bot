import SwiftUI

/// Above the chat while the bridge is out of reach: the chat list's banner, with its cause, its age and its actions
/// (F-AR-002, F-AR-006).
struct OfflineBar: View {
    @Environment(AppStore.self) private var store
    @State private var lastRetryFailed = false

    var body: some View {
        Group {
            if store.connection == .unrecognized {
                UnrecognizedBanner(staleSince: store.heardAt, staleWhat: "Messages")
            } else {
                ConnectionBanner(state: store.connection, staleSince: store.heardAt, staleWhat: "Messages", lastRetryFailed: $lastRetryFailed)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .onChange(of: store.machine) { lastRetryFailed = false }
    }
}

/// Offline, what a bot was doing is only last known (P-ALIVE-3, F-AR-005, F-AR-009).
enum LastKnown {
    static let working = "Working when last updated"
    static let background = "Running in the background when last updated"
}

extension AppStore {
    /// Offline a working bot's avatar rests: nothing says it still works.
    func motion(of bot: Bot) -> AvatarMotion {
        showsOnline ? bot.motion : .idle
    }
}

/// In the chat once the bot and its agents have spent 80% of today's cap.
struct SpendWarning: View {
    let bot: Bot
    let spend: Spend
    let cap: Double
    let onChangeCap: () -> Void

    static func text(_ bot: Bot, _ spend: Spend, cap: Double) -> String {
        let head = spend.reached
            ? "\(bot.name) reached today's \(Money.text(cap)) cap."
            : "\(bot.name) has spent \(spend.text) today."
        return "\(head) At the cap, routines and agents wait until midnight. Messages you type still run."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(Self.text(bot, spend, cap: cap), systemImage: "gauge.with.dots.needle.67percent")
                .font(.ui(size: 14))
                .foregroundStyle(.white)
            Button("Change the cap", action: onChangeCap)
                .font(.ui(size: 14, weight: .semibold))
                .foregroundStyle(Theme.attention)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.attention.opacity(0.4)))
    }
}

/// A fact this bot asked to remember. Until the user confirms it only this bot reads it; Forget deletes it.
struct ProposedFactCard: View {
    let bot: Bot
    let fact: Fact
    @Environment(BridgeClient.self) private var client

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("\(bot.name) wants to remember", systemImage: "brain")
                .font(.ui(size: 13, weight: .semibold))
                .foregroundStyle(Theme.secondary)
            Text(fact.text)
                .font(.ui(size: 16))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            Text("Only \(bot.name) uses it until you confirm. Then every Bot knows it.")
                .font(.ui(size: 13))
                .foregroundStyle(Theme.tertiary)
            HStack(spacing: 8) {
                Button("Confirm") { client.send(.confirmFact(factId: fact.id)) }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(.black)
                Button("Forget", role: .destructive) { client.send(.forgetFact(factId: fact.id)) }
                    .buttonStyle(.bordered)
            }
            .font(.ui(size: 14, weight: .semibold))
            .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
