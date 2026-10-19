import SwiftUI

/// The bot's spend today and its daily cap, if any, in its profile. The cap covers the bot and its agents; at the cap,
/// routines and other background work wait until midnight while messages you type still run. There is none by default.
struct SpendingSection: View {
    let bot: Bot
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @State private var typingCap = false
    @State private var capText = ""

    static func capLabel(_ bot: Bot) -> String {
        if let own = bot.dailyCapUsd { return Money.text(own) }
        return bot.capUsd.map { "Default (\(Money.text($0)))" } ?? "No cap"
    }

    static func footer(_ spend: Spend) -> String {
        let today = "Today covers this Bot and its agents, as Claude Code estimates it."
        guard spend.limitUsd != nil else { return today }
        return "\(today) At the cap, routines and agents wait until midnight. Messages you type still run."
    }

    static func setCap(_ botId: BotID, _ usd: Double?) -> ClientMessage {
        .updateBot(botId: botId, patch: BotPatch(dailyCapUsd: .some(usd)))
    }

    var body: some View {
        if let spend = bot.spend {
            CardSection(title: "Spending", footer: Self.footer(spend)) {
                today(spend)
                Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16)
                capRow
            }
            .alert("Daily cap", isPresented: $typingCap) {
                TextField("Dollars", text: $capText)
                    .keyboardType(.decimalPad)
                Button("Cancel", role: .cancel) {}
                Button("Set") {
                    if let usd = Money.parse(capText) { client.send(Self.setCap(bot.id, usd)) }
                }
            } message: {
                Text("The most \(bot.name) and its agents may spend in a day on their own.")
            }
        } else if store.lacks(.spend) {
            NeedsNewerBridge(title: "Spending", what: "see what this Bot spends and set its daily cap")
        }
    }

    private func today(_ spend: Spend) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Today").font(.ui(size: 16)).foregroundStyle(.white)
                Spacer()
                Text(spend.text)
                    .font(.ui(size: 15).monospacedDigit())
                    .foregroundStyle(spend.nearLimit ? Theme.attention : Theme.secondary)
            }
            if let fraction = spend.fraction {
                ProgressView(value: min(fraction, 1))
                    .tint(spend.nearLimit ? Theme.attention : AvatarColor.teal.color)
            }
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }

    private var capRow: some View {
        Menu {
            Button("No cap") { client.send(Self.setCap(bot.id, nil)) }
            ForEach(Money.capChoices, id: \.self) { usd in
                Button(Money.text(usd)) { client.send(Self.setCap(bot.id, usd)) }
            }
            Button("Custom…") {
                capText = bot.dailyCapUsd.map { String($0) } ?? ""
                typingCap = true
            }
        } label: {
            HStack {
                Text("Daily cap").font(.ui(size: 16)).foregroundStyle(.white)
                Spacer()
                Text(Self.capLabel(bot)).font(.ui(size: 15)).foregroundStyle(Theme.secondary)
                Image(systemName: "chevron.up.chevron.down").font(.ui(size: 12, weight: .semibold)).foregroundStyle(Theme.tertiary)
            }
            .padding(16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A card in a profile: the bridge on the Mac speaks this app's protocol but predates this feature.
struct NeedsNewerBridge: View {
    let title: String
    let what: String

    var body: some View {
        CardSection(title: title) {
            Placeholder(text: "Update the bridge on your Mac to \(what).")
        }
    }
}
