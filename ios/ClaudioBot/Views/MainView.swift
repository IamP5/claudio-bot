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
            // A plain column rather than .inspector: on iPad portrait the inspector covers and dims the chat.
            HStack(spacing: 0) {
                DetailStack()
                if let id = inspectorBot {
                    Rectangle().fill(Theme.hairline).frame(width: 1).ignoresSafeArea()
                    NavigationStack { ProfileView(botId: id) }
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

    private var nothingSelected: some View {
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
