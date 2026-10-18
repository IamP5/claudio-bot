#if DEBUG
import AppKit
import SwiftUI

/// `-confirmPairing` presses Pair on every pairing confirmation, so a check can pair a Debug build from a
/// `claudiobot://pair` link opened with `open`, with nobody at the keyboard. Everything after the click is the
/// app's own path: POST /pair, the first hello, then the Keychain.
struct DebugConfirmPairing: ViewModifier {
    static let isEnabled = ProcessInfo.processInfo.arguments.contains("-confirmPairing")
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content.onChange(of: app.pairingFlow?.confirming, initial: true) { _, invite in
            if Self.isEnabled, invite != nil { app.confirmPairing() }
        }
    }
}

/// `claudiobot://debug/<what>` drives a Debug build from a script: a MacCommand by name (startBridge, pairIPhone, …),
/// `useThisMac`, `bridgeSettings` to open Settings › Bridge, `menuBar` to open the menu bar extra. Stop skips its
/// confirmation.
enum DebugURL {
    @MainActor static func handle(_ url: URL, _ delegate: MacAppDelegate) -> Bool {
        guard url.scheme == "claudiobot", url.host() == "debug" else { return false }
        let what = url.lastPathComponent
        let context = MacContext(app: delegate.app, local: delegate.local, chrome: delegate.chrome) {}
        switch what {
        case "stopBridge": Task { await delegate.local.stop() }
        case "useThisMac": Task { _ = await delegate.local.useThisMac(delegate.app.client) }
        case "bridgeSettings":
            UserDefaults.standard.set("bridge", forKey: "settingsTab")
            delegate.app.router.showingSettings = true
        case "menuBar":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSApp.windows.lazy.compactMap { $0.contentView.flatMap(statusButton) }.first?.performClick(nil)
            }
        default:
            MacCommand(rawValue: what)?.perform(context)
        }
        return true
    }

    private static func statusButton(in view: NSView) -> NSStatusBarButton? {
        if let button = view as? NSStatusBarButton { return button }
        return view.subviews.lazy.compactMap(statusButton).first
    }
}
#endif
