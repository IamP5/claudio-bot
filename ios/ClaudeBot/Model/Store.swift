import Foundation
import Observation

enum ConnectionState: Equatable, Sendable {
    case unpaired
    case connecting
    /// Set only by the bridge's hello, so "connected" means the token was accepted.
    case connected(machine: String)
    case disconnected(retryAt: Date)
}

/// Transcript items in arrival order, upserted by id.
struct OrderedItems: Equatable, Sendable {
    private(set) var items: [Item] = []
    private var positions: [ItemID: Int] = [:]

    init(_ items: [Item] = []) {
        for item in items { upsert(item) }
    }

    subscript(id: ItemID) -> Item? {
        positions[id].map { items[$0] }
    }

    /// Returns whether anything changed, so a replayed item reports false.
    @discardableResult
    mutating func upsert(_ item: Item) -> Bool {
        if let at = positions[item.id] {
            guard items[at] != item else { return false }
            items[at] = item
        } else {
            positions[item.id] = items.count
            items.append(item)
        }
        return true
    }
}

/// Something the user should hear about, derived from a state change.
struct Attention: Equatable, Sendable {
    enum Reason: Equatable, Sendable {
        case approval(ApprovalItem)
        case question(QuestionItem)
        case needsInput
        case finished
        case failed
    }

    let task: TaskSummary
    let reason: Reason
}

struct ErrorNotice: Equatable, Sendable {
    let id = UUID()
    let message: String
}

@Observable
@MainActor
final class AppStore {
    private(set) var connection: ConnectionState = .unpaired
    private(set) var projects: [Project] = []
    private(set) var tasks: [TaskID: TaskSummary] = [:]
    private(set) var transcripts: [TaskID: OrderedItems] = [:]
    private(set) var lastError: ErrorNotice?
    /// The newest task id introduced by a "task" message; the new-task flow navigates to it.
    private(set) var lastNewTask: TaskID?

    var machine: String? {
        if case .connected(let machine) = connection { machine } else { nil }
    }

    /// Transport changes from the client. Unpairing forgets the Mac's projects and tasks.
    func setConnection(_ state: ConnectionState) {
        connection = state
        if state == .unpaired {
            projects = []
            tasks = [:]
            transcripts = [:]
        }
    }

    @discardableResult
    func apply(_ msg: ServerMessage) -> [Attention] {
        switch msg {
        case let .hello(machine, projects, tasks):
            connection = .connected(machine: machine)
            self.projects = projects
            let previous = self.tasks
            self.tasks = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            transcripts = transcripts.filter { self.tasks[$0.key] != nil }
            return tasks.compactMap { task in
                previous[task.id].flatMap { statusAttention(from: $0.status, to: task) }
            }

        case let .task(task):
            let previous = tasks[task.id]
            tasks[task.id] = task
            if previous == nil { lastNewTask = task.id }
            guard let previous else { return [] }
            return statusAttention(from: previous.status, to: task).map { [$0] } ?? []

        case let .transcript(taskId, items):
            transcripts[taskId] = OrderedItems(items)
            return []

        case let .item(taskId, item):
            guard transcripts[taskId, default: OrderedItems()].upsert(item) else { return [] }
            guard let task = tasks[taskId] else { return [] }
            switch item {
            case .approval(let a) where a.state == .pending:
                return [Attention(task: task, reason: .approval(a))]
            case .question(let q) where q.answers == nil:
                return [Attention(task: task, reason: .question(q))]
            default:
                return []
            }

        case let .error(message):
            lastError = ErrorNotice(message: message)
            return []

        case .unknown:
            return []
        }
    }

    private func statusAttention(from old: TaskStatus, to task: TaskSummary) -> Attention? {
        guard old != task.status else { return nil }
        switch task.status {
        case .needsInput:
            // The approval or question item carries the detail; only fall back when it has not arrived.
            let hasPendingItem = transcripts[task.id]?.items.contains(where: \.awaitsUser) ?? false
            return hasPendingItem ? nil : Attention(task: task, reason: .needsInput)
        case .idle: return Attention(task: task, reason: .finished)
        case .failed: return Attention(task: task, reason: .failed)
        case .running, .stopped, .unknown: return nil
        }
    }

    func project(_ id: ProjectID) -> Project? {
        projects.first { $0.id == id }
    }

    func sections(matching query: String) -> [HomeSection] {
        HomeSection.make(from: tasks.values, matching: query)
    }
}

struct HomeSection: Identifiable, Equatable {
    enum Kind: CaseIterable {
        case needsYou, running, recent

        var title: String {
            switch self {
            case .needsYou: "Needs you"
            case .running: "Running"
            case .recent: "Recent"
            }
        }

        init(_ status: TaskStatus) {
            switch status {
            case .needsInput: self = .needsYou
            case .running: self = .running
            case .idle, .failed, .stopped, .unknown: self = .recent
            }
        }
    }

    let kind: Kind
    let tasks: [TaskSummary]
    var id: Kind { kind }

    /// Groups by what the user should do next; empty sections are dropped. Newest first within a section.
    static func make(from tasks: some Sequence<TaskSummary>, matching query: String) -> [HomeSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = tasks.filter { task in
            needle.isEmpty
                || [task.title, task.projectName, task.preview].contains { $0.localizedCaseInsensitiveContains(needle) }
        }
        let grouped = Dictionary(grouping: matching) { Kind($0.status) }
        return Kind.allCases.compactMap { kind in
            guard let tasks = grouped[kind], !tasks.isEmpty else { return nil }
            return HomeSection(kind: kind, tasks: tasks.sorted { $0.updatedAt > $1.updatedAt })
        }
    }
}
