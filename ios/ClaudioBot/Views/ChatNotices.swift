import SwiftUI

/// Above the chat while the Mac is out of reach: what is wrong, and that what you send waits.
struct OfflineBar: View {
    let state: ConnectionState

    static func shows(_ state: ConnectionState) -> Bool {
        switch state {
        case .connected, .unpaired: false
        case .connecting, .disconnected, .unrecognized: true
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            ConnectionBadge(state: state)
            Text(state == .unrecognized ? "Pair again from the chat list." : "Messages you send wait until your Mac is back.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
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
                .font(.system(size: 14))
                .foregroundStyle(.white)
            Button("Change the cap", action: onChangeCap)
                .font(.system(size: 14, weight: .semibold))
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
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.secondary)
            Text(fact.text)
                .font(.system(size: 16))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            Text("Only \(bot.name) uses it until you confirm. Then every Bot knows it.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.tertiary)
            HStack(spacing: 8) {
                Button("Confirm") { client.send(.confirmFact(factId: fact.id)) }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(.black)
                Button("Forget", role: .destructive) { client.send(.forgetFact(factId: fact.id)) }
                    .buttonStyle(.bordered)
            }
            .font(.system(size: 14, weight: .semibold))
            .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
