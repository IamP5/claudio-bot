import SwiftUI

/// Sidebar, chat and (on iPad) the profile inspector. On iPhone it collapses to list, chat, profile.
struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
