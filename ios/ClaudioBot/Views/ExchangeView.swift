import SwiftUI

/// What a bot said with one of its agents, or with another bot, opened from an exchange line or the Agents tab.
struct ExchangeView: View {
    enum Subject: Hashable {
        case agent(AgentID)
        case bots(BotID, peer: BotID)
    }

    let subject: Subject

    init(agentId: AgentID) {
        subject = .agent(agentId)
    }

    init(botId: BotID, peer: BotID) {
        subject = .bots(botId, peer: peer)
    }

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            switch subject {
            case .agent(let agentId): agentThread(agentId)
            case let .bots(botId, peer): botThread(botId, peer: peer)
            }
        }
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { breadcrumb }
        }
        .onAppear {
            switch subject {
            case .agent(let agentId): client.send(.agent(agentId: agentId))
            case let .bots(botId, peer): client.send(.exchange(botId: botId, peer: peer))
            }
        }
    }

    /// "engineer ⇄ Add checkout smoke tests", or "bot maker ⇄ standup notes". A bot's name opens its chat.
    private var breadcrumb: some View {
        HStack(spacing: 6) {
            switch subject {
            case .agent(let agentId):
                let thread = store.agents[agentId]
                if let bot = thread.flatMap({ store.bots[$0.agent.botId] }) { botCrumb(bot) }
                Image(systemName: "arrow.left.arrow.right").font(.ui(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                Image(systemName: "gearshape.fill").font(.ui(size: 12)).foregroundStyle(Theme.secondary)
                Text(thread?.agent.title ?? "Agent").lineLimit(1).truncationMode(.tail)
            case let .bots(botId, peer):
                if let bot = store.bots[botId] { botCrumb(bot) }
                Image(systemName: "arrow.left.arrow.right").font(.ui(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                if let other = store.bots[peer] { botCrumb(other) }
            }
        }
        .font(.ui(size: 15))
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .frame(maxWidth: 300)
    }

    private func botCrumb(_ bot: Bot) -> some View {
        Button { router.open(bot.id) } label: {
            HStack(spacing: 6) {
                AvatarView(avatar: bot.avatar, size: 20)
                Text(bot.name).fontWeight(.semibold).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(bot.name)")
    }

    @ViewBuilder
    private func botThread(_ botId: BotID, peer: BotID) -> some View {
        if let messages = store.exchanges[ExchangeKey(botId: botId, peer: peer)] {
            let rows = Timeline.rows(messages.map(\.asMessage))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty { Placeholder(text: "Nothing between them yet.") }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        let opensRun = Timeline.opensRun(rows, at: index)
                        Group {
                            switch row {
                            case .separator(let date):
                                TimeSeparator(date: date)
                            case let .message(.bot(_, _, text, from)):
                                MemberBubble(sender: from.flatMap { store.bots[$0] }, text: text, opensRun: opensRun) { router.open($0) }
                            case .message:
                                EmptyView()
                            }
                        }
                        .padding(.top, index == 0 ? 8 : opensRun ? 14 : row.isSeparator ? 22 : 4)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            #if os(iOS)
            .safeAreaInset(edge: .bottom) { closeBar { EmptyView() } }
            #endif
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func agentThread(_ agentId: AgentID) -> some View {
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
                        ActivityLine(botId: thread.agent.botId, agentId: thread.agent.id)
                        AgentEvidenceSection(agent: thread.agent)
                    }
                    .padding(16)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
                .defaultScrollAnchor(.bottom)
                #if os(macOS)
                .toolbar { agentToolbar(thread.agent) }
                #else
                .safeAreaInset(edge: .bottom) { actions(thread.agent) }
                #endif
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func bubble(_ message: AgentMessage, color: AvatarColor) -> some View {
        let fromBot = message.from == .bot
        return HStack(spacing: 0) {
            if fromBot { Spacer(minLength: 48) }
            MarkdownText(text: message.text, fillsWidth: Bubble.fillsWidth)
                .font(.ui(size: 16))
                .bubbleText()
                .foregroundStyle(fromBot ? color.onAccent : .white)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Bubble.padding)
                .background(fromBot ? color.accent : Theme.bubble, in: Bubble.shape)
            if !fromBot { Spacer(minLength: 48) }
        }
        .bubbleRow(fromBot ? .trailing : .leading)
    }

    #if os(macOS)
    /// On a Mac, Back and ⌘[ already close the thread, so the agent's actions sit in the toolbar.
    @ToolbarContentBuilder
    private func agentToolbar(_ agent: Agent) -> some ToolbarContent {
        if agent.status == .working {
            ToolbarItem(placement: .primaryAction) {
                Button("Stop", systemImage: "stop.fill") { client.send(.stopAgent(agentId: agent.id)) }
                    .help("Stop the Agent")
            }
        }
        if let url = agent.url {
            ToolbarItem(placement: .primaryAction) {
                Button("Open in Claude", systemImage: "arrow.up.right.square") { openURL(url) }
                    .help("Open in Claude")
            }
        }
    }
    #endif

    private func status(_ agent: Agent) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                AgentStatusPill(status: agent.status)
                Text("\(agent.projectName) on \(agent.where == .cloud ? "the cloud" : "your Mac")")
                    .font(.ui(size: 13))
                    .foregroundStyle(Theme.tertiary)
            }
            if let line = Self.spendLine(agent) {
                Text(line)
                    .font(.ui(size: 13).monospacedDigit())
                    .foregroundStyle(agent.spend?.nearLimit == true ? Theme.attention : Theme.tertiary)
            }
            if agent.where == .mac, store.lacks(.worktrees) {
                Text("Update the bridge on your Mac to see what this agent changed in git.")
                    .font(.ui(size: 13))
                    .foregroundStyle(Theme.tertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// Cloud agents run on claude.ai, which the bridge does not meter, so they have no line.
    static func spendLine(_ agent: Agent) -> String? {
        guard let spend = agent.spend else { return nil }
        guard let budget = spend.limitUsd else { return "Spent \(spend.text)" }
        return spend.reached ? "Used its \(Money.text(budget)) budget" : "Spent \(spend.text) budget"
    }

    #if os(iOS)
    private func actions(_ agent: Agent) -> some View {
        closeBar {
            if agent.status == .working {
                Button { client.send(.stopAgent(agentId: agent.id)) } label: {
                    Label("Stop", systemImage: "stop.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .glass(in: Capsule())
                        .contentShape(Capsule())
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
        }
    }

    /// The buttons under a thread, ending with Close Chat.
    private func closeBar<Leading: View>(@ViewBuilder _ leading: () -> Leading) -> some View {
        HStack(spacing: 12) {
            leading()
            Button { dismiss() } label: {
                Text("Close Chat")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .glass(in: Capsule())
                    // The glass isn't hit-testable on its own, so without this only the word takes a tap.
                    .contentShape(Capsule())
                    .foregroundStyle(.white)
            }
        }
        .font(.ui(size: 16, weight: .semibold))
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: 560)
    }
    #endif
}
