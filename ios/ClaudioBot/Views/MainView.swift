import SwiftUI

/// Sidebar, chat and (on iPad) the profile inspector. On iPhone it collapses to list, chat, profile.
struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(macOS)
    @State private var windowWidth: CGFloat = 0
    @State private var sidebarWidth: CGFloat = 0
    /// The sidebar's visibility before it was hidden to make room, to give back once the chat has room beside it.
    @State private var columnsBeforeHiding: NavigationSplitViewVisibility?
    /// The split view lays the chat out no narrower than this (measured), and neither a narrower window (a
    /// half-screen tile) nor opening the profile shrinks the sidebar or hides it on its own: the columns run past
    /// the window's edges.
    private static let chatMinimum: CGFloat = 470
    private static let profileWidth: CGFloat = 320
    #endif

    /// Whether each bot has an open question. A bot that gains one buzzes; bots arriving in a snapshot do not.
    private var asking: [BotID: Bool] {
        store.bots.mapValues { $0.question != nil }
    }

    /// Mac and iPad only, and only beside a bot's chat. On iPhone the profile is pushed instead.
    private var inspectorBot: BotID? {
        guard sizeClass == .regular, router.showingInspector, let bot = router.selection?.bot, store.bots[bot] != nil else { return nil }
        return bot
    }

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $router.columns) {
            SidebarRoot()
                #if os(macOS)
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 400)
                // A hidden sidebar keeps the width it comes back at.
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if $0 > 0 { sidebarWidth = $0 } }
                #else
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
                #endif
        } detail: {
            #if os(macOS)
            // The profile pushes onto the chat's stack, so it gets no stack of its own: a second stack in the
            // detail column makes SwiftUI compare the two stacks' paths on the next push, and that traps.
            DetailStack()
                .inspector(isPresented: Binding(get: { inspectorBot != nil }, set: { router.showingInspector = $0 })) {
                    if let id = inspectorBot {
                        ProfileView(botId: id)
                            // The inspector has a toolbar of its own, so the profile's Pin and Hide menu belongs in
                            // it, as it does when the profile is pushed.
                            .environment(\.horizontalSizeClass, .compact)
                            .inspectorColumnWidth(min: 280, ideal: 320, max: 440)
                    }
                }
            #else
            // A plain column rather than .inspector: on iPad portrait the inspector covers and dims the chat. Like the
            // Mac's inspector, it gets no stack of its own: the profile pushes onto the chat's.
            HStack(spacing: 0) {
                DetailStack()
                if let id = inspectorBot {
                    Rectangle().fill(Theme.hairline).frame(width: 1).ignoresSafeArea()
                    ProfileView(botId: id)
                        .frame(width: 380)
                        .transition(reduceMotion ? .opacity : .move(edge: .trailing))
                }
            }
            .animation(.snappy, value: inspectorBot)
            #endif
        }
        #if os(macOS)
        // The window's width: the split view itself stays as wide as its columns need, past the window's edges.
        .frame(minWidth: 0, maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
        // Once the width settles: mid-tile it jumps between the old and new sizes, and a sidebar shown then grows
        // the window, which untiles it.
        .task(id: windowWidth) {
            guard (try? await Task.sleep(for: .milliseconds(300))) != nil else { return }
            makeRoomForChat()
        }
        .onChange(of: inspectorBot != nil, initial: true) { makeRoomForChat() }
        #endif
        #if DEBUG && os(iOS)
        .environment(\.horizontalSizeClass, Demo.forcesWide ? .regular : sizeClass)
        #endif
        .sheet(isPresented: $router.showingNewChat) { NewChatView() }
        .sheet(item: $router.newSession) { NewSessionSheet(projectId: $0.projectId) }
        #if os(iOS)
        .sheet(isPresented: $router.showingSettings) { SettingsView() }
        #endif
        .sheet(isPresented: $router.showingUsage) { PlanUsageView() }
        .sensoryFeedback(.warning, trigger: asking) { old, new in
            new.contains { id, asks in asks && old[id] == false }
        }
    }

    #if os(macOS)
    /// Grok Bot's rule: a chat (and profile) with no room beside the sidebar hides it, and it comes back once they
    /// fit beside it again, when the profile closes or the window widens. Showing it while they don't fit would grow
    /// the window, and so untile it.
    private func makeRoomForChat() {
        guard windowWidth > 0 else { return }
        let fits = windowWidth >= sidebarWidth + Self.chatMinimum + (inspectorBot == nil ? 0 : Self.profileWidth)
        if let columns = columnsBeforeHiding {
            if fits {
                router.columns = columns
                columnsBeforeHiding = nil
            }
        } else if router.columns != .detailOnly, !fits {
            columnsBeforeHiding = router.columns
            router.columns = .detailOnly
        }
    }
    #endif
}

/// The chat or session a window shows, with the screens pushed over it. The main window puts it beside the sidebar;
/// a Mac window opened for one chat or session shows it alone.
struct DetailStack: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            Group {
                switch router.selection {
                case .bot(let id) where store.bots[id] != nil:
                    ChatView(botId: id)
                        .id(id)
                case .session(let id):
                    SessionThreadView(sessionId: id)
                        .id(id)
                default:
                    if router.hasSidebar { nothingSelected } else { gone }
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .profile(let bot, let tab): ProfileView(botId: bot, tab: tab)
                case .exchange(let agent): ExchangeView(agentId: agent)
                case .botExchange(let bot, let peer): ExchangeView(botId: bot, peer: peer)
                case .file(let bot, let path): FileView(botId: bot, path: path)
                case .routine(let bot, let routine): RoutineView(botId: bot, routineId: routine)
                }
            }
        }
    }

    /// The Sessions side with nothing chosen: what runs or waits elsewhere, or, before the first list or with the Mac out
    /// of reach, that the app is waiting for the Mac rather than that nothing runs (F-SES-311).
    @ViewBuilder
    private var nothingSelected: some View {
        let freshness = store.sessions.freshness(online: store.showsOnline)
        let atWork = SessionsAtWork(store.sessions.rows.values, freshness: freshness)
        if router.sidebar != .sessions {
            nothingToShow
        } else if !atWork.isEmpty {
            SessionsAtWorkView(atWork: atWork)
        } else if store.sessions.loaded, freshness == .live {
            nothingToShow
        } else {
            waitingForMac(since: store.sessions.updatedAt)
        }
    }

    private func waitingForMac(since: Date?) -> some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            ContentUnavailableView(
                "Waiting for your Mac",
                systemImage: "desktopcomputer",
                description: Text(since.map { SessionText.updated($0, now: context.date) + ". Nothing ran or waited on you then." }
                    ?? "Your sessions show once your Mac answers.")
            )
        }
        .foregroundStyle(Theme.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }

    private var nothingToShow: some View {
        ContentUnavailableView(
            router.sidebar == .sessions ? "No session selected" : "No chat selected",
            systemImage: router.sidebar == .sessions ? "chevron.left.forwardslash.chevron.right" : "bubble.left.and.bubble.right",
            description: Text(router.sidebar == .sessions
                ? "Pick a session, or \(ThisDevice.tapVerb) + to start one in a project."
                : "Pick a bot, or \(ThisDevice.tapVerb) + to start a chat.")
        )
        .foregroundStyle(Theme.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }

    private var gone: some View {
        ContentUnavailableView("This conversation is gone", systemImage: "questionmark.bubble")
            .foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
    }
}

/// A wide layout's detail pane with no session chosen: the sessions that run, wait on the user, broke or were stopped,
/// one button each. A list the Mac no longer answers for says how old it is, and its working rows wear no ring.
struct SessionsAtWorkView: View {
    let atWork: SessionsAtWork
    @Environment(Router.self) private var router

    var body: some View {
        // Live clocks tick each second; a kept list's only moving part is its age.
        ScrollView {
            TimelineView(.periodic(from: .now, by: atWork.freshness == .live ? 1 : 30)) { context in
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(atWork.summary(now: context.date) ?? "")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.white)
                        if case .asOf(let since) = atWork.freshness {
                            Text(SessionText.updated(since, now: context.date) + ". Rows show what your Mac said then.")
                                .font(.footnote)
                                .foregroundStyle(Theme.secondary)
                        } else if let running = atWork.runningTotal {
                            Text(running + " running")
                                .font(.footnote)
                                .foregroundStyle(Theme.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(atWork.spoken(now: context.date) ?? "")
                    .accessibilityAddTraits(.isHeader)
                    VStack(spacing: 0) {
                        ForEach(atWork.entries) { entry in
                            button(entry, now: context.date)
                            if entry.id != atWork.entries.last?.id { Rectangle().fill(Theme.hairline).frame(height: 1) }
                        }
                    }
                    .padding(.horizontal, 14)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
        }
        .background(Theme.background)
    }

    private func button(_ entry: SessionsAtWork.Entry, now: Date) -> some View {
        Button { router.open(.session(entry.id)) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                mark(entry.kind).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.row.title).font(.body).foregroundStyle(.white)
                    Text(atWork.line(entry, now: now))
                        .font(.footnote)
                        .foregroundStyle(tone(entry.kind))
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.tertiary)
            }
            .padding(.vertical, 10)
            .frame(minHeight: HitTarget.minHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(entry.row.title + ", " + Self.word(entry.kind) + ", " + atWork.line(entry, now: now, spoken: true))
        .accessibilityHint("Opens the session")
    }

    /// Each kind has its own symbol, so none is color alone. Only a live working row spins.
    @ViewBuilder
    private func mark(_ kind: SessionsAtWork.Kind) -> some View {
        switch kind {
        case .needsYou: Image(systemName: "hand.raised").foregroundStyle(Theme.attention)
        case .working: WorkingRing(size: 12)
        case .lastKnownWorking: Image(systemName: "clock").foregroundStyle(Theme.secondary)
        case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger)
        case .stopped: Image(systemName: "stop.circle").foregroundStyle(Theme.secondary)
        }
    }

    private func tone(_ kind: SessionsAtWork.Kind) -> Color {
        switch kind {
        case .needsYou: Theme.attention
        case .failed: Theme.danger
        case .working, .lastKnownWorking, .stopped: Theme.secondary
        }
    }

    private static func word(_ kind: SessionsAtWork.Kind) -> String {
        switch kind {
        case .needsYou: "needs you"
        case .working: "working"
        case .lastKnownWorking: "last known"
        case .failed: "failed"
        case .stopped: "stopped"
        }
    }
}
