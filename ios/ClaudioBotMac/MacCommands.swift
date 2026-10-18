import AppKit
import SwiftUI

/// What the Mac's own chrome shows outside the shared screens.
@Observable
@MainActor
final class MacChrome {
    /// The Pair iPhone sheet over the main window.
    var pairingIPhone = false
}

/// What a command reads and drives. Commands hold no state of their own.
@MainActor
struct MacContext {
    let app: AppModel
    let local: LocalBridge
    let chrome: MacChrome
    let openMain: () -> Void

    var store: AppStore { app.store }
    var paired: Bool { store.connection != .unpaired }
    /// The Bridge menu manages this Mac's service, so it stands down while the app is paired with another Mac.
    var managesLocal: Bool { BridgePlace(app.client.pairing) != .otherMac }
}

/// Every menu command, once. The menus, the menu bar extra and Debug checks all go through this list.
enum MacCommand: String, CaseIterable, Identifiable {
    case newChat, newSession, pairIPhone
    case bots, sessions, profile, planUsage, refresh
    case startBridge, stopBridge, restartBridge, showLog

    enum Menu { case file, view, bridge }

    var id: Self { self }

    var menu: Menu {
        switch self {
        case .newChat, .newSession, .pairIPhone: .file
        case .bots, .sessions, .profile, .planUsage, .refresh: .view
        case .startBridge, .stopBridge, .restartBridge, .showLog: .bridge
        }
    }

    @MainActor func title(_ c: MacContext) -> String {
        switch self {
        case .newChat: "New Chat"
        case .newSession: "New Session…"
        case .pairIPhone: "Pair iPhone…"
        case .bots: "Bots"
        case .sessions: "Sessions"
        case .profile: c.app.router.showingInspector ? "Hide Profile" : "Show Profile"
        case .planUsage: "Plan Usage"
        case .refresh: "Refresh"
        case .startBridge: "Start Bridge"
        case .stopBridge: "Stop Bridge…"
        case .restartBridge: "Restart Bridge"
        case .showLog: "Show Log"
        }
    }

    var shortcut: KeyboardShortcut? {
        switch self {
        case .newChat: KeyboardShortcut("n")
        case .newSession: KeyboardShortcut("n", modifiers: [.command, .option])
        case .pairIPhone: KeyboardShortcut("p", modifiers: [.command, .shift])
        case .bots: KeyboardShortcut("1")
        case .sessions: KeyboardShortcut("2")
        case .profile: KeyboardShortcut("i", modifiers: [.command, .option])
        case .planUsage: KeyboardShortcut("u", modifiers: [.command, .shift])
        case .refresh: KeyboardShortcut("r")
        case .startBridge, .stopBridge, .restartBridge, .showLog: nil
        }
    }

    @MainActor func isEnabled(_ c: MacContext) -> Bool {
        let idle = c.local.action == nil
        switch self {
        case .newChat, .bots, .refresh: return c.paired
        case .newSession: return c.paired && c.store.has(.sessions)
        case .sessions: return c.paired && !c.store.lacks(.sessions)
        case .pairIPhone: return c.store.machine != nil && c.store.bridgeManagesDevices
        case .profile: return c.app.router.selection?.bot != nil
        case .planUsage: return c.store.has(.usage)
        case .startBridge: return c.managesLocal && idle && c.local.state.canStart
        case .stopBridge: return c.managesLocal && idle && c.local.state.canStop
        case .restartBridge: return c.managesLocal && idle && c.local.state.canRestart
        case .showLog: return c.managesLocal
        }
    }

    @MainActor func perform(_ c: MacContext) {
        let router = c.app.router
        switch self {
        case .newChat:
            c.openMain()
            router.showingNewChat = true
        case .newSession:
            c.openMain()
            router.newSession = NewSessionRequest()
        case .pairIPhone:
            c.openMain()
            c.chrome.pairingIPhone = true
        case .bots: router.sidebar = .bots
        case .sessions: router.sidebar = .sessions
        case .profile: router.showingInspector.toggle()
        case .planUsage:
            c.openMain()
            router.showingUsage = true
        case .refresh:
            c.app.client.reconnectNow()
            if router.watchesSessions { c.app.client.refreshSessions() }
            if c.store.has(.usage) { c.app.client.send(.refreshUsage) }
        case .startBridge: Task { await c.local.start() }
        case .stopBridge: if Self.confirmStop() { Task { await c.local.stop() } }
        case .restartBridge: Task { await c.local.restart() }
        case .showLog: c.local.showLog()
        }
    }

    @MainActor static func confirmStop() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Stop the bridge?"
        alert.informativeText = "Your bots and routines stop until you start it again, and your phone cannot reach them."
        alert.addButton(withTitle: "Stop")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

struct MacCommands: Commands {
    let app: AppModel
    let local: LocalBridge
    let chrome: MacChrome
    @Environment(\.openWindow) private var openWindow

    private var context: MacContext {
        MacContext(app: app, local: local, chrome: chrome) { [openWindow] in
            openWindow(id: "main")
            NSApp.activate()
        }
    }

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .newItem) { buttons(.file) }
        CommandGroup(before: .sidebar) {
            buttons(.view)
            Divider()
        }
        SwiftUI.CommandMenu("Bridge") { buttons(.bridge) }
    }

    private func buttons(_ menu: MacCommand.Menu) -> MenuButtons {
        MenuButtons(commands: MacCommand.allCases.filter { $0.menu == menu }, context: context)
    }
}

private struct MenuButtons: View {
    let commands: [MacCommand]
    let context: MacContext

    var body: some View {
        ForEach(commands) { command in
            Button(command.title(context)) { command.perform(context) }
                .keyboardShortcut(command.shortcut)
                .disabled(!command.isEnabled(context))
        }
    }
}
