import Foundation
import Security

/// A one-time pairing code and the bridge it belongs to, from the QR link or typed in by hand.
struct PairInvite: Equatable, Sendable {
    /// The bridge's socket address, like ws://10.0.0.20:7878/ws. Its path always ends in /ws.
    let url: URL
    let code: String

    enum Invalid: LocalizedError {
        case url, path, code

        var errorDescription: String? {
            switch self {
            case .url: "Enter the bridge address, like ws://10.0.0.20:7878/ws."
            case .path: "The bridge address ends in /ws, like ws://10.0.0.20:7878/ws."
            case .code: "Enter the pairing code the bridge printed."
            }
        }
    }

    init(url: URL, code: String) {
        self.url = url
        self.code = code
    }

    /// Parses what a person types or pastes. A bare host and port gets the /ws path; any other path must end in /ws.
    init(urlString: String, code: String) throws(Invalid) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(), ["ws", "wss"].contains(scheme),
              let host = components.host, !host.isEmpty
        else { throw .url }
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty { path = "/ws" }
        guard path.hasSuffix("/ws") else { throw .path }
        components.scheme = scheme
        components.path = path
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw .url }
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

    /// POST /pair beside the socket path (wss://host/prefix/ws pairs at https://host/prefix/pair), over HTTP(S) to match ws(s).
    func request(deviceName: String) -> URLRequest {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = url.scheme?.lowercased() == "wss" ? "https" : "http"
        components.path = components.path.hasSuffix("/ws") ? String(components.path.dropLast(2)) + "pair" : "/pair"
        components.query = nil
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(PairRequest(code: code, name: deviceName))
        request.timeoutInterval = 10
        return request
    }

    /// What the user confirms before anything is sent to the bridge.
    func confirmation(replacing current: Pairing?) -> PairingConfirmation {
        PairingConfirmation(
            title: "Pair with \(url.bridgeAddress)?",
            detail: current.map { "This replaces your pairing with \($0.url.bridgeAddress)." }
        )
    }
}

struct PairingConfirmation: Equatable, Sendable {
    let title: String
    let detail: String?
}

/// A pairing the user started, from the invite to the new bridge's first hello. `confirm()` is the only source of
/// an invite to redeem, so a link, a scan or the form never reaches a bridge the user has not approved by address.
struct PairingFlow: Equatable, Sendable {
    enum Step: Equatable, Sendable {
        case entering
        case confirming(PairInvite)
        /// Redeeming the code, then waiting for the new bridge's hello.
        case pairing(PairInvite)
    }

    private(set) var step: Step = .entering
    private(set) var failure: String?

    init(failure: String? = nil) {
        self.failure = failure
    }

    var confirming: PairInvite? {
        if case .confirming(let invite) = step { invite } else { nil }
    }

    var isPairing: Bool {
        if case .pairing = step { true } else { false }
    }

    /// A link, a scan or the form proposes a bridge. A pairing already under way is not interrupted.
    mutating func propose(_ invite: PairInvite) {
        guard !isPairing else { return }
        step = .confirming(invite)
        failure = nil
    }

    /// The user's Confirm. Returns the invite to redeem, and only from the confirmation step.
    mutating func confirm() -> PairInvite? {
        guard let invite = confirming else { return nil }
        step = .pairing(invite)
        return invite
    }

    mutating func cancelConfirmation() {
        if confirming != nil { step = .entering }
    }

    mutating func fail(_ message: String) {
        step = .entering
        failure = message
    }
}

extension URL {
    /// host:port, the part of the address a person recognizes their Mac by.
    var bridgeAddress: String {
        let host = host(percentEncoded: false) ?? absoluteString
        let shown = host.contains(":") ? "[\(host)]" : host
        return port.map { "\(shown):\($0)" } ?? shown
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
        case unreachable(String), rejected(String), notABridge, silent

        var errorDescription: String? {
            switch self {
            case .unreachable(let reason): "The bridge did not answer: \(reason) Check the address and that your phone is on the same network or tailnet."
            case .rejected(let reason): reason
            case .notABridge: "Something answered, but it is not a ClaudioBot bridge."
            case .silent: "The bridge took the pairing code but did not connect."
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

    /// Opens one socket and waits for the bridge's hello, so a new pairing replaces the old one only once it works.
    func greet(within timeout: Duration, session: URLSession = .shared) async throws(Failure) {
        let ws = session.webSocketTask(with: socketRequest())
        ws.resume()
        let timer = Task {
            try? await Task.sleep(for: timeout)
            ws.cancel(with: .goingAway, reason: nil)
        }
        defer {
            timer.cancel()
            ws.cancel(with: .normalClosure, reason: nil)
        }
        let first: URLSessionWebSocketTask.Message
        do {
            first = try await ws.receive()
        } catch {
            throw .silent
        }
        let data = switch first {
        case .string(let text): Data(text.utf8)
        case .data(let bytes): bytes
        @unknown default: Data()
        }
        guard case .hello? = try? Wire.decoder().decode(ServerFrame.self, from: data).message else { throw .notABridge }
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
struct PairingVault: Sendable {
    let service: String
    private static let account = "bridge"

    static let app = PairingVault(service: "dev.claudiobot.app.pairing")

    struct SaveFailed: LocalizedError {
        let status: OSStatus

        var errorDescription: String? { "This iPhone could not save the pairing to its Keychain (error \(status))." }
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: Self.account]
    }

    func load() -> Pairing? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    /// Updates in place, so a failed write leaves the previous pairing where it was.
    func save(_ pairing: Pairing) throws {
        let data = try JSONEncoder().encode(pairing)
        let fields: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(fields) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SaveFailed(status: status) }
    }

    func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
