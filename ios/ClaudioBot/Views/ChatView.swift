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
    @State private var reveal = Reveal()
    @State private var speech = ChatSpeech()

    var body: some View {
        if let bot = store.bots[botId] {
            let timeline = Timeline.rows(store.conversations[botId]?.messages ?? [])
            let paced = paced(timeline)
            let rows = paced.visible(timeline)
            // Typing stays up until the last held bubble lands, even if the turn already ended. Offline the Mac may
            // have stopped long ago, so the turn shows as last known instead.
            let typing = (bot.status == .working && store.showsOnline) || !paced.isCaughtUp
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        let opensRun = Timeline.opensRun(rows, at: index)
                        ChatRowView(row: row, bot: bot, onPeer: open, onExchange: openExchange, opensRun: opensRun)
                            .padding(.top, index == 0 ? 8 : opensRun ? Self.senderGap : Self.gap(between: rows[index - 1], and: row))
                            .transition(arrival)
                    }
                    ForEach(store.botSends(in: botId), id: \.clientId) { clientId, send in
                        SessionUserBubble(
                            text: send.pending.text, from: .user, queued: true, actions: undelivered(clientId, send), delivery: send.pending.state,
                            computer: store.computerName()
                        )
                        .padding(.top, Self.senderGap)
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
                    if bot.isGroup && typing {
                        TypingRow(
                            avatars: working.isEmpty ? store.members(of: bot).prefix(1).map(\.avatar) : working.map(\.avatar),
                            text: GroupRules.typing(working.map(\.name))
                        )
                        .padding(.top, 14)
                        .transition(typingTransition)
                    }
                    if typing && !bot.isGroup {
                        TypingRow(avatars: [bot.avatar])
                            .padding(.top, 14)
                            .transition(typingTransition)
                    }
                    switch bot.status {
                    case .working where !store.showsOnline:
                        Text(LastKnown.working)
                            .font(.ui(size: 13))
                            .foregroundStyle(Theme.tertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 14)
                    case .working where !bot.isGroup:
                        ActivityLine(botId: botId)
                    case .idle where bot.background != nil:
                        BackgroundLine(background: bot.background!, online: store.showsOnline)
                    case .unavailable:
                        Text("Claude Code could not start on \(store.computerName()). Your messages wait, and the bridge keeps trying.")
                            .font(.ui(size: 13))
                            .foregroundStyle(Theme.tertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 24)
                            .padding(.top, 14)
                    case .parked:
                        Text("Parked. It waits for the usage limit or today's spending cap to reset.")
                            .font(.ui(size: 13))
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
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25), value: typing)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .frame(maxWidth: Self.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .scrollPosition($position)
            .onChange(of: timeline.map(\.id), initial: true) { reveal.update(timeline, flush: reduceMotion) }
            .task(id: reveal.pending.first) {
                guard !reveal.isCaughtUp else { return }
                do { try await Task.sleep(for: Self.beat) } catch { return }
                reveal.step()
            }
            .defaultScrollAnchor(.bottom)
            .onScrollPhaseChange { _, phase, context in
                switch phase {
                case .interacting: followsBottom = false
                case .idle: if !followsBottom { followsBottom = Self.bottomGap(context.geometry) < 60 }
                default: break
                }
            }
            // New content glides the list up with the bubble's own fade. An inset change (the keyboard, a taller
            // composer) already animates, so the list snaps to keep up with it.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                guard followsBottom else { return }
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { position.scrollTo(edge: .bottom) }
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, _ in
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
            .topBar {
                if !store.showsOnline {
                    OfflineBar()
                        .frame(maxWidth: Self.readableWidth)
                }
            }
            .composerBar {
                Composer(bot: bot, openQuestion: store.openQuestion(in: botId) != nil) {
                    reveal.flush()
                    followsBottom = true
                    if reduceMotion {
                        position.scrollTo(edge: .bottom)
                    } else {
                        withAnimation { position.scrollTo(edge: .bottom) }
                    }
                }
                    .frame(maxWidth: Self.readableWidth)
            }
            .navigationBarTitleDisplayMode(.inline)
            #if os(macOS)
            // Names the window in the Window menu and Mission Control. The toolbar shows the pill, not this title.
            .navigationTitle(bot.name)
            #endif
            .toolbar {
                #if os(macOS)
                // The pill brings its own glass, so the toolbar's shared glass behind it would double it.
                ToolbarItem(placement: .principal) {
                    Button(action: openProfile) { HeaderPill(bot: bot) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(bot.name), view profile")
                        .help("Show \(bot.name)'s Profile")
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .primaryAction) {
                    Button(action: openProfile) {
                        Label(router.showingInspector ? "Hide Profile" : "Show Profile", systemImage: "sidebar.trailing")
                    }
                    .help(router.showingInspector ? "Hide Profile" : "Show Profile")
                }
                #else
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
                #endif
            }
            // The "/" menu and the connectors the "@" menu offers. A group has neither: its members answer.
            .task(id: store.has(.commands)) {
                if store.has(.commands), !bot.isGroup { client.send(.commands(botId: botId)) }
            }
            .task(id: store.has(.mentions) && store.has(.connectors)) {
                if store.has(.mentions), store.has(.connectors), !bot.isGroup { client.send(.connectors(botId: botId)) }
            }
            .onChange(of: store.conversations[botId]?.messages.map(\.id)) { old, new in
                guard let messages = store.conversations[botId]?.messages, new != nil else { return }
                speech.arrived(ChatAnnouncement.arrivals(from: old, to: messages, bot: bot.name) { store.bots[$0]?.name })
            }
            .onChange(of: bot.status) { old, new in
                speech.status(from: old, to: new, bot: bot.name)
            }
        }
    }

    /// New rows fade up a few points; under Reduce Motion they only fade.
    private var arrival: AnyTransition {
        // The fade waits for the rows below to slide out of the way, so the typing row never draws through it.
        reduceMotion ? .opacity : .asymmetric(
            insertion: .opacity.animation(.easeOut(duration: 0.2).delay(0.1)).combined(with: .offset(y: 8)),
            removal: .opacity
        )
    }

    /// The reveal with this render's rows taken in, so a frame never draws a row the pacer is about to hold back.
    private func paced(_ timeline: [ChatRow]) -> Reveal {
        var next = reveal
        next.update(timeline, flush: reduceMotion)
        return next
    }

    /// Time between the bubbles of a burst.
    private static let beat = Duration.milliseconds(180)

    /// The typing avatar pops in from its corner and shrinks back into it when the turn ends.
    private var typingTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .scale(scale: 0.5, anchor: .bottomLeading).combined(with: .opacity),
            removal: .scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity)
        )
    }

    private func jumpToLatest() {
        reveal.flush()
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

    /// The transcript's column with its 16 pt gutters. A Mac window is wider, so its column grows to 960.
    #if os(macOS)
    static let readableWidth: CGFloat = 960 + 32
    private static let senderGap: CGFloat = 16
    #else
    static let readableWidth: CGFloat = 760
    private static let senderGap: CGFloat = 14
    #endif

    /// Bubbles in a run sit close together; anything else gets air around it.
    private static func gap(between previous: ChatRow, and row: ChatRow) -> CGFloat {
        switch (previous, row) {
        case (.message(.bot), .message(.bot)), (.message(.user), .message(.user)): 4
        case (.separator, _): 10
        case (_, .separator): 22
        default: senderGap
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
    /// Until the Mac shows a send back it is this phone's alone: send the same frame again, so it runs once, or give it up.
    private func undelivered(_ clientId: String, _ send: BotSend) -> SessionUserBubble.Actions? {
        switch send.pending.state {
        case .unechoed, .notSent: .undelivered(retry: { client.send(send.message) }, discard: { client.discard(botSend: clientId) })
        case .waiting, .sending: nil
        }
    }

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
    @Environment(AppStore.self) private var store

    #if os(macOS)
    private static let avatar: CGFloat = 22
    private static let height: CGFloat = 40
    private static let weight = Font.Weight.medium
    /// Clickable glass answers the pointer, the way the toolbar's own buttons do.
    private static let interactive = true
    #else
    private static let interactive = false
    private static let avatar: CGFloat = 26
    private static let height: CGFloat = 38
    private static let weight = Font.Weight.semibold
    #endif

    var body: some View {
        HStack(spacing: 8) {
            BotAvatar(bot: bot, size: Self.avatar, motion: store.motion(of: bot))
            Text(bot.name)
                .font(.ui(size: 17, weight: Self.weight))
                .foregroundStyle(.white)
                .lineLimit(1)
            BotStatusChip(status: bot.status)
        }
        .padding(.leading, (Self.height - Self.avatar) / 2)
        .padding(.trailing, 14)
        .frame(height: Self.height)
        .glass(in: Capsule(), interactive: Self.interactive)
        .contentShape(Capsule())
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
                .font(.ui(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .glass(in: Circle(), interactive: true)
                // A fingertip around the circle. The glass isn't hit-testable on its own, so without this a tap falls
                // through to the list.
                .frame(width: HitTarget.minHeight, height: HitTarget.minHeight)
                .contentShape(Circle())
        }
        .buttonStyle(.pressable)
        .help("Jump to Latest")
        .accessibilityLabel("Jump to latest message")
        .accessibilityIdentifier("jumpToLatest")
    }
}

/// What VoiceOver hears as a bot's chat changes, as the Sessions thread speaks its own (F-AR-003, F-AR-013).
enum ChatAnnouncement {
    /// More new messages than this at once (a reconnect catching up) are counted rather than read.
    static let readable = 3

    /// What the messages `new` has that `old` did not say. old nil: the chat just loaded, so nothing in it is news.
    /// The user's own messages, exchanges and cards that arrive already closed say nothing. told: a note or an open
    /// card among them already says how the turn stands.
    static func arrivals(from old: [MessageID]?, to new: [Message], bot: String, member: (BotID) -> String?) -> (lines: [String], told: Bool) {
        guard let old else { return ([], false) }
        let seen = Set(old)
        let fresh = new.filter { !seen.contains($0.id) }
        let lines = fresh.compactMap { line($0, bot: bot, member: member) }
        let tells = fresh.filter {
            switch $0 {
            case .note: true
            case .question, .permission: line($0, bot: bot, member: member) != nil
            default: false
            }
        }
        guard lines.count > readable else { return (lines, !tells.isEmpty) }
        let cards = tells.compactMap { m -> String? in
            if case .note = m { return nil }
            return line(m, bot: bot, member: member)
        }
        return (["\(lines.count) new messages."] + cards, !tells.isEmpty)
    }

    static func line(_ message: Message, bot: String, member: (BotID) -> String?) -> String? {
        switch message {
        case let .bot(_, _, text, from):
            let name = from.flatMap(member) ?? bot
            return "\(name): \(cut(text))"
        case let .question(_, _, card) where card.answer == nil:
            return "Question from \(bot): \(card.question)"
        case let .permission(_, _, card) where card.answer == nil:
            let asker = card.from?.label ?? bot
            return "Approval needed. \(asker) wants to run \(card.tool)" + (OpenCard.firstLine(card.detail).map { ": " + $0 } ?? ".")
        case let .note(_, _, text, _):
            return text
        default:
            return nil
        }
    }

    /// The turn came to rest. A note or card since it began already said how it ended, so only a quiet end is spoken.
    static func turnEnded(from old: BotStatus, to new: BotStatus, bot: String, told: Bool) -> String? {
        guard old == .working, new == .idle, !told else { return nil }
        return "\(bot) finished."
    }

    private static func cut(_ text: String, limit: Int = 300) -> String {
        text.count <= limit ? text : String(text.prefix(limit)) + "…"
    }
}

/// Speaks a bot chat's ChatAnnouncement lines, at the Sessions thread's pace.
@MainActor
final class ChatSpeech {
    private let announcer = Announcer()
    /// A note or card was spoken since the turn began.
    private var told = false
    private var resting: Task<Void, Never>?

    func arrived(_ news: (lines: [String], told: Bool)) {
        if news.told { told = true }
        guard !news.lines.isEmpty else { return }
        announcer.post(news.lines.joined(separator: " "))
    }

    func status(from old: BotStatus, to new: BotStatus, bot: String) {
        if new == .working { told = false }
        resting?.cancel()
        // The note that says how a turn ended can land just after the status does.
        resting = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, !Task.isCancelled else { return }
            if let line = ChatAnnouncement.turnEnded(from: old, to: new, bot: bot, told: told) { announcer.post(line) }
        }
    }
}

/// Under the chat while work the bot started runs on after its turn: what runs, for how long, and that Stop ends it.
private struct BackgroundLine: View {
    let background: BotBackground
    let online: Bool

    var body: some View {
        Group {
            if online {
                Text(background.text) + Text(" · ") + Text(background.since, style: .timer).monospacedDigit() + Text(". Stop ends it.")
            } else {
                Text(LastKnown.background)
            }
        }
        .font(.ui(size: 13))
        .foregroundStyle(Theme.tertiary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.top, 14)
    }
}
