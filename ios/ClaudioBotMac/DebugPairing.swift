#if DEBUG
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
#endif
