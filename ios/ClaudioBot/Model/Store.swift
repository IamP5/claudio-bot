import Foundation
import Observation

enum ConnectionState: Equatable, Sendable {
    case unpaired
    case connecting
    /// Set only by the bridge's hello, so "connected" means the token was accepted.
    case connected(machine: String)
    case disconnected(retryAt: Date)
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
}

struct AgentThread: Equatable, Sendable {
    var agent: Agent
    var messages: [AgentMessage]
}

struct FileKey: Hashable, Sendable {
    let botId: BotID
    let path: String
}

struct ErrorNotice: Equatable, Sendable {
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
    /// The phones paired with this Mac, once Settings asked for them.
    private(set) var devices: [Device]?
    /// The newest code for pairing another phone.
    private(set) var pairCode: PairCode?

    var machine: String? {
        if case .connected(let machine) = connection { machine } else { nil }
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
            devices = nil
            pairCode = nil
        }
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
            bots = Dictionary(hello.bots.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            conversations = conversations.filter { self.bots[$0.key] != nil }
            details = details.filter { self.bots[$0.key] != nil }
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
            return []

        case let .created(ref, botId):
            created[ref] = botId
            return []

        case let .conversation(botId, messages):
            conversations[botId] = Conversation(messages)
            return []

        case let .message(botId, message):
            let previous = conversations[botId]?[message.id]
            guard conversations[botId, default: Conversation()].upsert(message), let bot = bots[botId] else { return [] }
            switch message {
            case .bot(_, _, let text) where previous == nil:
                return [Alert(bot: bot, reason: .message(text))]
            case .question(let id, _, let card) where previous == nil && card.answer == nil:
                return [Alert(bot: bot, reason: .question(id: id, question: card.question, options: card.options))]
            case .permission(let id, _, let card) where previous == nil && card.answer == nil:
                return [Alert(bot: bot, reason: .permission(id: id, label: card.label))]
            default:
                return []
            }

        case let .details(botId, library, links, agents):
            details[botId] = BotDetails(library: library, links: links, agents: agents)
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

        case let .error(message):
            lastError = ErrorNotice(message: message)
            return []

        case .unknown:
            return []
        }
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

    /// The open question card, newest first, if any.
    func openQuestion(in botId: BotID, now: Date = .now) -> (id: MessageID, card: QuestionCard)? {
        for message in conversations[botId]?.messages.reversed() ?? [] {
            if case let .question(id, _, card) = message, card.answer(at: now) == nil { return (id, card) }
        }
        return nil
    }
}

extension Bot {
    static func homeOrder(_ a: Bot, _ b: Bot) -> Bool {
        if a.pinned != b.pinned { return a.pinned }
        if a.lastAt != b.lastAt { return a.lastAt > b.lastAt }
        return a.id.rawValue < b.id.rawValue
    }
}
