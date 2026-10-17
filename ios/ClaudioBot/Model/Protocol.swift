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
enum RunTag {}
enum DeviceTag {}
enum FactTag {}
typealias BotID = Identifier<BotTag>
typealias MessageID = Identifier<MessageTag>
typealias AgentID = Identifier<AgentTag>
typealias RoutineID = Identifier<RoutineTag>
typealias RunID = Identifier<RunTag>
typealias DeviceID = Identifier<DeviceTag>
typealias FactID = Identifier<FactTag>

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

/// awaitingApproval: resting with a permission card open. parked: paused by the usage limit or the daily cap.
/// unavailable: Claude Code could not start on the Mac; queued work waits and the bridge keeps trying.
enum BotStatus: OpenEnum {
    case idle, working, awaitingApproval, parked, unavailable
    case unknown(String)

    static let allCases: [BotStatus] = [.idle, .working, .awaitingApproval, .parked, .unavailable]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .idle: "idle"
        case .working: "working"
        case .awaitingApproval: "awaiting_approval"
        case .parked: "parked"
        case .unavailable: "unavailable"
        case .unknown(let raw): raw
        }
    }
}

enum TriggerKind: OpenEnum {
    case cron, webhook
    case unknown(String)

    static let allCases: [TriggerKind] = [.cron, .webhook]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .cron: "cron"
        case .webhook: "webhook"
        case .unknown(let raw): raw
        }
    }
}

/// What a bridge can do beyond protocol 3's base (hello.features). Screens for a feature the bridge does not list stay hidden.
enum Feature: OpenEnum {
    case memory, activity, mute, worktrees, connectors, skills, webhooks
    case unknown(String)

    static let allCases: [Feature] = [.memory, .activity, .mute, .worktrees, .connectors, .skills, .webhooks]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .memory: "memory"
        case .activity: "activity"
        case .mute: "mute"
        case .worktrees: "worktrees"
        case .connectors: "connectors"
        case .skills: "skills"
        case .webhooks: "webhooks"
        case .unknown(let raw): raw
        }
    }
}

/// running: fired, turn not finished. quiet: ran with nothing to say. skipped: did not run.
enum RunStatus: OpenEnum {
    case running, ok, quiet, failed, skipped
    case unknown(String)

    static let allCases: [RunStatus] = [.running, .ok, .quiet, .failed, .skipped]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .running: "running"
        case .ok: "ok"
        case .quiet: "quiet"
        case .failed: "failed"
        case .skipped: "skipped"
        case .unknown(let raw): raw
        }
    }
}

struct RoutineRun: Codable, Hashable, Sendable, Identifiable {
    let id: RunID
    let at: Date
    let status: RunStatus
    /// Fired after its time because the Mac was asleep.
    let late: Bool
    /// Run now from the phone.
    let manual: Bool
    let note: String?

    private enum CodingKeys: String, CodingKey { case id, at, status, late, manual, note }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(at, forKey: .at)
        try c.encode(status, forKey: .status)
        try c.encode(late, forKey: .late)
        try c.encode(manual, forKey: .manual)
        try c.encode(note, forKey: .note)
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
    var trigger: TriggerKind = .cron
    var nextRunAt: Date?
    /// Newest first.
    var runs: [RoutineRun] = []

    private enum CodingKeys: String, CodingKey { case id, name, schedule, describe, prompt, enabled, lastRunAt, trigger, nextRunAt, runs }

    init(
        id: RoutineID, name: String, schedule: String, describe: String, prompt: String, enabled: Bool,
        lastRunAt: Date?, trigger: TriggerKind = .cron, nextRunAt: Date? = nil, runs: [RoutineRun] = []
    ) {
        self.id = id
        self.name = name
        self.schedule = schedule
        self.describe = describe
        self.prompt = prompt
        self.enabled = enabled
        self.lastRunAt = lastRunAt
        self.trigger = trigger
        self.nextRunAt = nextRunAt
        self.runs = runs
    }

    // The protocol 3 fields are optional on decode so a protocol 2 bridge still loads.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(RoutineID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        schedule = try c.decode(String.self, forKey: .schedule)
        describe = try c.decode(String.self, forKey: .describe)
        prompt = try c.decode(String.self, forKey: .prompt)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        lastRunAt = try c.decodeIfPresent(Date.self, forKey: .lastRunAt)
        trigger = try c.decodeIfPresent(TriggerKind.self, forKey: .trigger) ?? .cron
        nextRunAt = try c.decodeIfPresent(Date.self, forKey: .nextRunAt)
        runs = try c.decodeIfPresent([RoutineRun].self, forKey: .runs) ?? []
    }

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
        try c.encode(trigger, forKey: .trigger)
        try c.encode(nextRunAt, forKey: .nextRunAt)
        try c.encode(runs, forKey: .runs)
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
    /// Spend cap per local day. nil: the bridge default.
    var dailyCapUsd: Double?
    /// No message pushes for this bot; cards still push. False from a bridge without the mute feature.
    var muted: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, title, avatar, pinned, hidden, status, unread, question, preview, lastAt, createdAt, routines, dailyCapUsd, muted
    }

    init(
        id: BotID, name: String, title: String?, avatar: Avatar, pinned: Bool, hidden: Bool, status: BotStatus,
        unread: Int, question: String?, preview: String, lastAt: Date, createdAt: Date, routines: [Routine],
        dailyCapUsd: Double? = nil, muted: Bool = false
    ) {
        self.id = id
        self.name = name
        self.title = title
        self.avatar = avatar
        self.pinned = pinned
        self.hidden = hidden
        self.status = status
        self.unread = unread
        self.question = question
        self.preview = preview
        self.lastAt = lastAt
        self.createdAt = createdAt
        self.routines = routines
        self.dailyCapUsd = dailyCapUsd
        self.muted = muted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(BotID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        avatar = try c.decode(Avatar.self, forKey: .avatar)
        pinned = try c.decode(Bool.self, forKey: .pinned)
        hidden = try c.decode(Bool.self, forKey: .hidden)
        status = try c.decode(BotStatus.self, forKey: .status)
        unread = try c.decode(Int.self, forKey: .unread)
        question = try c.decodeIfPresent(String.self, forKey: .question)
        preview = try c.decode(String.self, forKey: .preview)
        lastAt = try c.decode(Date.self, forKey: .lastAt)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        routines = try c.decode([Routine].self, forKey: .routines)
        dailyCapUsd = try c.decodeIfPresent(Double.self, forKey: .dailyCapUsd)
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
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
        try c.encode(dailyCapUsd, forKey: .dailyCapUsd)
        try c.encode(muted, forKey: .muted)
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
    /// Nobody answered before `expiresAt`.
    case expired

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let index = try? c.decode(Int.self) {
            self = .option(index)
        } else {
            // A closing state a newer bridge invented still closes the card, with no choice.
            self = try c.decode(String.self) == "expired" ? .expired : .dismissed
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .option(let index): try c.encode(index)
        case .dismissed: try c.encode("dismissed")
        case .expired: try c.encode("expired")
        }
    }
}

struct QuestionCard: Hashable, Sendable {
    let question: String
    let options: [String]
    var answer: Answer?
    /// nil for cards from before protocol 3, which never expire.
    var expiresAt: Date?

    init(question: String, options: [String], answer: Answer?, expiresAt: Date? = nil) {
        self.question = question
        self.options = options
        self.answer = answer
        self.expiresAt = expiresAt
    }
}

/// The four buttons on a permission card. The app sends only these strings.
enum PermissionChoice: String, Codable, Hashable, Sendable, CaseIterable {
    case once, always, deny, never
}

/// How a permission card was closed. `nil` on the card means it is still open.
enum PermissionAnswer: Codable, Hashable, Sendable {
    case chose(PermissionChoice)
    case expired
    /// A closing state a newer bridge invented.
    case closed(String)

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        if let choice = PermissionChoice(rawValue: raw) {
            self = .chose(choice)
        } else {
            self = raw == "expired" ? .expired : .closed(raw)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .chose(let choice): try c.encode(choice.rawValue)
        case .expired: try c.encode("expired")
        case .closed(let raw): try c.encode(raw)
        }
    }
}

/// A tool call held for approval. It has not run, and runs only if the user allows it.
struct PermissionCard: Hashable, Sendable {
    /// nil when the bot itself asked; the agent when one of the bot's agents did.
    let from: Peer?
    /// "Bash", "Write", "mcp__github__merge_pull_request".
    let tool: String
    /// The rule that asked, in words.
    let label: String
    /// The exact call the user approves, secrets masked.
    let detail: String
    /// What "Always" would allow from now on, in words.
    let always: String
    var answer: PermissionAnswer?
    let expiresAt: Date
}

enum Message: Codable, Hashable, Sendable, Identifiable {
    /// clientId: the id the app gave its send, echoed back by the bridge.
    case user(id: MessageID, at: Date, text: String, attachments: [Attachment], clientId: String? = nil)
    case bot(id: MessageID, at: Date, text: String)
    case question(id: MessageID, at: Date, card: QuestionCard)
    case permission(id: MessageID, at: Date, card: PermissionCard)
    /// A run of messages between this bot and one peer.
    case exchange(id: MessageID, at: Date, peer: Peer, sent: Int, received: Int)
    /// A system line whose `{n}` placeholders become chips for `refs[n]`.
    case note(id: MessageID, at: Date, text: String, refs: [Peer])
    case unknown(id: MessageID, at: Date, kind: String)

    var id: MessageID {
        switch self {
        case .user(let id, _, _, _, _), .bot(let id, _, _), .question(let id, _, _), .permission(let id, _, _),
             .exchange(let id, _, _, _, _), .note(let id, _, _, _), .unknown(let id, _, _): id
        }
    }

    var at: Date {
        switch self {
        case .user(_, let at, _, _, _), .bot(_, let at, _), .question(_, let at, _), .permission(_, let at, _),
             .exchange(_, let at, _, _, _), .note(_, let at, _, _), .unknown(_, let at, _): at
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, at, text, attachments, question, options, answer, expiresAt, peer, sent, received, refs
        case from, tool, label, detail, always, clientId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(MessageID.self, forKey: .id)
        let at = try c.decode(Date.self, forKey: .at)
        switch try c.decode(String.self, forKey: .kind) {
        case "user":
            self = .user(
                id: id, at: at, text: try c.decode(String.self, forKey: .text),
                attachments: try c.decode([Attachment].self, forKey: .attachments),
                clientId: try c.decodeIfPresent(String.self, forKey: .clientId)
            )
        case "bot":
            self = .bot(id: id, at: at, text: try c.decode(String.self, forKey: .text))
        case "question":
            self = .question(id: id, at: at, card: QuestionCard(
                question: try c.decode(String.self, forKey: .question),
                options: try c.decode([String].self, forKey: .options),
                answer: try c.decodeIfPresent(Answer.self, forKey: .answer),
                expiresAt: try c.decodeIfPresent(Date.self, forKey: .expiresAt)
            ))
        case "permission":
            self = .permission(id: id, at: at, card: PermissionCard(
                from: try c.decodeIfPresent(Peer.self, forKey: .from),
                tool: try c.decode(String.self, forKey: .tool),
                label: try c.decode(String.self, forKey: .label),
                detail: try c.decode(String.self, forKey: .detail),
                always: try c.decode(String.self, forKey: .always),
                answer: try c.decodeIfPresent(PermissionAnswer.self, forKey: .answer),
                expiresAt: try c.decode(Date.self, forKey: .expiresAt)
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
        case let .user(_, _, text, attachments, clientId):
            try c.encode("user", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(attachments, forKey: .attachments)
            try c.encodeIfPresent(clientId, forKey: .clientId)
        case let .bot(_, _, text):
            try c.encode("bot", forKey: .kind)
            try c.encode(text, forKey: .text)
        case let .question(_, _, card):
            try c.encode("question", forKey: .kind)
            try c.encode(card.question, forKey: .question)
            try c.encode(card.options, forKey: .options)
            try c.encode(card.answer, forKey: .answer)
            try c.encode(card.expiresAt, forKey: .expiresAt)
        case let .permission(_, _, card):
            try c.encode("permission", forKey: .kind)
            try c.encode(card.from, forKey: .from)
            try c.encode(card.tool, forKey: .tool)
            try c.encode(card.label, forKey: .label)
            try c.encode(card.detail, forKey: .detail)
            try c.encode(card.always, forKey: .always)
            try c.encode(card.answer, forKey: .answer)
            try c.encode(card.expiresAt, forKey: .expiresAt)
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
    /// capped: the bot's daily cap stopped its turn. Not a failure.
    case working, waiting, failed, inCloud, awaitingApproval, parked, unavailable, capped
    case unknown(String)

    static let allCases: [AgentStatus] = [.working, .waiting, .failed, .inCloud, .awaitingApproval, .parked, .unavailable, .capped]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .working: "working"
        case .waiting: "waiting"
        case .failed: "failed"
        case .inCloud: "in_cloud"
        case .awaitingApproval: "awaiting_approval"
        case .parked: "parked"
        case .unavailable: "unavailable"
        case .capped: "capped"
        case .unknown(let raw): raw
        }
    }
}

/// What the bridge read from git after a mac agent's turn.
struct AgentEvidence: Codable, Hashable, Sendable {
    var at: Date
    var branch: String?
    var head: String?
    var ahead: Int
    var changed: Int
    var insertions: Int
    var deletions: Int
    var dirty: Bool
    var pr: URL?

    private enum CodingKeys: String, CodingKey { case at, branch, head, ahead, changed, insertions, deletions, dirty, pr }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at)
        try c.encode(branch, forKey: .branch)
        try c.encode(head, forKey: .head)
        try c.encode(ahead, forKey: .ahead)
        try c.encode(changed, forKey: .changed)
        try c.encode(insertions, forKey: .insertions)
        try c.encode(deletions, forKey: .deletions)
        try c.encode(dirty, forKey: .dirty)
        try c.encode(pr, forKey: .pr)
    }
}

/// The isolated git worktree a mac agent works in.
struct Worktree: Codable, Hashable, Sendable {
    var path: String
    var branch: String
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
    var evidence: AgentEvidence? = nil
    var worktree: Worktree? = nil

    private enum CodingKeys: String, CodingKey { case id, botId, title, `where`, projectName, status, url, createdAt, updatedAt, evidence, worktree }

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
        try c.encode(evidence, forKey: .evidence)
        try c.encode(worktree, forKey: .worktree)
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

struct Device: Codable, Hashable, Sendable, Identifiable {
    let id: DeviceID
    let name: String
    let createdAt: Date
    let lastSeenAt: Date?
    /// Paired with the shared token from before protocol 3.
    let legacy: Bool
    /// The device that asked for this list.
    let current: Bool

    private enum CodingKeys: String, CodingKey { case id, name, createdAt, lastSeenAt, legacy, current }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(lastSeenAt, forKey: .lastSeenAt)
        try c.encode(legacy, forKey: .legacy)
        try c.encode(current, forKey: .current)
    }
}

/// One fact in USER.md. by: the bot that remembered it, nil for the user. confirmed: the user added or confirmed it, so
/// every bot reads it; false is a bot's proposal only that bot reads. A bridge that predates the flag sent confirmed facts.
struct Fact: Codable, Hashable, Sendable, Identifiable {
    let id: FactID
    var text: String
    var at: Date
    var by: String?
    var confirmed: Bool

    private enum CodingKeys: String, CodingKey { case id, text, at, by, confirmed }

    init(id: FactID, text: String, at: Date, by: String?, confirmed: Bool = true) {
        self.id = id
        self.text = text
        self.at = at
        self.by = by
        self.confirmed = confirmed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(FactID.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        at = try c.decode(Date.self, forKey: .at)
        by = try c.decodeIfPresent(String.self, forKey: .by)
        confirmed = try c.decodeIfPresent(Bool.self, forKey: .confirmed) ?? true
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(text, forKey: .text)
        try c.encode(at, forKey: .at)
        try c.encode(by, forKey: .by)
        try c.encode(confirmed, forKey: .confirmed)
    }
}

/// unchecked: no query was open to ask.
enum ConnectorStatus: OpenEnum {
    case connected, pending, failed, needsAuth, unchecked
    case unknown(String)

    static let allCases: [ConnectorStatus] = [.connected, .pending, .failed, .needsAuth, .unchecked]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .connected: "connected"
        case .pending: "pending"
        case .failed: "failed"
        case .needsAuth: "needs_auth"
        case .unchecked: "unchecked"
        case .unknown(let raw): raw
        }
    }
}

/// An MCP server a bot's queries load, by name only.
struct Connector: Codable, Hashable, Sendable, Identifiable {
    let name: String
    var status: ConnectorStatus
    var enabled: Bool

    var id: String { name }
}

struct Skill: Codable, Hashable, Sendable, Identifiable {
    let name: String
    var description: String
    var updatedAt: Date

    var id: String { name }
}

/// A webhook routine's new token, shown once.
struct WebhookToken: Codable, Hashable, Sendable {
    let routineId: RoutineID
    let url: URL
    let token: String
}

/// A one-time code another phone can pair with.
struct PairCode: Codable, Hashable, Sendable {
    let code: String
    let expiresAt: Date
}

/// Where the broadcast stream stands. An empty epoch means the bridge keeps no replay ring.
struct StreamPosition: Hashable, Sendable {
    var epoch: String
    var seq: Int
    var resumed: Bool
}

struct Hello: Hashable, Sendable {
    /// Absent before protocol 3, which reads as 2.
    var `protocol`: Int
    /// Absent before the bridge had features, which reads as none.
    var features: [Feature]
    var machine: String
    var userName: String
    var bots: [Bot]
    var position: StreamPosition

    init(protocol: Int = Wire.protocolVersion, features: [Feature] = [], machine: String, userName: String, bots: [Bot],
         position: StreamPosition = StreamPosition(epoch: "", seq: 0, resumed: false)) {
        self.protocol = `protocol`
        self.features = features
        self.machine = machine
        self.userName = userName
        self.bots = bots
        self.position = position
    }
}

enum ServerMessage: Codable, Sendable {
    case hello(Hello)
    case bot(Bot)
    case botRemoved(BotID)
    case created(ref: String, botId: BotID)
    case conversation(botId: BotID, messages: [Message])
    case message(botId: BotID, message: Message)
    /// routines carries every kept run (at most 20), where a bot frame carries only the newest 5.
    case details(botId: BotID, library: [LibraryFile], links: [BotLink], agents: [Agent], routines: [Routine])
    case agent(Agent, messages: [AgentMessage])
    case file(botId: BotID, path: String, file: BotFile)
    case devices([Device])
    case pairCode(PairCode)
    /// What a bot or one of its agents is doing now. text nil: it stopped. Never sequenced or replayed.
    case activity(botId: BotID, agentId: AgentID?, text: String?, at: Date)
    case memory([Fact])
    case connectors(botId: BotID, connectors: [Connector])
    case skills(botId: BotID, skills: [Skill])
    case webhookToken(botId: BotID, token: WebhookToken)
    case error(message: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, machine, userName, bots, bot, botId, ref, messages, message, library, links, agents, routines, agent
        case path, mime, content, data, devices, code, expiresAt
        case `protocol`, epoch, seq, resumed, features
        case agentId, text, at, facts, connectors, skills, routineId, url, token
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "hello":
            self = .hello(Hello(
                protocol: try c.decodeIfPresent(Int.self, forKey: .protocol) ?? 2,
                features: try c.decodeIfPresent([Feature].self, forKey: .features) ?? [],
                machine: try c.decode(String.self, forKey: .machine),
                userName: try c.decode(String.self, forKey: .userName),
                bots: try c.decode([Bot].self, forKey: .bots),
                position: StreamPosition(
                    epoch: try c.decodeIfPresent(String.self, forKey: .epoch) ?? "",
                    seq: try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0,
                    resumed: try c.decodeIfPresent(Bool.self, forKey: .resumed) ?? false
                )
            ))
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
                agents: try c.decode([Agent].self, forKey: .agents),
                routines: try c.decodeIfPresent([Routine].self, forKey: .routines) ?? []
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
        case "devices":
            self = .devices(try c.decode([Device].self, forKey: .devices))
        case "pair_code":
            self = .pairCode(PairCode(code: try c.decode(String.self, forKey: .code), expiresAt: try c.decode(Date.self, forKey: .expiresAt)))
        case "activity":
            self = .activity(
                botId: try c.decode(BotID.self, forKey: .botId),
                agentId: try c.decodeIfPresent(AgentID.self, forKey: .agentId),
                text: try c.decodeIfPresent(String.self, forKey: .text),
                at: try c.decode(Date.self, forKey: .at)
            )
        case "memory":
            self = .memory(try c.decode([Fact].self, forKey: .facts))
        case "connectors":
            self = .connectors(botId: try c.decode(BotID.self, forKey: .botId), connectors: try c.decode([Connector].self, forKey: .connectors))
        case "skills":
            self = .skills(botId: try c.decode(BotID.self, forKey: .botId), skills: try c.decode([Skill].self, forKey: .skills))
        case "webhook_token":
            self = .webhookToken(botId: try c.decode(BotID.self, forKey: .botId), token: WebhookToken(
                routineId: try c.decode(RoutineID.self, forKey: .routineId),
                url: try c.decode(URL.self, forKey: .url),
                token: try c.decode(String.self, forKey: .token)
            ))
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case let other:
            self = .unknown(type: other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .hello(hello):
            try c.encode("hello", forKey: .type)
            try c.encode(hello.protocol, forKey: .protocol)
            try c.encode(hello.features, forKey: .features)
            try c.encode(hello.machine, forKey: .machine)
            try c.encode(hello.userName, forKey: .userName)
            try c.encode(hello.bots, forKey: .bots)
            try c.encode(hello.position.epoch, forKey: .epoch)
            try c.encode(hello.position.seq, forKey: .seq)
            try c.encode(hello.position.resumed, forKey: .resumed)
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
        case let .details(botId, library, links, agents, routines):
            try c.encode("details", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(library, forKey: .library)
            try c.encode(links, forKey: .links)
            try c.encode(agents, forKey: .agents)
            try c.encode(routines, forKey: .routines)
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
        case let .devices(devices):
            try c.encode("devices", forKey: .type)
            try c.encode(devices, forKey: .devices)
        case let .pairCode(code):
            try c.encode("pair_code", forKey: .type)
            try c.encode(code.code, forKey: .code)
            try c.encode(code.expiresAt, forKey: .expiresAt)
        case let .activity(botId, agentId, text, at):
            try c.encode("activity", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(agentId, forKey: .agentId)
            try c.encode(text, forKey: .text)
            try c.encode(at, forKey: .at)
        case let .memory(facts):
            try c.encode("memory", forKey: .type)
            try c.encode(facts, forKey: .facts)
        case let .connectors(botId, connectors):
            try c.encode("connectors", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(connectors, forKey: .connectors)
        case let .skills(botId, skills):
            try c.encode("skills", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(skills, forKey: .skills)
        case let .webhookToken(botId, token):
            try c.encode("webhook_token", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(token.routineId, forKey: .routineId)
            try c.encode(token.url, forKey: .url)
            try c.encode(token.token, forKey: .token)
        case let .error(message):
            try c.encode("error", forKey: .type)
            try c.encode(message, forKey: .message)
        case let .unknown(type):
            try c.encode(type, forKey: .type)
        }
    }
}

/// One frame off the socket. A broadcast carries the stream seq; a reply to one client does not.
/// A hello carries its seq inside its stream position, so `seq` mirrors it there.
struct ServerFrame: Codable, Sendable {
    let seq: Int?
    let message: ServerMessage

    private enum CodingKeys: String, CodingKey { case seq }

    init(seq: Int? = nil, message: ServerMessage) {
        self.seq = seq
        self.message = message
    }

    init(from decoder: Decoder) throws {
        message = try ServerMessage(from: decoder)
        seq = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(Int.self, forKey: .seq)
    }

    func encode(to encoder: Encoder) throws {
        try message.encode(to: encoder)
        if case .hello = message { return }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(seq, forKey: .seq)
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
    /// `.some(nil)` goes back to the bridge default.
    var dailyCapUsd: Double??
    var muted: Bool?

    private enum CodingKeys: String, CodingKey { case name, title, avatar, pinned, hidden, dailyCapUsd, muted }

    init(
        name: String? = nil, title: String?? = nil, avatar: Avatar? = nil, pinned: Bool? = nil, hidden: Bool? = nil,
        dailyCapUsd: Double?? = nil, muted: Bool? = nil
    ) {
        self.name = name
        self.title = title
        self.avatar = avatar
        self.pinned = pinned
        self.hidden = hidden
        self.dailyCapUsd = dailyCapUsd
        self.muted = muted
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
        if c.contains(.dailyCapUsd) {
            dailyCapUsd = .some(try c.decodeNil(forKey: .dailyCapUsd) ? nil : try c.decode(Double.self, forKey: .dailyCapUsd))
        }
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        if let title { try c.encode(title, forKey: .title) }
        try c.encodeIfPresent(avatar, forKey: .avatar)
        try c.encodeIfPresent(pinned, forKey: .pinned)
        try c.encodeIfPresent(hidden, forKey: .hidden)
        if let dailyCapUsd { try c.encode(dailyCapUsd, forKey: .dailyCapUsd) }
        try c.encodeIfPresent(muted, forKey: .muted)
    }
}

enum ClientMessage: Codable, Hashable, Sendable {
    case createBot(ref: String)
    /// Asks for the conversation and marks the bot read.
    case open(botId: BotID)
    /// clientId lets the bridge drop a send it already has and the app match the echo to its bubble.
    case send(botId: BotID, text: String, uploads: [Upload], clientId: String? = nil)
    case answer(botId: BotID, messageId: MessageID, option: Int)
    case dismiss(botId: BotID, messageId: MessageID)
    /// Answers a permission card. Chat text never approves.
    case decide(botId: BotID, messageId: MessageID, choice: PermissionChoice)
    /// Stops the bot's turn in flight and drops its queued unattended work.
    case stop(botId: BotID)
    case stopAgent(agentId: AgentID)
    case updateBot(botId: BotID, patch: BotPatch)
    case markUnread(botId: BotID)
    case deleteBot(botId: BotID)
    case setRoutine(botId: BotID, routineId: RoutineID, enabled: Bool)
    case runRoutine(botId: BotID, routineId: RoutineID)
    case details(botId: BotID)
    case agent(agentId: AgentID)
    case file(botId: BotID, path: String)
    case memory
    /// factId nil adds a fact.
    case setFact(factId: FactID?, text: String)
    case forgetFact(factId: FactID)
    case confirmFact(factId: FactID)
    case connectors(botId: BotID)
    case setConnector(botId: BotID, name: String, enabled: Bool)
    case skills(botId: BotID)
    case deleteSkill(botId: BotID, name: String)
    case webhookToken(botId: BotID, routineId: RoutineID)
    case removeWorktree(agentId: AgentID)
    case devices
    case revokeDevice(deviceId: DeviceID)
    case pairCode

    private enum CodingKeys: String, CodingKey {
        case type, ref, botId, text, uploads, messageId, option, choice, patch, routineId, enabled, agentId, path, deviceId
        case clientId, factId, name
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func bot() throws -> BotID { try c.decode(BotID.self, forKey: .botId) }
        switch try c.decode(String.self, forKey: .type) {
        case "create_bot": self = .createBot(ref: try c.decode(String.self, forKey: .ref))
        case "open": self = .open(botId: try bot())
        case "send":
            self = .send(
                botId: try bot(), text: try c.decode(String.self, forKey: .text), uploads: try c.decode([Upload].self, forKey: .uploads),
                clientId: try c.decodeIfPresent(String.self, forKey: .clientId)
            )
        case "answer":
            self = .answer(botId: try bot(), messageId: try c.decode(MessageID.self, forKey: .messageId), option: try c.decode(Int.self, forKey: .option))
        case "dismiss": self = .dismiss(botId: try bot(), messageId: try c.decode(MessageID.self, forKey: .messageId))
        case "decide":
            self = .decide(botId: try bot(), messageId: try c.decode(MessageID.self, forKey: .messageId), choice: try c.decode(PermissionChoice.self, forKey: .choice))
        case "stop": self = .stop(botId: try bot())
        case "stop_agent": self = .stopAgent(agentId: try c.decode(AgentID.self, forKey: .agentId))
        case "update_bot": self = .updateBot(botId: try bot(), patch: try c.decode(BotPatch.self, forKey: .patch))
        case "mark_unread": self = .markUnread(botId: try bot())
        case "delete_bot": self = .deleteBot(botId: try bot())
        case "set_routine":
            self = .setRoutine(botId: try bot(), routineId: try c.decode(RoutineID.self, forKey: .routineId), enabled: try c.decode(Bool.self, forKey: .enabled))
        case "run_routine": self = .runRoutine(botId: try bot(), routineId: try c.decode(RoutineID.self, forKey: .routineId))
        case "details": self = .details(botId: try bot())
        case "agent": self = .agent(agentId: try c.decode(AgentID.self, forKey: .agentId))
        case "file": self = .file(botId: try bot(), path: try c.decode(String.self, forKey: .path))
        case "memory": self = .memory
        case "set_fact": self = .setFact(factId: try c.decodeIfPresent(FactID.self, forKey: .factId), text: try c.decode(String.self, forKey: .text))
        case "forget_fact": self = .forgetFact(factId: try c.decode(FactID.self, forKey: .factId))
        case "confirm_fact": self = .confirmFact(factId: try c.decode(FactID.self, forKey: .factId))
        case "connectors": self = .connectors(botId: try bot())
        case "set_connector":
            self = .setConnector(botId: try bot(), name: try c.decode(String.self, forKey: .name), enabled: try c.decode(Bool.self, forKey: .enabled))
        case "skills": self = .skills(botId: try bot())
        case "delete_skill": self = .deleteSkill(botId: try bot(), name: try c.decode(String.self, forKey: .name))
        case "webhook_token": self = .webhookToken(botId: try bot(), routineId: try c.decode(RoutineID.self, forKey: .routineId))
        case "remove_worktree": self = .removeWorktree(agentId: try c.decode(AgentID.self, forKey: .agentId))
        case "devices": self = .devices
        case "revoke_device": self = .revokeDevice(deviceId: try c.decode(DeviceID.self, forKey: .deviceId))
        case "pair_code": self = .pairCode
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
        case let .send(botId, text, uploads, clientId):
            try c.encode("send", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(text, forKey: .text)
            try c.encode(uploads, forKey: .uploads)
            try c.encodeIfPresent(clientId, forKey: .clientId)
        case let .answer(botId, messageId, option):
            try c.encode("answer", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(messageId, forKey: .messageId)
            try c.encode(option, forKey: .option)
        case let .dismiss(botId, messageId):
            try c.encode("dismiss", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(messageId, forKey: .messageId)
        case let .decide(botId, messageId, choice):
            try c.encode("decide", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(messageId, forKey: .messageId)
            try c.encode(choice, forKey: .choice)
        case let .stop(botId):
            try c.encode("stop", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .stopAgent(agentId):
            try c.encode("stop_agent", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
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
        case let .runRoutine(botId, routineId):
            try c.encode("run_routine", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(routineId, forKey: .routineId)
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
        case .memory:
            try c.encode("memory", forKey: .type)
        case let .setFact(factId, text):
            try c.encode("set_fact", forKey: .type)
            try c.encode(factId, forKey: .factId)
            try c.encode(text, forKey: .text)
        case let .forgetFact(factId):
            try c.encode("forget_fact", forKey: .type)
            try c.encode(factId, forKey: .factId)
        case let .confirmFact(factId):
            try c.encode("confirm_fact", forKey: .type)
            try c.encode(factId, forKey: .factId)
        case let .connectors(botId):
            try c.encode("connectors", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .setConnector(botId, name, enabled):
            try c.encode("set_connector", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(name, forKey: .name)
            try c.encode(enabled, forKey: .enabled)
        case let .skills(botId):
            try c.encode("skills", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .deleteSkill(botId, name):
            try c.encode("delete_skill", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(name, forKey: .name)
        case let .webhookToken(botId, routineId):
            try c.encode("webhook_token", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(routineId, forKey: .routineId)
        case let .removeWorktree(agentId):
            try c.encode("remove_worktree", forKey: .type)
            try c.encode(agentId, forKey: .agentId)
        case .devices:
            try c.encode("devices", forKey: .type)
        case let .revokeDevice(deviceId):
            try c.encode("revoke_device", forKey: .type)
            try c.encode(deviceId, forKey: .deviceId)
        case .pairCode:
            try c.encode("pair_code", forKey: .type)
        }
    }
}

/// HTTP, outside the socket: POST /pair with a one-time code returns this device's own token.
struct PairRequest: Codable, Hashable, Sendable {
    let code: String
    let name: String
}

struct PairResponse: Codable, Hashable, Sendable {
    let deviceId: DeviceID
    let token: String
}

enum Wire {
    /// The protocol this app speaks, sent on every connect.
    static let protocolVersion = 3
    /// The bridge protocols this app works with. Outside it the app asks to update one side.
    static let protocols = 3...3

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
