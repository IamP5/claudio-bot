import Foundation

/// Every claudiobot:// link the app opens.
enum DeepLink: Equatable {
    /// `claudiobot://pair?url=<ws url>&code=<code>`, from the bridge's QR code or another phone's.
    case pair(PairInvite)
    /// `claudiobot://pair?url=<ws url>&token=<token>`, printed by a protocol 2 bridge. It is never redeemed:
    /// a shared token in a QR code is what protocol 3 removed, and this app no longer speaks protocol 2.
    case outdatedBridge
    /// `claudiobot://bot/<id>?message=<id>`, from a push notification.
    case bot(BotID, message: MessageID?)
    /// `claudiobot://session/<id>?card=<id>`, from a push about a session. card: the card the push was about, absent
    /// for an ending and from an older bridge.
    case session(SessionID, card: MessageID?)

    static let outdatedBridgeMessage = "This bridge is older than the app. Update the bridge."

    init?(url: URL) {
        guard url.scheme == "claudiobot" else { return nil }
        switch url.host() {
        case "pair":
            if let invite = PairInvite(link: url) {
                self = .pair(invite)
            } else if URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "token" }) == true {
                self = .outdatedBridge
            } else {
                return nil
            }
        case "bot":
            guard let id = url.pathComponents.dropFirst().first, !id.isEmpty else { return nil }
            self = .bot(BotID(id), message: Self.query("message", in: url).map { MessageID($0) })
        case "session":
            guard let id = url.pathComponents.dropFirst().first, !id.isEmpty else { return nil }
            self = .session(SessionID(id), card: Self.query("card", in: url).map { MessageID($0) })
        default:
            return nil
        }
    }

    private static func query(_ name: String, in url: URL) -> String? {
        let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
        return value?.isEmpty == false ? value : nil
    }
}
