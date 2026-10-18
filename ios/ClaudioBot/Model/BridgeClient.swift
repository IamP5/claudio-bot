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
    enum Continuity: Equatable, Sendable { case inOrder, broken }

    private(set) var epoch = ""
    private(set) var seq = 0

    /// Every broadcast must carry the next seq. Anything else means frames were lost or replayed out of order, so
    /// the cursor forgets its position and the next connect gets a fresh hello instead of a replay.
    mutating func observe(_ frame: ServerFrame) -> Continuity {
        guard case .hello(let hello) = frame.message else { return advance(to: frame.seq) }
        // A resumed hello is followed by the frames after our seq, which advance it themselves.
        if !(hello.position.resumed && hello.position.epoch == epoch) {
            epoch = hello.position.epoch
            seq = hello.position.seq
        }
        return .inOrder
    }

    /// A frame the app could not decode still used up its seq, so skipping it is a gap.
    mutating func skipped(seq frameSeq: Int?) -> Continuity {
        guard frameSeq != nil, !epoch.isEmpty else { return .inOrder }
        self = StreamCursor()
        return .broken
    }

    private mutating func advance(to frameSeq: Int?) -> Continuity {
        // Replies to this client carry no seq. Without a replay ring there is no position to hold seqs to.
        guard let frameSeq, !epoch.isEmpty else { return .inOrder }
        guard frameSeq == seq + 1 else {
            self = StreamCursor()
            return .broken
        }
        seq = frameSeq
        return .inOrder
    }

    /// Empty when the bridge keeps no replay ring, or after a gap.
    var resumeQuery: [URLQueryItem] {
        epoch.isEmpty ? [] : [URLQueryItem(name: "epoch", value: epoch), URLQueryItem(name: "after", value: String(seq))]
    }
}

/// Owns the one WebSocket to the Mac bridge and feeds every frame into the store's reducer.
@Observable
@MainActor
final class BridgeClient {
    /// How long the client waits on the bridge. Tests shorten them.
    struct Timing: Sendable {
        var greeting: Duration = .seconds(10)
        var health: TimeInterval = 10
        var reply: Duration = .seconds(10)
        var legacyRetry: Duration = .seconds(600)
        /// A Stop queued offline for longer than this is dropped: by the time it arrives it would stop a later turn.
        var staleStop: TimeInterval = 60
    }

    /// Failed connects in a row after which the app offers to edit the address or pair again.
    static let failuresBeforeHelp = 3

    enum Ending: Equatable, Sendable { case greeted, failed, revoked, unrecognized }

    let store: AppStore
    @ObservationIgnored var onAlerts: ([Alert]) -> Void = { _ in }
    /// The client dropped everything from a Mac: the user unpaired, the Mac revoked this iPhone, or another bridge replaced it.
    @ObservationIgnored var onForget: () -> Void = {}

    private(set) var pairing: Pairing?
    /// Why this phone was unpaired without the user asking, for the pairing screen.
    private(set) var unpairedReason: String?
    /// Connects in a row that ended without a hello. A hello resets it.
    private(set) var failures = 0

    /// The bot on screen. It is opened now and again after every reconnect, which also marks it read.
    var openBot: BotID? {
        didSet {
            guard let openBot, openBot != oldValue else { return }
            transmitIfConnected(.open(botId: openBot))
        }
    }

    /// Whether the Sessions list is on screen. It is watched now and again after every hello, and unwatched when it goes.
    var watchingSessions = false {
        didSet {
            guard watchingSessions != oldValue, store.has(.sessions) else { return }
            transmitIfConnected(watchingSessions ? .watchSessions : .unwatchSessions)
        }
    }

    /// The session thread on screen. Watched now and again after every hello with the position the app holds;
    /// leaving it unwatches it, which marks it visited.
    var openSession: SessionID? {
        didSet {
            guard openSession != oldValue else { return }
            if let oldValue, store.has(.sessions) { transmitIfConnected(.unwatchSession(sessionId: oldValue)) }
            guard let openSession else { return }
            store.threads.open(openSession)
            if store.has(.sessions) { watchThreadIfConnected(openSession) }
        }
    }

    /// Whether someone is looking at this app, sent after every hello and on every change to a bridge with presence.
    /// nil never sends one, so the bridge counts the socket as attended: the iPhone leaves it nil.
    var attended: Bool? {
        didSet {
            guard let attended, attended != oldValue, store.has(.presence) else { return }
            transmitIfConnected(.presence(attended: attended))
        }
    }

    @ObservationIgnored private let vault: PairingVault
    @ObservationIgnored private let deviceName: String
    @ObservationIgnored private let timing: Timing
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var nap: Task<Void, Never>?
    @ObservationIgnored private var upgrade: Task<Void, Never>?
    @ObservationIgnored private var pairCodeReply: (@Sendable (PairCode?) -> Void)?
    /// What the user did offline, with when, sent after the next hello.
    @ObservationIgnored private var outbox: [(message: ClientMessage, at: Date)] = []
    /// Kept across reconnects to one bridge, because the store still holds what came before.
    @ObservationIgnored private var cursor = StreamCursor()
    @ObservationIgnored private let log = Logger(subsystem: "dev.claudiobot.app", category: "bridge")

    init(store: AppStore, vault: PairingVault = .app, deviceName: String = "iPhone", timing: Timing = Timing()) {
        self.store = store
        self.vault = vault
        self.deviceName = deviceName
        self.timing = timing
    }

    /// Gives a notification action launched in the background a few seconds to reconnect and flush.
    func waitUntilSent(timeout: Duration = .seconds(5)) async {
        let deadline = ContinuousClock.now + timeout
        while !outbox.isEmpty, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Connects with `pairing`. Another bridge starts from an empty store, so nothing from the old Mac lingers.
    func start(_ pairing: Pairing) {
        stop()
        if let current = self.pairing, current.url != pairing.url {
            store.setConnection(.unpaired)
            outbox.removeAll()
            cursor = StreamCursor()
            onForget()
        }
        self.pairing = pairing
        unpairedReason = nil
        store.setConnection(.connecting)
        loop = Task { [weak self] in await self?.run() }
    }

    func stop() {
        loop?.cancel()
        nap?.cancel()
        upgrade?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        loop = nil
        nap = nil
        upgrade = nil
        socket = nil
        answerPairCode(nil)
    }

    /// Redeems the code, then keeps the current pairing until the new bridge says hello. On any failure nothing changes.
    func pair(_ invite: PairInvite) async throws {
        let candidate = try await Pairing.redeem(invite, deviceName: deviceName)
        try await candidate.greet(within: timing.greeting)
        try vault.save(candidate)
        start(candidate)
    }

    /// Points this pairing at another address of the same Mac, such as its Tailscale name. The token goes to the new
    /// address only after whatever answers there proves it is the bridge that issued it, and the address is saved
    /// only once that bridge says hello.
    func changeAddress(to url: URL) async throws {
        guard let current = pairing, url != current.url else { return }
        try await current.proveBridge(at: url, timeout: timing.health)
        let moved = Pairing(url: url, credential: current.credential)
        do {
            try await moved.greet(within: timing.greeting)
        } catch {
            throw Pairing.AddressChange.unreachable(url)
        }
        try vault.save(moved)
        // Set first, so start() sees the same bridge and keeps what the store holds.
        pairing = moved
        start(moved)
    }

    /// Revokes this iPhone on the bridge first when it can, so the token is dead even if the phone is lost later.
    func unpair() async {
        if case .device(let id, _)? = pairing?.credential, let socket, store.machine != nil {
            let revoke = ClientMessage.revokeDevice(deviceId: id)
            _ = await reply(within: timing.reply) { (done: @escaping @Sendable (Bool?) -> Void) in
                transmit(revoke, on: socket) { done($0) }
            }
        }
        forget(reason: nil)
    }

    /// Tries a bridge that did not recognize this iPhone again, for example back on the home network.
    func retry() {
        if store.connection == .unrecognized, let pairing { start(pairing) }
    }

    /// Skips the remaining backoff, for example when the app returns to the foreground.
    func reconnectNow() {
        nap?.cancel()
        retry()
    }

    /// Sends now when connected; otherwise holds the message until the next hello.
    func send(_ msg: ClientMessage) {
        if case let .decide(_, card, choice) = msg { store.decisionSent(choice, for: card) }
        if case let .sessionDecide(_, card, choice) = msg { store.decisionSent(choice, for: card) }
        #if DEBUG
        if Demo.isEnabled { return Demo.respond(to: msg, store: store) }
        #endif
        if let socket, store.machine != nil {
            transmitCounted(msg, on: socket)
        } else {
            outbox.append((msg, .now))
        }
    }

    /// Pull to refresh: the bridge answers a repeated watch with a fresh list.
    func refreshSessions() {
        if store.has(.sessions) { transmitIfConnected(.watchSessions) }
    }

    /// Whether a message queued offline still means what the user meant. A Stop is for the turn on screen when it was
    /// tapped; a minute later it would stop whatever turn runs by then.
    nonisolated static func stillWanted(_ msg: ClientMessage, queuedAt: Date, now: Date, staleStop: TimeInterval) -> Bool {
        switch msg {
        case .stop, .stopAgent: now.timeIntervalSince(queuedAt) <= staleStop
        default: true
        }
    }

    private func forget(reason: String?) {
        stop()
        vault.clear()
        pairing = nil
        cursor = StreamCursor()
        unpairedReason = reason
        outbox.removeAll()
        store.setConnection(.unpaired)
        onForget()
    }

    private func transmitIfConnected(_ msg: ClientMessage) {
        #if DEBUG
        if Demo.isEnabled { return Demo.respond(to: msg, store: store) }
        #endif
        if let socket, store.machine != nil { transmit(msg, on: socket) }
    }

    private func watchThreadIfConnected(_ id: SessionID) {
        #if DEBUG
        if Demo.isEnabled { return Demo.respond(to: .watchSession(sessionId: id, after: nil), store: store) }
        #endif
        if let socket, store.machine != nil { watchThread(id, on: socket) }
    }

    /// The live text goes at the moment the watch is sent: the reply resends any streaming text from offset 0.
    private func watchThread(_ id: SessionID, on socket: URLSessionWebSocketTask) {
        transmit(.watchSession(sessionId: id, after: store.threads.willWatch(id)), on: socket)
    }

    /// A send's frame counts toward giving up its resends only once a socket took it.
    private func transmitCounted(_ msg: ClientMessage, on socket: URLSessionWebSocketTask) {
        guard case .send = msg else { return transmit(msg, on: socket) }
        let store = store
        transmit(msg, on: socket) { ok in
            if ok { Task { @MainActor in store.sendTransmitted(msg) } }
        }
    }

    private func transmit(_ msg: ClientMessage, on socket: URLSessionWebSocketTask, sent: @escaping @Sendable (Bool) -> Void = { _ in }) {
        guard let data = try? Wire.encoder().encode(msg) else { return }
        let log = log
        let store = store
        socket.send(.string(String(decoding: data, as: UTF8.self))) { error in
            if let error {
                log.error("send failed: \(error.localizedDescription)")
                switch msg {
                case .decide(_, let card, _), .sessionDecide(_, let card, _): Task { @MainActor in store.decisionFailed(for: card) }
                default: break
                }
            }
            sent(error == nil)
        }
    }

    private func run() async {
        failures = 0
        while !Task.isCancelled, let pairing {
            store.setConnection(.connecting)
            let ending = await session(pairing)
            if Task.isCancelled { return }
            switch ending {
            case .revoked:
                return forget(reason: "This \(ThisDevice.noun) was removed from your Mac. Pair it again to reconnect.")
            case .unrecognized:
                return store.setConnection(.unrecognized)
            case .greeted:
                failures = 0
            case .failed:
                break
            }
            let delay = Backoff.delay(afterFailures: failures)
            if ending == .failed { failures += 1 }
            store.setConnection(.disconnected(retryAt: .now + delay))
            let nap = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
            self.nap = nap
            await nap.value
        }
    }

    /// Only the bridge's revoked close (4001) unpairs. A 401 on the upgrade may come from another server on
    /// whatever network the phone is on, so it keeps the pairing and waits for the user.
    nonisolated static func ending(greeted: Bool, closeCode: Int, upgradeStatus: Int?) -> Ending {
        if closeCode == 4001 { return .revoked }
        if !greeted, upgradeStatus == 401 { return .unrecognized }
        return greeted ? .greeted : .failed
    }

    /// The seq of a frame the app could not decode, if it has one.
    nonisolated static func seq(in data: Data) -> Int? {
        struct Stamp: Decodable { let seq: Int? }
        return (try? JSONDecoder().decode(Stamp.self, from: data))?.seq
    }

    /// Runs one socket until it closes, or until the stream shows a gap.
    private func session(_ pairing: Pairing) async -> Ending {
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
                return Self.ending(greeted: greeted, closeCode: ws.closeCode.rawValue, upgradeStatus: (ws.response as? HTTPURLResponse)?.statusCode)
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
                if cursor.skipped(seq: Self.seq(in: data)) == .broken { break }
                continue
            }
            guard cursor.observe(frame) == .inOrder else {
                log.info("stream gap; reconnecting for a fresh hello")
                break
            }
            let msg = frame.message
            let alerts = store.apply(msg)
            switch msg {
            case .hello:
                greeted = true
                if let attended, store.has(.presence) { transmit(.presence(attended: attended), on: ws) }
                if let openBot { transmit(.open(botId: openBot), on: ws) }
                // Facts bots propose show as a badge and in their chats, so the app keeps them live from the start.
                if store.has(.memory) { transmit(.memory, on: ws) }
                // Before the outbox, so a send made offline lands after the thread's snapshot, not before it.
                if store.has(.sessions) {
                    if watchingSessions { transmit(.watchSessions, on: ws) }
                    if let openSession { watchThread(openSession, on: ws) }
                }
                let resent = store.resendsAfterHello()
                resent.forEach { transmitCounted($0, on: ws) }
                let pending = outbox
                outbox.removeAll()
                let now = Date.now
                pending
                    .filter { !resent.contains($0.message) && Self.stillWanted($0.message, queuedAt: $0.at, now: now, staleStop: timing.staleStop) }
                    .forEach { send($0.message) }
                upgradeLegacyPairing()
            case .bot(let bot) where bot.id == openBot && bot.unread > 0:
                // The bridge counts a message as unread until the next open, so re-open the bot on screen.
                transmit(.open(botId: bot.id), on: ws)
            case .pairCode(let code):
                answerPairCode(code)
            default:
                break
            }
            onAlerts(alerts)
        }
        return greeted ? .greeted : .failed
    }

    /// A phone paired before protocol 3 trades the shared token for its own, over its own socket and against its
    /// own bridge. Until that works it keeps the legacy pairing and tries again later.
    private func upgradeLegacyPairing() {
        guard upgrade == nil, case .legacy? = pairing?.credential, store.bridgeManagesDevices else { return }
        upgrade = Task { [weak self] in await self?.upgradeLoop() }
    }

    private func upgradeLoop() async {
        while !Task.isCancelled, let legacy = pairing, case .legacy = legacy.credential {
            if let upgraded = await tradeLegacyToken(legacy), !Task.isCancelled {
                do {
                    try vault.save(upgraded)
                    pairing = upgraded
                    upgrade = nil
                    // The run loop reconnects with the new pairing, so the next upgrade carries a Bearer token.
                    socket?.cancel(with: .goingAway, reason: nil)
                    return
                } catch {
                    log.error("could not save the upgraded pairing: \(error.localizedDescription)")
                }
            }
            try? await Task.sleep(for: timing.legacyRetry)
        }
    }

    private func tradeLegacyToken(_ legacy: Pairing) async -> Pairing? {
        guard let socket, store.machine != nil else { return nil }
        let code = await reply(within: timing.reply) { finish in
            pairCodeReply = finish
            transmit(.pairCode, on: socket)
        }
        pairCodeReply = nil
        guard let code else { return nil }
        return try? await Pairing.redeem(PairInvite(url: legacy.url, code: code.code), deviceName: deviceName)
    }

    private func answerPairCode(_ code: PairCode?) {
        let reply = pairCodeReply
        pairCodeReply = nil
        reply?(code)
    }
}

/// Waits for `start`'s callback or for `timeout`, whichever comes first. The callback may fire late, or never.
@MainActor
private func reply<T: Sendable>(within timeout: Duration, _ start: (@escaping @Sendable (T?) -> Void) -> Void) async -> T? {
    await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
        let waiting = OSAllocatedUnfairLock<CheckedContinuation<T?, Never>?>(initialState: continuation)
        let finish: @Sendable (T?) -> Void = { value in
            let pending = waiting.withLock { pending in
                defer { pending = nil }
                return pending
            }
            pending?.resume(returning: value)
        }
        start(finish)
        Task {
            try? await Task.sleep(for: timeout)
            finish(nil)
        }
    }
}
