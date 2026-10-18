import Foundation
import Observation

enum ConnectionState: Equatable, Sendable {
    case unpaired
    case connecting
    /// Set only by the bridge's hello, so "connected" means the token was accepted.
    case connected(machine: String)
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

/// Something worth a local notification, derived from a state change.
struct Alert: Equatable, Sendable {
    enum Reason: Equatable, Sendable {
        case message(String)
        case question(id: MessageID, question: String, options: [String])
        case permission(id: MessageID, label: String)
    }

    let bot: Bot
    let reason: Reason
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

struct FileKey: Hashable, Sendable {
    let botId: BotID
    let path: String
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
    /// Decisions sent and not yet echoed back by their card, so a second tap cannot send another.
    private(set) var pendingDecisions: [MessageID: PermissionChoice] = [:]
    /// The phones paired with this Mac, once Settings asked for them.
    private(set) var devices: [Device]?
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
    /// The newest webhook token, shown once and then dismissed.
    private(set) var webhookToken: WebhookToken?
    /// Sends the bridge has not echoed back yet, oldest first, each with how many times a socket took it. In memory
    /// only: quitting the app forgets them.
    private(set) var unechoedSends: [(message: ClientMessage, transmitted: Int)] = []

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
        if case .connected(let machine) = connection { machine } else { nil }
    }

    /// Paired devices, pairing codes and Bearer tokens arrived with protocol 3.
    var bridgeManagesDevices: Bool {
        (bridgeProtocol ?? 0) >= 3
    }

    /// Transport changes from the client. Unpairing forgets everything the Mac sent.
    func setConnection(_ state: ConnectionState) {
        connection = state
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
            pendingDecisions = [:]
            devices = nil
            pairCode = nil
            features = []
            activity = [:]
            facts = nil
            connectors = [:]
            skills = [:]
            webhookToken = nil
            unechoedSends = []
        }
    }

    /// A frame sent on a socket that dropped may never have arrived, so a send stays here until its echo.
    func sendStarted(_ msg: ClientMessage) {
        guard has(.mute), Self.clientId(of: msg) != nil, !unechoedSends.contains(where: { $0.message == msg }) else { return }
        unechoedSends.append((msg, 0))
    }

    /// A socket took the frame. Only these count toward giving up, so a send made offline survives any number of
    /// reconnects that drop before it goes out.
    func sendTransmitted(_ msg: ClientMessage) {
        guard let i = unechoedSends.firstIndex(where: { $0.message == msg }) else { return }
        unechoedSends[i].transmitted += 1
    }

    /// What to send again on the socket that just said hello, with the same clientIds. A send three sockets took
    /// without an echo is given up, so one the bridge refuses is not repeated forever.
    func resendsAfterHello() -> [ClientMessage] {
        // The bridge drops a repeated clientId from the same release that added mute; an older one would post it twice.
        guard has(.mute) else {
            unechoedSends = []
            return []
        }
        unechoedSends.removeAll { pending in
            guard case .send(let botId, _, _, _, _) = pending.message, bots[botId] != nil else { return true }
            return pending.transmitted >= 3
        }
        return unechoedSends.map(\.message)
    }

    private static func clientId(of msg: ClientMessage) -> String? {
        if case .send(_, _, _, let clientId, _) = msg { clientId } else { nil }
    }

    func decisionSent(_ choice: PermissionChoice, for card: MessageID) {
        pendingDecisions[card] = choice
    }

    /// The socket refused the frame, so the buttons come back.
    func decisionFailed(for card: MessageID) {
        pendingDecisions[card] = nil
        lastError = ErrorNotice(message: "Your decision did not reach your Mac. Try again.")
    }

    func dismissError(_ notice: ErrorNotice) {
        if lastError == notice { lastError = nil }
    }

    /// The bridge keeps one live code, so a new request makes the shown one stale until the reply lands.
    func discardPairCode() {
        pairCode = nil
    }

    /// The reducer. Returns what the user should be notified about.
    @discardableResult
    func apply(_ msg: ServerMessage) -> [Alert] {
        switch msg {
        case let .hello(hello):
            connection = .connected(machine: hello.machine)
            userName = hello.userName
            protocolMismatch = ProtocolMismatch(bridge: hello.protocol)
            bridgeProtocol = hello.protocol
            features = Set(hello.features)
            activity = [:]
            // A decision in flight when the socket dropped either landed, and the card says so, or it is lost.
            pendingDecisions = [:]
            bots = Dictionary(hello.bots.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            conversations = conversations.filter { self.bots[$0.key] != nil }
            details = details.filter { self.bots[$0.key] != nil }
            connectors = connectors.filter { self.bots[$0.key] != nil }
            skills = skills.filter { self.bots[$0.key] != nil }
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
                return [Alert(bot: bot, reason: .message(text))]
            case .question(let id, _, let card) where previous == nil && card.answer == nil:
                return [Alert(bot: bot, reason: .question(id: id, question: card.question, options: card.options))]
            case .permission(let id, _, let card) where previous == nil && card.answer == nil:
                return [Alert(bot: bot, reason: .permission(id: id, label: card.label))]
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

        case let .error(message):
            lastError = ErrorNotice(message: message)
            return []

        case .commands, .exchange, .unknown:
            return []
        }
    }

    private func settlePending(_ message: Message) {
        if case .permission(let id, _, let card) = message, card.answer != nil { pendingDecisions[id] = nil }
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

    /// Facts bots proposed that wait for the user's Confirm or Forget.
    var proposedFacts: [Fact] {
        facts?.filter { !$0.confirmed } ?? []
    }

    /// The proposals this bot made. A bridge that predates proposerBotId names the proposer only by Fact.by, the bot's
    /// name when it remembered the fact, so there a proposal from before a rename shows only in Settings.
    func proposedFacts(by bot: Bot) -> [Fact] {
        proposedFacts.filter { $0.proposerBotId.map { $0 == bot.id } ?? ($0.by == bot.name) }
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
