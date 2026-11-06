import AppKit
import SwiftUI

/// What the Mac's own chrome shows outside the shared screens.
@Observable
@MainActor
final class MacChrome {
    /// The Pair Another Device sheet over the main window.
    var pairingIPhone = false
    #if DEBUG
    /// A window `claudiobot://debug/window` asked for, opened by the main window as Open in New Window would.
    var debugWindow: Selection?
    #endif
}

extension FocusedValues {
    /// The router of the key window, so a command acts on the window in front.
    @Entry var router: Router?
}

/// What a command reads and drives. Commands hold no state of their own.
@MainActor
struct MacContext {
    let app: AppModel
    let local: LocalBridge
    let chrome: MacChrome
    /// The key window's router, else the main window's.
    let router: Router
    let openMain: () -> Void

    init(app: AppModel, local: LocalBridge, chrome: MacChrome, router: Router? = nil, openMain: @escaping () -> Void) {
        self.app = app
        self.local = local
        self.chrome = chrome
        self.router = router ?? app.router
        self.openMain = openMain
    }

    var store: AppStore { app.store }
    var paired: Bool { store.connection != .unpaired }
    /// The Bridge menu manages this Mac's service, so it stands down while the app is paired with another Mac, and in
    /// a demo.
    var managesLocal: Bool { BridgePlace(app.client.pairing) != .otherMac && !local.isDemo }

    /// The main window shows the profile in its inspector; a window for one chat pushes it over the chat.
    var showsProfile: Bool {
        if router.hasSidebar { return router.showingInspector }
        if case .profile = router.path.last { return true }
        return false
    }

    /// The bot `step` rows away from the open one in the sidebar's list, wrapping around.
    func bot(_ step: Int) -> BotID? {
        let bots = store.homeBots.map(\.id)
        guard !bots.isEmpty else { return nil }
        guard let at = router.selection?.bot.flatMap(bots.firstIndex(of:)) else { return step > 0 ? bots.first : bots.last }
        return bots[(at + step + bots.count) % bots.count]
    }
}

/// Every menu command, once. The menus, the menu bar extra and Debug checks all go through this list.
enum MacCommand: String, CaseIterable, Identifiable {
    case newChat, newSession, pairIPhone
    case bots, sessions, previousChat, nextChat, profile, planUsage, refresh
    case startBridge, stopBridge, restartBridge, showLog

    enum Menu { case file, view, bridge }

    var id: Self { self }

    var menu: Menu {
        switch self {
        case .newChat, .newSession, .pairIPhone: .file
        case .bots, .sessions, .previousChat, .nextChat, .profile, .planUsage, .refresh: .view
        case .startBridge, .stopBridge, .restartBridge, .showLog: .bridge
        }
    }

    @MainActor func title(_ c: MacContext) -> String {
        switch self {
        case .newChat: "New Chat"
        case .newSession: "New Session…"
        case .pairIPhone: "Pair Another Device…"
        case .bots: "Bots"
        case .sessions: "Sessions"
        case .previousChat: "Previous Chat"
        case .nextChat: "Next Chat"
        case .profile: c.showsProfile ? "Hide Profile" : "Show Profile"
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
        // Messages' keys for the next and previous conversation.
        case .previousChat: KeyboardShortcut(.tab, modifiers: [.control, .shift])
        case .nextChat: KeyboardShortcut(.tab, modifiers: .control)
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
        case .previousChat, .nextChat: return c.paired && c.router.hasSidebar && c.router.sidebar == .bots && c.bot(1) != nil
        case .pairIPhone: return c.store.machine != nil && c.store.bridgeManagesDevices
        case .profile: return c.router.selection?.bot != nil
        case .planUsage: return c.store.has(.usage)
        case .startBridge: return c.managesLocal && idle && c.local.state.canStart
        case .stopBridge: return c.managesLocal && idle && c.local.state.canStop
        case .restartBridge: return c.managesLocal && idle && c.local.state.canRestart
        case .showLog: return c.managesLocal
        }
    }

    @MainActor func perform(_ c: MacContext) {
        let main = c.app.router
        let router = c.router
        switch self {
        case .newChat:
            c.openMain()
            main.showingNewChat = true
        case .newSession:
            c.openMain()
            main.newSession = NewSessionRequest()
        case .pairIPhone:
            c.openMain()
            c.chrome.pairingIPhone = true
        case .bots: main.sidebar = .bots
        case .sessions: main.sidebar = .sessions
        case .previousChat: if let bot = c.bot(-1) { router.open(bot) }
        case .nextChat: if let bot = c.bot(1) { router.open(bot) }
        case .profile:
            if router.hasSidebar {
                router.showingInspector.toggle()
            } else if c.showsProfile {
                router.path.removeLast()
            } else if let bot = router.selection?.bot {
                router.path.append(.profile(bot))
            }
        case .planUsage:
            c.openMain()
            main.showingUsage = true
        case .refresh:
            c.app.client.retryNow()
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
    @FocusedValue(\.router) private var router
    @FocusedValue(\.sidebarSearch) private var search

    private var context: MacContext {
        MacContext(app: app, local: local, chrome: chrome, router: router) { [openWindow] in
            openWindow(id: "main")
            NSApp.activate()
        }
    }

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .newItem) { buttons(.file) }
        CommandGroup(after: .textEditing) {
            Button("Find…") {
                if let router, router.columns == .detailOnly { router.columns = .all }
                search?.focus()
            }
            .keyboardShortcut("f")
            .disabled(search == nil)
        }
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
