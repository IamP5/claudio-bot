import Foundation
import Observation
import os

enum Backoff {
    /// 1, 2, 4, 8, 16, then 30 seconds for every later attempt.
    static func delay(afterFailures failures: Int) -> TimeInterval {
        min(30, pow(2, Double(min(failures, 5))))
    }
}

/// Owns the one WebSocket to the Mac bridge and feeds every frame into the store's reducer.
@Observable
@MainActor
final class BridgeClient {
    let store: AppStore
    @ObservationIgnored var onAlerts: ([Alert]) -> Void = { _ in }

    private(set) var pairing: Pairing?

    /// The bot on screen. It is opened now and again after every reconnect, which also marks it read.
    var openBot: BotID? {
        didSet {
            guard let openBot, openBot != oldValue else { return }
            transmitIfConnected(.open(botId: openBot))
        }
    }

    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var nap: Task<Void, Never>?
    @ObservationIgnored private var outbox: [ClientMessage] = []
    @ObservationIgnored private let log = Logger(subsystem: "dev.claudebot.app", category: "bridge")

    init(store: AppStore) {
        self.store = store
    }

    /// Gives a notification action launched in the background a few seconds to reconnect and flush.
    func waitUntilSent(timeout: Duration = .seconds(5)) async {
        let deadline = ContinuousClock.now + timeout
        while !outbox.isEmpty, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    func start(_ pairing: Pairing) {
        stop()
        self.pairing = pairing
        loop = Task { [weak self] in await self?.run(pairing) }
    }

    func stop() {
        loop?.cancel()
        nap?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        loop = nil
        socket = nil
    }

    func unpair() {
        stop()
        PairingVault.clear()
        pairing = nil
        outbox.removeAll()
        store.setConnection(.unpaired)
    }

    /// Skips the remaining backoff, for example when the app returns to the foreground.
    func reconnectNow() {
        nap?.cancel()
    }

    /// Sends now when connected; otherwise holds the message until the next hello.
    func send(_ msg: ClientMessage) {
        #if DEBUG
        if Demo.isEnabled { return Demo.respond(to: msg, store: store) }
        #endif
        if let socket, store.machine != nil {
            transmit(msg, on: socket)
        } else {
            outbox.append(msg)
        }
    }

    private func transmitIfConnected(_ msg: ClientMessage) {
        if let socket, store.machine != nil { transmit(msg, on: socket) }
    }

    private func transmit(_ msg: ClientMessage, on socket: URLSessionWebSocketTask) {
        guard let data = try? Wire.encoder().encode(msg) else { return }
        let log = log
        socket.send(.string(String(decoding: data, as: UTF8.self))) { error in
            if let error { log.error("send failed: \(error.localizedDescription)") }
        }
    }

    private func run(_ pairing: Pairing) async {
        var failures = 0
        while !Task.isCancelled {
            store.setConnection(.connecting)
            let greeted = await session(pairing)
            if Task.isCancelled { return }
            if greeted { failures = 0 }
            let delay = Backoff.delay(afterFailures: failures)
            failures += 1
            store.setConnection(.disconnected(retryAt: .now + delay))
            let nap = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
            self.nap = nap
            await nap.value
        }
    }

    /// Runs one socket until it closes. Returns whether the bridge said hello.
    private func session(_ pairing: Pairing) async -> Bool {
        let ws = URLSession.shared.webSocketTask(with: pairing.socketURL)
        ws.maximumMessageSize = 32 << 20
        socket = ws
        ws.resume()
        let pinger = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                ws.sendPing { error in
                    if error != nil { ws.cancel(with: .goingAway, reason: nil) }
                }
            }
        }
        defer {
            pinger.cancel()
            ws.cancel(with: .goingAway, reason: nil)
            if socket === ws { socket = nil }
        }

        let decoder = Wire.decoder()
        var greeted = false
        while !Task.isCancelled {
            let frame: URLSessionWebSocketTask.Message
            do {
                frame = try await ws.receive()
            } catch {
                log.info("socket closed: \(error.localizedDescription)")
                break
            }
            let data: Data
            switch frame {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: continue
            }
            let msg: ServerMessage
            do {
                msg = try decoder.decode(ServerMessage.self, from: data)
            } catch {
                log.error("undecodable frame: \(error)")
                continue
            }
            let alerts = store.apply(msg)
            if case .hello = msg {
                greeted = true
                if let openBot { transmit(.open(botId: openBot), on: ws) }
                let pending = outbox
                outbox.removeAll()
                pending.forEach { transmit($0, on: ws) }
            }
            // The bridge counts a message as unread until the next open, so re-open the bot on screen.
            if case .bot(let bot) = msg, bot.id == openBot, bot.unread > 0 {
                transmit(.open(botId: bot.id), on: ws)
            }
            onAlerts(alerts)
        }
        return greeted
    }

    enum ProbeError: LocalizedError {
        case timeout, notABridge, refused(String)

        var errorDescription: String? {
            switch self {
            case .timeout: "The bridge did not answer. Check the address and that your phone is on the same network or tailnet."
            case .notABridge: "Something answered, but it is not a ClaudeBot bridge."
            case .refused(let reason): "Could not connect: \(reason)"
            }
        }
    }

    /// Opens a throwaway socket and waits for hello, so a bad address or token fails before it is saved.
    static func probe(_ pairing: Pairing) async throws -> String {
        let ws = URLSession.shared.webSocketTask(with: pairing.socketURL)
        ws.resume()
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                let frame: URLSessionWebSocketTask.Message
                do {
                    frame = try await ws.receive()
                } catch let error as URLError where error.code == .badServerResponse {
                    throw ProbeError.refused("the bridge rejected the token.")
                } catch {
                    throw ProbeError.refused(error.localizedDescription)
                }
                let data: Data = switch frame {
                case .string(let text): Data(text.utf8)
                case .data(let bytes): bytes
                @unknown default: Data()
                }
                guard case .hello(let machine, _, _) = try? Wire.decoder().decode(ServerMessage.self, from: data) else {
                    throw ProbeError.notABridge
                }
                return machine
            }
            group.addTask {
                try await Task.sleep(for: .seconds(8))
                ws.cancel(with: .goingAway, reason: nil)
                throw ProbeError.timeout
            }
            defer { group.cancelAll() }
            guard let machine = try await group.next() else { throw ProbeError.timeout }
            return machine
        }
    }
}
