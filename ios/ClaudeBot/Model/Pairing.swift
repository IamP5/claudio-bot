import Foundation
import Security

struct Pairing: Codable, Equatable, Sendable {
    let url: URL
    let token: String

    enum Invalid: LocalizedError {
        case url, token

        var errorDescription: String? {
            switch self {
            case .url: "Enter the bridge address, like ws://192.168.1.20:7878/ws."
            case .token: "Enter the token the bridge printed."
            }
        }
    }

    init(url: URL, token: String) {
        self.url = url
        self.token = token
    }

    /// Parses what a person types or pastes into the manual form.
    init(urlString: String, token: String) throws(Invalid) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), ["ws", "wss"].contains(url.scheme?.lowercased()), url.host() != nil else {
            throw .url
        }
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw .token }
        self.init(url: url, token: token)
    }

    /// Parses `claudebot://pair?url=<ws url>&token=<hex>`, the payload of the bridge's QR code.
    init?(link: URL) {
        guard link.scheme == "claudebot", link.host() == "pair",
              let query = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
              let url = query.first(where: { $0.name == "url" })?.value,
              let token = query.first(where: { $0.name == "token" })?.value,
              let pairing = try? Pairing(urlString: url, token: token)
        else { return nil }
        self = pairing
    }

    /// The socket URL with the token attached, as the bridge expects.
    var socketURL: URL {
        url.appending(queryItems: [URLQueryItem(name: "token", value: token)])
    }
}

/// Keeps the pairing in the Keychain because the token grants control of the Mac.
enum PairingVault {
    private static let service = "dev.claudebot.app.pairing"
    private static let account = "bridge"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func load() -> Pairing? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    static func save(_ pairing: Pairing) {
        guard let data = try? JSONEncoder().encode(pairing) else { return }
        clear()
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
