import Foundation
import Observation

enum ConnectionState: Equatable, Sendable {
    case unpaired
    case connecting
    /// Set only by the bridge's hello, so "connected" means the token was accepted. `quietSince` is when the bridge
    /// last sent anything, set only once that is too long ago while a thread on screen is working; nil otherwise.
    case connected(machine: String, quietSince: Date? = nil)
    case disconnected(retryAt: Date)
    /// The bridge answered with 401. It may be another server on this network, so the pairing stays until the user acts.
    case unrecognized
}

/// A conversation in arrival order, upserted by message id.
struct Conversation: Equatable, Sendable {
    private(set) var messages: [Message] = []
    private var positions: [MessageID: Int] = [:]

    init(_ messages: [Message] = []) {
        for message in messages { upsert(message) }
    }

    subscript(id: MessageID) -> Message? {
        positions[id].map { messages[$0] }
    }

    /// Returns whether anything changed, so a replayed message reports false.
    @discardableResult
    mutating func upsert(_ message: Message) -> Bool {
        if let at = positions[message.id] {
            guard messages[at] != message else { return false }
            messages[at] = message
        } else {
            positions[message.id] = messages.count
            messages.append(message)
        }
        return true
    }
}

/// Something worth a local notification: a bot's new message or card, or a session the bridge sent no push for.
enum Alert: Equatable, Sendable {
    enum Reason: Equatable, Sendable {
        case message(String)
        case question(id: MessageID, question: String, options: [String])
        case permission(id: MessageID, label: String)
    }

    case bot(Bot, Reason)
    case session(SessionAlert)
}

struct BotDetails: Equatable, Sendable {
    var library: [LibraryFile]
    var links: [BotLink]
    var agents: [Agent]
    var routines: [Routine]
}

struct AgentThread: Equatable, Sendable {
    var agent: Agent
    var messages: [AgentMessage]
}

/// Whose activity line: a bot's own (agentId nil) or one of its agents'.
struct ActivityKey: Hashable, Sendable {
    let botId: BotID
    let agentId: AgentID?
}

/// The messages between a bot and another bot, behind the exchange lines in the bot's chat.
struct ExchangeKey: Hashable, Sendable {
    let botId: BotID
    let peer: BotID
}

struct FileKey: Hashable, Sendable {
    let botId: BotID
    let path: String
}

/// A decision or answer this phone sent for one card (F-SES-142).
struct CardDecision: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        /// On its way, on a bridge that acks: nobody can say yet whether it landed.
        case sending
        /// The Mac took it from this phone.
        case taken
        /// It went on a socket that dropped before the Mac said whether it took it.
        case unsure
        /// It did not count, for this reason.
        case failed(DecisionNote)
    }

    /// nil: an answer to a question.
    let choice: PermissionChoice?
    var phase: Phase
    /// The card's buttons wait for it to close, with a spinner on the one tapped.
    var holds: Bool
    /// When it was tapped.
    let at: Date
    /// An earlier tap on this card went out and nobody can say whether it landed. A refusal of this one as already
    /// answered may be that earlier tap's doing, so the card is never said to be answered elsewhere.
    var earlierMayHaveLanded = false

    mutating func fail(_ note: DecisionNote) {
        phase = .failed(note)
        holds = false
    }
}

/// Why a card's last decision did not count. The card says it, and takes a tap again.
enum DecisionNote: Equatable, Sendable {
    /// The socket refused the frame.
    case notSent
    /// It waited offline past the age a decision still means what the user meant.
    case tooLate
    /// The Mac refused it, in its words.
    case refused(String)
    /// Nobody can say whether it landed: the socket dropped, or no ack came within AppStore.decisionPatience.
    case unsure

    var text: String {
        switch self {
        case .unsure: "Your answer may not have reached your Mac · Tap again"
        case .notSent: "Not sent · Try again"
        case .tooLate: "Not sent: your Mac was unreachable · Try again"
        case .refused(let why): why.localizedCaseInsensitiveContains("already answered") ? "Already answered" : why.hasSuffix(".") ? why : why + "."
        }
    }
}

struct ErrorNotice: Equatable, Sendable, Identifiable {
    let id = UUID()
    let message: String
}

/// The bridge speaks a protocol outside `Wire.protocols`, so one side needs an update.
enum ProtocolMismatch: Equatable, Sendable {
    case updateBridge, updateApp

    init?(bridge: Int) {
        guard !Wire.protocols.contains(bridge) else { return nil }
        self = bridge < Wire.protocols.lowerBound ? .updateBridge : .updateApp
    }
}

// The bridge closes a card when its deadline passes. Until that frame arrives, a deadline already
// past reads as expired, so nobody taps a button the bridge will refuse.
extension QuestionCard {
    func answer(at now: Date) -> Answer? {
        if answer == nil, let expiresAt, now >= expiresAt { return .expired }
        return answer
    }
}

extension PermissionCard {
    func answer(at now: Date) -> PermissionAnswer? {
        if answer == nil, now >= expiresAt { return .expired }
        return answer
    }
}

@Observable
@MainActor
final class AppStore {
    private(set) var connection: ConnectionState = .unpaired
    private(set) var userName = ""
    private(set) var bots: [BotID: Bot] = [:]
    private(set) var conversations: [BotID: Conversation] = [:]
    private(set) var details: [BotID: BotDetails] = [:]
    private(set) var agents: [AgentID: AgentThread] = [:]
    private(set) var files: [FileKey: BotFile] = [:]
    /// The bot each `create_bot` ref became, so the screen that asked can open it.
    private(set) var created: [String: BotID] = [:]
    private(set) var lastError: ErrorNotice?
    private(set) var protocolMismatch: ProtocolMismatch?
    /// From the last hello. Nil until this pairing has connected once.
    private(set) var bridgeProtocol: Int?
    /// The decisions and answers this phone sent, by card. They outlive the card's view and a reconnect, so a card
    /// closing is announced as this phone's answer, another device's, or one this phone cannot vouch for.
    private(set) var decisions: [MessageID: CardDecision] = [:]
    /// Session create requests the Mac refused, by ref, in its words.
    private(set) var createRefusals: [String: String] = [:]
    /// The phones paired with this Mac, once Settings asked for them.
    private(set) var devices: [Device]?
    /// Device lists heard, so a view sees every reply, even one that repeats the list.
    private(set) var devicesHeard = 0
    /// When the bridge's last frame was applied, by this device's clock. A screen that loses the Mac shows what it
    /// knew then. Not observed: it changes with every frame, and only a change of connection asks for it.
    @ObservationIgnored private(set) var heardAt: Date?
    /// The newest code for pairing another phone.
    private(set) var pairCode: PairCode?
    /// From the last hello. Empty for a bridge from before features.
    private(set) var features: Set<Feature> = []
    /// What each bot or agent is doing right now. Live only: cleared by every hello.
    private(set) var activity: [ActivityKey: String] = [:]
    /// USER.md's facts, once Memory asked for them.
    private(set) var facts: [Fact]?
    private(set) var connectors: [BotID: [Connector]] = [:]
    private(set) var skills: [BotID: [Skill]] = [:]
    /// Each bot's "/" menu, once its chat asked for it.
    private(set) var commands: [BotID: [Command]] = [:]
    /// What two bots said to each other, once an exchange line was opened.
    private(set) var exchanges: [ExchangeKey: [ExchangeMessage]] = [:]
    /// The newest webhook token, shown once and then dismissed.
    private(set) var webhookToken: WebhookToken?
    /// The plan's usage limits as the bridge last read them. Kept while offline: its fetchedAt says how old it is.
    private(set) var usage: PlanUsage?
    /// Whether pushes reach the phone while the app is away, from hello and push_state. nil: the bridge does not say.
    private(set) var pushState: PushState?
    /// Stops this phone asked for in each session, by what they stop, until the session rests. The composer and the
    /// background work sheet both read them, so a refusal shows on the control that asked.
    private(set) var stops: [SessionID: [StopTarget: StopRequest]] = [:]
    /// Model and mode changes in flight, until controls carry the new value or the Mac refuses it.
    private(set) var sets: [SessionID: SetRequest] = [:]
    /// What the Mac refused in a session, shown under its composer until dismissed.
    private(set) var sessionErrors: [SessionID: SessionError] = [:]
    /// Sends the bridge has not echoed back yet, oldest first, each with how many times a socket took it and when it was
    /// tapped. In memory only: quitting the app forgets them.
    private(set) var unechoedSends: [(message: ClientMessage, transmitted: Int, at: Date)] = []
    /// The Claude app setting before this phone changed it, while the change is not confirmed, so a change that never
    /// went can put it back.
    @ObservationIgnored private var mirrorAsked: MirrorChange?
    /// Why the Claude app setting went back, shown beside it until the next change.
    private(set) var mirrorNote: String?
    /// Settings is on screen, so the mirror note beside the picker is seen and spoken there. Elsewhere it needs a toast.
    @ObservationIgnored var settingsShown = false

    private struct MirrorChange {
        let before: MirrorPref?
    }
    /// The Sessions list. Its own observable, so a list diff never re-renders a reader of the bots.
    let sessions = SessionIndex()
    let threads = SessionThreads()

    func has(_ feature: Feature) -> Bool {
        features.contains(feature)
    }

    /// The bridge said hello without this feature, so the screen that needs it says to update the bridge.
    func lacks(_ feature: Feature) -> Bool {
        bridgeProtocol != nil && !features.contains(feature)
    }

    func dismissWebhookToken() {
        webhookToken = nil
    }

    var machine: String? {
        if case .connected(let machine, _) = connection { machine } else { nil }
    }

    /// Paired devices, pairing codes and Bearer tokens arrived with protocol 3.
    var bridgeManagesDevices: Bool {
        (bridgeProtocol ?? 0) >= 3
    }

    /// A reconnect the app chose while the Mac answered: back on screen after a while away, a new network, a probe
    /// with no pong. For `rejoinGrace` the list stays as it was, as the thread does (P-CONN-4). Then it says it is
    /// reconnecting and its rows are last known, until the first failed try says the Mac is out of reach. Tries the
    /// app restarts itself never fail, so after `rejoinPatience` the reconnect counts as lost all the same.
    enum Rejoin: Equatable, Sendable { case grace, showing }

    static let rejoinGrace: Duration = .milliseconds(400)
    static let rejoinPatience: Duration = .seconds(10)

    private(set) var rejoin: Rejoin?
    @ObservationIgnored private var rejoinClock: Task<Void, Never>?

    /// Screens may show what they hold as current: the Mac answers, or a reconnect the app chose is still in its grace.
    var showsOnline: Bool {
        machine != nil || rejoin == .grace
    }

    /// Transport changes from the client. Unpairing forgets everything the Mac sent.
    func setConnection(_ state: ConnectionState) {
        let rejoining = state == .connecting && (machine != nil || rejoin != nil)
        connection = state
        if !rejoining {
            endRejoin()
        } else if rejoin == nil {
            rejoin = .grace
            rejoinClock = Task { [weak self] in
                try? await Task.sleep(for: Self.rejoinGrace)
                guard let self, !Task.isCancelled, rejoin == .grace else { return }
                rejoin = .showing
                sessions.markStale()
                try? await Task.sleep(for: Self.rejoinPatience)
                if !Task.isCancelled, rejoin == .showing { rejoin = nil }
            }
        }
        if machine == nil && rejoin != .grace { sessions.markStale() }
        if state == .unpaired {
            userName = ""
            bots = [:]
            conversations = [:]
            details = [:]
            agents = [:]
            files = [:]
            created = [:]
            protocolMismatch = nil
            bridgeProtocol = nil
            decisions = [:]
            decided = []
            createRefusals = [:]
            devices = nil
            pairCode = nil
            features = []
            activity = [:]
            facts = nil
            connectors = [:]
            skills = [:]
            commands = [:]
            exchanges = [:]
            webhookToken = nil
            usage = nil
            pushState = nil
            unechoedSends = []
            mirrorAsked = nil
            mirrorNote = nil
            stops = [:]
            sets = [:]
            sessionErrors = [:]
            sessions.reset()
            threads.reset()
        }
    }

    private func endRejoin() {
        rejoin = nil
        rejoinClock?.cancel()
        rejoinClock = nil
    }

    /// A frame sent on a socket that dropped may never have arrived, so a send stays here until its echo. A bot's send
    /// needs a bridge that drops a repeated clientId, which came with mute; every bridge with sessions drops a repeated
    /// session send. A Retry of one still held starts its age again.
    func sendStarted(_ msg: ClientMessage, at now: Date = .now) {
        if case let .sessionSend(sessionId, _, clientId, _, _) = msg { threads[sessionId]?.sendWaiting(clientId) }
        guard Self.clientId(of: msg) != nil else { return }
        if let i = unechoedSends.firstIndex(where: { $0.message == msg }) { return unechoedSends[i].at = now }
        if case .send = msg, !has(.mute) { return }
        unechoedSends.append((msg, 0, now))
    }

    /// The user gave up on a session send the Mac never showed back.
    func discardSend(sessionId: SessionID, clientId: String) {
        unechoedSends.removeAll { Self.clientId(of: $0.message) == clientId }
        threads[sessionId]?.discardSend(clientId)
    }

    /// A socket took the frame. Only these count toward giving up, so a send made offline survives any number of
    /// reconnects that drop before it goes out.
    func sendTransmitted(_ msg: ClientMessage, at now: Date = .now) {
        guard let i = unechoedSends.firstIndex(where: { $0.message == msg }) else { return }
        unechoedSends[i].transmitted += 1
        if case let .sessionSend(sessionId, _, clientId, _, _) = msg { threads[sessionId]?.sendTransmitted(clientId, at: now) }
    }

    /// What to send again on the socket that just said hello, with the same clientIds. A send three sockets took
    /// without an echo is given up, so one the bridge refuses is not repeated forever. A session send goes again only
    /// within OutboxRule.maxAge of the tap; after that only the user's Retry sends it.
    func resendsAfterHello(now: Date = .now) -> [ClientMessage] {
        unechoedSends.removeAll { pending in
            switch pending.message {
            // The bridge drops a repeated clientId from the same release that added mute; an older one would post it twice.
            case .send(let botId, _, _, _, _): !has(.mute) || bots[botId] == nil || pending.transmitted >= 3
            case .sessionSend:
                !has(.sessions) || pending.transmitted >= 3 || now.timeIntervalSince(pending.at) > OutboxRule.maxAge
            default: true
            }
        }
        return unechoedSends.map(\.message)
    }

    private static func clientId(of msg: ClientMessage) -> String? {
        switch msg {
        case .send(_, _, _, let clientId, _): clientId
        case .sessionSend(_, _, let clientId, _, _): clientId
        default: nil
        }
    }

    /// The session sends a thread frame shows back are no longer owed a resend.
    private func settleSends(_ sessionId: SessionID, _ frame: ThreadFrame) {
        let shown: Set<ItemID> = switch frame {
        case .snapshot(let snapshot): ThreadModel.clientIds(snapshot.items, removed: [])
        case let .items(_, items, removed, _): ThreadModel.clientIds(items, removed: removed)
        case let .page(items, _): ThreadModel.clientIds(items, removed: [])
        case .delta, .toolOutput, .removed: []
        }
        guard !shown.isEmpty else { return }
        unechoedSends.removeAll { pending in
            if case let .sessionSend(id, _, clientId, _, _) = pending.message { id == sessionId && shown.contains(ItemID(clientId)) } else { false }
        }
    }

    /// The buttons hold until the card closes. On a bridge that acks decisions, the Mac's ack makes it this phone's;
    /// on one that does not, the socket taking it does, as before.
    func decisionSent(_ choice: PermissionChoice?, for card: MessageID, at now: Date = .now) {
        let acks = has(.decideAck)
        let earlier = decisions[card].map { $0.phase == .unsure || $0.earlierMayHaveLanded } ?? false
        decisions[card] = CardDecision(choice: choice, phase: acks ? .sending : .taken, holds: true, at: now, earlierMayHaveLanded: earlier)
        decided.removeAll { $0 == card }
        decided.append(card)
        // The newest are enough: a card's close is announced within seconds, and a push link names a recent card.
        while decided.count > Self.decisionsKept { decisions[decided.removeFirst()] = nil }
        guard acks else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.decisionPatience))
            self?.lapseDecisions(at: .now)
        }
    }

    static let decisionsKept = 200
    /// How long a decision may wait for its ack before nobody can say whether it landed (F-SES-229).
    static let decisionPatience: TimeInterval = 10

    /// Decisions with no ack within the patience: the card takes a tap again and says why.
    func lapseDecisions(at now: Date) {
        for (card, decision) in decisions where decision.phase == .sending && now.timeIntervalSince(decision.at) >= Self.decisionPatience {
            decisions[card]?.phase = .unsure
            decisions[card]?.holds = false
        }
    }
    /// The cards in `decisions`, oldest first.
    @ObservationIgnored private var decided: [MessageID] = []

    /// The socket refused the frame, so the buttons come back and the card says it was not sent.
    func decisionFailed(for card: MessageID) {
        decisions[card]?.fail(.notSent)
    }

    /// The choice on its way for an open card, which holds its buttons.
    var pendingDecisions: [MessageID: PermissionChoice] {
        decisions.compactMapValues { $0.holds ? $0.choice : nil }
    }

    func holds(_ card: MessageID) -> Bool {
        decisions[card]?.holds == true
    }

    /// Cards whose decision the Mac took from this phone.
    var decidedHere: Set<MessageID> {
        Set(decisions.compactMap { $0.value.phase == .taken ? $0.key : nil })
    }

    /// Cards this phone decided or is deciding, so a link's note never calls them answered elsewhere.
    var decidedOrSending: Set<MessageID> {
        Set(decisions.compactMap { $0.value.phase == .taken || $0.value.phase == .sending ? $0.key : nil })
    }

    /// Who closed the card, as far as this phone knows: true here, false elsewhere, nil when it cannot tell (its
    /// decision went on a socket that dropped, or the Mac's ack has not come yet).
    func decidedHere(_ card: MessageID) -> Bool? {
        guard let decision = decisions[card] else { return false }
        switch decision.phase {
        case .taken: return true
        case .sending, .unsure: return nil
        case .failed: return decision.earlierMayHaveLanded ? nil : false
        }
    }

    /// Why a card's last decision did not count, or may not have, until the next tap.
    func decisionNote(_ card: MessageID) -> DecisionNote? {
        switch decisions[card]?.phase {
        case .failed(let note)?: note
        case .unsure?: .unsure
        case .sending?, .taken?, nil: nil
        }
    }

    /// A message held offline was not sent: no socket took it within OutboxRule.maxAge of the tap, and later it would
    /// no longer mean what the user meant.
    func requestDropped(_ msg: ClientMessage) {
        let unreachable = " not sent: your Mac was unreachable."
        switch msg {
        case let .sessionStop(sessionId, target, _):
            stops[sessionId]?[target ?? .all] = nil
            sessionErrors[sessionId] = SessionError(kind: .stop, text: "Stop" + unreachable)
        case .stop, .stopAgent:
            lastError = ErrorNotice(message: "Stop" + unreachable)
        case .decide(_, let card, _), .sessionDecide(_, let card, _), .sessionAnswer(_, let card, _):
            decisions[card]?.fail(.tooLate)
        case let .sessionSet(sessionId, patch):
            if patch.mode != nil || patch.model != nil {
                sets[sessionId] = nil
                sessionErrors[sessionId] = SessionError(kind: .set, text: (patch.mode != nil ? "Mode change" : "Model change") + unreachable)
            } else if let hidden = patch.hidden {
                lastError = ErrorNotice(message: (hidden ? "Hide" : "Show") + unreachable)
            } else if patch.title != nil {
                lastError = ErrorNotice(message: "Rename" + unreachable)
            }
        case .sessionOpenDesktop:
            lastError = ErrorNotice(message: "Open in the Claude app" + unreachable)
        case .sessionPrefs:
            if let before = mirrorAsked?.before { sessions.setMirror(before) }
            mirrorAsked = nil
            mirrorNote = "Not changed: your Mac was unreachable."
            if !settingsShown { lastError = ErrorNotice(message: "The Claude app setting was not changed: your Mac was unreachable.") }
        case let .sessionSend(sessionId, _, clientId, _, _):
            unechoedSends.removeAll { Self.clientId(of: $0.message) == clientId }
            // A Retry of one a socket took before may have arrived the first time: it keeps saying so.
            if threads[sessionId]?.pendingSends[ItemID(clientId)]?.state == .waiting { threads[sessionId]?.sendRefused(clientId, nil) }
        default:
            break
        }
    }

    /// The socket refused a Stop's frame. It waits for the next hello, under the outbox's age.
    func stopNotSent(sessionId: SessionID, target: StopTarget) {
        stops[sessionId]?[target]?.state = .notSent
    }

    func dismissError(_ notice: ErrorNotice) {
        if lastError == notice { lastError = nil }
    }

    func dismissSessionError(_ error: SessionError, in sessionId: SessionID) {
        if sessionErrors[sessionId] == error { sessionErrors[sessionId] = nil }
    }

    /// A session request is on its way, so the composer can say so until the Mac answers.
    func sessionRequestSent(_ msg: ClientMessage, at now: Date = .now) {
        switch msg {
        case let .sessionStop(sessionId, target, turnStartedAt):
            let target = target ?? .all
            var request = StopRequest(target: target, turnStartedAt: turnStartedAt, at: now)
            if target == .all { request.tasks = Set(threads[sessionId]?.controls?.tasks?.map(\.id) ?? []) }
            stops[sessionId, default: [:]][target] = request
            if sessionErrors[sessionId]?.kind == .stop { sessionErrors[sessionId] = nil }
        case let .sessionSet(sessionId, patch):
            let models = threads[sessionId]?.controls?.models ?? []
            if let mode = patch.mode {
                sets[sessionId] = SetRequest(change: .mode(mode), at: now)
            } else if case .some(.some(let id)) = patch.model {
                sets[sessionId] = SetRequest(change: .model(id: id, label: models.first { $0.id == id }?.label ?? id), at: now)
            } else {
                return
            }
            if sessionErrors[sessionId]?.kind == .set { sessionErrors[sessionId] = nil }
        case let .sessionSend(sessionId, _, _, _, _), let .sessionUnqueue(sessionId, _):
            // A refused stop stays: the slot's Stop again needs its reason.
            if sessionErrors[sessionId]?.kind != .stop { sessionErrors[sessionId] = nil }
        case let .sessionPrefs(pref):
            // Shown at once. A change made again while one is unconfirmed keeps the value from before the first.
            if mirrorAsked == nil { mirrorAsked = MirrorChange(before: sessions.mirror) }
            mirrorNote = nil
            sessions.setMirror(pref)
        default:
            break
        }
    }

    /// The newest stop this phone asked for in the session, among `targets`.
    func latestStop(in sessionId: SessionID, _ targets: [StopTarget]) -> StopRequest? {
        targets.compactMap { stops[sessionId]?[$0] }.max { $0.at < $1.at }
    }

    /// A change the user gave up waiting for.
    func dismissSet(in sessionId: SessionID) {
        sets[sessionId] = nil
    }

    /// A frame for the thread came in. A stop whose work no longer runs is confirmed, and a change the controls now
    /// carry has landed. Once nothing runs, nothing is left to stop.
    private func settleRequests(_ sessionId: SessionID) {
        guard let controls = threads[sessionId]?.controls else { return }
        if !controls.working {
            stops[sessionId] = nil
            // A stop Claude Code took late still landed: the status line says how the run ended.
            if sessionErrors[sessionId]?.kind == .stop { sessionErrors[sessionId] = nil }
        } else if var asked = stops[sessionId] {
            for (target, request) in asked where request.state == .pending && request.landed(in: controls) {
                asked[target]?.state = .confirmed
            }
            stops[sessionId] = asked
        }
        if let set = sets[sessionId], set.landed(in: controls) {
            sets[sessionId] = nil
        }
    }

    /// An error about a session request goes under that session's composer. A refused stop marks the newest stop asked
    /// for there, whichever frame came first. A refused change says the value the controls still show.
    private func sessionRefused(_ message: String, _ about: ErrorAbout) -> Bool {
        switch about {
        case .stop(let sessionId):
            if let latest = stops[sessionId]?.values.max(by: { $0.at < $1.at }) {
                stops[sessionId]?[latest.target]?.state = .refused(message)
            }
            sessionErrors[sessionId] = SessionError(kind: .stop, text: "Couldn't stop. " + message)
        case .set(let sessionId):
            let kept = threads[sessionId]?.controls.map { controls in
                if case .model = sets[sessionId]?.change { "The model stays \(controls.modelLabel)." }
                else { "The mode stays \(SessionText.mode(controls.mode))." }
            }
            sets[sessionId] = nil
            sessionErrors[sessionId] = SessionError(kind: .set, text: [kept, message].compactMap { $0 }.joined(separator: " "))
        case .send(let sessionId, let clientId):
            threads[sessionId]?.withdrawRefused(ItemID(clientId))
            threads[sessionId]?.sendRefused(clientId, message)
            unechoedSends.removeAll { Self.clientId(of: $0.message) == clientId }
            sessionErrors[sessionId] = SessionError(kind: .send, text: message)
        case let .decide(_, cardId):
            decisions[cardId]?.fail(.refused(message))
        case let .tool(sessionId, toolUseId):
            guard let thread = threads[sessionId] else { return false }
            thread.apply(.toolOutput(toolUseId: toolUseId, .missing(message)))
        case .create(let ref):
            // Only the sheet that sent the ref reads it, and only while it is open: one is enough.
            createRefusals = [ref: message]
        case .page(let sessionId):
            threads[sessionId]?.pageRefused()
            return false
        case .unknown:
            return false
        }
        return true
    }

    /// The bridge keeps one live code, so a new request makes the shown one stale until the reply lands.
    func discardPairCode() {
        pairCode = nil
    }

    /// The reducer. Returns what the user should be notified about.
    @discardableResult
    func apply(_ msg: ServerMessage, at now: Date = .now) -> [Alert] {
        heardAt = now
        switch msg {
        case let .hello(hello):
            connection = .connected(machine: hello.machine)
            endRejoin()
            userName = hello.userName
            protocolMismatch = ProtocolMismatch(bridge: hello.protocol)
            bridgeProtocol = hello.protocol
            features = Set(hello.features)
            activity = [:]
            if !features.contains(.usage) { usage = nil }
            pushState = hello.push
            // A decision in flight when the socket dropped either landed, and the card says so, or it is lost. Without
            // its ack this phone cannot say which, and an open card takes a tap again.
            for (card, decision) in decisions where decision.holds || decision.phase == .sending {
                decisions[card]?.holds = false
                if decision.phase == .sending { decisions[card]?.phase = .unsure }
            }
            bots = Dictionary(hello.bots.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            conversations = conversations.filter { self.bots[$0.key] != nil }
            details = details.filter { self.bots[$0.key] != nil }
            connectors = connectors.filter { self.bots[$0.key] != nil }
            skills = skills.filter { self.bots[$0.key] != nil }
            commands = commands.filter { self.bots[$0.key] != nil }
            exchanges = exchanges.filter { self.bots[$0.key.botId] != nil && self.bots[$0.key.peer] != nil }
            return []

        case let .bot(bot):
            bots[bot.id] = bot
            return []

        case let .botRemoved(id):
            bots[id] = nil
            conversations[id] = nil
            details[id] = nil
            agents = agents.filter { $0.value.agent.botId != id }
            files = files.filter { $0.key.botId != id }
            activity = activity.filter { $0.key.botId != id }
            connectors[id] = nil
            skills[id] = nil
            commands[id] = nil
            exchanges = exchanges.filter { $0.key.botId != id && $0.key.peer != id }
            return []

        case let .created(ref, botId):
            created[ref] = botId
            return []

        case let .conversation(botId, messages):
            conversations[botId] = Conversation(messages)
            messages.forEach(settlePending)
            return []

        case let .message(botId, message):
            settlePending(message)
            let previous = conversations[botId]?[message.id]
            guard conversations[botId, default: Conversation()].upsert(message), let bot = bots[botId] else { return [] }
            switch message {
            case .bot(_, _, let text, _) where previous == nil:
                return [.bot(bot, .message(text))]
            case .question(let id, _, let card) where previous == nil && card.answer == nil:
                return [.bot(bot, .question(id: id, question: card.question, options: card.options))]
            case .permission(let id, _, let card) where previous == nil && card.answer == nil:
                return [.bot(bot, .permission(id: id, label: card.label))]
            default:
                return []
            }

        case let .details(botId, library, links, agents, routines):
            details[botId] = BotDetails(library: library, links: links, agents: agents, routines: routines)
            return []

        case let .agent(agent, messages):
            agents[agent.id] = AgentThread(agent: agent, messages: messages)
            // The bridge pushes every agent change, including agents the cached details have not seen yet.
            if var current = details[agent.botId] {
                if let at = current.agents.firstIndex(where: { $0.id == agent.id }) {
                    current.agents[at] = agent
                } else {
                    current.agents.append(agent)
                }
                details[agent.botId] = current
            }
            return []

        case let .file(botId, path, file):
            files[FileKey(botId: botId, path: path)] = file
            return []

        case let .devices(devices):
            self.devices = devices
            devicesHeard += 1
            return []

        case let .pairCode(code):
            pairCode = code
            return []

        case let .activity(botId, agentId, text, _):
            activity[ActivityKey(botId: botId, agentId: agentId)] = text
            return []

        case let .memory(facts):
            self.facts = facts
            return []

        case let .connectors(botId, connectors):
            self.connectors[botId] = connectors
            return []

        case let .skills(botId, skills):
            self.skills[botId] = skills
            return []

        case let .webhookToken(_, token):
            webhookToken = token
            return []

        case let .error(message, about):
            if let about, sessionRefused(message, about) { return [] }
            lastError = ErrorNotice(message: message)
            return []

        case let .commands(botId, commands):
            self.commands[botId] = commands
            return []

        case let .exchange(botId, peer, messages):
            exchanges[ExchangeKey(botId: botId, peer: peer)] = messages
            return []

        case let .usage(usage):
            self.usage = usage
            return []

        case let .sessions(frame):
            if case .list = frame { mirrorAsked = nil }
            sessions.apply(frame)
            return []

        case let .thread(sessionId, frame):
            for card in threads.apply(sessionId, frame) { decisions[card]?.holds = false }
            settleSends(sessionId, frame)
            settleRequests(sessionId)
            return []

        case let .decided(cardId):
            decisions[cardId]?.phase = .taken
            return []

        case let .sessionCreated(ref, sessionId):
            sessions.recordCreated(ref: ref, sessionId: sessionId)
            return []

        case let .pushState(push):
            pushState = push
            return []

        case let .sessionAlert(alert):
            return [.session(alert)]

        case .unknown:
            return []
        }
    }

    private func settlePending(_ message: Message) {
        if case .permission(let id, _, let card) = message, card.answer != nil { decisions[id]?.holds = false }
        if case .user(_, _, _, _, let clientId?, _) = message { unechoedSends.removeAll { Self.clientId(of: $0.message) == clientId } }
    }

    /// The home list: visible bots, pinned first, then newest activity.
    var homeBots: [Bot] {
        bots.values.filter { !$0.hidden }.sorted(by: Bot.homeOrder)
    }

    /// Search and the new-chat picker include hidden bots.
    func bots(matching query: String) -> [Bot] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return bots.values
            .filter { needle.isEmpty || [$0.name, $0.title ?? "", $0.preview].contains { $0.localizedCaseInsensitiveContains(needle) } }
            .sorted(by: Bot.homeOrder)
    }

    /// A group's members that still exist, in the order the user picked them.
    func members(of bot: Bot) -> [Bot] {
        bot.members.compactMap { bots[$0] }
    }

    /// Facts bots proposed that wait for the user's Confirm or Forget.
    var proposedFacts: [Fact] {
        facts?.filter { !$0.confirmed } ?? []
    }

    /// The proposals this bot made. A bridge that predates proposerBotId names the proposer only by Fact.by, the bot's
    /// name when it remembered the fact, so there a proposal from before a rename shows only in Settings.
    func proposedFacts(by bot: Bot) -> [Fact] {
        proposedFacts.filter { $0.proposerBotId.map { $0 == bot.id } ?? ($0.by == bot.name) }
    }

    /// What waits on the user, for the Dock badge and the menu bar: each bot's open question and open permission
    /// card, and each listed session that needs you. Hidden sessions count only once the user looks for them.
    var waitingOnYou: Int {
        let cards = bots.values.reduce(0) { $0 + ($1.question != nil ? 1 : 0) + ($1.status == .awaitingApproval ? 1 : 0) }
        return cards + sessions.rows.values.filter { $0.needsYou && !$0.hidden }.count
    }

    /// The open question card, newest first, if any.
    func openQuestion(in botId: BotID, now: Date = .now) -> (id: MessageID, card: QuestionCard)? {
        for message in conversations[botId]?.messages.reversed() ?? [] {
            if case let .question(id, _, card) = message, card.answer(at: now) == nil { return (id, card) }
        }
        return nil
    }

    /// A routine's runs, newest first. Bot frames stay live but carry only the newest 5;
    /// details carries every kept run as of the last fetch, so it fills in the older ones.
    func runs(of routineId: RoutineID, in botId: BotID) -> [RoutineRun] {
        let live = bots[botId]?.routines.first { $0.id == routineId }?.runs ?? []
        let kept = details[botId]?.routines.first { $0.id == routineId }?.runs ?? []
        let liveIds = Set(live.map(\.id))
        return (live + kept.filter { !liveIds.contains($0.id) }).sorted { $0.at > $1.at }
    }
}

extension Bot {
    static func homeOrder(_ a: Bot, _ b: Bot) -> Bool {
        if a.pinned != b.pinned { return a.pinned }
        if a.lastAt != b.lastAt { return a.lastAt > b.lastAt }
        return a.id.rawValue < b.id.rawValue
    }
}
