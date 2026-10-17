import SwiftUI

struct ChatView: View {
    let botId: BotID

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var position = ScrollPosition(edge: .bottom)
    /// Whether the list follows new content down. Dragging lets go; settling near the bottom or sending takes hold again.
    @State private var followsBottom = true

    var body: some View {
        if let bot = store.bots[botId] {
            let rows = Timeline.rows(store.conversations[botId]?.messages ?? [])
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        ChatRowView(row: row, bot: bot, onPeer: open)
                            .padding(.top, index == 0 ? 8 : Self.gap(between: rows[index - 1], and: row))
                    }
                    if bot.status == .working {
                        TypingRow(avatar: bot.avatar)
                            .padding(.top, 12)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom)
            .onScrollPhaseChange { _, phase, context in
                switch phase {
                case .interacting: followsBottom = false
                case .idle: if !followsBottom { followsBottom = Self.bottomGap(context.geometry) < 60 }
                default: break
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height + $0.contentInsets.bottom } action: { _, _ in
                if followsBottom { position.scrollTo(edge: .bottom) }
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.background)
            .safeAreaInset(edge: .bottom) {
                Composer(bot: bot, openQuestion: store.openQuestion(in: botId) != nil) {
                    followsBottom = true
                    withAnimation { position.scrollTo(edge: .bottom) }
                }
                    .frame(maxWidth: 760)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Button(action: openProfile) { HeaderPill(bot: bot) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(bot.name), view profile")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(action: openProfile) { Label("View Profile", systemImage: "person.crop.circle") }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("More")
                }
            }
        }
    }

    private static func bottomGap(_ geometry: ScrollGeometry) -> CGFloat {
        geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY
    }

    /// Bubbles in a run sit close together; anything else gets air around it.
    private static func gap(between previous: ChatRow, and row: ChatRow) -> CGFloat {
        switch (previous, row) {
        case (.message(.bot), .message(.bot)), (.message(.user), .message(.user)): 4
        case (.separator, _): 10
        case (_, .separator): 22
        default: 14
        }
    }

    private func openProfile() {
        if sizeClass == .regular {
            router.showingInspector.toggle()
        } else {
            router.path.append(.profile(botId))
        }
    }

    private func open(_ peer: Peer) {
        switch peer {
        case .agent(let id, _): router.path.append(.exchange(id))
        case .bot(let id, _, _): if store.bots[id] != nil { router.open(id) }
        case .routine: openProfile()
        case .unknown: break
        }
    }
}

struct HeaderPill: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: 8) {
            AvatarView(avatar: bot.avatar, size: 26, animated: bot.status == .working)
            Text(bot.name)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .padding(.leading, 6)
        .padding(.trailing, 14)
        .padding(.vertical, 6)
        .glass(in: Capsule())
    }
}

struct TypingRow: View {
    let avatar: Avatar

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(avatar: avatar, size: 28, animated: true)
            Text("Typing…")
                .font(.subheadline)
                .foregroundStyle(Theme.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
