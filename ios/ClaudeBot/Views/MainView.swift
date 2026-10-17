import SwiftUI

/// Sidebar, chat and (on iPad) the profile inspector. On iPhone it collapses to list, chat, profile.
struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var visibility: NavigationSplitViewVisibility = .all

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(columnVisibility: $visibility) {
            HomeView()
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
        } detail: {
            NavigationStack(path: $router.path) {
                Group {
                    if let id = router.selection, store.bots[id] != nil {
                        ChatView(botId: id)
                            .id(id)
                    } else {
                        ContentUnavailableView("No chat selected", systemImage: "bubble.left.and.bubble.right", description: Text("Pick a bot, or tap + to start a chat."))
                            .foregroundStyle(Theme.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Theme.background)
                    }
                }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case let .profile(bot, tab): ProfileView(botId: bot, tab: tab)
                    case .exchange(let agent): ExchangeView(agentId: agent)
                    case let .file(bot, path): FileView(botId: bot, path: path)
                    }
                }
            }
        }
        .sheet(isPresented: $router.showingNewChat) { NewChatView() }
        .sheet(isPresented: $router.showingSettings) { SettingsView() }
    }
}
