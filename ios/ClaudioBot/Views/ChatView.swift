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
    /// Whether the newest message is far enough below the screen to offer a way back down.
    @State private var showsJump = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let bot = store.bots[botId] {
            let rows = Timeline.rows(store.conversations[botId]?.messages ?? [])
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        let opensRun = Timeline.opensRun(rows, at: index)
                        ChatRowView(row: row, bot: bot, onPeer: open, onExchange: openExchange, opensRun: opensRun)
                            .padding(.top, index == 0 ? 8 : opensRun ? 14 : Self.gap(between: rows[index - 1], and: row))
                            .transition(arrival)
                    }
                    ForEach(store.proposedFacts(by: bot)) { fact in
                        ProposedFactCard(bot: bot, fact: fact)
                            .padding(.top, 14)
                    }
                    if let spend = bot.spend, let cap = spend.limitUsd, spend.nearLimit {
                        SpendWarning(bot: bot, spend: spend, cap: cap, onChangeCap: openProfile)
                            .padding(.top, 14)
                    }
                    let working = GroupRules.typists(store.members(of: bot), line: ActivityLine.text(in: store, botId: botId))
                    // A group types through its members, so the row names the ones at work on it.
                    if bot.isGroup && bot.status == .working {
                        TypingRow(
                            avatars: working.isEmpty ? store.members(of: bot).prefix(1).map(\.avatar) : working.map(\.avatar),
                            text: GroupRules.typing(working.map(\.name))
                        )
                        .padding(.top, 14)
                        .transition(typing)
                    }
                    switch bot.status {
                    case .working where !bot.isGroup:
                        TypingRow(avatars: [bot.avatar])
                            .padding(.top, 14)
                            .transition(typing)
                        ActivityLine(botId: botId)
                    case .unavailable:
                        Text("Claude Code could not start on your Mac. Your messages wait, and the bridge keeps trying.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.tertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 24)
                            .padding(.top, 14)
                    case .parked:
                        Text("Parked. It waits for the usage limit or today's spending cap to reset.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.tertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 24)
                            .padding(.top, 14)
                    default:
                        EmptyView()
                    }
                }
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25), value: rows.count)
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25), value: bot.status)
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
            .onScrollGeometryChange(for: Bool.self) { Self.bottomGap($0) > 200 } action: { _, far in
                withAnimation(.easeOut(duration: 0.2)) { showsJump = far }
            }
            .overlay(alignment: .bottomTrailing) {
                if showsJump {
                    JumpToLatestButton(action: jumpToLatest)
                        .padding(.trailing, 16)
                        .padding(.bottom, 12)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.8)))
                }
            }
            .scrollDismissesKeyboard(.immediately)
            #if os(iOS)
            // Opening the keyboard is starting a reply, so the newest message rides up with it from wherever the
            // list was. Moving a scrolled-up list by the keyboard's height can't be done reliably mid-transition.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                followsBottom = true
                position.scrollTo(edge: .bottom)
            }
            // A tap on the conversation puts the keyboard away. Simultaneous, so links and options still take the tap.
            .simultaneousGesture(TapGesture().onEnded {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            })
            #endif
            .background(Theme.background)
            .safeAreaInset(edge: .top) {
                if OfflineBar.shows(store.connection) {
                    OfflineBar(state: store.connection)
                        .frame(maxWidth: 760)
                }
            }
            .composerBar {
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
            // The "/" menu and the connectors the "@" menu offers. A group has neither: its members answer.
            .task(id: store.has(.commands)) {
                if store.has(.commands), !bot.isGroup { client.send(.commands(botId: botId)) }
            }
            .task(id: store.has(.mentions) && store.has(.connectors)) {
                if store.has(.mentions), store.has(.connectors), !bot.isGroup { client.send(.connectors(botId: botId)) }
            }
        }
    }

    /// New rows fade up a few points; under Reduce Motion they only fade.
    private var arrival: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 8))
    }

    /// The typing avatar pops in from its corner and shrinks back into it when the turn ends.
    private var typing: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .scale(scale: 0.5, anchor: .bottomLeading).combined(with: .opacity),
            removal: .scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity)
        )
    }

    private func jumpToLatest() {
        followsBottom = true
        if reduceMotion {
            position.scrollTo(edge: .bottom)
        } else {
            withAnimation(.snappy(duration: 0.35)) { position.scrollTo(edge: .bottom) }
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

    /// An exchange with another bot opens what they said, on a bridge that serves it. Otherwise it opens that bot.
    private func openExchange(_ peer: Peer) {
        if case .bot(let id, _, _) = peer, store.has(.exchanges), store.bots[id] != nil {
            router.path.append(.botExchange(botId, peer: id))
        } else {
            open(peer)
        }
    }

    private func open(_ peer: Peer) {
        switch peer {
        case .agent(let id, _): router.path.append(.exchange(id))
        case .bot(let id, _, _): if store.bots[id] != nil { router.open(id) }
        case .routine(let id, _):
            if store.bots[botId]?.routines.contains(where: { $0.id == id }) == true {
                router.path.append(.routine(botId, id))
            } else {
                openProfile()
            }
        case .unknown: break
        }
    }
}

struct HeaderPill: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: 8) {
            BotAvatar(bot: bot, size: 26, motion: bot.motion)
            Text(bot.name)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            BotStatusChip(status: bot.status)
        }
        .padding(.leading, 6)
        .padding(.trailing, 14)
        .padding(.vertical, 6)
        .glass(in: Capsule())
    }
}

struct TypingRow: View {
    let avatars: [Avatar]
    var text = "Typing…"

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: -8) {
                ForEach(Array(avatars.prefix(3).enumerated()), id: \.offset) { _, avatar in
                    AvatarView(avatar: avatar, size: 28, motion: .working)
                }
            }
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.secondary)
                .shimmering()
        }
        .accessibilityElement(children: .combine)
    }
}

/// Takes the list back down to the newest message after the user scrolled up.
struct JumpToLatestButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .glass(in: Circle(), interactive: true)
                // The glass isn't hit-testable on its own, so without this a tap falls through to the list.
                .contentShape(Circle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Jump to latest message")
        .accessibilityIdentifier("jumpToLatest")
    }
}
