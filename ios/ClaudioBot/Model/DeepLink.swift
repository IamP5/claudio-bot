import Foundation

/// Every claudiobot:// link the app opens.
enum DeepLink: Equatable {
    /// `claudiobot://pair?url=<ws url>&code=<code>`, from the bridge's QR code or another phone's.
    case pair(PairInvite)
    /// `claudiobot://bot/<id>?message=<id>`, from a push notification.
    case bot(BotID, message: MessageID?)

    init?(url: URL) {
        guard url.scheme == "claudiobot" else { return nil }
        switch url.host() {
        case "pair":
            guard let invite = PairInvite(link: url) else { return nil }
            self = .pair(invite)
        case "bot":
            guard let id = url.pathComponents.dropFirst().first, !id.isEmpty else { return nil }
            let message = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "message" })?.value
            self = .bot(BotID(id), message: message.map { MessageID($0) })
        default:
            return nil
        }
    }
}
