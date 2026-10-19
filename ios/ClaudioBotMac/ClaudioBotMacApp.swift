import AppKit
import SwiftUI

@main
struct ClaudioBotMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        Window("ClaudioBot", id: "main") {
            MacRoot()
                .shared(delegate)
                .onOpenURL { url in
                    #if DEBUG
                    if DebugURL.handle(url, delegate) { return }
                    #endif
                    delegate.app.open(url)
                }
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1180, height: 780)
        .defaultLaunchBehavior(.presented)
        .windowResizability(.contentMinSize)
        .commands { MacCommands(app: delegate.app, local: delegate.local, chrome: delegate.chrome) }
        .onChange(of: scenePhase) { _, phase in delegate.app.scenePhaseChanged(phase) }

        // Open in New Window: one chat or session per window, each holding its own viewing lease.
        WindowGroup("ClaudioBot", for: Selection.self) { $selection in
            if let selection {
                SelectionWindow(selection: selection)
                    .shared(delegate)
                    .frame(minWidth: 480, minHeight: 420)
            }
        }
        .defaultSize(width: 760, height: 780)
        .windowResizability(.contentMinSize)
        // Its New Window item would open an empty one.
        .commandsRemoved()

        Settings {
            MacSettings()
                .shared(delegate)
                .frame(width: 560, height: 640)
        }

        MenuBarExtra("ClaudioBot", systemImage: "bubble.left.and.text.bubble.right") {
            MenuBarContent()
                .shared(delegate)
        }
        .menuBarExtraStyle(.menu)
    }
}

/// Owns the models, so the Dock badge, presence and the service probe keep running while no window is open.
/// Closing the window keeps the app, its socket and so its notifications running. The Dock icon reopens the window.
@MainActor
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    let app = AppModel()
    let local = LocalBridge()
    let chrome = MacChrome()

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let client = app.client
        client.attended = NSApp.isActive
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { client.attended = NSApp.isActive }
            }
        }
        badgeDock()
        #if DEBUG
        DebugURL.openAtLaunch(self)
        #endif
        let store = app.store
        Task { [local] in
            await local.run { client.pairing?.url.isLoopback == true && store.machine == nil }
        }
    }

    private func badgeDock() {
        let waiting = withObservationTracking { app.store.waitingOnYou } onChange: { [weak self] in
            Task { @MainActor in self?.badgeDock() }
        }
        NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil
    }
}

/// Unpaired: the welcome screen, or the shared pairing form for another Mac. Paired: the shared RootView with the
/// iPad layout: list selection, and the profile in an inspector beside the chat.
private struct MacRoot: View {
    @State private var anotherMac = false
    @AppStorage(Editor.preferenceKey) private var editor = ""
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(MacChrome.self) private var chrome
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        @Bindable var chrome = chrome
        Group {
            if store.connection == .unpaired && !anotherMac {
                WelcomeView { anotherMac = true }
            } else {
                RootView()
                    .toolbar {
                        if store.connection == .unpaired {
                            ToolbarItem(placement: .navigation) {
                                Button("Back", systemImage: "chevron.left") { anotherMac = false }
                            }
                        }
                    }
            }
        }
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.localOpener, BridgePlace(client.pairing) == .thisMac ? LocalOpener.installed(editor: Editor.preferred(editor)) : nil)
        .textFieldStyle(.plain)
        // The bot pill in the chat's toolbar names the window; a title beside it would say it twice.
        .toolbar(removing: .title)
        // After a revoke the app is back at the welcome screen, and pairs again only on a click.
        .onChange(of: store.connection == .unpaired) { _, unpaired in if unpaired { anotherMac = false } }
        // The phone's Settings sheet is the Settings window here.
        .onChange(of: router.showingSettings, initial: true) { _, showing in
            guard showing else { return }
            router.showingSettings = false
            openSettings()
        }
        .sheet(isPresented: $chrome.pairingIPhone) {
            PairAnotherView()
                .frame(width: 440, height: 600)
        }
        #if DEBUG
        .modifier(DebugConfirmPairing())
        .modifier(DebugOpenWindow())
        #endif
    }
}

/// A window for one chat or session: the shared detail with its pushed screens, and no sidebar. Its router is its
/// own, so what it pushes and opens stays in it.
private struct SelectionWindow: View {
    @State private var router: Router

    init(selection: Selection) {
        _router = State(initialValue: Router(showing: selection))
    }

    var body: some View {
        @Bindable var router = router
        DetailStack()
            .environment(router)
            .viewing(router)
            // No column beside the chat, so the profile is pushed over it.
            .environment(\.horizontalSizeClass, .compact)
            .textFieldStyle(.plain)
            .toolbar(removing: .title)
            .sheet(isPresented: $router.showingUsage) { PlanUsageView() }
    }
}

/// ⌘, : the shared Settings, and where this Mac's bridge runs.
private struct MacSettings: View {
    @AppStorage("settingsTab") private var tab = "general"

    var body: some View {
        TabView(selection: $tab) {
            SettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag("general")
            BridgeSettings()
                .tabItem { Label("Bridge", systemImage: "server.rack") }
                .tag("bridge")
        }
    }
}

/// The minimal menu bar extra: where things stand, and the ways in.
private struct MenuBarContent: View {
    @Environment(AppStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(LocalBridge.self) private var local
    @Environment(MacChrome.self) private var chrome
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let context = MacContext(app: app, local: local, chrome: chrome, openMain: openMain)
        Text(store.connection == .unpaired ? "Not paired" : store.connection.summary)
        if store.waitingOnYou > 0 {
            Text(store.waitingOnYou == 1 ? "1 waiting on you" : "\(store.waitingOnYou) waiting on you")
        }
        Divider()
        Button(MacCommand.pairIPhone.title(context)) { MacCommand.pairIPhone.perform(context) }
            .disabled(!MacCommand.pairIPhone.isEnabled(context))
        Button("Open ClaudioBot", action: openMain)
        Divider()
        Button("Quit ClaudioBot") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func openMain() {
        openWindow(id: "main")
        NSApp.activate()
    }
}

private extension View {
    func shared(_ delegate: MacAppDelegate) -> some View {
        environment(delegate.app)
            .environment(delegate.app.store)
            .environment(delegate.app.client)
            .environment(delegate.app.router)
            .environment(delegate.local)
            .environment(delegate.chrome)
            .preferredColorScheme(.dark)
            .formStyle(.grouped)
    }
}
