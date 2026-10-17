import Foundation
import Security

/// A one-time pairing code and the bridge it belongs to, from the QR link or typed in by hand.
struct PairInvite: Equatable, Sendable {
    /// The bridge's socket address, like ws://10.0.0.20:7878/ws.
    let url: URL
    let code: String

    enum Invalid: LocalizedError {
        case url, code

        var errorDescription: String? {
            switch self {
            case .url: "Enter the bridge address, like ws://10.0.0.20:7878/ws."
            case .code: "Enter the pairing code the bridge printed."
            }
        }
    }

    init(url: URL, code: String) {
        self.url = url
        self.code = code
    }

    /// Parses what a person types or pastes into the manual form.
    init(urlString: String, code: String) throws(Invalid) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), ["ws", "wss"].contains(url.scheme?.lowercased()), url.host() != nil else {
            throw .url
        }
        let code = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !code.isEmpty else { throw .code }
        self.init(url: url, code: code)
    }

    /// Parses `claudiobot://pair?url=<ws url>&code=<code>`, the payload of the bridge's QR code.
    init?(link: URL) {
        guard link.scheme == "claudiobot", link.host() == "pair",
              let query = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
              let url = query.first(where: { $0.name == "url" })?.value,
              let code = query.first(where: { $0.name == "code" })?.value,
              let invite = try? PairInvite(urlString: url, code: code)
        else { return nil }
        self = invite
    }

    /// The link another phone scans to pair with the same bridge.
    var link: URL {
        var components = URLComponents()
        components.scheme = "claudiobot"
        components.host = "pair"
        components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString), URLQueryItem(name: "code", value: code)]
        return components.url!
    }

    /// POST /pair on the bridge's own host and port, over HTTP(S) to match ws(s).
    func request(deviceName: String) -> URLRequest {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = url.scheme?.lowercased() == "wss" ? "https" : "http"
        components.path = "/pair"
        components.query = nil
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(PairRequest(code: code, name: deviceName))
        request.timeoutInterval = 10
        return request
    }
}

struct Pairing: Equatable, Sendable {
    enum Credential: Equatable, Sendable {
        /// This phone's own token, from POST /pair.
        case device(DeviceID, token: String)
        /// The shared token from before protocol 3. Only a pairing saved by an older build holds one.
        case legacy(token: String)
    }

    let url: URL
    let credential: Credential

    enum Failure: LocalizedError {
        case unreachable(String), rejected(String), notABridge

        var errorDescription: String? {
            switch self {
            case .unreachable(let reason): "The bridge did not answer: \(reason) Check the address and that your phone is on the same network or tailnet."
            case .rejected(let reason): reason
            case .notABridge: "Something answered, but it is not a ClaudioBot bridge."
            }
        }
    }

    /// Trades a one-time code for this phone's own token.
    static func redeem(_ invite: PairInvite, deviceName: String, session: URLSession = .shared) async throws(Failure) -> Pairing {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: invite.request(deviceName: deviceName))
        } catch {
            throw .unreachable(error.localizedDescription)
        }
        return try pairing(for: invite, status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }

    /// The bridge answers a bad code with `{"error": "..."}`.
    static func pairing(for invite: PairInvite, status: Int, body: Data) throws(Failure) -> Pairing {
        if (200..<300).contains(status), let paired = try? JSONDecoder().decode(PairResponse.self, from: body) {
            return Pairing(url: invite.url, credential: .device(paired.deviceId, token: paired.token))
        }
        struct Refusal: Decodable { let error: String }
        if let refusal = try? JSONDecoder().decode(Refusal.self, from: body) {
            throw .rejected(refusal.error)
        }
        throw .notABridge
    }

    /// The socket request: the protocol this app speaks, where to resume the stream, and the credential.
    func socketRequest(resumingFrom cursor: StreamCursor? = nil) -> URLRequest {
        var items = [URLQueryItem(name: "protocol", value: String(Wire.protocolVersion))]
        items += cursor?.resumeQuery ?? []
        if case .legacy(let token) = credential {
            items.append(URLQueryItem(name: "token", value: token))
        }
        var request = URLRequest(url: url.appending(queryItems: items))
        if case .device(_, let token) = credential {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

// Stored as {url, token, deviceId}. A pairing saved by an older build has no deviceId, which is what marks it legacy.
extension Pairing: Codable {
    private enum CodingKeys: String, CodingKey { case url, token, deviceId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = try c.decode(URL.self, forKey: .url)
        let token = try c.decode(String.self, forKey: .token)
        credential = if let id = try c.decodeIfPresent(DeviceID.self, forKey: .deviceId) {
            .device(id, token: token)
        } else {
            .legacy(token: token)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(url, forKey: .url)
        switch credential {
        case let .device(id, token):
            try c.encode(token, forKey: .token)
            try c.encode(id, forKey: .deviceId)
        case let .legacy(token):
            try c.encode(token, forKey: .token)
        }
    }
}

/// Keeps the pairing in the Keychain because the token grants control of the Mac.
enum PairingVault {
    private static let service = "dev.claudiobot.app.pairing"
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
