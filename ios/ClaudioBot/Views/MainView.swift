import SwiftUI

/// Sidebar, chat and (on iPad) the profile inspector. On iPhone it collapses to list, chat, profile.
struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    #if DEBUG
    @State private var visibility: NavigationSplitViewVisibility = Demo.showsAllColumns ? .all : .automatic
    #else
    @State private var visibility: NavigationSplitViewVisibility = .automatic
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether each bot has an open question. A bot that gains one buzzes; bots arriving in a snapshot do not.
    private var asking: [BotID: Bool] {
        store.bots.mapValues { $0.question != nil }
    }

    /// iPad only, and only beside a bot's chat. On iPhone the profile is pushed instead.
    private var inspectorBot: BotID? {
        guard sizeClass == .regular, router.showingInspector, let bot = router.selection?.bot, store.bots[bot] != nil else { return nil }
        return bot
    }

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility) {
            SidebarRoot()
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
        } detail: {
            // A plain column rather than .inspector: on iPad portrait the inspector covers and dims the chat.
            HStack(spacing: 0) {
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
                            ContentUnavailableView(
                                router.sidebar == .sessions ? "No session selected" : "No chat selected",
                                systemImage: router.sidebar == .sessions ? "chevron.left.forwardslash.chevron.right" : "bubble.left.and.bubble.right",
                                description: Text(router.sidebar == .sessions
                                    ? "Pick a session, or tap + to start one in a project."
                                    : "Pick a bot, or tap + to start a chat.")
                            )
                            .foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Theme.background)
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
                if let id = inspectorBot {
                    Rectangle().fill(Theme.hairline).frame(width: 1).ignoresSafeArea()
                    NavigationStack { ProfileView(botId: id) }
                        .frame(width: 380)
                        .transition(reduceMotion ? .opacity : .move(edge: .trailing))
                }
            }
            .animation(.snappy, value: inspectorBot)
        }
        .sheet(isPresented: $router.showingNewChat) { NewChatView() }
        .sheet(item: $router.newSession) { NewSessionSheet(projectId: $0.projectId) }
        .sheet(isPresented: $router.showingSettings) { SettingsView() }
        .sheet(isPresented: $router.showingUsage) { PlanUsageView() }
        .sensoryFeedback(.warning, trigger: asking) { old, new in
            new.contains { id, asks in asks && old[id] == false }
        }
    }
}
