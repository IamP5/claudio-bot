import SwiftUI

/// Menu commands drive the shared Router and BridgeClient and hold no state of their own.
struct MacCommands: Commands {
    let app: AppModel

    private var paired: Bool { app.store.connection != .unpaired }

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .newItem) {
            Button("New Chat") { app.router.showingNewChat = true }
                .keyboardShortcut("n")
                .disabled(!paired)
        }
        CommandGroup(before: .sidebar) {
            Button("Bots") { app.router.sidebar = .bots }
                .keyboardShortcut("1")
                .disabled(!paired)
            Button("Sessions") { app.router.sidebar = .sessions }
                .keyboardShortcut("2")
                .disabled(!paired || app.store.lacks(.sessions))
            Divider()
            Button(app.router.showingInspector ? "Hide Profile" : "Show Profile") { app.router.showingInspector.toggle() }
                .keyboardShortcut("i", modifiers: [.command, .option])
                .disabled(app.router.selection?.bot == nil)
            Button("Refresh", action: refresh)
                .keyboardShortcut("r")
                .disabled(!paired)
            Divider()
        }
    }

    private func refresh() {
        app.client.reconnectNow()
        if app.router.watchesSessions { app.client.refreshSessions() }
        if app.store.has(.usage) { app.client.send(.refreshUsage) }
    }
}
