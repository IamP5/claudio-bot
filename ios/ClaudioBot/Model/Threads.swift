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
    /// A work item with a step still running or waiting stays out of a fold, so live work is never hidden.
    var folds: Bool {
        switch self {
        case .thinking, .assistant: true
        case .work(_, _, let steps): !steps.contains { $0.state.isLive }
        default: false
        }
    }

    var isUnknown: Bool {
        if case .unknown = self { true } else { false }
    }
}

enum WorkSummary {
    /// An edit counts only once it is done: a failed, denied or stopped write changed nothing.
    static func text(_ steps: [ToolStep]) -> String {
        var edited = Set<String>()
        var counts: [String: Int] = [:]
        for step in steps {
            switch step.tool {
            case "Edit", "Write", "MultiEdit", "NotebookEdit": if step.state == .ok { edited.insert(step.diff?.path ?? step.label) }
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
        guard let first = parts.first else { return steps.isEmpty ? "No steps" : plural(steps.count, "step") }
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
        let diffs = steps.filter { $0.state == .ok }.compactMap(\.diff)
        guard !diffs.isEmpty else { return nil }
        return (diffs.reduce(0) { $0 + $1.added }, diffs.reduce(0) { $0 + $1.removed })
    }

    static func plural(_ n: Int, _ noun: String) -> String {
        "\(n) \(noun)\(n == 1 ? "" : "s")"
    }
}

extension ToolStep {
    /// What an unsure step says: its command may outlive what the bridge can follow.
    static let mayStillRun = "May still run on your Mac"
}

extension ToolStepState {
    /// Not over yet: running, or held by an open approval card.
    var isLive: Bool { self == .running || self == .waiting }
}

/// Elapsed times the way the thread shows and speaks them. Shown times use whole seconds, so they tick in step.
enum RunClock {
    /// "43s", "2m 05s", "1h 02m".
    static func short(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m " + String(format: "%02ds", s % 60) }
        return "\(s / 3600)h " + String(format: "%02dm", s % 3600 / 60)
    }

    /// "43 seconds", "2 minutes 5 seconds", "1 hour 2 minutes".
    static func spoken(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        let (big, small, units): (Int, Int, (String, String)) =
            s < 60 ? (s, 0, ("second", "")) : s < 3600 ? (s / 60, s % 60, ("minute", "second")) : (s / 3600, s % 3600 / 60, ("hour", "minute"))
        let head = WorkSummary.plural(big, units.0)
        return small == 0 ? head : head + " " + WorkSummary.plural(small, units.1)
    }

    /// A quiet spell, to the minute past the first: "45s", "3m", "1h 10m".
    static func coarse(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \(s % 3600 / 60)m"
    }
}

/// A work item read as one run: what is live, what went wrong, and since when. tasks: the session's live tasks by
/// the step that started them, which carry a subagent's progress. heardAt: the last sign of life for the session.
struct WorkRun {
    /// How long a running step may go without a sign of life before it reads as quiet.
    static let quietAfter: TimeInterval = 60

    let steps: [ToolStep]
    let tasks: [String: SessionTask]
    let heardAt: Date?

    init(steps: [ToolStep], controls: SessionControls? = nil) {
        self.steps = steps
        tasks = Dictionary((controls?.tasks ?? []).compactMap { task in task.stepId.map { ($0, task) } }, uniquingKeysWith: { a, _ in a })
        heardAt = controls?.heardAt
    }

    var live: [ToolStep] { steps.filter(\.state.isLive) }
    var isLive: Bool { steps.contains { $0.state.isLive } }
    /// Busy, as opposed to live: a run held only by approval cards is blocked, so it never looks busy.
    var isRunning: Bool { steps.contains { $0.state == .running } }
    /// Running with something that changes with time: a step's clock, or a quiet spell measured from a sign of life.
    var ticks: Bool { isRunning && (since != nil || heardAt != nil || !tasks.isEmpty) }

    /// The run's clock: the earliest start among running steps. A waiting step has not started.
    var since: Date? { steps.filter { $0.state == .running }.compactMap(\.startedAt).min() }

    /// From the first start to the last end, once nothing is live and some step carries both.
    var duration: TimeInterval? {
        guard !isLive, let start = steps.compactMap(\.startedAt).min(), let end = steps.compactMap(\.endedAt).max(), end >= start else { return nil }
        return end.timeIntervalSince(start)
    }

    /// "3 agents running · 1 waiting for approval · 1 stopped", or for a finished run "Ran 3 agents, 43s".
    /// Spoken, the state leads: "Running: 3 agents, 1 waiting for approval".
    func headline(spoken: Bool = false) -> String {
        let format = spoken ? RunClock.spoken : RunClock.short
        var parts: [String] = []
        let running = steps.filter { $0.state == .running }
        if !running.isEmpty { parts.append(spoken ? "Running: " + Self.nouns(running) : Self.nouns(running) + " running") }
        let waiting = steps.count { $0.state == .waiting }
        if waiting > 0 { parts.append("\(waiting) waiting for approval") }
        if parts.isEmpty {
            parts.append(WorkSummary.text(steps) + (duration.map { ", " + format($0) } ?? ""))
        }
        for (state, word) in [(ToolStepState.stopped, "stopped"), (.denied, "denied"), (.unsure, "may still run")] {
            let n = steps.count { $0.state == state }
            if n > 0 { parts.append("\(n) \(word)") }
        }
        return parts.joined(separator: spoken ? ", " : " · ")
    }

    /// The failed steps, named when there is one: "broken helper failed: Agent type not found".
    var failure: String? {
        let failed = steps.filter { $0.state == .error }
        guard let first = failed.first else { return nil }
        guard failed.count == 1 else { return "\(failed.count) failed" }
        return "\(first.label) failed" + (first.cause.map { ": " + $0 } ?? "")
    }

    /// The header as VoiceOver speaks it: "Running: 3 agents, 2 minutes 5 seconds. broken helper failed: …".
    func spoken(now: Date) -> String {
        var line = headline(spoken: true)
        if let since { line += ", " + RunClock.spoken(now.timeIntervalSince(since)) }
        if let failure { line += ". " + failure }
        return line
    }

    func task(for step: ToolStep) -> SessionTask? { tasks[step.id] }

    /// The label of the subagent that made this call, when it is in the same run.
    func owner(of step: ToolStep) -> String? {
        step.owner.flatMap { id in steps.first { $0.id == id }?.label }
    }

    /// How long a running step has gone without a sign of life, once that passes `quietAfter`. A task's progress is
    /// the sign when it reports one, otherwise the session's: a background command reports none while it runs. A task
    /// held by an approval card waits on the user, so it is never quiet.
    func quiet(_ step: ToolStep, now: Date) -> TimeInterval? {
        guard step.state == .running else { return nil }
        let task = tasks[step.id]
        guard task?.waiting == nil, let last = task?.progress?.at ?? heardAt else { return nil }
        let gap = now.timeIntervalSince(last)
        return gap > Self.quietAfter ? gap : nil
    }

    /// One step's state and timing in words: "Running · 1m 12s · 3 tools, last Bash · started by sleeper two".
    func status(_ step: ToolStep, now: Date, spoken: Bool = false) -> [String] {
        let format = spoken ? RunClock.spoken : RunClock.short
        let task = tasks[step.id]
        var parts: [String] = []
        switch step.state {
        case .running:
            parts.append("Running" + (step.startedAt.map { (spoken ? ", " : " · ") + format(now.timeIntervalSince($0)) } ?? ""))
        case .waiting:
            parts.append("Waiting for approval")
        case .ok, .error:
            var word = step.state == .ok ? "Done" : "Failed"
            if let start = step.startedAt, let end = step.endedAt {
                word += (spoken ? ", " : " · ") + format(end.timeIntervalSince(start))
            } else if let ms = step.usage?.ms {
                word += (spoken ? ", " : " · ") + format(Double(ms) / 1000)
            }
            parts.append(word)
        case .stopped:
            parts.append(step.cause ?? "Stopped")
        case .denied:
            parts.append("Denied")
        case .unsure:
            parts.append(ToolStep.mayStillRun)
        case .unknown(let raw):
            parts.append(raw.prefix(1).uppercased() + raw.dropFirst())
        }
        if task?.waiting != nil { parts.append("waiting for your approval") }
        if let progress = task?.progress {
            parts.append(WorkSummary.plural(progress.tools, "tool") + (progress.last.map { ", last \($0)" } ?? ""))
        } else if let usage = step.usage, !step.state.isLive {
            parts.append(WorkSummary.plural(usage.tools, "tool"))
        }
        if let owner = owner(of: step) { parts.append("started by \(owner)") }
        if let quiet = quiet(step, now: now) {
            parts.append("no activity for " + (spoken ? RunClock.spoken(quiet) : RunClock.coarse(quiet)))
        }
        return parts
    }

    /// "3 agents", "2 agents, 1 command", "1 step".
    static func nouns(_ steps: [ToolStep]) -> String {
        var counts: [(noun: String, n: Int)] = []
        for step in steps {
            let noun = switch step.tool {
            case "Task", "Agent": "agent"
            case "Bash": "command"
            default: "step"
            }
            if let at = counts.firstIndex(where: { $0.noun == noun }) { counts[at].n += 1 } else { counts.append((noun, 1)) }
        }
        return counts.map { WorkSummary.plural($0.n, $0.noun) }.joined(separator: ", ")
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
    @ObservationIgnored private(set) var lost = false
    @ObservationIgnored private var index: [ItemID: Int] = [:]
    @ObservationIgnored private var markdown: [ItemID: (text: String, value: RenderedMarkdown)] = [:]
    /// A watch from a position is out: its reply may jump ahead to any later rev.
    @ObservationIgnored private var replying = false
    /// A watch for a lost frame is out. Until its snapshot lands, another loss waits for the one timed retry or the next
    /// watch instead, so a reply the app cannot read never makes it ask again and again.
    @ObservationIgnored private var repairing = false
    @ObservationIgnored private var retried = false
    /// The newest rev applied since the last watch. A snapshot older than it would erase what that frame brought.
    @ObservationIgnored private var newestRev: Int?
    /// The order each item was first seen in, which is also the bridge's order among items at the same time.
    @ObservationIgnored private var arrival: [ItemID: Int] = [:]
    @ObservationIgnored private var firstArrival = 0
    @ObservationIgnored private var lastArrival = 0

    init(id: SessionID) {
        self.id = id
    }

    /// Applies one frame. Returns the permission cards it settled, so pending decisions can clear.
    @discardableResult
    func apply(_ frame: ThreadFrame) -> [MessageID] {
        switch frame {
        case .snapshot(let snapshot):
            if let newestRev, newestRev > snapshot.rev {
                forget(again: true)
                return []
            }
            replace(snapshot.items)
            before = snapshot.before
            controls = snapshot.controls
            position = snapshot.position
            newestRev = snapshot.rev
            phase = .ready
            loadingEarlier = false
            replying = false
            repairing = false
            retried = false
            live.seed(snapshot.live)
            relayout()
            return Self.settled(snapshot.items)

        case let .items(rev, items, removed, controls):
            // The bridge's revs follow on: the next one, or the same state again.
            if let position {
                guard rev == position.rev + 1 || rev == position.rev || (replying && rev > position.rev) else {
                    lose()
                    return []
                }
                self.position = ThreadPosition(epoch: position.epoch, rev: rev)
            }
            replying = false
            newestRev = max(newestRev ?? rev, rev)
            for item in items {
                upsert(item)
                live.drop(item.id)
            }
            if !removed.isEmpty {
                let gone = Set(removed)
                self.items.removeAll { gone.contains($0.id) }
                for id in removed { arrival[id] = nil }
                reindex()
            }
            if let controls { self.controls = controls }
            if phase == .loading, self.position != nil { phase = .ready }
            relayout()
            return Self.settled(items)

        case let .delta(itemId, offset, text):
            // An item already upserted has its text; a late delta for it would start a duplicate tail.
            guard index[itemId] == nil else { return [] }
            live.apply(itemId: itemId, offset: offset, text: text)
            return []

        case let .page(items, before):
            // Older by position: a page item at the same time as one already shown goes above it.
            let older = items.filter { index[$0.id] == nil }
            for item in older.reversed() {
                firstArrival -= 1
                arrival[item.id] = firstArrival
            }
            self.items = (older + self.items).sorted { place($0) < place($1) }
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
        let from = phase == .ready ? position : nil
        replying = from != nil
        newestRev = nil
        return from
    }

    /// A frame for this thread was lost or could not be read. The thread forgets its position, so the next watch asks
    /// for a snapshot, and wants that watch at once unless one for an earlier loss is still out.
    func lose() {
        forget(again: !repairing)
    }

    /// A watch sent for a lost frame whose snapshot never came is sent once more, and only once.
    func retryRepair() -> Bool {
        guard repairing, !retried else { return false }
        retried = true
        return true
    }

    private func forget(again: Bool) {
        position = nil
        replying = false
        if again { lost = true }
    }

    /// Whether the thread wants watching again now; asking marks the watch as sent.
    func takeLost() -> Bool {
        guard lost else { return false }
        lost = false
        repairing = true
        return true
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
        arrival = [:]
        firstArrival = 0
        lastArrival = 0
        for item in items { upsert(item) }
    }

    /// Where an item sits, as bridge/src/threads.ts ordered() puts it: by time, a message Claude Code has not taken yet
    /// after everything, and items at one time in the order they were first seen, as the bridge's stable sort keeps
    /// them. Snapshot, page, replay and live frames all land in this one order.
    private func place(_ item: SessionItem) -> (Int, Date, Int) {
        let waits = if case .user(_, _, _, _, true) = item { 1 } else { 0 }
        return (waits, item.at, arrival[item.id] ?? 0)
    }

    private func upsert(_ item: SessionItem) {
        guard let at = index[item.id] else {
            lastArrival += 1
            arrival[item.id] = lastArrival
            return insert(item)
        }
        guard items[at] != item else { return }
        guard place(items[at]) != place(item) else { items[at] = item; return }
        items.remove(at: at)
        reindex()
        insert(item)
    }

    private func insert(_ item: SessionItem) {
        let key = place(item)
        let slot = items.lastIndex { place($0) < key }.map { $0 + 1 } ?? 0
        items.insert(item, at: slot)
        if slot == items.count - 1 { index[item.id] = slot } else { reindex() }
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

/// The threads the app keeps: every one on screen and the last few, so going back to one is instant. The bridge
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
    /// Threads some window shows, which are never evicted however many there are.
    @ObservationIgnored private var onScreen: Set<SessionID> = []

    subscript(id: SessionID) -> ThreadModel? { models[id] }

    @discardableResult
    func open(_ id: SessionID) -> ThreadModel {
        recent.removeAll { $0 == id }
        recent.append(id)
        let model = models[id] ?? ThreadModel(id: id)
        if models[id] == nil { models[id] = model }
        evict()
        return model
    }

    /// Sets the threads on screen. One that leaves the screen becomes the most recent of the rest.
    func keep(_ onScreen: Set<SessionID>) {
        for id in self.onScreen.subtracting(onScreen) where recent.contains(id) {
            recent.removeAll { $0 == id }
            recent.append(id)
        }
        self.onScreen = onScreen
        evict()
    }

    /// Drops the least recent threads off screen until at most `capacity` are kept, or only on-screen ones are left.
    private func evict() {
        while recent.count > Self.capacity, let index = recent.firstIndex(where: { !onScreen.contains($0) }) {
            models[recent.remove(at: index)] = nil
        }
    }

    func willWatch(_ id: SessionID) -> ThreadPosition? {
        models[id]?.willWatch()
    }

    func lose(_ id: SessionID) {
        models[id]?.lose()
    }

    /// The threads that lost a frame and want watching again now.
    func takeLost() -> [SessionID] {
        var ids: [SessionID] = []
        for (id, model) in models where model.takeLost() { ids.append(id) }
        return ids.sorted { $0.rawValue < $1.rawValue }
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
