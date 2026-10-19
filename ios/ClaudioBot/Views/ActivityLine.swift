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

    /// The animation sits on a Group outside the `if`, so the line fades in and out, not only between texts. A Group adds no
    /// view of its own, so an empty line takes no slot in the parent stack's spacing.
    var body: some View {
        let text = Self.text(in: store, botId: botId, agentId: agentId)
        Group {
            if let text {
            Label {
                Text(text).lineLimit(1).truncationMode(.middle)
            } icon: {
                Image(systemName: "ellipsis").symbolEffect(.variableColor.iterative)
            }
            .font(.ui(size: 13))
            .foregroundStyle(Theme.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
            .transition(.opacity)
            .accessibilityLabel(text)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: text)
    }
}
