import CryptoKit
import Foundation
import Security

/// A one-time pairing code and the bridge it belongs to, from the QR link or typed in by hand.
struct PairInvite: Equatable, Sendable {
    /// The bridge's socket address, like ws://10.0.0.20:7878/ws. Its path always ends in /ws.
    let url: URL
    let code: String
    /// More addresses of the same bridge from its link, best first, tried in turn when `url` does not answer.
    let fallbacks: [URL]

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

    init(url: URL, code: String, fallbacks: [URL] = []) {
        self.url = url
        self.code = code
        self.fallbacks = fallbacks
    }

    /// Parses what a person types or pastes. A bare host and port gets the /ws path; any other path must end in /ws.
    init(urlString: String, code: String) throws(Invalid) {
        self.init(url: try Self.bridgeURL(urlString), code: try Self.pairingCode(code))
    }

    /// A typed bridge address as a socket URL: ws or wss, a host, and a path ending in /ws (added when there is none).
    static func bridgeURL(_ urlString: String) throws(Invalid) -> URL {
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
        return url
    }

    private static func pairingCode(_ code: String) throws(Invalid) -> String {
        let code = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !code.isEmpty else { throw .code }
        return code
    }

    /// Parses `claudiobot://pair?url=<ws url>&url=<ws url>&code=<code>`, the payload of the bridge's QR code. The bridge
    /// lists its addresses best first; one this app cannot use is skipped, and at least one must be usable.
    init?(link: URL) {
        guard link.scheme == "claudiobot", link.host() == "pair",
              let query = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems,
              let code = try? Self.pairingCode(query.first(where: { $0.name == "code" })?.value ?? "")
        else { return nil }
        var seen = Set<URL>()
        let addresses = query
            .filter { $0.name == "url" }
            .compactMap { try? Self.bridgeURL($0.value ?? "") }
            .filter { seen.insert($0).inserted }
        guard let first = addresses.first else { return nil }
        self.init(url: first, code: code, fallbacks: Array(addresses.dropFirst()))
    }

    /// Every address of the bridge, in the order redeeming tries them.
    var addresses: [URL] { [url] + fallbacks }

    /// The same code at one of its addresses.
    func at(_ address: URL) -> PairInvite {
        PairInvite(url: address, code: code)
    }

    /// The link another phone scans to pair with the same bridge.
    var link: URL {
        var components = URLComponents()
        components.scheme = "claudiobot"
        components.host = "pair"
        components.queryItems = addresses.map { URLQueryItem(name: "url", value: $0.absoluteString) } + [URLQueryItem(name: "code", value: code)]
        return components.url!
    }

    /// POST /pair beside the socket path (wss://host/prefix/ws pairs at https://host/prefix/pair).
    func request(deviceName: String) -> URLRequest {
        var request = URLRequest(url: url.besideSocket("pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(PairRequest(code: code, name: deviceName))
        request.timeoutInterval = 10
        return request
    }

    /// What the user confirms before anything is sent to the bridge.
    func confirmation(replacing current: Pairing?) -> PairingConfirmation {
        let others = fallbacks.map(\.bridgeAddress)
        let fallback: String? = switch others.count {
        case 0: nil
        case 1: "If it does not answer, ClaudioBot tries \(others[0])."
        default: "If it does not answer, ClaudioBot tries \(others.dropLast().joined(separator: ", ")) and \(others.last!), in that order."
        }
        let replacing = current.map { "This replaces your pairing with \($0.url.bridgeAddress)." }
        let detail = [fallback, replacing].compactMap { $0 }
        return PairingConfirmation(
            title: "Pair with \(url.bridgeAddress)?",
            detail: detail.isEmpty ? nil : detail.joined(separator: " ")
        )
    }
}

extension PairCode {
    /// What another device scans: every address the bridge listed, best first, minus the loopback ones only this
    /// computer reaches. A bridge that lists none (one from before pair_code carried URLs) falls back to the address
    /// this app pairs at. nil when nothing is left that another device could reach.
    func invite(fallingBackTo own: URL?) -> PairInvite? {
        let listed = (urls ?? []).compactMap { try? PairInvite.bridgeURL($0) }.filter { !$0.isLoopback }
        var seen = Set<URL>()
        let addresses = (listed.isEmpty ? [own].compactMap { $0 }.filter { !$0.isLoopback } : listed)
            .filter { seen.insert($0).inserted }
        guard let first = addresses.first else { return nil }
        return PairInvite(url: first, code: code, fallbacks: Array(addresses.dropFirst()))
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
    /// An HTTP endpoint beside a socket address: wss://host/prefix/ws becomes https://host/prefix/<name>, ws gives http.
    func besideSocket(_ name: String) -> URL {
        var components = URLComponents(url: self, resolvingAgainstBaseURL: false)!
        components.scheme = scheme?.lowercased() == "wss" ? "https" : "http"
        components.path = components.path.hasSuffix("/ws") ? String(components.path.dropLast(2)) + name : "/" + name
        components.query = nil
        return components.url!
    }

    /// localhost, 127.0.0.0/8 or ::1.
    var isLoopback: Bool {
        guard let host = host(percentEncoded: false)?.lowercased() else { return false }
        if host == "localhost" || host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        return octets.count == 4 && octets.allSatisfy { UInt8($0) != nil } && octets[0] == "127"
    }

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

    /// The address in use: the one that last answered.
    let url: URL
    /// Every address of the world's home from its pair link, best first. Always holds `url`.
    let urls: [URL]
    let credential: Credential
    /// The world of bots these addresses reach, once its home said hello with one. Nil for a bridge without machines.
    let world: WorldID?

    init(url: URL, credential: Credential, urls: [URL] = [], world: WorldID? = nil) {
        self.url = url
        self.urls = urls.contains(url) ? urls : [url] + urls
        self.credential = credential
        self.world = world
    }

    /// The same pairing at another of its addresses. One the link did not list joins the end of the list.
    func at(_ address: URL) -> Pairing {
        Pairing(url: address, credential: credential, urls: urls.contains(address) ? urls : urls + [address], world: world)
    }

    func entering(_ world: WorldID?) -> Pairing {
        Pairing(url: url, credential: credential, urls: urls, world: world)
    }

    /// Whether `other` reaches the same world of bots, so what the app holds still applies. A bridge without machines
    /// names no world, and there the addresses decide, as they did before worlds.
    func sameWorld(as other: Pairing) -> Bool {
        if let world, let theirs = other.world { return world == theirs }
        return !Set(urls).isDisjoint(with: other.urls)
    }

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

    /// Trades a one-time code for this phone's own token at the first of the invite's addresses that answers. A bridge
    /// that answered and refused ends it there: its other addresses are the same bridge and would refuse too.
    static func redeem(_ invite: PairInvite, deviceName: String, session: URLSession = .shared) async throws(Failure) -> Pairing {
        var failure = Failure.unreachable("")
        for address in invite.addresses {
            do throws(Failure) {
                let paired = try await redeem(at: invite.at(address), deviceName: deviceName, session: session)
                return Pairing(url: paired.url, credential: paired.credential, urls: invite.addresses)
            } catch {
                guard case .unreachable = error else { throw error }
                failure = error
            }
        }
        throw failure
    }

    private static func redeem(at invite: PairInvite, deviceName: String, session: URLSession) async throws(Failure) -> Pairing {
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

    /// Why this pairing could not move to another address. Each keeps the old address.
    enum AddressChange: LocalizedError, Equatable {
        case legacy
        case unreachable(URL)
        /// Something answered, but not with proof that it holds this phone's token, so the token was not sent there.
        case unproven(URL)

        var errorDescription: String? {
            switch self {
            case .legacy: "Pair again with a code to change the address."
            case .unreachable(let url): "The bridge did not answer at \(url.bridgeAddress). The old address is kept."
            case .unproven(let url): "Something answered at \(url.bridgeAddress), but it could not prove it is your bridge. The old address is kept, and your pairing was not sent there."
            }
        }
    }

    /// Asks whatever answers at `address` to prove it is the bridge that issued this phone's token, without sending
    /// the token: GET /health with a fresh nonce, answered with the HMAC-SHA256 of the nonce keyed by the token's
    /// SHA-256. A legacy pairing has no device the bridge can prove itself to.
    func proveBridge(at address: URL, timeout: TimeInterval = 10, session: URLSession = .shared) async throws(AddressChange) {
        guard case let .device(id, token) = credential else { throw .legacy }
        let nonce = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.hex
        var components = URLComponents(url: address.besideSocket("health"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "device", value: id.rawValue), URLQueryItem(name: "nonce", value: nonce)]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = timeout
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .unreachable(address)
        }
        struct Health: Decodable { let proof: String? }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let proof = (try? JSONDecoder().decode(Health.self, from: data))?.proof.flatMap(Data.init(hex:)),
              Self.proves(proof, nonce: nonce, token: token)
        else { throw .unproven(address) }
    }

    /// Constant-time, so a wrong answer reveals nothing about the right one.
    static func proves(_ proof: Data, nonce: String, token: String) -> Bool {
        let key = SymmetricKey(data: SHA256.hash(data: Data(token.utf8)))
        return HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: Data(nonce.utf8), using: key)
    }

    /// Opens one socket and waits for the bridge's hello, so a new pairing replaces the old one only once it works.
    @discardableResult
    func greet(within timeout: Duration, session: URLSession = .shared) async throws(Failure) -> Hello {
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
        guard case .hello(let hello)? = try? Wire.decoder().decode(ServerFrame.self, from: data).message else { throw .notABridge }
        return hello
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

// Stored as {url, urls, token, deviceId, world}. A pairing saved by an older build has no deviceId, which is what marks
// it legacy, and one saved before worlds has neither urls nor world, so its one address is its only endpoint.
extension Pairing: Codable {
    private enum CodingKeys: String, CodingKey { case url, urls, token, deviceId, world }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let token = try c.decode(String.self, forKey: .token)
        let credential: Credential = if let id = try c.decodeIfPresent(DeviceID.self, forKey: .deviceId) {
            .device(id, token: token)
        } else {
            .legacy(token: token)
        }
        self.init(
            url: try c.decode(URL.self, forKey: .url),
            credential: credential,
            urls: try c.decodeIfPresent([URL].self, forKey: .urls) ?? [],
            world: try c.decodeIfPresent(WorldID.self, forKey: .world)
        )
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(url, forKey: .url)
        try c.encode(urls, forKey: .urls)
        try c.encodeIfPresent(world, forKey: .world)
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

    /// A Debug build takes `-pairingVault <service>`, so a check pairs with a throwaway bridge and leaves the
    /// app's own pairing alone.
    static let app: PairingVault = {
        #if DEBUG
        if let service = UserDefaults.standard.string(forKey: "pairingVault") { return PairingVault(service: service) }
        #endif
        return PairingVault(service: "dev.claudiobot.app.pairing")
    }()

    struct SaveFailed: LocalizedError {
        let status: OSStatus

        var errorDescription: String? { "This \(ThisDevice.noun) could not save the pairing to its Keychain (error \(status))." }
    }

    private var query: [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: Self.account]
        #if os(macOS)
        if Self.dataProtection { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }

    #if os(macOS)
    /// The data protection keychain needs an app signed with a team. A build signed to run locally gets
    /// errSecMissingEntitlement there, so it keeps the pairing in the login keychain instead.
    private static let dataProtection: Bool = {
        let probe: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: "dev.claudiobot.keychain-probe",
                                    kSecUseDataProtectionKeychain as String: true]
        let status = SecItemAdd(probe.merging([kSecValueData as String: Data()]) { $1 } as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        return status != errSecMissingEntitlement
    }()
    #endif

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

extension Data {
    /// Lowercase hex.
    var hex: String { map { String(format: "%02x", $0) }.joined() }

    /// Nil unless every character is a hex digit and they pair up into bytes.
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2), hex.allSatisfy(\.isHexDigit) else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}

/// Notices a device that paired while the pairing code is up: one missing from the first list heard after it went up.
struct NewDeviceWatch: Sendable {
    private var baseline: Set<DeviceID>?

    /// Whether `devices` holds a device the first list did not.
    mutating func heard(_ devices: [Device]) -> Bool {
        let ids = Set(devices.map(\.id))
        guard let baseline else {
            baseline = ids
            return false
        }
        return !ids.isSubset(of: baseline)
    }
}
