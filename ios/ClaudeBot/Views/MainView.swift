import SwiftUI

/// Sidebar, chat and (on iPad) the profile inspector. On iPhone it collapses to list, chat, profile.
struct MainView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var visibility: NavigationSplitViewVisibility = .all

    /// iPad only. On iPhone the profile is pushed instead, and an inspector would turn into a sheet.
    private var inspectorShown: Binding<Bool> {
        Binding(
            get: { sizeClass == .regular && router.showingInspector && router.selection != nil },
            set: { router.showingInspector = $0 }
        )
    }

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
            .inspector(isPresented: inspectorShown) {
                // Only built while shown, so its toolbar items never leak into the chat's toolbar.
                if inspectorShown.wrappedValue, let id = router.selection {
                    ProfileView(botId: id)
                        .inspectorColumnWidth(min: 320, ideal: 380, max: 460)
                }
            }
        }
        .sheet(isPresented: $router.showingNewChat) { NewChatView() }
        .sheet(isPresented: $router.showingSettings) { SettingsView() }
    }
}
