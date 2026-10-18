import Foundation
import Observation

/// Text streaming into an item the bridge has not upserted yet. Its own observable, so a delta re-renders the one row
/// that reads it and nothing else in the thread.
@Observable
@MainActor
final class LiveText {
    private(set) var itemId: ItemID?
    private(set) var text = ""

    /// protocol.ts: a delta applies only when its offset is the live text's UTF-16 length for that item (0 when the
    /// app has none). Anything else is dropped; the item's upsert brings the text.
    @discardableResult
    func apply(itemId: ItemID, offset: Int, text delta: String) -> Bool {
        let current = self.itemId == itemId ? text.utf16.count : 0
        guard offset == current else { return false }
        if self.itemId == itemId {
            text += delta
        } else {
            self.itemId = itemId
            text = delta
        }
        return true
    }

    func seed(_ live: ThreadLive?) {
        itemId = live?.itemId
        text = live?.text ?? ""
    }

    func drop(_ id: ItemID) {
        if itemId == id { seed(nil) }
    }

    func clear() {
        if itemId != nil { seed(nil) }
    }
}

enum ThreadRow: Equatable, Identifiable, Sendable {
    case item(SessionItem)
    /// A finished turn's thinking, tool runs and in-between text. id: the first folded item's id, prefixed, so it
    /// never collides with an item's. Expanded, the fold is a header and its items follow as rows of their own.
    case fold(id: ItemID, items: [SessionItem], expanded: Bool)

    var id: ItemID {
        switch self {
        case .item(let item): item.id
        case .fold(let id, _, _): id
        }
    }

    static func foldId(_ first: ItemID) -> ItemID { ItemID("fold:" + first.rawValue) }
}

enum ThreadLayout {
    /// The display rows for a thread, oldest first. A turn runs from a user item to the next one. In a finished turn
    /// the thinking, work and assistant text before its last assistant text fold into one row; cards, todos and
    /// notices stay out, so nothing that needs the user is ever folded away. A run of one item stays as it is.
    static func rows(_ items: [SessionItem], expanded: Set<ItemID>, working: Bool) -> [ThreadRow] {
        var rows: [ThreadRow] = []
        rows.reserveCapacity(items.count)
        var turnStart = 0
        func flushTurn(_ end: Int, finished: Bool) {
            let turn = items[turnStart..<end]
            let lastAnswer = finished ? turn.lastIndex(where: { if case .assistant = $0 { true } else { false } }) : nil
            var run: [SessionItem] = []
            func flushRun() {
                if run.count >= 2 {
                    let id = ThreadRow.foldId(run[0].id)
                    let open = expanded.contains(id)
                    rows.append(.fold(id: id, items: run, expanded: open))
                    if open { rows.append(contentsOf: run.map(ThreadRow.item)) }
                } else {
                    rows.append(contentsOf: run.map(ThreadRow.item))
                }
                run.removeAll()
            }
            for index in turn.indices {
                let item = items[index]
                if let lastAnswer, index < lastAnswer, item.folds {
                    run.append(item)
                } else {
                    flushRun()
                    if !item.isUnknown { rows.append(.item(item)) }
                }
            }
            flushRun()
        }
        for (index, item) in items.enumerated() where index > turnStart {
            if case .user = item {
                flushTurn(index, finished: true)
                turnStart = index
            }
        }
        if turnStart < items.count { flushTurn(items.count, finished: !working) }
        return rows
    }
}

extension SessionItem {
    var folds: Bool {
        switch self {
        case .thinking, .work, .assistant: true
        default: false
        }
    }

    var isUnknown: Bool {
        if case .unknown = self { true } else { false }
    }
}

enum WorkSummary {
    static func text(_ steps: [ToolStep]) -> String {
        var edited = Set<String>()
        var counts: [String: Int] = [:]
        for step in steps {
            switch step.tool {
            case "Edit", "Write", "MultiEdit", "NotebookEdit": edited.insert(step.diff?.path ?? step.label)
            case "Bash", "BashOutput": counts["command", default: 0] += 1
            case "Read": counts["read", default: 0] += 1
            case "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch": counts["search", default: 0] += 1
            case "Task", "Agent": counts["agent", default: 0] += 1
            case "TodoWrite": break
            default: counts["other", default: 0] += 1
            }
        }
        var parts: [String] = []
        if !edited.isEmpty { parts.append("edited \(plural(edited.count, "file"))") }
        if let n = counts["command"] { parts.append("ran \(plural(n, "command"))") }
        if let n = counts["read"] { parts.append("read \(plural(n, "file"))") }
        if let n = counts["search"] { parts.append("searched \(plural(n, "time"))") }
        if let n = counts["agent"] { parts.append("ran \(plural(n, "agent"))") }
        if let n = counts["other"] { parts.append(plural(n, parts.isEmpty ? "step" : "other step")) }
        guard let first = parts.first else { return "No steps" }
        parts[0] = first.prefix(1).uppercased() + first.dropFirst()
        return parts.joined(separator: ", ")
    }

    static func fold(_ items: [SessionItem]) -> String {
        let steps = items.flatMap { item -> [ToolStep] in if case .work(_, _, let steps) = item { steps } else { [] } }
        let replies = items.count { if case .assistant = $0 { true } else { false } }
        var parts = steps.isEmpty ? [] : [text(steps)]
        if replies > 0 { parts.append(plural(replies, "message")) }
        if parts.isEmpty { return "Thought it through" }
        return parts.joined(separator: ", ")
    }

    static func errors(_ steps: [ToolStep]) -> Int {
        steps.count { $0.state == .error }
    }

    static func diff(_ steps: [ToolStep]) -> (added: Int, removed: Int)? {
        let diffs = steps.compactMap(\.diff)
        guard !diffs.isEmpty else { return nil }
        return (diffs.reduce(0) { $0 + $1.added }, diffs.reduce(0) { $0 + $1.removed })
    }

    static func plural(_ n: Int, _ noun: String) -> String {
        "\(n) \(noun)\(n == 1 ? "" : "s")"
    }
}

@Observable
@MainActor
final class ThreadModel {
    enum Phase: Equatable, Sendable {
        case loading
        case ready
        /// The session is gone. movedTo: the id an agent's session restarted under.
        case removed(movedTo: SessionID?)
    }

    let id: SessionID
    private(set) var items: [SessionItem] = []
    /// What the thread shows, recomputed when items, folds or working change, never by a delta.
    private(set) var rows: [ThreadRow] = []
    private(set) var before: Cursor?
    private(set) var controls: SessionControls?
    private(set) var position: ThreadPosition?
    private(set) var phase = Phase.loading
    /// A session_page request is out. Cleared by its reply or by a snapshot.
    private(set) var loadingEarlier = false
    private(set) var expanded: Set<ItemID> = []
    /// Full tool outputs the user asked for, by tool_use id.
    private(set) var toolOutputs: [String: String] = [:]
    let live = LiveText()
    @ObservationIgnored private var index: [ItemID: Int] = [:]
    @ObservationIgnored private var markdown: [ItemID: (text: String, value: RenderedMarkdown)] = [:]

    init(id: SessionID) {
        self.id = id
    }

    /// Applies one frame. Returns the permission cards it settled, so pending decisions can clear.
    @discardableResult
    func apply(_ frame: ThreadFrame) -> [MessageID] {
        switch frame {
        case .snapshot(let snapshot):
            replace(snapshot.items)
            before = snapshot.before
            controls = snapshot.controls
            position = snapshot.position
            phase = .ready
            loadingEarlier = false
            live.seed(snapshot.live)
            relayout()
            return Self.settled(snapshot.items)

        case let .items(rev, items, removed, controls):
            for item in items {
                upsert(item)
                live.drop(item.id)
            }
            if !removed.isEmpty {
                let gone = Set(removed)
                self.items.removeAll { gone.contains($0.id) }
                reindex()
            }
            if let controls { self.controls = controls }
            if let position { self.position = ThreadPosition(epoch: position.epoch, rev: rev) }
            if phase == .loading, self.position != nil { phase = .ready }
            relayout()
            return Self.settled(items)

        case let .delta(itemId, offset, text):
            // An item already upserted has its text; a late delta for it would start a duplicate tail.
            guard index[itemId] == nil else { return [] }
            live.apply(itemId: itemId, offset: offset, text: text)
            return []

        case let .page(items, before):
            let older = items.filter { index[$0.id] == nil }
            self.items.insert(contentsOf: older, at: 0)
            reindex()
            self.before = before
            loadingEarlier = false
            relayout()
            return Self.settled(items)

        case let .toolOutput(toolUseId, output):
            toolOutputs[toolUseId] = output
            return []

        case .removed(let movedTo):
            phase = .removed(movedTo: movedTo)
            live.clear()
            return []
        }
    }

    /// What watch_session sends back. The contract has the app drop its live text at that moment: the reply resends
    /// any streaming text from offset 0.
    func willWatch() -> ThreadPosition? {
        live.clear()
        return phase == .ready ? position : nil
    }

    /// The user's message, shown queued at once under the clientId the bridge keeps until the transcript replaces it.
    func echo(clientId: String, text: String, at now: Date = .now) {
        upsert(.user(id: ItemID(clientId), at: now, text: text, from: .user, queued: true))
        relayout()
    }

    /// The cursor to ask for, once. Nil while a page is out or at the start of the transcript.
    func requestEarlier() -> Cursor? {
        guard !loadingEarlier, let before, phase == .ready else { return nil }
        loadingEarlier = true
        return before
    }

    func toggle(fold id: ItemID) {
        if expanded.remove(id) == nil { expanded.insert(id) }
        relayout()
    }

    /// Markdown parsed once per item text, so scrolling and streaming never parse it again.
    func rendered(_ id: ItemID, _ text: String) -> RenderedMarkdown {
        if let cached = markdown[id], cached.text == text { return cached.value }
        let value = RenderedMarkdown(text)
        markdown[id] = (text, value)
        return value
    }

    private func replace(_ items: [SessionItem]) {
        self.items = []
        index = [:]
        for item in items { upsert(item) }
    }

    private func upsert(_ item: SessionItem) {
        if let at = index[item.id] {
            if items[at] != item { items[at] = item }
        } else {
            index[item.id] = items.count
            items.append(item)
        }
    }

    private func reindex() {
        index = Dictionary(items.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        markdown = markdown.filter { index[$0.key] != nil }
    }

    private func relayout() {
        let next = ThreadLayout.rows(items, expanded: expanded, working: controls?.working ?? false)
        if next != rows { rows = next }
    }

    private static func settled(_ items: [SessionItem]) -> [MessageID] {
        items.compactMap { item in
            if case let .permission(_, _, permission) = item, permission.card.answer != nil { permission.cardId } else { nil }
        }
    }
}

/// The threads the app keeps: the one on screen and the last few, so going back to one is instant. The bridge
/// replays what each missed when it is watched again.
@Observable
@MainActor
final class SessionThreads {
    static let capacity = 4

    private(set) var models: [SessionID: ThreadModel] = [:]
    /// The newest models a thread offered, for the new-session sheet's model menu. Agent and cloud sessions offer
    /// none, so opening one leaves the menu as it was.
    private(set) var lastModels: [SessionModelOption] = []
    @ObservationIgnored private var recent: [SessionID] = []

    subscript(id: SessionID) -> ThreadModel? { models[id] }

    @discardableResult
    func open(_ id: SessionID) -> ThreadModel {
        recent.removeAll { $0 == id }
        recent.append(id)
        let model = models[id] ?? ThreadModel(id: id)
        if models[id] == nil { models[id] = model }
        while recent.count > Self.capacity {
            models[recent.removeFirst()] = nil
        }
        return model
    }

    func willWatch(_ id: SessionID) -> ThreadPosition? {
        models[id]?.willWatch()
    }

    /// Frames for a thread the app no longer keeps are dropped, except a snapshot, which is a reply to a watch.
    func apply(_ id: SessionID, _ frame: ThreadFrame) -> [MessageID] {
        let model: ThreadModel
        if let kept = models[id] {
            model = kept
        } else if case .snapshot = frame {
            model = open(id)
        } else {
            return []
        }
        let settled = model.apply(frame)
        if let models = model.controls?.models, !models.isEmpty, models != lastModels { lastModels = models }
        return settled
    }

    func reset() {
        models = [:]
        recent = []
        lastModels = []
    }
}
