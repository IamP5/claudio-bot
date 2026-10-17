import Foundation

// Mirror of bridge/src/protocol.ts. fixtures/protocol.json pins both sides.

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

enum TaskTag {}
enum ProjectTag {}
enum ItemTag {}
typealias TaskID = Identifier<TaskTag>
typealias ProjectID = Identifier<ProjectTag>
typealias ItemID = Identifier<ItemTag>

struct Project: Codable, Hashable, Sendable, Identifiable {
    let id: ProjectID
    let name: String
    let path: String
    let branch: String?
    let githubRepo: String?
}

/// A target kind this build does not know yet decodes to `.unknown` so a newer bridge cannot break the whole hello.
enum Target: Codable, Hashable, Sendable {
    case local(ProjectID)
    case cloud(ProjectID)
    case unknown(kind: String, projectId: ProjectID?)

    var projectId: ProjectID? {
        switch self {
        case .local(let id), .cloud(let id): id
        case .unknown(_, let id): id
        }
    }

    var isCloud: Bool {
        if case .cloud = self { true } else { false }
    }

    private var kind: String {
        switch self {
        case .local: "local"
        case .cloud: "cloud"
        case .unknown(let kind, _): kind
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, projectId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "local": self = .local(try c.decode(ProjectID.self, forKey: .projectId))
        case "cloud": self = .cloud(try c.decode(ProjectID.self, forKey: .projectId))
        case let other: self = .unknown(kind: other, projectId: try c.decodeIfPresent(ProjectID.self, forKey: .projectId))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(projectId, forKey: .projectId)
    }
}

/// Like `TaskStatus`, a value from a newer bridge is kept as `.unknown` instead of failing the decode.
enum PermissionMode: RawRepresentable, Codable, Hashable, Sendable {
    case `default`, acceptEdits, plan, auto, bypassPermissions
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "default": self = .default
        case "acceptEdits": self = .acceptEdits
        case "plan": self = .plan
        case "auto": self = .auto
        case "bypassPermissions": self = .bypassPermissions
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .default: "default"
        case .acceptEdits: "acceptEdits"
        case .plan: "plan"
        case .auto: "auto"
        case .bypassPermissions: "bypassPermissions"
        case .unknown(let raw): raw
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// A status this build does not know yet is `.unknown`, not `.idle`: idle renders as "Done", which would claim
/// a result the bridge never reported. Unknown is inactive, groups under Recent and raises no alert.
enum TaskStatus: RawRepresentable, Codable, Hashable, Sendable {
    case running, needsInput, idle, failed, stopped
    case unknown(String)

    init(rawValue: String) {
        switch rawValue {
        case "running": self = .running
        case "needs_input": self = .needsInput
        case "idle": self = .idle
        case "failed": self = .failed
        case "stopped": self = .stopped
        default: self = .unknown(rawValue)
        }
    }

    var rawValue: String {
        switch self {
        case .running: "running"
        case .needsInput: "needs_input"
        case .idle: "idle"
        case .failed: "failed"
        case .stopped: "stopped"
        case .unknown(let raw): raw
        }
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    var isActive: Bool { self == .running || self == .needsInput }
}

struct TaskSummary: Codable, Hashable, Sendable, Identifiable {
    let id: TaskID
    var title: String
    var target: Target
    var projectName: String
    var model: String
    var permissionMode: PermissionMode
    var status: TaskStatus
    var createdAt: Date
    var updatedAt: Date
    var preview: String
    var costUsd: Double
    var cloudUrl: URL?
}

struct QuestionOption: Codable, Hashable, Sendable {
    let label: String
    let description: String
}

struct Question: Codable, Hashable, Sendable {
    let question: String
    let header: String
    let multiSelect: Bool
    let options: [QuestionOption]
}

struct TextItem: Codable, Hashable, Sendable {
    let id: ItemID
    let text: String
    let at: Date
}

struct ToolItem: Codable, Hashable, Sendable {
    enum State: String, Codable, Sendable { case running, ok, error }
    let id: ItemID
    let name: String
    let summary: String
    let state: State
    let output: String?
    let at: Date
}

struct ApprovalItem: Codable, Hashable, Sendable {
    enum State: String, Codable, Sendable { case pending, allowed, denied }
    let id: ItemID
    let tool: String
    let summary: String
    let detail: String
    let state: State
    let at: Date
}

struct QuestionItem: Codable, Hashable, Sendable {
    let id: ItemID
    let questions: [Question]
    let answers: [String: String]?
    let at: Date
}

struct ResultItem: Codable, Hashable, Sendable {
    let id: ItemID
    let ok: Bool
    let text: String
    let costUsd: Double
    let durationMs: Double
    let at: Date
}

struct NoticeItem: Codable, Hashable, Sendable {
    let id: ItemID
    let text: String
    let url: URL?
    let at: Date
}

enum Item: Decodable, Hashable, Sendable, Identifiable {
    case user(TextItem)
    case assistant(TextItem)
    case tool(ToolItem)
    case approval(ApprovalItem)
    case question(QuestionItem)
    case result(ResultItem)
    case notice(NoticeItem)
    // A kind this build does not know yet. Kept so its id still dedupes and orders.
    case unknown(id: ItemID, kind: String)

    var id: ItemID {
        switch self {
        case .user(let i), .assistant(let i): i.id
        case .tool(let i): i.id
        case .approval(let i): i.id
        case .question(let i): i.id
        case .result(let i): i.id
        case .notice(let i): i.id
        case .unknown(let id, _): id
        }
    }

    /// An item the user still has to act on.
    var awaitsUser: Bool {
        switch self {
        case .approval(let a): a.state == .pending
        case .question(let q): q.answers == nil
        default: false
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, id }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "user": self = .user(try TextItem(from: decoder))
        case "assistant": self = .assistant(try TextItem(from: decoder))
        case "tool": self = .tool(try ToolItem(from: decoder))
        case "approval": self = .approval(try ApprovalItem(from: decoder))
        case "question": self = .question(try QuestionItem(from: decoder))
        case "result": self = .result(try ResultItem(from: decoder))
        case "notice": self = .notice(try NoticeItem(from: decoder))
        default: self = .unknown(id: try c.decode(ItemID.self, forKey: .id), kind: kind)
        }
    }
}

enum ServerMessage: Decodable, Sendable {
    case hello(machine: String, projects: [Project], tasks: [TaskSummary])
    case task(TaskSummary)
    case transcript(taskId: TaskID, items: [Item])
    case item(taskId: TaskID, item: Item)
    case error(message: String)
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, machine, projects, tasks, task, taskId, items, item, message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "hello":
            self = .hello(
                machine: try c.decode(String.self, forKey: .machine),
                projects: try c.decode([Project].self, forKey: .projects),
                tasks: try c.decode([TaskSummary].self, forKey: .tasks)
            )
        case "task":
            self = .task(try c.decode(TaskSummary.self, forKey: .task))
        case "transcript":
            self = .transcript(
                taskId: try c.decode(TaskID.self, forKey: .taskId),
                items: try c.decode([Item].self, forKey: .items)
            )
        case "item":
            self = .item(
                taskId: try c.decode(TaskID.self, forKey: .taskId),
                item: try c.decode(Item.self, forKey: .item)
            )
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case let other:
            self = .unknown(type: other)
        }
    }
}

enum Decision: String, Codable, Sendable {
    case allow
    case allowAlways = "allow_always"
    case deny
}

enum ClientMessage: Codable, Hashable, Sendable {
    case create(prompt: String, target: Target, model: String, permissionMode: PermissionMode)
    case subscribe(taskId: TaskID)
    case send(taskId: TaskID, text: String)
    case decide(taskId: TaskID, itemId: ItemID, decision: Decision)
    case answer(taskId: TaskID, itemId: ItemID, answers: [String: String])
    case stop(taskId: TaskID)

    private enum CodingKeys: String, CodingKey {
        case type, prompt, target, model, permissionMode, taskId, text, itemId, decision, answers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "create":
            self = .create(
                prompt: try c.decode(String.self, forKey: .prompt),
                target: try c.decode(Target.self, forKey: .target),
                model: try c.decode(String.self, forKey: .model),
                permissionMode: try c.decode(PermissionMode.self, forKey: .permissionMode)
            )
        case "subscribe":
            self = .subscribe(taskId: try c.decode(TaskID.self, forKey: .taskId))
        case "send":
            self = .send(taskId: try c.decode(TaskID.self, forKey: .taskId), text: try c.decode(String.self, forKey: .text))
        case "decide":
            self = .decide(
                taskId: try c.decode(TaskID.self, forKey: .taskId),
                itemId: try c.decode(ItemID.self, forKey: .itemId),
                decision: try c.decode(Decision.self, forKey: .decision)
            )
        case "answer":
            self = .answer(
                taskId: try c.decode(TaskID.self, forKey: .taskId),
                itemId: try c.decode(ItemID.self, forKey: .itemId),
                answers: try c.decode([String: String].self, forKey: .answers)
            )
        case "stop":
            self = .stop(taskId: try c.decode(TaskID.self, forKey: .taskId))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown client message \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .create(prompt, target, model, permissionMode):
            try c.encode("create", forKey: .type)
            try c.encode(prompt, forKey: .prompt)
            try c.encode(target, forKey: .target)
            try c.encode(model, forKey: .model)
            try c.encode(permissionMode, forKey: .permissionMode)
        case let .subscribe(taskId):
            try c.encode("subscribe", forKey: .type)
            try c.encode(taskId, forKey: .taskId)
        case let .send(taskId, text):
            try c.encode("send", forKey: .type)
            try c.encode(taskId, forKey: .taskId)
            try c.encode(text, forKey: .text)
        case let .decide(taskId, itemId, decision):
            try c.encode("decide", forKey: .type)
            try c.encode(taskId, forKey: .taskId)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(decision, forKey: .decision)
        case let .answer(taskId, itemId, answers):
            try c.encode("answer", forKey: .type)
            try c.encode(taskId, forKey: .taskId)
            try c.encode(itemId, forKey: .itemId)
            try c.encode(answers, forKey: .answers)
        case let .stop(taskId):
            try c.encode("stop", forKey: .type)
            try c.encode(taskId, forKey: .taskId)
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

    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }
}
