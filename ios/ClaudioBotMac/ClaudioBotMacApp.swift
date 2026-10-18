import AppKit
import SwiftUI

@main
struct ClaudioBotMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        Window("ClaudioBot", id: "main") {
            MacRoot()
                .shared(app)
                .onOpenURL { app.open($0) }
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1180, height: 780)
        .defaultLaunchBehavior(.presented)
        .windowResizability(.contentMinSize)
        .commands { MacCommands(app: app) }
        .onChange(of: scenePhase) { _, phase in app.scenePhaseChanged(phase) }

        Settings {
            TabView {
                SettingsView()
                    .tabItem { Label("General", systemImage: "gearshape") }
            }
            .shared(app)
            .frame(width: 560, height: 640)
        }
    }
}

/// The shared RootView with the iPad layout: list selection, and the profile in a column beside the chat. A window too
/// narrow for that column gets the iPhone layout instead, where the profile is pushed over the chat.
private struct MacRoot: View {
    static let profileColumnWidth: CGFloat = 1100
    @State private var wide = true
    @Environment(Router.self) private var router
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        RootView()
            .environment(\.horizontalSizeClass, wide ? .regular : .compact)
            .textFieldStyle(.plain)
            .onGeometryChange(for: Bool.self) { $0.size.width >= Self.profileColumnWidth } action: { wide = $0 }
            // The phone's Settings sheet is the Settings window here.
            .onChange(of: router.showingSettings, initial: true) { _, showing in
                guard showing else { return }
                router.showingSettings = false
                openSettings()
            }
    }
}

/// Closing the window keeps the app, its socket and so its notifications running. The Dock icon reopens the window.
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

private extension View {
    func shared(_ app: AppModel) -> some View {
        environment(app)
            .environment(app.store)
            .environment(app.client)
            .environment(app.router)
            .preferredColorScheme(.dark)
            .formStyle(.grouped)
    }
}
