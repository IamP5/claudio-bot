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

    static func steps(_ items: [SessionItem]) -> [ToolStep] {
        items.flatMap { item -> [ToolStep] in if case .work(_, _, let steps) = item { steps } else { [] } }
    }

    static func fold(_ items: [SessionItem]) -> String {
        let steps = steps(items)
        let replies = items.count { if case .assistant = $0 { true } else { false } }
        var parts = steps.isEmpty ? [] : [text(steps)]
        if replies > 0 { parts.append(plural(replies, "message")) }
        if parts.isEmpty { return "Thought it through" }
        return parts.joined(separator: ", ")
    }

    /// A folded turn's failures as its run header names them (F-SES-304).
    static func failure(_ items: [SessionItem]) -> String? {
        WorkRun(steps: steps(items)).failure
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

/// A work item read as one run: what is live, what went wrong, and since when. tasks: the session's live tasks, which
/// carry a subagent's progress and name the subagent that started them. heardAt: the last sign of life for the session.
struct WorkRun {
    /// How long a running step may go without a sign of life before it reads as quiet.
    static let quietAfter: TimeInterval = 60

    let steps: [ToolStep]
    let tasks: [SessionTask]
    let heardAt: Date?

    init(steps: [ToolStep], controls: SessionControls? = nil) {
        self.steps = steps
        tasks = controls?.tasks ?? []
        heardAt = controls?.heardAt
    }

    var isLive: Bool { steps.contains { $0.state.isLive } }
    /// Busy, as opposed to live: a run held only by approval cards is blocked, so it never looks busy.
    var isRunning: Bool { steps.contains { $0.state == .running } }
    /// Running with something that changes with time: a step's clock, or a quiet spell measured from a sign of life.
    var ticks: Bool { isRunning && (since != nil || heardAt != nil || !tasks.isEmpty) }
    /// Work that may still run states its age, which grows by the minute.
    var ages: Bool { steps.contains { $0.state == .unsure && $0.startedAt != nil } }

    /// What a collapsed run shows: its live steps and, while any agent of the run is live, every finished agent beside
    /// them, so an agent that ends first stays in view with how it ended (F-SES-195).
    var collapsed: [ToolStep] {
        let agentLive = steps.contains { $0.isAgent && $0.state.isLive }
        return steps.filter { $0.state.isLive || (agentLive && $0.isAgent) }
    }

    /// The run's clock: the earliest start among running steps. A waiting step has not started.
    var since: Date? { steps.filter { $0.state == .running }.compactMap(\.startedAt).min() }

    /// From the first start to the last end, once nothing is live and some step carries both.
    var duration: TimeInterval? {
        guard !isLive, let start = steps.compactMap(\.startedAt).min(), let end = steps.compactMap(\.endedAt).max(), end >= start else { return nil }
        return end.timeIntervalSince(start)
    }

    /// "2 of 3 agents running · 1 done · 1 waiting for approval · 1 stopped", or for a finished run "Ran 3 agents, 43s".
    /// Spoken, the state leads: "Running: 2 of 3 agents, 1 done". What may still run is never counted as ran.
    func headline(spoken: Bool = false) -> String {
        let format = spoken ? RunClock.spoken : RunClock.short
        var parts: [String] = []
        let running = steps.filter { $0.state == .running }
        let agents = steps.count(where: \.isAgent)
        let nouns = Self.nouns(running, agents: agents)
        if !running.isEmpty { parts.append(spoken ? "Running: " + nouns : nouns + " running") }
        let done = steps.count { $0.isAgent && $0.state == .ok }
        if steps.contains(where: { $0.isAgent && $0.state.isLive }), done > 0 { parts.append("\(done) done") }
        let waiting = steps.count { $0.state == .waiting }
        if waiting > 0 { parts.append("\(waiting) waiting for approval") }
        let settled = steps.filter { $0.state != .unsure }
        if parts.isEmpty, !settled.isEmpty || steps.isEmpty {
            parts.append(WorkSummary.text(settled) + (duration.map { ", " + format($0) } ?? ""))
        }
        for (state, word) in [(ToolStepState.stopped, "stopped"), (.denied, "denied"), (.unsure, "may still run"), (.ended, "ended")] {
            let n = steps.count { $0.state == state }
            if n > 0 { parts.append("\(n) \(word)") }
        }
        return parts.joined(separator: spoken ? ", " : " · ")
    }

    /// The first failed step, named, and how many more failed: "broken helper failed: Agent type not found, and 1 more failed".
    var failure: String? {
        let failed = steps.filter { $0.state == .error }
        guard let first = failed.first else { return nil }
        let line = "\(first.label) failed" + (first.cause.map { ": " + $0 } ?? "")
        return failed.count == 1 ? line : line + ", and \(failed.count - 1) more failed"
    }

    /// The header as VoiceOver speaks it: "Running: 3 agents, 2 minutes 5 seconds. broken helper failed: …".
    func spoken(now: Date) -> String {
        var line = headline(spoken: true)
        if let since { line += ", " + RunClock.spoken(now.timeIntervalSince(since)) }
        if let failure { line += ". " + failure }
        return line
    }

    func task(for step: ToolStep) -> SessionTask? { tasks.first { $0.stepId == step.id } }

    /// The label of the subagent that made this call, when it is in the same run.
    func owner(of step: ToolStep) -> String? {
        step.owner.flatMap { id in steps.first { $0.id == id }?.label }
    }

    /// How long a running step has gone without a sign of life, once that passes `quietAfter`. The signs are its task's
    /// progress, the progress of each live task it started, and the session's last word. A live command reports no
    /// progress while it runs, and a task held by an approval card waits on the user, so a step that is either, or
    /// started one, is never quiet (F-SES-198, F-SES-213). A command a subagent runs in the foreground counts before
    /// Claude Code registers its task.
    func quiet(_ step: ToolStep, now: Date) -> TimeInterval? {
        guard step.state == .running else { return nil }
        let own = task(for: step)
        let started = tasks.filter { $0.owner == step.id }
        let held = (own.map { [$0] } ?? []) + started
        guard !held.contains(where: { $0.kind == .command || $0.waiting != nil }) else { return nil }
        guard !steps.contains(where: { $0.owner == step.id && $0.tool == "Bash" && $0.state == .running }) else { return nil }
        let signs = [own?.progress?.at, heardAt] + started.map { $0.progress?.at ?? $0.startedAt }
        guard let last = signs.compactMap({ $0 }).max() else { return nil }
        let gap = now.timeIntervalSince(last)
        return gap > Self.quietAfter ? gap : nil
    }

    /// One step's state and timing in words: "Running · 1m 12s · 3 tools, last Bash · started by sleeper two".
    func status(_ step: ToolStep, now: Date, spoken: Bool = false) -> [String] {
        let format = spoken ? RunClock.spoken : RunClock.short
        let joint = spoken ? ", " : " · "
        let task = task(for: step)
        let ran = step.startedAt.flatMap { start in step.endedAt.map { format($0.timeIntervalSince(start)) } }
        var parts: [String] = []
        switch step.state {
        case .running:
            parts.append("Running" + (step.startedAt.map { joint + format(now.timeIntervalSince($0)) } ?? ""))
        case .waiting:
            parts.append("Waiting for approval")
        case .ok, .error:
            let time = ran ?? step.usage.map { format(Double($0.ms) / 1000) }
            parts.append((step.state == .ok ? "Done" : "Failed") + (time.map { joint + $0 } ?? ""))
        case .stopped:
            parts.append((step.cause ?? "Stopped") + (ran.map { joint + $0 } ?? ""))
        case .denied:
            parts.append("Denied")
        case .unsure:
            let age = step.startedAt.map { (spoken ? RunClock.spoken : RunClock.coarse)(now.timeIntervalSince($0)) }
            parts.append(ToolStep.mayStillRun + (age.map { joint + "started \($0) ago" } ?? ""))
        case .ended:
            parts.append(spoken ? "Ended, result unknown" : "Ended · result unknown")
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

    /// "3 agents", "2 agents, 1 command", "1 step". agents: how many agents the run has, so a run that has more than
    /// the ones counted says "2 of 3 agents".
    static func nouns(_ steps: [ToolStep], agents: Int = 0) -> String {
        var counts: [(noun: String, n: Int)] = []
        for step in steps {
            let noun = step.isAgent ? "agent" : step.tool == "Bash" ? "command" : "step"
            if let at = counts.firstIndex(where: { $0.noun == noun }) { counts[at].n += 1 } else { counts.append((noun, 1)) }
        }
        return counts.map { count in
            count.noun == "agent" && agents > count.n ? "\(count.n) of \(WorkSummary.plural(agents, "agent"))" : WorkSummary.plural(count.n, count.noun)
        }.joined(separator: ", ")
    }
}

extension ToolStep {
    var isAgent: Bool { tool == "Agent" || tool == "Task" }

    /// The output a step shows. A live step has none of its own yet: what it carries while it runs is an earlier
    /// attempt's, such as Claude Code's "Tool call interrupted" from before a restart (F-SES-224).
    var shownOutput: String? {
        guard !state.isLive, let output, !output.isEmpty else { return nil }
        return output
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
    /// A session_page request is out. Cleared by its reply, a snapshot, its refusal, or the next watch.
    private(set) var loadingEarlier = false
    /// A watch from the position the app holds is out, so what the thread shows may be old until its reply (F-SES-128).
    private(set) var catchingUp = false
    private(set) var expanded: Set<ItemID> = []
    /// Full tool outputs the user asked for, by tool_use id, or why the Mac has none.
    private(set) var toolOutputs: [String: ToolOutput] = [:]
    /// When each full output was last asked for, until it arrives.
    private(set) var toolAsked: [String: Date] = [:]
    /// Messages this phone sent that no frame from the Mac has shown back yet, by clientId (F-SES-070).
    private(set) var pendingSends: [ItemID: PendingSend] = [:]
    /// The composer's text, kept with the thread so a queued message taken back for editing lands in it.
    var draft = ComposerDraft()
    /// Queued messages the user took back, until the bridge's items drop them or it refuses (a Claude Code that hangs
    /// answers neither, so each also gives up after Withdrawal.patience).
    private(set) var withdrawals: [ItemID: Withdrawal] = [:]
    /// Messages taken back that went to Claude anyway, and whether their text went to the composer too.
    private(set) var sentAnyway: [ItemID: Bool] = [:]
    /// The user's prompts a stop ended before Claude answered (UnansweredPrompts), less the ones already taken back.
    private(set) var unanswered: Set<ItemID> = []
    @ObservationIgnored private var resent: Set<ItemID> = []
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
            acknowledge(snapshot.items, removed: [])
            replace(snapshot.items)
            before = snapshot.before
            controls = snapshot.controls
            position = snapshot.position
            newestRev = snapshot.rev
            phase = .ready
            loadingEarlier = false
            replying = false
            catchingUp = false
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
            catchingUp = false
            newestRev = max(newestRev ?? rev, rev)
            acknowledge(items, removed: removed)
            for item in items {
                rekey(item)
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
            acknowledge(items, removed: [])
            items.forEach(rekey)
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
            toolAsked[toolUseId] = nil
            return []

        case .removed(let movedTo):
            phase = .removed(movedTo: movedTo)
            catchingUp = false
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
        catchingUp = from != nil
        newestRev = nil
        // A page asked for on an earlier socket is answered on that socket or never; the row may ask again.
        loadingEarlier = false
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
    /// It stays pending until a frame from the Mac shows it back.
    func echo(clientId: String, text: String, at now: Date = .now) {
        let id = ItemID(clientId)
        pendingSends[id] = PendingSend(text: text, at: now)
        upsert(.user(id: id, at: now, text: text, from: .user, queued: true))
        relayout()
    }

    /// The message waits for a socket again: offline, or the user retried it.
    func sendWaiting(_ clientId: String) {
        pendingSends[ItemID(clientId)]?.state = .waiting
    }

    /// A socket took the message. Without a sign of it from the Mac within the patience, it reads as not sent.
    func sendTransmitted(_ clientId: String, at now: Date = .now) {
        let id = ItemID(clientId)
        guard pendingSends[id] != nil else { return }
        pendingSends[id]?.state = .sending(since: now)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(PendingSend.patience))
            self?.lapseSends(at: .now)
        }
    }

    func lapseSends(at now: Date) {
        for (id, send) in pendingSends {
            if case .sending(let since) = send.state, now.timeIntervalSince(since) >= PendingSend.patience { pendingSends[id]?.state = .notSent(nil) }
        }
    }

    /// The Mac refused the message, in its words.
    func sendRefused(_ clientId: String, _ why: String) {
        pendingSends[ItemID(clientId)]?.state = .notSent(why)
    }

    /// A frame that shows a pending message back, under its clientId or as the transcript's copy, or removes it, means
    /// the Mac has it.
    private func acknowledge(_ items: [SessionItem], removed: [ItemID]) {
        guard !pendingSends.isEmpty else { return }
        for id in Self.clientIds(items, removed: removed) { pendingSends[id] = nil }
    }

    /// The ids by which a frame names the phone's messages.
    static func clientIds(_ items: [SessionItem], removed: [ItemID]) -> Set<ItemID> {
        var ids = Set(removed)
        for item in items {
            ids.insert(item.id)
            if case let .user(_, _, _, _, _, clientId?) = item { ids.insert(ItemID(clientId)) }
        }
        return ids
    }

    /// The transcript now shows a message under its own id. What the phone knew about it under its clientId moves there.
    private func rekey(_ item: SessionItem) {
        guard case let .user(id, _, _, _, _, clientId?) = item else { return }
        let old = ItemID(clientId)
        guard old != id else { return }
        if let withdrawal = withdrawals.removeValue(forKey: old) { withdrawals[id] = withdrawal }
        if let edited = sentAnyway.removeValue(forKey: old) { sentAnyway[id] = edited }
        if resent.remove(old) != nil { resent.insert(id) }
    }

    /// Full output was asked for. One the Mac had no output for is asked for again.
    func askTool(_ toolUseId: String, at now: Date = .now) {
        if case .missing = toolOutputs[toolUseId] { toolOutputs[toolUseId] = nil }
        toolAsked[toolUseId] = now
    }

    /// The Mac refused a page, so the row may ask again.
    func pageRefused() {
        loadingEarlier = false
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

    /// A snapshot replaces the items. A message still pending is not in it yet, so its echo stays.
    private func replace(_ items: [SessionItem]) {
        self.items = []
        index = [:]
        arrival = [:]
        firstArrival = 0
        lastArrival = 0
        for item in items {
            rekey(item)
            upsert(item)
        }
        for (id, send) in pendingSends.sorted(by: { $0.value.at < $1.value.at }) where index[id] == nil {
            upsert(.user(id: id, at: send.at, text: send.text, from: .user, queued: true))
        }
    }

    /// Where an item sits, as bridge/src/threads.ts ordered() puts it: by time, a message Claude Code has not taken yet
    /// after everything, and items at one time in the order they were first seen, as the bridge's stable sort keeps
    /// them. Snapshot, page, replay and live frames all land in this one order.
    private func place(_ item: SessionItem) -> (Int, Date, Int) {
        let waits = if case .user(_, _, _, _, true, _) = item { 1 } else { 0 }
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
        if !withdrawals.isEmpty { settleWithdrawals() }
        // A message taken back that went to Claude anyway keeps its note only while it is in the thread.
        if sentAnyway.keys.contains(where: { index[$0] == nil }) { sentAnyway = sentAnyway.filter { index[$0.key] != nil } }
        let next = ThreadLayout.rows(items, expanded: expanded, working: controls?.working ?? false)
        if next != rows { rows = next }
        let prompts = UnansweredPrompts.of(items, turnRuns: ComposerState.queues(controls)).subtracting(resent)
        if prompts != unanswered { unanswered = prompts }
    }

    /// Edit and resend, once per prompt: its text goes back in the composer and the offer goes away.
    func resend(_ id: ItemID, text: String) {
        guard !resent.contains(id) else { return }
        resent.insert(id)
        edit(text)
        relayout()
    }

    /// The messages on their way out of the queue: not lapsed.
    var withdrawing: Set<ItemID> {
        Set(withdrawals.compactMap { $0.value.lapsed ? nil : $0.key })
    }

    /// The messages that wait for the turn as this phone counts them: the bridge's count, less the ones on their way out.
    var queuedCount: Int {
        max(0, (controls?.queued ?? 0) - withdrawing.count)
    }

    /// edited: its text went to the composer (now or on an earlier try), so it never goes there twice.
    func withdraw(_ id: ItemID, edited: Bool, at now: Date = .now) {
        withdrawals[id] = Withdrawal(at: now, edited: edited || withdrawals[id]?.edited == true)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Withdrawal.patience))
            self?.lapseWithdrawals(at: .now)
        }
    }

    /// Withdrawals with no word from the Mac within the patience: the message may still be queued.
    func lapseWithdrawals(at now: Date) {
        for (id, withdrawal) in withdrawals where !withdrawal.lapsed && now.timeIntervalSince(withdrawal.at) >= Withdrawal.patience {
            withdrawals[id]?.lapsed = true
        }
    }

    /// The bridge would not take the message back: it is queued, or went to Claude, as the items say.
    func withdrawRefused(_ id: ItemID) {
        withdrawals[id] = nil
    }

    /// A message still queued keeps its withdrawal. One gone from the items was dropped. One that is no longer queued
    /// went to Claude before the withdrawal reached it.
    private func settleWithdrawals() {
        var queued: [ItemID: Bool] = [:]
        for case let .user(id, _, _, .user, isQueued, _) in items { queued[id] = isQueued }
        for (id, withdrawal) in withdrawals where queued[id] != true {
            withdrawals[id] = nil
            if queued[id] == false { sentAnyway[id] = withdrawal.edited }
        }
    }

    /// Puts a message back in the composer for editing, after whatever is typed there.
    func edit(_ text: String) {
        if draft.isBlank { draft = ComposerDraft(text: text) } else { draft.append("\n\n" + text) }
    }

    /// The cards these items show closed, so the decisions sent for them settle.
    private static func settled(_ items: [SessionItem]) -> [MessageID] {
        items.compactMap { item in
            switch item {
            case let .permission(_, _, permission) where permission.card.answer != nil: permission.cardId
            case let .ask(_, _, _, _?, cardId?): cardId
            case let .plan(_, _, _, state, cardId?) where state != .proposed: cardId
            default: nil
            }
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
