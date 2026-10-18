import AppKit
import SwiftUI

@main
struct ClaudioBotMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        Window("ClaudioBot", id: "main") {
            RootView()
                .shared(app)
                // The iPad layout of the shared views: list selection, and the profile beside the chat.
                .environment(\.horizontalSizeClass, .regular)
                .onOpenURL { app.open($0) }
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 1180, height: 780)
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
    }
}
