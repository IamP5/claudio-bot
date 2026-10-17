import Foundation

// Mirror of bridge/src/protocol.ts. fixtures/protocol.json pins both sides.
// Every enum the bridge may grow (message types, kinds, shapes, colors, statuses) decodes an unknown
// value to `.unknown` instead of throwing, so a newer bridge cannot break a whole hello.

struct Identifier<Tag>: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    init(_ rawValue: String) { self.rawValue = rawValue }
    var description: String { rawValue }

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

enum BotTag {}
enum MessageTag {}
enum AgentTag {}
enum RoutineTag {}
typealias BotID = Identifier<BotTag>
typealias MessageID = Identifier<MessageTag>
typealias AgentID = Identifier<AgentTag>
typealias RoutineID = Identifier<RoutineTag>

/// A string enum whose unknown values survive a decode and encode back unchanged.
protocol OpenEnum: RawRepresentable<String>, Codable, Hashable, Sendable, CaseIterable {
    static func unknown(_ raw: String) -> Self
}

extension OpenEnum {
    init(wire: String) {
        self = Self.allCases.first { $0.rawValue == wire } ?? .unknown(wire)
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

enum AvatarShape: OpenEnum {
    case circle, cloud, diamond, star4, flower, blob, scallop, drop, pill, triangle, pentagon, star6, hexagon
    case unknown(String)

    static let allCases: [AvatarShape] = [
        .circle, .cloud, .diamond, .star4, .flower, .blob, .scallop, .drop, .pill, .triangle, .pentagon, .star6, .hexagon,
    ]

    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .circle: "circle"
        case .cloud: "cloud"
        case .diamond: "diamond"
        case .star4: "star4"
        case .flower: "flower"
        case .blob: "blob"
        case .scallop: "scallop"
        case .drop: "drop"
        case .pill: "pill"
        case .triangle: "triangle"
        case .pentagon: "pentagon"
        case .star6: "star6"
        case .hexagon: "hexagon"
        case .unknown(let raw): raw
        }
    }
}

enum AvatarColor: OpenEnum {
    case white, brown, red, orange, amber, green, teal, blue, purple, pink, gray
    case unknown(String)

    static let allCases: [AvatarColor] = [.white, .brown, .red, .orange, .amber, .green, .teal, .blue, .purple, .pink, .gray]

    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .white: "white"
        case .brown: "brown"
        case .red: "red"
        case .orange: "orange"
        case .amber: "amber"
        case .green: "green"
        case .teal: "teal"
        case .blue: "blue"
        case .purple: "purple"
        case .pink: "pink"
        case .gray: "gray"
        case .unknown(let raw): raw
        }
    }
}

struct Avatar: Codable, Hashable, Sendable {
    var shape: AvatarShape
    var color: AvatarColor

    static let standard = Avatar(shape: .circle, color: .white)
}

enum BotStatus: OpenEnum {
    case idle, working
    case unknown(String)

    static let allCases: [BotStatus] = [.idle, .working]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .idle: "idle"
        case .working: "working"
        case .unknown(let raw): raw
        }
    }
}

struct Routine: Codable, Hashable, Sendable, Identifiable {
    let id: RoutineID
    var name: String
    var schedule: String
    var describe: String
    var prompt: String
    var enabled: Bool
    var lastRunAt: Date?

    private enum CodingKeys: String, CodingKey { case id, name, schedule, describe, prompt, enabled, lastRunAt }

    // Written out so nil goes on the wire as null, the way the bridge sends it.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(schedule, forKey: .schedule)
        try c.encode(describe, forKey: .describe)
        try c.encode(prompt, forKey: .prompt)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(lastRunAt, forKey: .lastRunAt)
    }
}

struct Bot: Codable, Hashable, Sendable, Identifiable {
    let id: BotID
    var name: String
    var title: String?
    var avatar: Avatar
    var pinned: Bool
    var hidden: Bool
    var status: BotStatus
    var unread: Int
    var question: String?
    var preview: String
    var lastAt: Date
    var createdAt: Date
    var routines: [Routine]

    private enum CodingKeys: String, CodingKey {
        case id, name, title, avatar, pinned, hidden, status, unread, question, preview, lastAt, createdAt, routines
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(title, forKey: .title)
        try c.encode(avatar, forKey: .avatar)
        try c.encode(pinned, forKey: .pinned)
        try c.encode(hidden, forKey: .hidden)
        try c.encode(status, forKey: .status)
        try c.encode(unread, forKey: .unread)
        try c.encode(question, forKey: .question)
        try c.encode(preview, forKey: .preview)
        try c.encode(lastAt, forKey: .lastAt)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(routines, forKey: .routines)
    }
}

enum Peer: Codable, Hashable, Sendable {
    case bot(id: BotID, name: String, avatar: Avatar)
    case agent(id: AgentID, title: String)
    case routine(id: RoutineID, name: String)
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey { case kind, id, name, avatar, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "bot":
            self = .bot(
                id: try c.decode(BotID.self, forKey: .id),
                name: try c.decode(String.self, forKey: .name),
                avatar: try c.decode(Avatar.self, forKey: .avatar)
            )
        case "agent":
            self = .agent(id: try c.decode(AgentID.self, forKey: .id), title: try c.decode(String.self, forKey: .title))
        case "routine":
            self = .routine(id: try c.decode(RoutineID.self, forKey: .id), name: try c.decode(String.self, forKey: .name))
        case let other:
            self = .unknown(kind: other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .bot(id, name, avatar):
            try c.encode("bot", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
            try c.encode(avatar, forKey: .avatar)
        case let .agent(id, title):
            try c.encode("agent", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(title, forKey: .title)
        case let .routine(id, name):
            try c.encode("routine", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
        case let .unknown(kind):
            try c.encode(kind, forKey: .kind)
        }
    }

    var label: String {
        switch self {
        case .bot(_, let name, _), .routine(_, let name): name
        case .agent(_, let title): title
        case .unknown: "something"
        }
    }
}

struct Attachment: Codable, Hashable, Sendable {
    let name: String
    let mime: String
    let path: String
}

/// How a question card was closed. `nil` on the message means it is still open.
enum Answer: Codable, Hashable, Sendable {
    case option(Int)
    case dismissed

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let index = try? c.decode(Int.self) {
            self = .option(index)
        } else {
            // "dismissed", or a closing state a newer bridge invented: either way the card is closed with no choice.
            _ = try c.decode(String.self)
            self = .dismissed
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .option(let index): try c.encode(index)
        case .dismissed: try c.encode("dismissed")
        }
    }
}

struct QuestionCard: Hashable, Sendable {
    let question: String
    let options: [String]
    var answer: Answer?
}

enum Message: Codable, Hashable, Sendable, Identifiable {
    case user(id: MessageID, at: Date, text: String, attachments: [Attachment])
    case bot(id: MessageID, at: Date, text: String)
    case question(id: MessageID, at: Date, card: QuestionCard)
    /// A run of messages between this bot and one peer.
    case exchange(id: MessageID, at: Date, peer: Peer, sent: Int, received: Int)
    /// A system line whose `{n}` placeholders become chips for `refs[n]`.
    case note(id: MessageID, at: Date, text: String, refs: [Peer])
    case unknown(id: MessageID, at: Date, kind: String)

    var id: MessageID {
        switch self {
        case .user(let id, _, _, _), .bot(let id, _, _), .question(let id, _, _),
             .exchange(let id, _, _, _, _), .note(let id, _, _, _), .unknown(let id, _, _): id
        }
    }

    var at: Date {
        switch self {
        case .user(_, let at, _, _), .bot(_, let at, _), .question(_, let at, _),
             .exchange(_, let at, _, _, _), .note(_, let at, _, _), .unknown(_, let at, _): at
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, at, text, attachments, question, options, answer, peer, sent, received, refs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(MessageID.self, forKey: .id)
        let at = try c.decode(Date.self, forKey: .at)
        switch try c.decode(String.self, forKey: .kind) {
        case "user":
            self = .user(
                id: id, at: at, text: try c.decode(String.self, forKey: .text),
                attachments: try c.decode([Attachment].self, forKey: .attachments)
            )
        case "bot":
            self = .bot(id: id, at: at, text: try c.decode(String.self, forKey: .text))
        case "question":
            self = .question(id: id, at: at, card: QuestionCard(
                question: try c.decode(String.self, forKey: .question),
                options: try c.decode([String].self, forKey: .options),
                answer: try c.decodeIfPresent(Answer.self, forKey: .answer)
            ))
        case "exchange":
            self = .exchange(
                id: id, at: at, peer: try c.decode(Peer.self, forKey: .peer),
                sent: try c.decode(Int.self, forKey: .sent), received: try c.decode(Int.self, forKey: .received)
            )
        case "note":
            self = .note(id: id, at: at, text: try c.decode(String.self, forKey: .text), refs: try c.decode([Peer].self, forKey: .refs))
        case let other:
            self = .unknown(id: id, at: at, kind: other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(at, forKey: .at)
        switch self {
        case let .user(_, _, text, attachments):
            try c.encode("user", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(attachments, forKey: .attachments)
        case let .bot(_, _, text):
            try c.encode("bot", forKey: .kind)
            try c.encode(text, forKey: .text)
        case let .question(_, _, card):
            try c.encode("question", forKey: .kind)
            try c.encode(card.question, forKey: .question)
            try c.encode(card.options, forKey: .options)
            try c.encode(card.answer, forKey: .answer)
        case let .exchange(_, _, peer, sent, received):
            try c.encode("exchange", forKey: .kind)
            try c.encode(peer, forKey: .peer)
            try c.encode(sent, forKey: .sent)
            try c.encode(received, forKey: .received)
        case let .note(_, _, text, refs):
            try c.encode("note", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(refs, forKey: .refs)
        case let .unknown(_, _, kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

enum AgentStatus: OpenEnum {
    case working, waiting, failed, inCloud
    case unknown(String)

    static let allCases: [AgentStatus] = [.working, .waiting, .failed, .inCloud]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .working: "working"
        case .waiting: "waiting"
        case .failed: "failed"
        case .inCloud: "in_cloud"
        case .unknown(let raw): raw
        }
    }
}

enum AgentPlace: OpenEnum {
    case mac, cloud
    case unknown(String)

    static let allCases: [AgentPlace] = [.mac, .cloud]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .mac: "mac"
        case .cloud: "cloud"
        case .unknown(let raw): raw
        }
    }
}

struct Agent: Codable, Hashable, Sendable, Identifiable {
    let id: AgentID
    let botId: BotID
    var title: String
    var `where`: AgentPlace
    var projectName: String
    var status: AgentStatus
    var url: URL?
    var createdAt: Date
    var updatedAt: Date

    private enum CodingKeys: String, CodingKey { case id, botId, title, `where`, projectName, status, url, createdAt, updatedAt }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(botId, forKey: .botId)
        try c.encode(title, forKey: .title)
        try c.encode(`where`, forKey: .where)
        try c.encode(projectName, forKey: .projectName)
        try c.encode(status, forKey: .status)
        try c.encode(url, forKey: .url)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
    }
}

enum AgentSpeaker: OpenEnum {
    case bot, agent
    case unknown(String)

    static let allCases: [AgentSpeaker] = [.bot, .agent]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .bot: "bot"
        case .agent: "agent"
        case .unknown(let raw): raw
        }
    }
}

struct AgentMessage: Codable, Hashable, Sendable, Identifiable {
    let id: MessageID
    let at: Date
    let from: AgentSpeaker
    let text: String
}

struct LibraryFile: Codable, Hashable, Sendable {
    let path: String
    let size: Int
    let modifiedAt: Date
}

struct BotLink: Codable, Hashable, Sendable {
    let url: URL
    let host: String
    let at: Date
}

struct BotFile: Hashable, Sendable {
    let mime: String
    /// Text up to 1 MB.
    let content: String?
    /// Base64 image bytes up to 10 MB.
    let data: String?
}

enum ServerMessage: Codable, Sendable {
    case hello(machine: String, userName: String, bots: [Bot])
    case bot(Bot)
    case botRemoved(BotID)
    case created(ref: String, botId: BotID)
    case conversation(botId: BotID, messages: [Message])
    case message(botId: BotID, message: Message)
    case details(botId: BotID, library: [LibraryFile], links: [BotLink], agents: [Agent])
    case agent(Agent, messages: [AgentMessage])
    case file(botId: BotID, path: String, file: BotFile)
    case error(message: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, machine, userName, bots, bot, botId, ref, messages, message, library, links, agents, agent
        case path, mime, content, data
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "hello":
            self = .hello(
                machine: try c.decode(String.self, forKey: .machine),
                userName: try c.decode(String.self, forKey: .userName),
                bots: try c.decode([Bot].self, forKey: .bots)
            )
        case "bot":
            self = .bot(try c.decode(Bot.self, forKey: .bot))
        case "bot_removed":
            self = .botRemoved(try c.decode(BotID.self, forKey: .botId))
        case "created":
            self = .created(ref: try c.decode(String.self, forKey: .ref), botId: try c.decode(BotID.self, forKey: .botId))
        case "conversation":
            self = .conversation(botId: try c.decode(BotID.self, forKey: .botId), messages: try c.decode([Message].self, forKey: .messages))
        case "message":
            self = .message(botId: try c.decode(BotID.self, forKey: .botId), message: try c.decode(Message.self, forKey: .message))
        case "details":
            self = .details(
                botId: try c.decode(BotID.self, forKey: .botId),
                library: try c.decode([LibraryFile].self, forKey: .library),
                links: try c.decode([BotLink].self, forKey: .links),
                agents: try c.decode([Agent].self, forKey: .agents)
            )
        case "agent":
            self = .agent(try c.decode(Agent.self, forKey: .agent), messages: try c.decode([AgentMessage].self, forKey: .messages))
        case "file":
            self = .file(
                botId: try c.decode(BotID.self, forKey: .botId),
                path: try c.decode(String.self, forKey: .path),
                file: BotFile(
                    mime: try c.decode(String.self, forKey: .mime),
                    content: try c.decodeIfPresent(String.self, forKey: .content),
                    data: try c.decodeIfPresent(String.self, forKey: .data)
                )
            )
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case let other:
            self = .unknown(type: other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(machine, userName, bots):
            try c.encode("hello", forKey: .type)
            try c.encode(machine, forKey: .machine)
            try c.encode(userName, forKey: .userName)
            try c.encode(bots, forKey: .bots)
        case let .bot(bot):
            try c.encode("bot", forKey: .type)
            try c.encode(bot, forKey: .bot)
        case let .botRemoved(botId):
            try c.encode("bot_removed", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .created(ref, botId):
            try c.encode("created", forKey: .type)
            try c.encode(ref, forKey: .ref)
            try c.encode(botId, forKey: .botId)
        case let .conversation(botId, messages):
            try c.encode("conversation", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(messages, forKey: .messages)
        case let .message(botId, message):
            try c.encode("message", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(message, forKey: .message)
        case let .details(botId, library, links, agents):
            try c.encode("details", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(library, forKey: .library)
            try c.encode(links, forKey: .links)
            try c.encode(agents, forKey: .agents)
        case let .agent(agent, messages):
            try c.encode("agent", forKey: .type)
            try c.encode(agent, forKey: .agent)
            try c.encode(messages, forKey: .messages)
        case let .file(botId, path, file):
            try c.encode("file", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(path, forKey: .path)
            try c.encode(file.mime, forKey: .mime)
            try c.encode(file.content, forKey: .content)
            try c.encode(file.data, forKey: .data)
        case let .error(message):
            try c.encode("error", forKey: .type)
            try c.encode(message, forKey: .message)
        case let .unknown(type):
            try c.encode(type, forKey: .type)
        }
    }
}

struct Upload: Codable, Hashable, Sendable {
    let name: String
    let mime: String
    /// Base64 file bytes.
    let data: String
}

/// Only the fields that are set go on the wire. `title: .some(nil)` clears the label.
struct BotPatch: Codable, Hashable, Sendable {
    var name: String?
    var title: String??
    var avatar: Avatar?
    var pinned: Bool?
    var hidden: Bool?

    private enum CodingKeys: String, CodingKey { case name, title, avatar, pinned, hidden }

    init(name: String? = nil, title: String?? = nil, avatar: Avatar? = nil, pinned: Bool? = nil, hidden: Bool? = nil) {
        self.name = name
        self.title = title
        self.avatar = avatar
        self.pinned = pinned
        self.hidden = hidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        if c.contains(.title) {
            title = .some(try c.decodeNil(forKey: .title) ? nil : try c.decode(String.self, forKey: .title))
        }
        avatar = try c.decodeIfPresent(Avatar.self, forKey: .avatar)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        if let title { try c.encode(title, forKey: .title) }
        try c.encodeIfPresent(avatar, forKey: .avatar)
        try c.encodeIfPresent(pinned, forKey: .pinned)
        try c.encodeIfPresent(hidden, forKey: .hidden)
    }
}

enum ClientMessage: Codable, Hashable, Sendable {
    case createBot(ref: String)
    /// Asks for the conversation and marks the bot read.
    case open(botId: BotID)
    case send(botId: BotID, text: String, uploads: [Upload])
    case answer(botId: BotID, messageId: MessageID, option: Int)
    case dismiss(botId: BotID, messageId: MessageID)
    case updateBot(botId: BotID, patch: BotPatch)
    case markUnread(botId: BotID)
    case deleteBot(botId: BotID)
    case setRoutine(botId: BotID, routineId: RoutineID, enabled: Bool)
    case details(botId: BotID)
    case agent(agentId: AgentID)
    case file(botId: BotID, path: String)

    private enum CodingKeys: String, CodingKey {
        case type, ref, botId, text, uploads, messageId, option, patch, routineId, enabled, agentId, path
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func bot() throws -> BotID { try c.decode(BotID.self, forKey: .botId) }
        switch try c.decode(String.self, forKey: .type) {
        case "create_bot": self = .createBot(ref: try c.decode(String.self, forKey: .ref))
        case "open": self = .open(botId: try bot())
        case "send":
            self = .send(botId: try bot(), text: try c.decode(String.self, forKey: .text), uploads: try c.decode([Upload].self, forKey: .uploads))
        case "answer":
            self = .answer(botId: try bot(), messageId: try c.decode(MessageID.self, forKey: .messageId), option: try c.decode(Int.self, forKey: .option))
        case "dismiss": self = .dismiss(botId: try bot(), messageId: try c.decode(MessageID.self, forKey: .messageId))
        case "update_bot": self = .updateBot(botId: try bot(), patch: try c.decode(BotPatch.self, forKey: .patch))
        case "mark_unread": self = .markUnread(botId: try bot())
        case "delete_bot": self = .deleteBot(botId: try bot())
        case "set_routine":
            self = .setRoutine(botId: try bot(), routineId: try c.decode(RoutineID.self, forKey: .routineId), enabled: try c.decode(Bool.self, forKey: .enabled))
        case "details": self = .details(botId: try bot())
        case "agent": self = .agent(agentId: try c.decode(AgentID.self, forKey: .agentId))
        case "file": self = .file(botId: try bot(), path: try c.decode(String.self, forKey: .path))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown client message \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .createBot(ref):
            try c.encode("create_bot", forKey: .type)
            try c.encode(ref, forKey: .ref)
        case let .open(botId):
            try c.encode("open", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .send(botId, text, uploads):
            try c.encode("send", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(text, forKey: .text)
            try c.encode(uploads, forKey: .uploads)
        case let .answer(botId, messageId, option):
            try c.encode("answer", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(messageId, forKey: .messageId)
            try c.encode(option, forKey: .option)
        case let .dismiss(botId, messageId):
            try c.encode("dismiss", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(messageId, forKey: .messageId)
        case let .updateBot(botId, patch):
            try c.encode("update_bot", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(patch, forKey: .patch)
        case let .markUnread(botId):
            try c.encode("mark_unread", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .deleteBot(botId):
            try c.encode("delete_bot", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .setRoutine(botId, routineId, enabled):
            try c.encode("set_routine", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(routineId, forKey: .routineId)
            try c.encode(enabled, forKey: .enabled)
        case let .details(botId):
            try c.encode("details", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .agent(agentId):
            try c.encode("agent", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
        case let .file(botId, path):
            try c.encode("file", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(path, forKey: .path)
        }
    }
}

enum Wire {
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s))
                ?? (try? Date.ISO8601FormatStyle().parse(s)) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad date \(s)")
        }
        return d
    }

    /// Dates go out the way JavaScript's toISOString writes them.
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        }
        return e
    }
}
