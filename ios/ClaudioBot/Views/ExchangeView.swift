import SwiftUI

/// What a bot and one of its agents said to each other, opened from an exchange line or the Agents tab.
struct ExchangeView: View {
    let agentId: AgentID

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        let thread = store.agents[agentId]
        let bot = thread.flatMap { store.bots[$0.agent.botId] }
        Group {
            if let thread {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(thread.messages) { message in
                            bubble(message, color: bot?.avatar.color ?? .white)
                        }
                        status(thread.agent)
                            .padding(.top, 10)
                    }
                    .padding(16)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
                .defaultScrollAnchor(.bottom)
                .safeAreaInset(edge: .bottom) { actions(thread.agent) }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    if let bot {
                        AvatarView(avatar: bot.avatar, size: 20)
                        Text(bot.name).fontWeight(.semibold)
                    }
                    Image(systemName: "arrow.left.arrow.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                    Image(systemName: "gearshape.fill").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    Text(thread?.agent.title ?? "Agent").lineLimit(1).truncationMode(.tail)
                }
                .font(.system(size: 15))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .frame(maxWidth: 280)
            }
        }
        .onAppear { client.send(.agent(agentId: agentId)) }
    }

    private func bubble(_ message: AgentMessage, color: AvatarColor) -> some View {
        let fromBot = message.from == .bot
        return HStack(spacing: 0) {
            if fromBot { Spacer(minLength: 48) }
            MarkdownText(text: message.text)
                .font(.system(size: 16))
                .foregroundStyle(fromBot ? color.onAccent : .white)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(fromBot ? color.accent : Theme.bubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            if !fromBot { Spacer(minLength: 48) }
        }
    }

    private func status(_ agent: Agent) -> some View {
        HStack(spacing: 8) {
            AgentStatusPill(status: agent.status)
            Text("\(agent.projectName) on \(agent.where == .cloud ? "the cloud" : "your Mac")")
                .font(.system(size: 13))
                .foregroundStyle(Theme.tertiary)
        }
        .frame(maxWidth: .infinity)
    }

    private func actions(_ agent: Agent) -> some View {
        HStack(spacing: 12) {
            if agent.status == .working {
                Button { client.send(.stopAgent(agentId: agent.id)) } label: {
                    Label("Stop", systemImage: "stop.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .glass(in: Capsule())
                        .foregroundStyle(Theme.danger)
                }
            }
            if let url = agent.url {
                Button { openURL(url) } label: {
                    Label("Open in Claude", systemImage: "arrow.up.right.square")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.white, in: Capsule())
                        .foregroundStyle(.black)
                }
            }
            Button { dismiss() } label: {
                Text("Close")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .glass(in: Capsule())
                    .foregroundStyle(.white)
            }
        }
        .font(.system(size: 16, weight: .semibold))
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: 560)
    }
}
