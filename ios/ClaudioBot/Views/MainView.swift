import SwiftUI

/// Sidebar, chat and (on iPad) the profile inspector. On iPhone it collapses to list, chat, profile.
struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var visibility: NavigationSplitViewVisibility = .automatic
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Whether each bot has an open question. A bot that gains one buzzes; bots arriving in a snapshot do not.
    private var asking: [BotID: Bool] {
        store.bots.mapValues { $0.question != nil }
    }

    /// iPad only. On iPhone the profile is pushed instead.
    private var inspectorShown: Bool {
        sizeClass == .regular && router.showingInspector && router.selection != nil
    }

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility) {
            HomeView()
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
        } detail: {
            // A plain column rather than .inspector: on iPad portrait the inspector covers and dims the chat.
            HStack(spacing: 0) {
                NavigationStack(path: $router.path) {
                    Group {
                        if let id = router.selection, store.bots[id] != nil {
                            ChatView(botId: id)
                                .id(id)
                        } else {
                            ContentUnavailableView(
                                "No chat selected", systemImage: "bubble.left.and.bubble.right",
                                description: Text("Pick a bot, or tap + to start a chat.")
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
                if inspectorShown, let id = router.selection {
                    Rectangle().fill(Theme.hairline).frame(width: 1).ignoresSafeArea()
                    NavigationStack { ProfileView(botId: id) }
                        .frame(width: 380)
                        .transition(reduceMotion ? .opacity : .move(edge: .trailing))
                }
            }
            .animation(.snappy, value: inspectorShown)
        }
        .sheet(isPresented: $router.showingNewChat) { NewChatView() }
        .sheet(isPresented: $router.showingSettings) { SettingsView() }
        .sensoryFeedback(.warning, trigger: asking) { old, new in
            new.contains { id, asks in asks && old[id] == false }
        }
    }
}
