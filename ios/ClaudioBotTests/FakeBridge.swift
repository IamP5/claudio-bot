import CryptoKit
import Foundation
import Network
import os

/// A bridge on 127.0.0.1 that speaks just enough HTTP and WebSocket to drive the client's real connect, pair,
/// stream and close paths. A test scripts it at init and reads back what the client sent.
final class FakeBridge: @unchecked Sendable {
    struct Upgrade: Sendable {
        /// The request target: path and query, as sent.
        let target: String
        /// Header names lowercased.
        let headers: [String: String]

        var query: [String: String] {
            let items = URLComponents(string: target)?.queryItems ?? []
            return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, new in new })
        }

        var authorization: String? { headers["authorization"] }
    }

    enum Answer: Sendable {
        case accept
        case refuse(status: Int)
    }

    /// One accepted WebSocket.
    final class Socket: @unchecked Sendable {
        let upgrade: Upgrade
        /// 0 for the first socket this bridge accepted.
        let index: Int
        fileprivate let connection: NWConnection

        fileprivate init(upgrade: Upgrade, index: Int, connection: NWConnection) {
            self.upgrade = upgrade
            self.index = index
            self.connection = connection
        }

        func send(_ json: String) {
            connection.send(content: FakeBridge.frame(opcode: 0x1, payload: Data(json.utf8)), completion: .contentProcessed { _ in })
        }

        func close(code: UInt16) {
            let payload = Data([UInt8(code >> 8), UInt8(code & 0xFF)])
            connection.send(content: FakeBridge.frame(opcode: 0x8, payload: payload), completion: .contentProcessed { _ in })
        }
    }

    private struct Record {
        var upgrades: [Upgrade] = []
        var texts: [String] = []
        var pairBodies: [String] = []
        var healthChecks: [[String: String]] = []
        var sockets: [Socket] = []
    }

    private let onUpgrade: @Sendable (Upgrade) -> Answer
    private let onOpen: @Sendable (Socket) -> Void
    private let onText: @Sendable (Socket, String) -> Void
    private let onPair: @Sendable (String) -> (status: Int, body: String)
    private let onHealth: @Sendable ([String: String]) -> (status: Int, body: String)
    private let queue = DispatchQueue(label: "fake-bridge")
    private let record = OSAllocatedUnfairLock(uncheckedState: Record())
    private let listener: NWListener

    init(
        onUpgrade: @escaping @Sendable (Upgrade) -> Answer = { _ in .accept },
        onOpen: @escaping @Sendable (Socket) -> Void = { _ in },
        onText: @escaping @Sendable (Socket, String) -> Void = { _, _ in },
        onPair: @escaping @Sendable (String) -> (status: Int, body: String) = { _ in (404, "") },
        onHealth: @escaping @Sendable ([String: String]) -> (status: Int, body: String) = { _ in (200, #"{"ok":true}"#) }
    ) throws {
        self.onUpgrade = onUpgrade
        self.onOpen = onOpen
        self.onText = onText
        self.onPair = onPair
        self.onHealth = onHealth
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    deinit {
        listener.cancel()
    }

    var upgrades: [Upgrade] { record.withLockUnchecked { $0.upgrades } }
    var texts: [String] { record.withLockUnchecked { $0.texts } }
    var pairBodies: [String] { record.withLockUnchecked { $0.pairBodies } }
    /// The query of every GET /health.
    var healthChecks: [[String: String]] { record.withLockUnchecked { $0.healthChecks } }
    var sockets: [Socket] { record.withLockUnchecked { $0.sockets } }

    /// Starts listening and returns the socket address, like ws://127.0.0.1:53211/ws.
    func start() async throws -> URL {
        listener.newConnectionHandler = { [self] connection in
            connection.start(queue: queue)
            readRequest(connection, buffer: Data())
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let resumed = OSAllocatedUnfairLock(initialState: false)
            let listener = listener
            listener.stateUpdateHandler = { state in
                let result: Result<UInt16, Error>? = switch state {
                case .ready: .success(listener.port?.rawValue ?? 0)
                case .failed(let error): .failure(error)
                default: nil
                }
                guard let result, resumed.withLock({ done in defer { done = true }; return !done }) else { return }
                continuation.resume(with: result)
            }
            listener.start(queue: queue)
        }
        return URL(string: "ws://127.0.0.1:\(port)/ws")!
    }

    private func readRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [self] data, _, done, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if done || error != nil { connection.cancel() } else { readRequest(connection, buffer: buffer) }
                return
            }
            var lines = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            let requestLine = lines.removeFirst().split(separator: " ").map(String.init)
            var headers: [String: String] = [:]
            for line in lines {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let target = requestLine.count > 1 ? requestLine[1] : "/"
            if headers["upgrade"]?.lowercased() == "websocket" {
                upgrade(connection, Upgrade(target: target, headers: headers))
            } else {
                let length = Int(headers["content-length"] ?? "0") ?? 0
                readBody(connection, target: target, body: Data(buffer[end.upperBound...]), length: length)
            }
        }
    }

    private func readBody(_ connection: NWConnection, target: String, body: Data, length: Int) {
        guard body.count < length else {
            return respond(connection, target: target, body: String(decoding: body.prefix(length), as: UTF8.self))
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [self] data, _, done, error in
            var body = body
            if let data { body.append(data) }
            if body.count < length, done || error != nil { return connection.cancel() }
            readBody(connection, target: target, body: body, length: length)
        }
    }

    private func respond(_ connection: NWConnection, target: String, body: String) {
        let components = URLComponents(string: target)
        let path = components?.path ?? ""
        let (status, json): (Int, String)
        if path.hasSuffix("/pair") {
            record.withLockUnchecked { $0.pairBodies.append(body) }
            (status, json) = onPair(body)
        } else if path.hasSuffix("/health") {
            let query = Dictionary((components?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, new in new })
            record.withLockUnchecked { $0.healthChecks.append(query) }
            (status, json) = onHealth(query)
        } else {
            (status, json) = (404, "")
        }
        let response = "HTTP/1.1 \(status) Answer\r\nContent-Type: application/json\r\nContent-Length: \(json.utf8.count)\r\nConnection: close\r\n\r\n\(json)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    private func upgrade(_ connection: NWConnection, _ request: Upgrade) {
        let index = record.withLockUnchecked { record in
            record.upgrades.append(request)
            return record.sockets.count
        }
        switch onUpgrade(request) {
        case .refuse(let status):
            let response = "HTTP/1.1 \(status) Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        case .accept:
            let key = request.headers["sec-websocket-key"] ?? ""
            let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
            let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(Data(digest).base64EncodedString())\r\n\r\n"
            let socket = Socket(upgrade: request, index: index, connection: connection)
            record.withLockUnchecked { $0.sockets.append(socket) }
            connection.send(content: Data(response.utf8), completion: .contentProcessed { [self] _ in
                onOpen(socket)
                readFrames(socket, buffer: Data())
            })
        }
    }

    private func readFrames(_ socket: Socket, buffer: Data) {
        socket.connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [self] data, _, done, error in
            var bytes = [UInt8](buffer)
            if let data { bytes += data }
            while let (opcode, payload, used) = Self.parse(bytes) {
                bytes.removeFirst(used)
                switch opcode {
                case 0x1:
                    let text = String(decoding: payload, as: UTF8.self)
                    record.withLockUnchecked { $0.texts.append(text) }
                    onText(socket, text)
                case 0x8:
                    return socket.connection.cancel()
                case 0x9:
                    socket.connection.send(content: Self.frame(opcode: 0xA, payload: payload), completion: .contentProcessed { _ in })
                default:
                    break
                }
            }
            if done || error != nil { return socket.connection.cancel() }
            readFrames(socket, buffer: Data(bytes))
        }
    }

    /// One client frame: opcode, unmasked payload, and how many bytes it used.
    private static func parse(_ bytes: [UInt8]) -> (UInt8, Data, Int)? {
        guard bytes.count >= 2 else { return nil }
        var length = Int(bytes[1] & 0x7F)
        var offset = 2
        if length == 126 {
            guard bytes.count >= 4 else { return nil }
            length = Int(bytes[2]) << 8 | Int(bytes[3])
            offset = 4
        } else if length == 127 {
            guard bytes.count >= 10 else { return nil }
            length = bytes[2..<10].reduce(0) { $0 << 8 | Int($1) }
            offset = 10
        }
        let masked = bytes[1] & 0x80 != 0
        let mask = masked && bytes.count >= offset + 4 ? Array(bytes[offset..<offset + 4]) : []
        if masked { offset += 4 }
        guard bytes.count >= offset + length else { return nil }
        var payload = Array(bytes[offset..<offset + length])
        if masked { for i in payload.indices { payload[i] ^= mask[i % 4] } }
        return (bytes[0] & 0x0F, Data(payload), offset + length)
    }

    fileprivate static func frame(opcode: UInt8, payload: Data) -> Data {
        var out = Data([0x80 | opcode])
        switch payload.count {
        case ..<126:
            out.append(UInt8(payload.count))
        case ..<65536:
            out.append(126)
            out.append(contentsOf: [UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)])
        default:
            out.append(127)
            out.append(contentsOf: stride(from: 56, through: 0, by: -8).map { UInt8((payload.count >> $0) & 0xFF) })
        }
        out.append(payload)
        return out
    }
}

extension FakeBridge {
    /// What the real bridge answers on /health for a paired device whose token is `token`.
    static func proving(_ token: String) -> @Sendable ([String: String]) -> (status: Int, body: String) {
        { query in
            let key = SymmetricKey(data: SHA256.hash(data: Data(token.utf8)))
            let proof = HMAC<SHA256>.authenticationCode(for: Data((query["nonce"] ?? "").utf8), using: key)
            let hex = proof.map { String(format: "%02x", $0) }.joined()
            return (200, #"{"ok":true,"proof":"\#(hex)"}"#)
        }
    }
}
