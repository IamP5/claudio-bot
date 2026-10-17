import Foundation
import Observation
import os

enum Backoff {
    /// 1, 2, 4, 8, 16, then 30 seconds for every later attempt.
    static func delay(afterFailures failures: Int) -> TimeInterval {
        min(30, pow(2, Double(min(failures, 5))))
    }
}

/// The last broadcast this app applied, so a reconnect asks the bridge to replay only what it missed.
struct StreamCursor: Equatable, Sendable {
    private(set) var epoch = ""
    private(set) var seq = 0

    mutating func observe(_ frame: ServerFrame) {
        if case .hello(let hello) = frame.message {
            // A resumed hello is followed by the frames after our seq, which advance it themselves.
            guard !(hello.position.resumed && hello.position.epoch == epoch) else { return }
            epoch = hello.position.epoch
            seq = hello.position.seq
        } else if let frameSeq = frame.seq {
            seq = frameSeq
        }
    }

    /// Empty when the bridge keeps no replay ring.
    var resumeQuery: [URLQueryItem] {
        epoch.isEmpty ? [] : [URLQueryItem(name: "epoch", value: epoch), URLQueryItem(name: "after", value: String(seq))]
    }
}

/// Owns the one WebSocket to the Mac bridge and feeds every frame into the store's reducer.
@Observable
@MainActor
final class BridgeClient {
    let store: AppStore
    @ObservationIgnored var onAlerts: ([Alert]) -> Void = { _ in }

    private(set) var pairing: Pairing?
    /// Why this phone was unpaired without the user asking, for the pairing screen.
    private(set) var unpairedReason: String?

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
    /// Kept across reconnects within one launch, because the store still holds what came before.
    @ObservationIgnored private var cursor: StreamCursor?
    @ObservationIgnored private let log = Logger(subsystem: "dev.claudiobot.app", category: "bridge")

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
        unpairedReason = nil
        cursor = nil
        loop = Task { [weak self] in await self?.run(pairing) }
    }

    func stop() {
        loop?.cancel()
        nap?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        loop = nil
        socket = nil
    }

    func unpair(reason: String? = nil) {
        stop()
        PairingVault.clear()
        pairing = nil
        cursor = nil
        unpairedReason = reason
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
            let outcome = await session(pairing)
            if Task.isCancelled { return }
            if outcome == .revoked {
                return unpair(reason: "This iPhone was removed from your Mac. Pair it again to reconnect.")
            }
            let greeted = outcome == .greeted
            if greeted { failures = 0 }
            let delay = Backoff.delay(afterFailures: failures)
            failures += 1
            store.setConnection(.disconnected(retryAt: .now + delay))
            let nap = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
            self.nap = nap
            await nap.value
        }
    }

    private enum Outcome { case greeted, failed, revoked }

    /// The bridge closes a revoked device's live socket with 4001, and answers its next upgrade with 401.
    nonisolated static func wasRevoked(closeCode: Int, upgradeStatus: Int?) -> Bool {
        closeCode == 4001 || upgradeStatus == 401
    }

    /// Runs one socket until it closes.
    private func session(_ pairing: Pairing) async -> Outcome {
        let ws = URLSession.shared.webSocketTask(with: pairing.socketRequest(resumingFrom: cursor))
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
            let received: URLSessionWebSocketTask.Message
            do {
                received = try await ws.receive()
            } catch {
                log.info("socket closed: \(error.localizedDescription)")
                if Self.wasRevoked(closeCode: ws.closeCode.rawValue, upgradeStatus: greeted ? nil : (ws.response as? HTTPURLResponse)?.statusCode) {
                    return .revoked
                }
                break
            }
            let data: Data
            switch received {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: continue
            }
            let frame: ServerFrame
            do {
                frame = try decoder.decode(ServerFrame.self, from: data)
            } catch {
                log.error("undecodable frame: \(error)")
                continue
            }
            let msg = frame.message
            cursor = cursor ?? StreamCursor()
            cursor?.observe(frame)
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
        return greeted ? .greeted : .failed
    }
}
