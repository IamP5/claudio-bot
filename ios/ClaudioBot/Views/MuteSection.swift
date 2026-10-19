import SwiftUI

/// The bot's mute switch in its profile. Shown when the bridge lists .mute.
struct MuteSection: View {
    let bot: Bot
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client

    var body: some View {
        if store.has(.mute) {
            CardSection(title: "Notifications", footer: "Muted Bots still notify you when they need an answer.") {
                // Label and switch laid out by hand: outside a Form a Mac toggle is a checkbox beside its label.
                HStack(spacing: 12) {
                    Text("Mute updates").font(.ui(size: 16)).foregroundStyle(.white)
                    Spacer(minLength: 0)
                    Toggle("Mute updates", isOn: Binding(
                        get: { bot.muted },
                        set: { client.send(.updateBot(botId: bot.id, patch: BotPatch(muted: $0))) }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .tint(AvatarColor.teal.color)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        } else if store.lacks(.mute) {
            NeedsNewerBridge(title: "Notifications", what: "mute this Bot's updates")
        }
    }
}
