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
    case memory, activity, mute, worktrees, connectors, skills, webhooks, spend
    case mentions, commands, exchanges, groups, usage, sessions
    case unknown(String)

    static let allCases: [Feature] = [
        .memory, .activity, .mute, .worktrees, .connectors, .skills, .webhooks, .spend,
        .mentions, .commands, .exchanges, .groups, .usage, .sessions,
    ]
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
        case .spend: "spend"
        case .mentions: "mentions"
        case .commands: "commands"
        case .exchanges: "exchanges"
        case .groups: "groups"
        case .usage: "usage"
        case .sessions: "sessions"
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

/// A group is a chat of the user and several bots. It has no Claude Code session of its own: its members answer in it.
enum BotKind: OpenEnum {
    case bot, group
    case unknown(String)

    static let allCases: [BotKind] = [.bot, .group]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .bot: "bot"
        case .group: "group"
        case .unknown(let raw): raw
        }
    }
}

struct Bot: Codable, Hashable, Sendable, Identifiable {
    let id: BotID
    /// .bot from a bridge without the groups feature.
    var kind: BotKind
    /// The bots in a group. Empty for a plain bot.
    var members: [BotID]
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
    /// What the bot and its agents spent today, and the cap in force. Nil from a bridge without the spend feature.
    var spentTodayUsd: Double?
    var capUsd: Double?

    private enum CodingKeys: String, CodingKey {
        case id, name, title, avatar, pinned, hidden, status, unread, question, preview, lastAt, createdAt, routines, dailyCapUsd, muted
        case spentTodayUsd, capUsd, kind, members
    }

    init(
        id: BotID, name: String, title: String?, avatar: Avatar, pinned: Bool, hidden: Bool, status: BotStatus,
        unread: Int, question: String?, preview: String, lastAt: Date, createdAt: Date, routines: [Routine],
        dailyCapUsd: Double? = nil, muted: Bool = false, spentTodayUsd: Double? = nil, capUsd: Double? = nil,
        kind: BotKind = .bot, members: [BotID] = []
    ) {
        self.id = id
        self.kind = kind
        self.members = members
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
        self.spentTodayUsd = spentTodayUsd
        self.capUsd = capUsd
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(BotID.self, forKey: .id)
        kind = try c.decodeIfPresent(BotKind.self, forKey: .kind) ?? .bot
        members = try c.decodeIfPresent([BotID].self, forKey: .members) ?? []
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
        spentTodayUsd = try c.decodeIfPresent(Double.self, forKey: .spentTodayUsd)
        capUsd = try c.decodeIfPresent(Double.self, forKey: .capUsd)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(members, forKey: .members)
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
        // A bridge with spend sends capUsd beside spentTodayUsd, null when there is no cap.
        if let spentTodayUsd {
            try c.encode(spentTodayUsd, forKey: .spentTodayUsd)
            try c.encode(capUsd, forKey: .capUsd)
        }
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

/// What one "@name" token in a user message points to. The text keeps the token.
enum Mention: Codable, Hashable, Sendable {
    case bot(id: BotID, name: String)
    case connector(name: String)
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey { case kind, id, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "bot": self = .bot(id: try c.decode(BotID.self, forKey: .id), name: try c.decode(String.self, forKey: .name))
        case "connector": self = .connector(name: try c.decode(String.self, forKey: .name))
        case let other: self = .unknown(kind: other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .bot(id, name):
            try c.encode("bot", forKey: .kind)
            try c.encode(id, forKey: .id)
            try c.encode(name, forKey: .name)
        case let .connector(name):
            try c.encode("connector", forKey: .kind)
            try c.encode(name, forKey: .name)
        case let .unknown(kind):
            try c.encode(kind, forKey: .kind)
        }
    }
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
    /// clientId: the id the app gave its send, echoed back by the bridge. mentions: what each "@name" in text points to.
    case user(id: MessageID, at: Date, text: String, attachments: [Attachment], clientId: String? = nil, mentions: [Mention] = [])
    /// from: in a group conversation, the member who posted it. nil in a bot's own chat.
    case bot(id: MessageID, at: Date, text: String, from: BotID? = nil)
    case question(id: MessageID, at: Date, card: QuestionCard)
    case permission(id: MessageID, at: Date, card: PermissionCard)
    /// A run of messages between this bot and one peer.
    case exchange(id: MessageID, at: Date, peer: Peer, sent: Int, received: Int)
    /// A system line whose `{n}` placeholders become chips for `refs[n]`.
    case note(id: MessageID, at: Date, text: String, refs: [Peer])
    case unknown(id: MessageID, at: Date, kind: String)

    var id: MessageID {
        switch self {
        case .user(let id, _, _, _, _, _), .bot(let id, _, _, _), .question(let id, _, _), .permission(let id, _, _),
             .exchange(let id, _, _, _, _), .note(let id, _, _, _), .unknown(let id, _, _): id
        }
    }

    var at: Date {
        switch self {
        case .user(_, let at, _, _, _, _), .bot(_, let at, _, _), .question(_, let at, _), .permission(_, let at, _),
             .exchange(_, let at, _, _, _), .note(_, let at, _, _), .unknown(_, let at, _): at
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, at, text, attachments, question, options, answer, expiresAt, peer, sent, received, refs
        case from, tool, label, detail, always, clientId, mentions
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
                clientId: try c.decodeIfPresent(String.self, forKey: .clientId),
                mentions: try c.decodeIfPresent([Mention].self, forKey: .mentions) ?? []
            )
        case "bot":
            self = .bot(id: id, at: at, text: try c.decode(String.self, forKey: .text), from: try c.decodeIfPresent(BotID.self, forKey: .from))
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
        case let .user(_, _, text, attachments, clientId, mentions):
            try c.encode("user", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(attachments, forKey: .attachments)
            try c.encodeIfPresent(clientId, forKey: .clientId)
            if !mentions.isEmpty { try c.encode(mentions, forKey: .mentions) }
        case let .bot(_, _, text, from):
            try c.encode("bot", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(from, forKey: .from)
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
    /// Lifetime spend and the budget in force. Nil for cloud agents, and from a bridge without the spend feature.
    var spentUsd: Double? = nil
    var budgetUsd: Double? = nil

    private enum CodingKeys: String, CodingKey {
        case id, botId, title, `where`, projectName, status, url, createdAt, updatedAt, evidence, worktree, spentUsd, budgetUsd
    }

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
        try c.encode(spentUsd, forKey: .spentUsd)
        try c.encode(budgetUsd, forKey: .budgetUsd)
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
/// proposerBotId: the bot whose proposal this is, nil once confirmed and from a bridge that predates it.
struct Fact: Codable, Hashable, Sendable, Identifiable {
    let id: FactID
    var text: String
    var at: Date
    var by: String?
    var confirmed: Bool
    var proposerBotId: BotID?

    private enum CodingKeys: String, CodingKey { case id, text, at, by, confirmed, proposerBotId }

    init(id: FactID, text: String, at: Date, by: String?, confirmed: Bool = true, proposerBotId: BotID? = nil) {
        self.id = id
        self.text = text
        self.at = at
        self.by = by
        self.confirmed = confirmed
        self.proposerBotId = proposerBotId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(FactID.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        at = try c.decode(Date.self, forKey: .at)
        by = try c.decodeIfPresent(String.self, forKey: .by)
        confirmed = try c.decodeIfPresent(Bool.self, forKey: .confirmed) ?? true
        proposerBotId = try c.decodeIfPresent(BotID.self, forKey: .proposerBotId)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(text, forKey: .text)
        try c.encode(at, forKey: .at)
        try c.encode(by, forKey: .by)
        try c.encode(proposerBotId, forKey: .proposerBotId)
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

enum CommandSource: OpenEnum {
    case skill, builtin
    case unknown(String)

    static let allCases: [CommandSource] = [.skill, .builtin]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .skill: "skill"
        case .builtin: "builtin"
        case .unknown(let raw): raw
        }
    }
}

/// One entry of the "/" menu, as the bot's Claude Code session reports it. argumentHint is empty when it takes none.
struct Command: Codable, Hashable, Sendable, Identifiable {
    let name: String
    var description: String
    var argumentHint: String
    var source: CommandSource

    var id: String { name }
}

/// One message between two bots, the text behind an exchange line.
struct ExchangeMessage: Codable, Hashable, Sendable, Identifiable {
    let id: MessageID
    let at: Date
    let from: BotID
    let text: String
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

/// Which limit window of the Claude plan a row is. An unknown kind reads as a weekly window.
enum UsageWindowKind: OpenEnum {
    case session, weekly, weeklyModel
    case unknown(String)

    static let allCases: [UsageWindowKind] = [.session, .weekly, .weeklyModel]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .session: "session"
        case .weekly: "weekly"
        case .weeklyModel: "weekly_model"
        case .unknown(let raw): raw
        }
    }
}

/// How close a window is to its limit, as the server rates it. An unknown severity reads as normal.
enum UsageSeverity: OpenEnum {
    case normal, warning, critical
    case unknown(String)

    static let allCases: [UsageSeverity] = [.normal, .warning, .critical]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .normal: "normal"
        case .warning: "warning"
        case .critical: "critical"
        case .unknown(let raw): raw
        }
    }
}

/// Why the bridge shows no plan limits. An unknown reason reads as failed.
enum UsageUnavailable: OpenEnum {
    case apiKey, thirdParty, loggedOut, noScope, failed
    case unknown(String)

    static let allCases: [UsageUnavailable] = [.apiKey, .thirdParty, .loggedOut, .noScope, .failed]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .apiKey: "api_key"
        case .thirdParty: "third_party"
        case .loggedOut: "logged_out"
        case .noScope: "no_scope"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

struct UsageWindow: Codable, Hashable, Sendable, Identifiable {
    /// The same window keeps its id across reads: "session", "weekly", "weekly:fable".
    let id: String
    var kind: UsageWindowKind
    /// "Current session", "Weekly · all models", "Weekly · Fable".
    var label: String
    /// The share used, from 0. At or past 1 the limit is reached.
    var utilization: Double
    var resetsAt: Date?
    var severity: UsageSeverity

    private enum CodingKeys: String, CodingKey { case id, kind, label, utilization, resetsAt, severity }

    init(id: String, kind: UsageWindowKind, label: String, utilization: Double, resetsAt: Date?, severity: UsageSeverity) {
        self.id = id
        self.kind = kind
        self.label = label
        self.utilization = utilization
        self.resetsAt = resetsAt
        self.severity = severity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(UsageWindowKind.self, forKey: .kind)
        label = try c.decode(String.self, forKey: .label)
        utilization = try c.decode(Double.self, forKey: .utilization)
        resetsAt = try c.decodeIfPresent(Date.self, forKey: .resetsAt)
        severity = try c.decode(UsageSeverity.self, forKey: .severity)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(label, forKey: .label)
        try c.encode(utilization, forKey: .utilization)
        try c.encode(resetsAt, forKey: .resetsAt)
        try c.encode(severity, forKey: .severity)
    }
}

/// The plan's usage limits as the bridge last read them (feature usage). fetchedAt: when these numbers were read.
/// stale: the reads since failed, so these are the last good ones.
enum PlanUsage: Codable, Hashable, Sendable {
    case ok(plan: String?, fetchedAt: Date, stale: Bool, windows: [UsageWindow])
    case unavailable(reason: UsageUnavailable, fetchedAt: Date)

    private enum CodingKeys: String, CodingKey { case state, plan, fetchedAt, stale, windows, reason }

    var fetchedAt: Date {
        switch self {
        case .ok(_, let at, _, _), .unavailable(_, let at): at
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let fetchedAt = try c.decode(Date.self, forKey: .fetchedAt)
        // A state this app does not know shows as a read that failed.
        guard try c.decode(String.self, forKey: .state) == "ok" else {
            self = .unavailable(reason: try c.decodeIfPresent(UsageUnavailable.self, forKey: .reason) ?? .failed, fetchedAt: fetchedAt)
            return
        }
        self = .ok(
            plan: try c.decodeIfPresent(String.self, forKey: .plan),
            fetchedAt: fetchedAt,
            stale: try c.decodeIfPresent(Bool.self, forKey: .stale) ?? false,
            windows: try c.decode([UsageWindow].self, forKey: .windows)
        )
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .ok(plan, fetchedAt, stale, windows):
            try c.encode("ok", forKey: .state)
            try c.encode(plan, forKey: .plan)
            try c.encode(fetchedAt, forKey: .fetchedAt)
            try c.encode(stale, forKey: .stale)
            try c.encode(windows, forKey: .windows)
        case let .unavailable(reason, fetchedAt):
            try c.encode("unavailable", forKey: .state)
            try c.encode(reason, forKey: .reason)
            try c.encode(fetchedAt, forKey: .fetchedAt)
        }
    }
}

// MARK: Sessions (feature sessions)

// The Claude Code sessions on the Mac, grouped by project, and one thread at a time. Session frames carry no seq and
// are never replayed: each is a reply, or comes on the list channel (after watchSessions) or a thread's channel
// (after watchSession). bridge/src/protocol.ts documents each frame's delivery and invariants.

enum SessionTag {}
enum ProjectTag {}
enum ItemTag {}
enum CursorTag {}
typealias SessionID = Identifier<SessionTag>
typealias ProjectID = Identifier<ProjectTag>
typealias ItemID = Identifier<ItemTag>
/// Opaque: where the next older page starts. Sent back as it came.
typealias Cursor = Identifier<CursorTag>

/// Who started the session.
enum SessionOrigin: OpenEnum {
    case phone, agent, desktop, terminal, sdk, cloud
    case unknown(String)

    static let allCases: [SessionOrigin] = [.phone, .agent, .desktop, .terminal, .sdk, .cloud]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .phone: "phone"
        case .agent: "agent"
        case .desktop: "desktop"
        case .terminal: "terminal"
        case .sdk: "sdk"
        case .cloud: "cloud"
        case .unknown(let raw): raw
        }
    }
}

/// awaitingApproval: a permission or plan card is open. awaitingInput: an ask card is open. parked: queued input waits
/// on a hold. unavailable: Claude Code could not start.
enum SessionStatus: OpenEnum {
    case idle, working, awaitingApproval, awaitingInput, failed, parked, unavailable
    case unknown(String)

    static let allCases: [SessionStatus] = [.idle, .working, .awaitingApproval, .awaitingInput, .failed, .parked, .unavailable]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .idle: "idle"
        case .working: "working"
        case .awaitingApproval: "awaiting_approval"
        case .awaitingInput: "awaiting_input"
        case .failed: "failed"
        case .parked: "parked"
        case .unavailable: "unavailable"
        case .unknown(let raw): raw
        }
    }
}

/// Which live process holds the session. nobody is the wire's "none"; claudio is this bridge.
enum SessionHolder: OpenEnum {
    case nobody, claudio, desktop, terminal, other
    case unknown(String)

    static let allCases: [SessionHolder] = [.nobody, .claudio, .desktop, .terminal, .other]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .nobody: "none"
        case .claudio: "claudio"
        case .desktop: "desktop"
        case .terminal: "terminal"
        case .other: "other"
        case .unknown(let raw): raw
        }
    }
}

/// Whether the Claude app lists the session. pending: an automatic import waits. failed: an import did not show up,
/// so automatic retries stopped. notMirrored is the wire's "none".
enum SessionMirror: OpenEnum {
    case imported, pending, failed, notMirrored
    case unknown(String)

    static let allCases: [SessionMirror] = [.imported, .pending, .failed, .notMirrored]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .imported: "imported"
        case .pending: "pending"
        case .failed: "failed"
        case .notMirrored: "none"
        case .unknown(let raw): raw
        }
    }
}

/// Settings, "Show agent sessions in the Claude app": Automatically, When I tap, Never.
enum MirrorPref: OpenEnum {
    case auto, tap, never
    case unknown(String)

    static let allCases: [MirrorPref] = [.auto, .tap, .never]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .auto: "auto"
        case .tap: "tap"
        case .never: "never"
        case .unknown(let raw): raw
        }
    }
}

/// Claude Code's permission modes. The phone never offers bypassPermissions, and the bridge refuses it.
enum PermissionMode: OpenEnum {
    case `default`, acceptEdits, bypassPermissions, plan, dontAsk, auto
    case unknown(String)

    static let allCases: [PermissionMode] = [.default, .acceptEdits, .bypassPermissions, .plan, .dontAsk, .auto]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .default: "default"
        case .acceptEdits: "acceptEdits"
        case .bypassPermissions: "bypassPermissions"
        case .plan: "plan"
        case .dontAsk: "dontAsk"
        case .auto: "auto"
        case .unknown(let raw): raw
        }
    }
}

/// Where a new session works: the project folder itself (the wire's "none"), or a new worktree.
enum SessionIsolation: String, Codable, Hashable, Sendable, CaseIterable {
    case inPlace = "none"
    case worktree
}

/// A git repository's main checkout. name: the GitHub repo name, else the folder name. lastAt: nil when it has no sessions.
struct SessionProject: Codable, Hashable, Sendable, Identifiable {
    let id: ProjectID
    var name: String
    var path: String
    var githubRepo: String?
    var lastAt: Date?
    /// Reserved for phone-started cloud sessions; false for now.
    var canCloud: Bool

    private enum CodingKeys: String, CodingKey { case id, name, path, githubRepo, lastAt, canCloud }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(path, forKey: .path)
        try c.encode(githubRepo, forKey: .githubRepo)
        try c.encode(lastAt, forKey: .lastAt)
        try c.encode(canCloud, forKey: .canCloud)
    }
}

enum PullRequestState: OpenEnum {
    case open, merged, closed
    case unknown(String)

    static let allCases: [PullRequestState] = [.open, .merged, .closed]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .open: "open"
        case .merged: "merged"
        case .closed: "closed"
        case .unknown(let raw): raw
        }
    }
}

/// state nil: the transcript names the PR without its state.
struct SessionPullRequest: Codable, Hashable, Sendable {
    var number: Int
    var url: URL
    var state: PullRequestState?

    private enum CodingKeys: String, CodingKey { case number, url, state }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(number, forKey: .number)
        try c.encode(url, forKey: .url)
        try c.encode(state, forKey: .state)
    }
}

/// The bot's agent that owns a session.
struct SessionAgentLink: Codable, Hashable, Sendable {
    let botId: BotID
    let agentId: AgentID
}

/// One session in the list. parentId: the session it was spawned from. url: claude.ai for a cloud row.
struct SessionRow: Codable, Hashable, Sendable, Identifiable {
    let id: SessionID
    var projectId: ProjectID
    var parentId: SessionID?
    var title: String
    var origin: SessionOrigin
    var agent: SessionAgentLink?
    var status: SessionStatus
    var holder: SessionHolder
    var unread: Bool
    var branch: String?
    /// The cwd is a git worktree, not the main checkout.
    var worktree: Bool
    var pr: SessionPullRequest?
    var mirror: SessionMirror
    var hidden: Bool
    var url: URL?
    var createdAt: Date
    var lastAt: Date

    private enum CodingKeys: String, CodingKey {
        case id, projectId, parentId, title, origin, agent, status, holder, unread, branch, worktree, pr, mirror, hidden, url, createdAt, lastAt
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(projectId, forKey: .projectId)
        try c.encode(parentId, forKey: .parentId)
        try c.encode(title, forKey: .title)
        try c.encode(origin, forKey: .origin)
        try c.encode(agent, forKey: .agent)
        try c.encode(status, forKey: .status)
        try c.encode(holder, forKey: .holder)
        try c.encode(unread, forKey: .unread)
        try c.encode(branch, forKey: .branch)
        try c.encode(worktree, forKey: .worktree)
        try c.encode(pr, forKey: .pr)
        try c.encode(mirror, forKey: .mirror)
        try c.encode(hidden, forKey: .hidden)
        try c.encode(url, forKey: .url)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(lastAt, forKey: .lastAt)
    }
}

enum ToolStepState: OpenEnum {
    case running, ok, error, denied
    case unknown(String)

    static let allCases: [ToolStepState] = [.running, .ok, .error, .denied]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .running: "running"
        case .ok: "ok"
        case .error: "error"
        case .denied: "denied"
        case .unknown(let raw): raw
        }
    }
}

/// The line counts of an Edit, Write or MultiEdit.
struct ToolDiff: Codable, Hashable, Sendable {
    var path: String
    var added: Int
    var removed: Int
}

/// One tool call in a work item. id: its tool_use id, which sessionTool names. output: the last 2 KB of its result.
struct ToolStep: Codable, Hashable, Sendable, Identifiable {
    let id: String
    var tool: String
    /// The call in words: "Edit src/app.ts", "Run bun test".
    var label: String
    var state: ToolStepState
    var diff: ToolDiff?
    var output: String?

    private enum CodingKeys: String, CodingKey { case id, tool, label, state, diff, output }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(tool, forKey: .tool)
        try c.encode(label, forKey: .label)
        try c.encode(state, forKey: .state)
        try c.encode(diff, forKey: .diff)
        try c.encode(output, forKey: .output)
    }
}

enum TodoState: OpenEnum {
    case pending, inProgress, done
    case unknown(String)

    static let allCases: [TodoState] = [.pending, .inProgress, .done]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .pending: "pending"
        case .inProgress: "in_progress"
        case .done: "done"
        case .unknown(let raw): raw
        }
    }
}

struct SessionTodo: Codable, Hashable, Sendable {
    var text: String
    var state: TodoState
}

enum PlanState: OpenEnum {
    case proposed, approved, rejected, expired
    case unknown(String)

    static let allCases: [PlanState] = [.proposed, .approved, .rejected, .expired]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .proposed: "proposed"
        case .approved: "approved"
        case .rejected: "rejected"
        case .expired: "expired"
        case .unknown(let raw): raw
        }
    }
}

enum NoticeTone: OpenEnum {
    case info, error
    case unknown(String)

    static let allCases: [NoticeTone] = [.info, .error]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .info: "info"
        case .error: "error"
        case .unknown(let raw): raw
        }
    }
}

/// Who wrote a user item: the user, a bot to its agent, or the bridge.
enum SessionAuthor: OpenEnum {
    case user, bot, system
    case unknown(String)

    static let allCases: [SessionAuthor] = [.user, .bot, .system]
    init?(rawValue: String) { self.init(wire: rawValue) }

    var rawValue: String {
        switch self {
        case .user: "user"
        case .bot: "bot"
        case .system: "system"
        case .unknown(let raw): raw
        }
    }
}

struct AskOption: Codable, Hashable, Sendable {
    var label: String
    var description: String
}

/// One AskUserQuestion question. The app offers a free answer besides the options.
struct AskQuestion: Codable, Hashable, Sendable {
    var question: String
    var header: String
    var options: [AskOption]
    var multiSelect: Bool
}

/// How an ask item was closed. nil on the item means it is still open.
enum AskAnswers: Codable, Hashable, Sendable {
    /// By question text; a multi-select's labels are comma-separated.
    case answered([String: String])
    case dismissed
    case expired
    /// A closing state a newer bridge invented.
    case closed(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let answers = try? c.decode([String: String].self) {
            self = .answered(answers)
            return
        }
        switch try c.decode(String.self) {
        case "dismissed": self = .dismissed
        case "expired": self = .expired
        case let other: self = .closed(other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .answered(let answers): try c.encode(answers)
        case .dismissed: try c.encode("dismissed")
        case .expired: try c.encode("expired")
        case .closed(let raw): try c.encode(raw)
        }
    }
}

/// A permission card in a thread, the same card a bot's chat shows. cardId is what sessionDecide sends.
struct SessionPermission: Hashable, Sendable {
    let cardId: MessageID
    let at: Date
    var card: PermissionCard
}

/// One row of a thread, upserted by id. See SessionItem in bridge/src/protocol.ts for each kind.
enum SessionItem: Codable, Hashable, Sendable, Identifiable {
    /// queued: not sent yet.
    case user(id: ItemID, at: Date, text: String, from: SessionAuthor, queued: Bool)
    case assistant(id: ItemID, at: Date, text: String)
    /// ms: how long it thought, nil when unknown.
    case thinking(id: ItemID, at: Date, text: String, ms: Int?)
    /// One run of tool calls.
    case work(id: ItemID, at: Date, steps: [ToolStep])
    case todo(id: ItemID, at: Date, todos: [SessionTodo])
    /// cardId: set while the phone may decide it (sessionDecide: once approves, deny keeps planning).
    case plan(id: ItemID, at: Date, text: String, state: PlanState, cardId: MessageID?)
    case permission(id: ItemID, at: Date, permission: SessionPermission)
    /// answers nil: open. cardId: set while the phone may answer it.
    case ask(id: ItemID, at: Date, questions: [AskQuestion], answers: AskAnswers?, cardId: MessageID?)
    case notice(id: ItemID, at: Date, text: String, tone: NoticeTone)
    case compaction(id: ItemID, at: Date)
    /// A kind this app does not know. The thread skips it.
    case unknown(id: ItemID, at: Date, kind: String)

    var id: ItemID {
        switch self {
        case .user(let id, _, _, _, _), .assistant(let id, _, _), .thinking(let id, _, _, _), .work(let id, _, _), .todo(let id, _, _),
             .plan(let id, _, _, _, _), .permission(let id, _, _), .ask(let id, _, _, _, _), .notice(let id, _, _, _),
             .compaction(let id, _), .unknown(let id, _, _): id
        }
    }

    var at: Date {
        switch self {
        case .user(_, let at, _, _, _), .assistant(_, let at, _), .thinking(_, let at, _, _), .work(_, let at, _), .todo(_, let at, _),
             .plan(_, let at, _, _, _), .permission(_, let at, _), .ask(_, let at, _, _, _), .notice(_, let at, _, _),
             .compaction(_, let at), .unknown(_, let at, _): at
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, at, text, from, queued, ms, steps, todos, state, cardId, card, questions, answers, tone
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(ItemID.self, forKey: .id)
        let at = try c.decode(Date.self, forKey: .at)
        func text() throws -> String { try c.decode(String.self, forKey: .text) }
        switch try c.decode(String.self, forKey: .kind) {
        case "user":
            self = .user(id: id, at: at, text: try text(), from: try c.decode(SessionAuthor.self, forKey: .from), queued: try c.decode(Bool.self, forKey: .queued))
        case "assistant":
            self = .assistant(id: id, at: at, text: try text())
        case "thinking":
            self = .thinking(id: id, at: at, text: try text(), ms: try c.decodeIfPresent(Int.self, forKey: .ms))
        case "work":
            self = .work(id: id, at: at, steps: try c.decode([ToolStep].self, forKey: .steps))
        case "todo":
            self = .todo(id: id, at: at, todos: try c.decode([SessionTodo].self, forKey: .todos))
        case "plan":
            self = .plan(
                id: id, at: at, text: try text(), state: try c.decode(PlanState.self, forKey: .state),
                cardId: try c.decodeIfPresent(MessageID.self, forKey: .cardId)
            )
        case "permission":
            guard case let .permission(cardId, cardAt, card) = try c.decode(Message.self, forKey: .card) else {
                throw DecodingError.dataCorruptedError(forKey: .card, in: c, debugDescription: "a permission item's card is a permission card")
            }
            self = .permission(id: id, at: at, permission: SessionPermission(cardId: cardId, at: cardAt, card: card))
        case "ask":
            self = .ask(
                id: id, at: at, questions: try c.decode([AskQuestion].self, forKey: .questions),
                answers: try c.decodeIfPresent(AskAnswers.self, forKey: .answers),
                cardId: try c.decodeIfPresent(MessageID.self, forKey: .cardId)
            )
        case "notice":
            self = .notice(id: id, at: at, text: try text(), tone: try c.decode(NoticeTone.self, forKey: .tone))
        case "compaction":
            self = .compaction(id: id, at: at)
        case let other:
            self = .unknown(id: id, at: at, kind: other)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(at, forKey: .at)
        switch self {
        case let .user(_, _, text, from, queued):
            try c.encode("user", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(from, forKey: .from)
            try c.encode(queued, forKey: .queued)
        case let .assistant(_, _, text):
            try c.encode("assistant", forKey: .kind)
            try c.encode(text, forKey: .text)
        case let .thinking(_, _, text, ms):
            try c.encode("thinking", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(ms, forKey: .ms)
        case let .work(_, _, steps):
            try c.encode("work", forKey: .kind)
            try c.encode(steps, forKey: .steps)
        case let .todo(_, _, todos):
            try c.encode("todo", forKey: .kind)
            try c.encode(todos, forKey: .todos)
        case let .plan(_, _, text, state, cardId):
            try c.encode("plan", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(state, forKey: .state)
            try c.encode(cardId, forKey: .cardId)
        case let .permission(_, _, permission):
            try c.encode("permission", forKey: .kind)
            try c.encode(Message.permission(id: permission.cardId, at: permission.at, card: permission.card), forKey: .card)
        case let .ask(_, _, questions, answers, cardId):
            try c.encode("ask", forKey: .kind)
            try c.encode(questions, forKey: .questions)
            try c.encode(answers, forKey: .answers)
            try c.encode(cardId, forKey: .cardId)
        case let .notice(_, _, text, tone):
            try c.encode("notice", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(tone, forKey: .tone)
        case .compaction:
            try c.encode("compaction", forKey: .kind)
        case let .unknown(_, _, kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

struct SessionModelOption: Codable, Hashable, Sendable, Identifiable {
    let id: String
    var label: String
}

/// What the composer may do now. canSend false comes with the reason in words. queued: the user's messages waiting.
/// model nil: the transcript's last model, else the user's default. modes: what the mode menu offers.
struct SessionControls: Codable, Hashable, Sendable {
    var canSend: Bool
    var reason: String?
    var working: Bool
    var queued: Int
    var model: String?
    var models: [SessionModelOption]
    var mode: PermissionMode
    var modes: [PermissionMode]

    private enum CodingKeys: String, CodingKey { case canSend, reason, working, queued, model, models, mode, modes }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(canSend, forKey: .canSend)
        try c.encode(reason, forKey: .reason)
        try c.encode(working, forKey: .working)
        try c.encode(queued, forKey: .queued)
        try c.encode(model, forKey: .model)
        try c.encode(models, forKey: .models)
        try c.encode(mode, forKey: .mode)
        try c.encode(modes, forKey: .modes)
    }
}

/// Where a thread stands: rev counts upserts per session within one bridge epoch. watchSession sends it back.
struct ThreadPosition: Codable, Hashable, Sendable {
    var epoch: String
    var rev: Int
}

/// Text streaming into an item not yet upserted. Offsets and lengths count UTF-16 code units (String.utf16.count).
struct ThreadLive: Codable, Hashable, Sendable {
    var itemId: ItemID
    var text: String
}

/// The reply to watchSession when it needs a snapshot. items: the newest page, oldest first. before nil: the start.
struct SessionSnapshot: Hashable, Sendable {
    var epoch: String
    var rev: Int
    var items: [SessionItem]
    var before: Cursor?
    var controls: SessionControls
    var live: ThreadLive?

    var position: ThreadPosition { ThreadPosition(epoch: epoch, rev: rev) }
}

/// The list's frames: the reply to watchSessions, which replaces the list, and its channel's diffs.
enum SessionsFrame: Hashable, Sendable {
    case list(projects: [SessionProject], rows: [SessionRow], mirror: MirrorPref)
    /// rows and projects upsert by id; removed rows go.
    case changed(rows: [SessionRow], removed: [SessionID], projects: [SessionProject])
}

/// One thread's frames.
enum ThreadFrame: Hashable, Sendable {
    case snapshot(SessionSnapshot)
    /// Upserts by id and removals; rev is the thread's rev after it. controls nil: unchanged. An upsert drops its live text.
    case items(rev: Int, items: [SessionItem], removed: [ItemID], controls: SessionControls?)
    /// Applies only when offset equals the live text's UTF-16 length for itemId (0 when none); otherwise dropped.
    case delta(itemId: ItemID, offset: Int, text: String)
    /// The page before the cursor, oldest first, to put above the items.
    case page(items: [SessionItem], before: Cursor?)
    /// A tool call's full result, its last 64 KB when longer.
    case toolOutput(toolUseId: String, output: String)
    /// The session is gone. movedTo: the id an agent's session restarted under, which the app opens instead.
    case removed(movedTo: SessionID?)
}

/// The fields that are set go on the wire. `model: .some(nil)` goes back to the transcript's model.
struct SessionPatch: Codable, Hashable, Sendable {
    var title: String?
    var hidden: Bool?
    var model: String??
    var mode: PermissionMode?

    private enum CodingKeys: String, CodingKey { case title, hidden, model, mode }

    init(title: String? = nil, hidden: Bool? = nil, model: String?? = nil, mode: PermissionMode? = nil) {
        self.title = title
        self.hidden = hidden
        self.model = model
        self.mode = mode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden)
        if c.contains(.model) {
            model = .some(try c.decodeNil(forKey: .model) ? nil : try c.decode(String.self, forKey: .model))
        }
        mode = try c.decodeIfPresent(PermissionMode.self, forKey: .mode)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(hidden, forKey: .hidden)
        if let model { try c.encode(model, forKey: .model) }
        try c.encodeIfPresent(mode, forKey: .mode)
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
    case commands(botId: BotID, commands: [Command])
    /// Every message between botId and peer, oldest first.
    case exchange(botId: BotID, peer: BotID, messages: [ExchangeMessage])
    /// The plan's usage limits. Sent after each hello and when they change. Never sequenced or replayed.
    case usage(PlanUsage)
    /// The Sessions list (feature sessions): the reply to watchSessions and the list channel's diffs.
    case sessions(SessionsFrame)
    /// One thread's frames (feature sessions): replies to watchSession, sessionPage and sessionTool, and its channel.
    case thread(sessionId: SessionID, ThreadFrame)
    /// Answers sessionCreate with its ref. The session exists before Claude Code starts.
    case sessionCreated(ref: String, sessionId: SessionID)
    case error(message: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, machine, userName, bots, bot, botId, ref, messages, message, library, links, agents, routines, agent
        case path, mime, content, data, devices, code, expiresAt
        case `protocol`, epoch, seq, resumed, features
        case agentId, text, at, facts, connectors, skills, routineId, url, token, commands, peer, usage
        case projects, rows, mirror, removed, sessionId, rev, items, before, controls, live, itemId, offset, toolUseId, output, movedTo
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func session() throws -> SessionID { try c.decode(SessionID.self, forKey: .sessionId) }
        func items() throws -> [SessionItem] { try c.decode([SessionItem].self, forKey: .items) }
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
        case "commands":
            self = .commands(botId: try c.decode(BotID.self, forKey: .botId), commands: try c.decode([Command].self, forKey: .commands))
        case "exchange":
            self = .exchange(
                botId: try c.decode(BotID.self, forKey: .botId),
                peer: try c.decode(BotID.self, forKey: .peer),
                messages: try c.decode([ExchangeMessage].self, forKey: .messages)
            )
        case "usage":
            self = .usage(try c.decode(PlanUsage.self, forKey: .usage))
        case "sessions":
            self = .sessions(.list(
                projects: try c.decode([SessionProject].self, forKey: .projects),
                rows: try c.decode([SessionRow].self, forKey: .rows),
                mirror: try c.decode(MirrorPref.self, forKey: .mirror)
            ))
        case "session_rows":
            self = .sessions(.changed(
                rows: try c.decode([SessionRow].self, forKey: .rows),
                removed: try c.decode([SessionID].self, forKey: .removed),
                projects: try c.decode([SessionProject].self, forKey: .projects)
            ))
        case "session":
            self = .thread(sessionId: try session(), .snapshot(SessionSnapshot(
                epoch: try c.decode(String.self, forKey: .epoch),
                rev: try c.decode(Int.self, forKey: .rev),
                items: try items(),
                before: try c.decodeIfPresent(Cursor.self, forKey: .before),
                controls: try c.decode(SessionControls.self, forKey: .controls),
                live: try c.decodeIfPresent(ThreadLive.self, forKey: .live)
            )))
        case "session_items":
            self = .thread(sessionId: try session(), .items(
                rev: try c.decode(Int.self, forKey: .rev),
                items: try items(),
                removed: try c.decode([ItemID].self, forKey: .removed),
                controls: try c.decodeIfPresent(SessionControls.self, forKey: .controls)
            ))
        case "session_delta":
            self = .thread(sessionId: try session(), .delta(
                itemId: try c.decode(ItemID.self, forKey: .itemId),
                offset: try c.decode(Int.self, forKey: .offset),
                text: try c.decode(String.self, forKey: .text)
            ))
        case "session_page":
            self = .thread(sessionId: try session(), .page(items: try items(), before: try c.decodeIfPresent(Cursor.self, forKey: .before)))
        case "session_tool_output":
            self = .thread(sessionId: try session(), .toolOutput(
                toolUseId: try c.decode(String.self, forKey: .toolUseId),
                output: try c.decode(String.self, forKey: .output)
            ))
        case "session_removed":
            self = .thread(sessionId: try session(), .removed(movedTo: try c.decodeIfPresent(SessionID.self, forKey: .movedTo)))
        case "session_created":
            self = .sessionCreated(ref: try c.decode(String.self, forKey: .ref), sessionId: try session())
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
        case let .commands(botId, commands):
            try c.encode("commands", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(commands, forKey: .commands)
        case let .exchange(botId, peer, messages):
            try c.encode("exchange", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(peer, forKey: .peer)
            try c.encode(messages, forKey: .messages)
        case let .usage(usage):
            try c.encode("usage", forKey: .type)
            try c.encode(usage, forKey: .usage)
        case let .sessions(.list(projects, rows, mirror)):
            try c.encode("sessions", forKey: .type)
            try c.encode(projects, forKey: .projects)
            try c.encode(rows, forKey: .rows)
            try c.encode(mirror, forKey: .mirror)
        case let .sessions(.changed(rows, removed, projects)):
            try c.encode("session_rows", forKey: .type)
            try c.encode(rows, forKey: .rows)
            try c.encode(removed, forKey: .removed)
            try c.encode(projects, forKey: .projects)
        case let .thread(sessionId, frame):
            try c.encode(sessionId, forKey: .sessionId)
            switch frame {
            case let .snapshot(snapshot):
                try c.encode("session", forKey: .type)
                try c.encode(snapshot.epoch, forKey: .epoch)
                try c.encode(snapshot.rev, forKey: .rev)
                try c.encode(snapshot.items, forKey: .items)
                try c.encode(snapshot.before, forKey: .before)
                try c.encode(snapshot.controls, forKey: .controls)
                try c.encode(snapshot.live, forKey: .live)
            case let .items(rev, items, removed, controls):
                try c.encode("session_items", forKey: .type)
                try c.encode(rev, forKey: .rev)
                try c.encode(items, forKey: .items)
                try c.encode(removed, forKey: .removed)
                try c.encode(controls, forKey: .controls)
            case let .delta(itemId, offset, text):
                try c.encode("session_delta", forKey: .type)
                try c.encode(itemId, forKey: .itemId)
                try c.encode(offset, forKey: .offset)
                try c.encode(text, forKey: .text)
            case let .page(items, before):
                try c.encode("session_page", forKey: .type)
                try c.encode(items, forKey: .items)
                try c.encode(before, forKey: .before)
            case let .toolOutput(toolUseId, output):
                try c.encode("session_tool_output", forKey: .type)
                try c.encode(toolUseId, forKey: .toolUseId)
                try c.encode(output, forKey: .output)
            case let .removed(movedTo):
                try c.encode("session_removed", forKey: .type)
                try c.encode(movedTo, forKey: .movedTo)
            }
        case let .sessionCreated(ref, sessionId):
            try c.encode("session_created", forKey: .type)
            try c.encode(ref, forKey: .ref)
            try c.encode(sessionId, forKey: .sessionId)
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
    /// A group's members, 2 to 8 different bots.
    var members: [BotID]?

    private enum CodingKeys: String, CodingKey { case name, title, avatar, pinned, hidden, dailyCapUsd, muted, members }

    init(
        name: String? = nil, title: String?? = nil, avatar: Avatar? = nil, pinned: Bool? = nil, hidden: Bool? = nil,
        dailyCapUsd: Double?? = nil, muted: Bool? = nil, members: [BotID]? = nil
    ) {
        self.name = name
        self.title = title
        self.avatar = avatar
        self.pinned = pinned
        self.hidden = hidden
        self.dailyCapUsd = dailyCapUsd
        self.muted = muted
        self.members = members
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
        members = try c.decodeIfPresent([BotID].self, forKey: .members)
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
        try c.encodeIfPresent(members, forKey: .members)
    }
}

enum ClientMessage: Codable, Hashable, Sendable {
    case createBot(ref: String)
    /// Asks for the conversation and marks the bot read.
    case open(botId: BotID)
    /// clientId lets the bridge drop a send it already has and the app match the echo to its bubble.
    /// mentions: what each "@name" in text points to, at most 10.
    case send(botId: BotID, text: String, uploads: [Upload], clientId: String? = nil, mentions: [Mention] = [])
    case answer(botId: BotID, messageId: MessageID, option: Int)
    case dismiss(botId: BotID, messageId: MessageID)
    /// Answers a permission card. Chat text never approves.
    case decide(botId: BotID, messageId: MessageID, choice: PermissionChoice)
    /// Stops the bot's turn in flight and drops its queued unattended work.
    case stop(botId: BotID)
    case stopAgent(agentId: AgentID)
    case updateBot(botId: BotID, patch: BotPatch)
    case markUnread(botId: BotID)
    /// force deletes a bot whose agents still hold worktrees, which the bridge otherwise refuses. The worktrees stay.
    case deleteBot(botId: BotID, force: Bool = false)
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
    case commands(botId: BotID)
    /// The messages behind the exchange lines between botId and peer.
    case exchange(botId: BotID, peer: BotID)
    /// Answered by created with the same ref. members: 2 to 8 different bots.
    case createGroup(ref: String, name: String, members: [BotID])
    case devices
    case revokeDevice(deviceId: DeviceID)
    case pairCode
    /// Reads the plan's usage now. Answered with a usage frame.
    case refreshUsage
    /// Subscribes to the Sessions list. Answered with a sessions frame; send again after each hello.
    case watchSessions
    case unwatchSessions
    /// Subscribes to one thread. after: the position the app holds, nil for a snapshot. Clear the thread's live text
    /// when sending it. Send again after each hello.
    case watchSession(sessionId: SessionID, after: ThreadPosition?)
    /// Unsubscribes and marks the session visited.
    case unwatchSession(sessionId: SessionID)
    case sessionPage(sessionId: SessionID, before: Cursor)
    /// clientId: the queued user item's id until the transcript's own entry replaces it. interrupt: "Stop and send".
    case sessionSend(sessionId: SessionID, text: String, clientId: String, interrupt: Bool)
    case sessionStop(sessionId: SessionID)
    /// Answers a permission item (its cardId) or a plan item (once approves, deny keeps planning).
    case sessionDecide(sessionId: SessionID, cardId: MessageID, choice: PermissionChoice)
    /// Answers an ask item by question text. nil dismisses it.
    case sessionAnswer(sessionId: SessionID, cardId: MessageID, answers: [String: String]?)
    /// Answered by sessionCreated with the same ref. model and mode nil: the user's Claude Code defaults.
    case sessionCreate(ref: String, projectId: ProjectID, text: String, model: String?, mode: PermissionMode?, isolate: SessionIsolation)
    case sessionSet(sessionId: SessionID, patch: SessionPatch)
    /// Imports the session into the Claude app when needed, then brings the app forward.
    case sessionOpenDesktop(sessionId: SessionID)
    /// Asks for a tool call's full output. Answered with a thread toolOutput frame.
    case sessionTool(sessionId: SessionID, toolUseId: String)
    /// Answered with a sessions list frame carrying the new mirror.
    case sessionPrefs(mirror: MirrorPref)

    private enum CodingKeys: String, CodingKey {
        case type, ref, botId, text, uploads, messageId, option, choice, patch, routineId, enabled, agentId, path, deviceId
        case clientId, factId, name, force, mentions, peer, members
        case sessionId, after, before, interrupt, cardId, answers, projectId, model, mode, isolate, toolUseId, mirror
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func bot() throws -> BotID { try c.decode(BotID.self, forKey: .botId) }
        func session() throws -> SessionID { try c.decode(SessionID.self, forKey: .sessionId) }
        func card() throws -> MessageID { try c.decode(MessageID.self, forKey: .cardId) }
        switch try c.decode(String.self, forKey: .type) {
        case "create_bot": self = .createBot(ref: try c.decode(String.self, forKey: .ref))
        case "open": self = .open(botId: try bot())
        case "send":
            self = .send(
                botId: try bot(), text: try c.decode(String.self, forKey: .text), uploads: try c.decode([Upload].self, forKey: .uploads),
                clientId: try c.decodeIfPresent(String.self, forKey: .clientId),
                mentions: try c.decodeIfPresent([Mention].self, forKey: .mentions) ?? []
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
        case "delete_bot": self = .deleteBot(botId: try bot(), force: try c.decodeIfPresent(Bool.self, forKey: .force) ?? false)
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
        case "commands": self = .commands(botId: try bot())
        case "exchange": self = .exchange(botId: try bot(), peer: try c.decode(BotID.self, forKey: .peer))
        case "create_group":
            self = .createGroup(
                ref: try c.decode(String.self, forKey: .ref), name: try c.decode(String.self, forKey: .name),
                members: try c.decode([BotID].self, forKey: .members)
            )
        case "devices": self = .devices
        case "revoke_device": self = .revokeDevice(deviceId: try c.decode(DeviceID.self, forKey: .deviceId))
        case "pair_code": self = .pairCode
        case "refresh_usage": self = .refreshUsage
        case "watch_sessions": self = .watchSessions
        case "unwatch_sessions": self = .unwatchSessions
        case "watch_session": self = .watchSession(sessionId: try session(), after: try c.decodeIfPresent(ThreadPosition.self, forKey: .after))
        case "unwatch_session": self = .unwatchSession(sessionId: try session())
        case "session_page": self = .sessionPage(sessionId: try session(), before: try c.decode(Cursor.self, forKey: .before))
        case "session_send":
            self = .sessionSend(
                sessionId: try session(), text: try c.decode(String.self, forKey: .text),
                clientId: try c.decode(String.self, forKey: .clientId), interrupt: try c.decode(Bool.self, forKey: .interrupt)
            )
        case "session_stop": self = .sessionStop(sessionId: try session())
        case "session_decide":
            self = .sessionDecide(sessionId: try session(), cardId: try card(), choice: try c.decode(PermissionChoice.self, forKey: .choice))
        case "session_answer":
            self = .sessionAnswer(sessionId: try session(), cardId: try card(), answers: try c.decodeIfPresent([String: String].self, forKey: .answers))
        case "session_create":
            self = .sessionCreate(
                ref: try c.decode(String.self, forKey: .ref), projectId: try c.decode(ProjectID.self, forKey: .projectId),
                text: try c.decode(String.self, forKey: .text), model: try c.decodeIfPresent(String.self, forKey: .model),
                mode: try c.decodeIfPresent(PermissionMode.self, forKey: .mode), isolate: try c.decode(SessionIsolation.self, forKey: .isolate)
            )
        case "session_set": self = .sessionSet(sessionId: try session(), patch: try c.decode(SessionPatch.self, forKey: .patch))
        case "session_open_desktop": self = .sessionOpenDesktop(sessionId: try session())
        case "session_tool": self = .sessionTool(sessionId: try session(), toolUseId: try c.decode(String.self, forKey: .toolUseId))
        case "session_prefs": self = .sessionPrefs(mirror: try c.decode(MirrorPref.self, forKey: .mirror))
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
        case let .send(botId, text, uploads, clientId, mentions):
            try c.encode("send", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(text, forKey: .text)
            try c.encode(uploads, forKey: .uploads)
            try c.encodeIfPresent(clientId, forKey: .clientId)
            if !mentions.isEmpty { try c.encode(mentions, forKey: .mentions) }
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
        case let .deleteBot(botId, force):
            try c.encode("delete_bot", forKey: .type)
            try c.encode(botId, forKey: .botId)
            if force { try c.encode(true, forKey: .force) }
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
        case let .commands(botId):
            try c.encode("commands", forKey: .type)
            try c.encode(botId, forKey: .botId)
        case let .exchange(botId, peer):
            try c.encode("exchange", forKey: .type)
            try c.encode(botId, forKey: .botId)
            try c.encode(peer, forKey: .peer)
        case let .createGroup(ref, name, members):
            try c.encode("create_group", forKey: .type)
            try c.encode(ref, forKey: .ref)
            try c.encode(name, forKey: .name)
            try c.encode(members, forKey: .members)
        case .devices:
            try c.encode("devices", forKey: .type)
        case let .revokeDevice(deviceId):
            try c.encode("revoke_device", forKey: .type)
            try c.encode(deviceId, forKey: .deviceId)
        case .pairCode:
            try c.encode("pair_code", forKey: .type)
        case .refreshUsage:
            try c.encode("refresh_usage", forKey: .type)
        case .watchSessions:
            try c.encode("watch_sessions", forKey: .type)
        case .unwatchSessions:
            try c.encode("unwatch_sessions", forKey: .type)
        case let .watchSession(sessionId, after):
            try c.encode("watch_session", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(after, forKey: .after)
        case let .unwatchSession(sessionId):
            try c.encode("unwatch_session", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
        case let .sessionPage(sessionId, before):
            try c.encode("session_page", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(before, forKey: .before)
        case let .sessionSend(sessionId, text, clientId, interrupt):
            try c.encode("session_send", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(text, forKey: .text)
            try c.encode(clientId, forKey: .clientId)
            try c.encode(interrupt, forKey: .interrupt)
        case let .sessionStop(sessionId):
            try c.encode("session_stop", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
        case let .sessionDecide(sessionId, cardId, choice):
            try c.encode("session_decide", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(cardId, forKey: .cardId)
            try c.encode(choice, forKey: .choice)
        case let .sessionAnswer(sessionId, cardId, answers):
            try c.encode("session_answer", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(cardId, forKey: .cardId)
            try c.encode(answers, forKey: .answers)
        case let .sessionCreate(ref, projectId, text, model, mode, isolate):
            try c.encode("session_create", forKey: .type)
            try c.encode(ref, forKey: .ref)
            try c.encode(projectId, forKey: .projectId)
            try c.encode(text, forKey: .text)
            try c.encode(model, forKey: .model)
            try c.encode(mode, forKey: .mode)
            try c.encode(isolate, forKey: .isolate)
        case let .sessionSet(sessionId, patch):
            try c.encode("session_set", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(patch, forKey: .patch)
        case let .sessionOpenDesktop(sessionId):
            try c.encode("session_open_desktop", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
        case let .sessionTool(sessionId, toolUseId):
            try c.encode("session_tool", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(toolUseId, forKey: .toolUseId)
        case let .sessionPrefs(mirror):
            try c.encode("session_prefs", forKey: .type)
            try c.encode(mirror, forKey: .mirror)
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
