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

/// Opens the window `claudiobot://debug/window?bot=<id>` (or `?session=<id>`) asked for, through `openWindow` as
/// Open in New Window does.
struct DebugOpenWindow: ViewModifier {
    @Environment(MacChrome.self) private var chrome
    @Environment(\.openWindow) private var openWindow

    func body(content: Content) -> some View {
        content.onChange(of: chrome.debugWindow) { _, selection in
            guard let selection else { return }
            chrome.debugWindow = nil
            openWindow(value: selection)
        }
    }
}

/// `claudiobot://debug/<what>` drives a Debug build from a script: a MacCommand by name (startBridge, pairIPhone, …),
/// `useThisMac`, `bridgeSettings` to open Settings › Bridge, `menuBar` to open the menu bar extra, `window?bot=<id>`
/// or `window?session=<id>` to open one in a window of its own. Stop skips its confirmation.
enum DebugURL {
    /// `-openURLs "<url> <url> …"` opens each URL in turn after launch, two seconds apart, as `open` would. Unlike
    /// `open`, it reaches this process even while another build with the same bundle id runs.
    @MainActor static func openAtLaunch(_ delegate: MacAppDelegate) {
        let urls = (UserDefaults.standard.string(forKey: "openURLs") ?? "").split(separator: " ").compactMap { URL(string: String($0)) }
        Task { @MainActor in
            for url in urls {
                try? await Task.sleep(for: .seconds(2))
                if !handle(url, delegate) { delegate.app.open(url) }
            }
        }
    }

    @MainActor static func handle(_ url: URL, _ delegate: MacAppDelegate) -> Bool {
        guard url.scheme == "claudiobot", url.host() == "debug" else { return false }
        let what = url.lastPathComponent
        let context = MacContext(app: delegate.app, local: delegate.local, chrome: delegate.chrome) {}
        switch what {
        case "stopBridge": Task { await delegate.local.stop() }
        case "window":
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let bot = query.first(where: { $0.name == "bot" })?.value {
                delegate.chrome.debugWindow = .bot(BotID(bot))
            } else if let session = query.first(where: { $0.name == "session" })?.value {
                delegate.chrome.debugWindow = .session(SessionID(session))
            }
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
