import SwiftUI

/// What a bot (agentId nil) or one of its agents is doing right now, from AppStore.activity. Shown when the bridge lists .activity.
struct ActivityLine: View {
    let botId: BotID
    var agentId: AgentID? = nil

    @Environment(AppStore.self) private var store

    /// The line this key shows, or nil when the bridge does not back activity or nothing is going on.
    static func text(in store: AppStore, botId: BotID, agentId: AgentID? = nil) -> String? {
        guard store.has(.activity) else { return nil }
        return store.activity[ActivityKey(botId: botId, agentId: agentId)]
    }

    var body: some View {
        if let text = Self.text(in: store, botId: botId, agentId: agentId) {
            Label {
                Text(text).lineLimit(1).truncationMode(.middle)
            } icon: {
                Image(systemName: "ellipsis").symbolEffect(.variableColor.iterative)
            }
            .font(.system(size: 13))
            .foregroundStyle(Theme.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: text)
            .accessibilityLabel(text)
        }
    }
}
