import SwiftUI

/// What a bot (agentId nil) or one of its agents is doing right now, from AppStore.activity. Shown when the bridge lists .activity.
struct ActivityLine: View {
    let botId: BotID
    var agentId: AgentID? = nil

    var body: some View {
        EmptyView()
    }
}
