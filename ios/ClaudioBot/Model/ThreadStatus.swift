import Foundation

/// The cards in a thread that wait on the user, as the status line shows them and VoiceOver announces them. The newest
/// leads: the line scrolls to it and a new one is spoken. The count and the names cover every open card (F-SES-221).
struct OpenCard: Equatable, Sendable {
    enum Kind: Hashable, Sendable { case permission, ask, plan }

    /// The newest open card.
    let id: ItemID
    let kind: Kind
    /// The header's word for what the cards need: "Needs your approval", "Needs your answer", "Needs you".
    let need: String
    /// "Needs your approval: Bash in sleeper two", "Needs your approval: 3 requests (sleeper one, sleeper two, sleeper three)".
    let line: String
    /// "Approval needed. sleeper two wants to run Bash: perl -e 'sleep 30'".
    let announcement: String
    /// The first moment an open card stops counting as open without a frame saying so.
    let expiresAt: Date?
    /// When the oldest open card was raised: how long the thread has waited on the user (F-SES-297).
    let since: Date
    let count: Int
    /// The kinds open now. Stop closes them all, and only a permission card says the stop itself.
    let kinds: Set<Kind>

    /// A permission card whose deadline passed is no longer open, so it no longer hides the run's state.
    static func waiting(in items: [SessionItem], at now: Date) -> OpenCard? {
        var open: [(id: ItemID, at: Date, kind: Kind, asker: String, line: String, announcement: String, expiresAt: Date?)] = []
        for item in items {
            switch item {
            case let .permission(id, at, permission) where permission.card.answer(at: now) == nil:
                let card = permission.card
                let who = permission.subagent.map { " in \($0)" } ?? ""
                let asker = permission.subagent ?? "Claude"
                open.append((
                    id, at, .permission, permission.subagent ?? card.tool, "Needs your approval: \(card.tool)\(who)",
                    "Approval needed. \(asker) wants to run \(card.tool)" + (Self.firstLine(card.detail).map { ": " + $0 } ?? "."),
                    card.expiresAt
                ))
            case let .ask(id, at, questions, nil, _?):
                let first = questions.first?.question ?? ""
                open.append((
                    id, at, .ask, "a question",
                    questions.count == 1 ? "Claude asks you a question" : "Claude asks you \(questions.count) questions",
                    questions.count == 1 ? "Question: \(first)" : "\(questions.count) questions. First: \(first)",
                    nil
                ))
            case let .plan(id, at, text, .proposed, _?):
                open.append((
                    id, at, .plan, "a plan", "A plan needs your approval",
                    "Plan ready for your approval" + (Self.heading(text).map { ": " + $0 } ?? "."),
                    nil
                ))
            default:
                continue
            }
        }
        guard let newest = open.last else { return nil }
        let since = open.map(\.at).min() ?? newest.at
        let expiresAt = open.compactMap(\.expiresAt).min()
        guard open.count > 1 else {
            let need = newest.kind == .ask ? "Needs your answer" : "Needs your approval"
            return OpenCard(
                id: newest.id, kind: newest.kind, need: need, line: newest.line, announcement: newest.announcement, expiresAt: expiresAt,
                since: since, count: 1, kinds: [newest.kind]
            )
        }
        let kinds = Set(open.map(\.kind))
        let need = kinds == [.ask] ? "Needs your answer" : kinds.contains(.ask) ? "Needs you" : "Needs your approval"
        var names: [String] = []
        for card in open where !names.contains(card.asker) { names.append(card.asker) }
        return OpenCard(
            id: newest.id, kind: newest.kind, need: need,
            line: "\(need): \(open.count) requests (\(names.joined(separator: ", ")))",
            announcement: "\(open.count) requests wait on you. Newest: \(newest.announcement)",
            expiresAt: expiresAt, since: since, count: open.count, kinds: kinds
        )
    }

    /// A command's first line, cut at `limit` characters so the line or announcement stays short.
    static func firstLine(_ text: String, limit: Int = 120) -> String? {
        let line = text.split(separator: "\n").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        guard !line.isEmpty else { return nil }
        return line.count > limit ? String(line.prefix(limit - 1)) + "…" : line
    }

    /// The plan's first heading, else its first line, without markdown marks.
    static func heading(_ markdown: String) -> String? {
        let lines = markdown.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let pick = lines.first { $0.hasPrefix("#") } ?? lines.first
        return pick.flatMap { firstLine($0.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)) }
    }
}

/// The card a push link named. A push already on the lock screen cannot be taken back, so a thread opened from one
/// that no longer waits on the user says so.
struct LinkedCard: Equatable, Sendable {
    let sessionId: SessionID
    let cardId: MessageID

    enum Closing { case answered, expired, stopped, closed }

    /// The note once the card is in `items`, closed and not decided on this phone. nil says nothing: the card is not
    /// loaded, still waits, or the user just answered it here. Another card that waits is named, not hidden behind the
    /// closed one (F-SES-247).
    func note(in items: [SessionItem], decidedHere: Set<MessageID>, at now: Date) -> String? {
        guard !decidedHere.contains(cardId), let closing = closing(in: items, at: now) else { return nil }
        let waits = OpenCard.waiting(in: items, at: now) != nil
        return switch closing {
        case .answered: waits ? "That request was answered. Another one waits on you." : "Already answered. Nothing here waits on you now."
        case .expired: waits ? "That request expired. Another one waits on you." : "That request expired."
        case .stopped:
            waits ? "That request closed when the turn was stopped. Another one waits on you." : "That request closed when the turn was stopped."
        case .closed: waits ? "That request is no longer open. Another one waits on you." : "That request is no longer open. Nothing here waits on you now."
        }
    }

    /// What closed the card; nil while it is open or not in `items`. An ask or plan drops its card id once it closes,
    /// so only an open one is ever found here.
    private func closing(in items: [SessionItem], at now: Date) -> Closing? {
        for item in items {
            switch item {
            case let .permission(_, _, permission) where permission.cardId == cardId:
                switch permission.card.answer(at: now) {
                case nil: return nil
                case .expired: return .expired
                case .stopped: return .stopped
                case .closed: return .closed
                case .chose, .unknown: return .answered
                }
            case let .ask(_, _, _, answers, id?) where id == cardId:
                switch answers {
                case nil: return nil
                case .expired: return .expired
                case .stopped: return .stopped
                case .answered, .dismissed, .closed: return .answered
                }
            case let .plan(_, _, _, state, id?) where id == cardId:
                switch state {
                case .proposed: return nil
                case .expired: return .expired
                case .stopped: return .stopped
                case .approved, .rejected, .unknown: return .answered
                }
            default:
                continue
            }
        }
        return nil
    }
}

/// The thread's one status line (P-STATE-5). The highest level that holds wins: a dead socket never shows a live
/// clock, and a run held by a card never reads as busy. Every level that may have work keeps the last-known tasks, so
/// Running now stays one tap away while anything runs or last ran (F-SES-220, F-SES-223).
enum ThreadStatus: Equatable, Sendable {
    /// The Mac is out of reach. lastUpdate: when the app last heard from it; nil when this thread never loaded.
    case offline(Reach, lastUpdate: Date?, tasks: [SessionTask])
    /// The thread shows what the app kept, and the Mac's reply to its watch has not come yet (F-SES-128).
    case catchingUp(lastUpdate: Date?, tasks: [SessionTask])
    /// The socket is up, but the Mac has sent nothing for a while although this thread works.
    case quiet(since: Date, tasks: [SessionTask])
    case needsYou(OpenCard, tasks: [SessionTask])
    /// Claude Code stopped unexpectedly or was cut off, and work it started still runs (F-SES-196).
    case orphaned(SessionOutcome, tasks: [SessionTask])
    /// A turn runs, or work runs that the bridge does not itemize. since: the turn's start.
    case working(since: Date?, tasks: [SessionTask])
    /// No turn, only tasks: background commands and subagents.
    case background(since: Date, tasks: [SessionTask])
    /// At rest after a run that failed, was stopped or was cut off, until the next send.
    case ended(SessionOutcome)

    /// quietSince: the connection's, set once a working thread on screen has heard nothing for too long.
    /// since: the row's run start, for a bridge whose controls carry no turn.
    static func of(
        reach: Reach, quietSince: Date?, lastUpdate: Date?, controls: SessionControls?, card: OpenCard?,
        since: Date?, outcome: SessionOutcome?, catchingUp: Bool = false
    ) -> ThreadStatus? {
        let tasks = controls?.tasks ?? []
        switch reach {
        case .connected, .unpaired: break
        case .firstConnect, .reconnecting, .unreachable, .retrying, .unrecognized: return .offline(reach, lastUpdate: lastUpdate, tasks: tasks)
        }
        if catchingUp { return .catchingUp(lastUpdate: lastUpdate, tasks: tasks) }
        let working = controls?.working ?? false
        if working, let quietSince { return .quiet(since: quietSince, tasks: tasks) }
        if let card { return .needsYou(card, tasks: tasks) }
        if let outcome, outcome.kind == .failed || outcome.kind == .lost, controls?.turn == nil, !tasks.isEmpty, outcome.at >= since ?? .distantPast {
            return .orphaned(outcome, tasks: tasks)
        }
        if let turn = controls?.turn { return .working(since: Date(wire: turn.startedAt), tasks: tasks) }
        if let start = tasks.map(\.startedAt).min() { return .background(since: start, tasks: tasks) }
        if working { return .working(since: since, tasks: []) }
        if let outcome, outcome.kind != .finished { return .ended(outcome) }
        return nil
    }

    /// Where running marks stop and dim: the last moment the thread's state was known true.
    var staleAt: Date? {
        switch self {
        case .offline(_, let lastUpdate, _), .catchingUp(let lastUpdate, _): lastUpdate
        case .quiet(let since, _): since
        case .needsYou, .orphaned, .working, .background, .ended: nil
        }
    }

    /// What runs, or ran when the Mac last answered.
    var tasks: [SessionTask] {
        switch self {
        case .offline(_, _, let tasks), .catchingUp(_, let tasks), .quiet(_, let tasks), .needsYou(_, let tasks), .orphaned(_, let tasks),
             .working(_, let tasks), .background(_, let tasks): tasks
        case .ended: []
        }
    }

    /// The thread header's state, in one or two words.
    var word: String {
        switch self {
        case .offline(.firstConnect, _, _): "Connecting"
        case .offline: "Offline"
        case .catchingUp: "Catching up"
        case .quiet: "No word from your Mac"
        case .needsYou(let card, _): card.need
        case .working: "Working"
        case .background(_, let tasks): Self.outlives(tasks) ? "Still running" : "Running in background"
        case .orphaned(let outcome, _), .ended(let outcome): Self.word(outcome.kind)
        }
    }

    private static func word(_ kind: SessionOutcomeKind) -> String {
        switch kind {
        case .failed: "Failed"
        case .stopped: "Stopped"
        case .lost: "Cut off"
        case .finished: "Finished"
        case .unknown(let raw): raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    /// The line as shown. cause: the connection copy the Sessions banner uses, for the offline level.
    func text(now: Date, cause: String = "") -> String {
        line(now: now, cause: cause, spoken: false)
    }

    /// The line as VoiceOver reads it: whole words for times.
    func spoken(now: Date, cause: String = "") -> String {
        line(now: now, cause: cause, spoken: true)
    }

    private func line(now: Date, cause: String, spoken: Bool) -> String {
        let clock = spoken ? RunClock.spoken : RunClock.short
        switch self {
        case let .offline(reach, lastUpdate, tasks):
            let head = reach == .firstConnect ? "Connecting to your Mac…" : cause
            guard let lastUpdate else { return head + " This session loads when your Mac is back." }
            let ago = clock(now.timeIntervalSince(lastUpdate))
            guard let ran = TaskCount(tasks).were(spoken: spoken) else { return head + " Last update \(ago) ago." }
            return head + " \(ran) running when your Mac last answered \(ago) ago."
        case let .catchingUp(_, tasks):
            return "Catching up…" + (TaskCount(tasks).were(spoken: spoken).map { " \($0) running at the last update." } ?? "")
        case let .quiet(since, tasks):
            let head = "No word from your Mac for \(clock(now.timeIntervalSince(since)))"
            return [head, TaskCount(tasks).were(spoken: spoken).map { $0 + " running then" }].compactMap { $0 }.joined(separator: " · ")
        case let .needsYou(card, tasks):
            let running = TaskCount(tasks.filter { $0.waiting == nil }).top.count
            // The wait counts in whole minutes from the first one: seconds would tick beside a card that just came. It goes
            // last, so the cut at the largest text sizes takes it first.
            let minutes = (now.timeIntervalSince(card.since) / 60).rounded(.down) * 60
            let waited = minutes < 60 ? nil : spoken ? "waiting " + RunClock.spoken(minutes) : RunClock.coarse(minutes)
            return [card.line, running > 0 ? "\(running) still running" : nil, waited].compactMap { $0 }.joined(separator: " · ")
        case let .orphaned(outcome, tasks):
            let count = TaskCount(tasks)
            let one = count.top.count == 1
            let crash = outcome.text.hasSuffix(".") ? String(outcome.text.dropLast()) : outcome.text
            return [crash, (count.text(spoken: spoken) ?? "") + (one ? " still runs" : " still run"), one ? "Stop ends it" : "Stop ends them"].joined(separator: " · ")
        case let .working(since, tasks):
            let what = TaskCount(tasks).text(spoken: spoken)
            return ["Working" + (since.map { " " + clock(now.timeIntervalSince($0)) } ?? ""), what].compactMap { $0 }.joined(separator: " · ")
        case let .background(since, tasks):
            // One task is named, cut short so the clock stays in view. The sheet has the whole label.
            let count = TaskCount(tasks)
            let what = tasks.count == 1 ? OpenCard.firstLine(tasks[0].label, limit: 40) ?? "" : count.text(spoken: spoken) ?? ""
            return Self.backgroundHead(tasks) + ": \(what) · " + clock(now.timeIntervalSince(since))
        case .ended(let outcome):
            return Self.outcome(outcome)
        }
    }

    /// A foreground command that outlived a Claude Code crash or a bridge restart keeps its foreground word (Run3 call
    /// 7): once a later run has its own outcome, the line says what it outlived instead of calling it background work.
    static func outlives(_ tasks: [SessionTask]) -> Bool {
        tasks.contains { $0.outlived && !$0.background }
    }

    static func backgroundHead(_ tasks: [SessionTask]) -> String {
        outlives(tasks) ? "Still running after Claude Code stopped" : "Running in background"
    }

    /// A run that failed or was cut off says how to go on.
    static func outcome(_ outcome: SessionOutcome) -> String {
        switch outcome.kind {
        case .failed, .lost: outcome.text + (outcome.text.hasSuffix(".") ? "" : ".") + " Send a message to start it again."
        case .stopped, .finished, .unknown: outcome.text
        }
    }
}

/// Live work as a person counts it (Run3 call 16): a task a live subagent started is named under that subagent, not
/// counted again, so three subagents with one command each read as three things, not six (F-SES-289).
struct TaskCount: Equatable, Sendable {
    /// The work no live subagent started.
    let top: [SessionTask]
    /// "3 agents (each running a command)", "1 command".
    let parts: [String]
    /// The same without what runs under each agent: "3 agents", "1 command".
    let heads: [String]

    init(_ tasks: [SessionTask]) {
        let agents = Set(tasks.filter { $0.kind == .agent }.compactMap(\.stepId))
        let under = tasks.filter { $0.owner.map(agents.contains) ?? false }
        top = tasks.filter { !($0.owner.map(agents.contains) ?? false) }
        var counts: [(noun: String, n: Int)] = []
        for task in top {
            let noun = switch task.kind {
            case .agent: "agent"
            case .command: "command"
            case .other, .unknown: "task"
            }
            if let at = counts.firstIndex(where: { $0.noun == noun }) { counts[at].n += 1 } else { counts.append((noun, 1)) }
        }
        heads = counts.map { WorkSummary.plural($0.n, $0.noun) }
        let topAgents = Set(top.filter { $0.kind == .agent }.compactMap(\.stepId))
        let started = under.filter { $0.owner.map(topAgents.contains) ?? false }
        parts = counts.map { count in
            let head = WorkSummary.plural(count.n, count.noun)
            guard count.noun == "agent", !started.isEmpty else { return head }
            return head + " (" + Self.under(agents: count.n, owners: Set(started.compactMap(\.owner)).count, started: started) + ")"
        }
    }

    /// "each running a command", "running 3 commands", "1 running a command".
    private static func under(agents: Int, owners: Int, started: [SessionTask]) -> String {
        let noun = started.allSatisfy { $0.kind == .command } ? "command" : "task"
        let what = started.count == owners ? "a \(noun)" : WorkSummary.plural(started.count, noun)
        if owners < agents { return "\(owners) running \(what)" }
        return (agents > 1 && started.count == owners ? "each running " : "running ") + what
    }

    /// "3 agents (each running a command), 1 command"; nil for none.
    var text: String? { text(spoken: true) }

    /// Shown, what runs under each agent is left to Running now: at the largest text sizes the line is cut at three
    /// lines, and a cut inside it lost the rest of the sentence.
    func text(spoken: Bool) -> String? {
        let words = spoken ? parts : heads
        return words.isEmpty ? nil : words.joined(separator: ", ")
    }

    /// "3 agents were", "1 command was"; nil for none.
    func were(spoken: Bool) -> String? { text(spoken: spoken).map { $0 + (top.count == 1 ? " was" : " were") } }
}

/// What VoiceOver hears when the thread's status changes. Only changes seen live are spoken: a status that follows an
/// offline or quiet one is what the Mac says on return, so it is not news. A card is news on first render too, but a
/// card already spoken is not spoken again.
enum ThreadAnnouncement {
    /// The part of a status a change is spoken for. Clocks and task progress move without anything to say.
    static func key(_ status: ThreadStatus?) -> String {
        switch status {
        case nil: "rest"
        case .offline: "offline"
        case .catchingUp: "catching up"
        case .quiet: "quiet"
        case .needsYou(let card, _): "card " + card.id.rawValue
        case .orphaned(let outcome, let tasks): "orphaned \(outcome.at.timeIntervalSince1970) " + tasks.map(\.id.rawValue).joined(separator: " ")
        case .working(_, let tasks): "working " + tasks.map(\.id.rawValue).joined(separator: " ")
        case .background(_, let tasks): "background " + tasks.map(\.id.rawValue).joined(separator: " ")
        case .ended(let outcome): "ended \(outcome.kind.rawValue) \(outcome.at.timeIntervalSince1970)"
        }
    }

    /// heard: the last card spoken in this thread.
    /// cardClosed: the run came to rest from an open permission card, whose close the card spoke itself.
    /// name: a task as it is spoken once it ended, with how it ended when the thread shows that.
    static func of(
        from old: ThreadStatus?, to new: ThreadStatus?, first: Bool = false, heard: ItemID? = nil, cardClosed: Bool = false,
        now: Date = .now, name: (SessionTask) -> EndedTask = { EndedTask(title: $0.label) }
    ) -> String? {
        if case .needsYou(let card, _) = new {
            return first || card.id != heard ? card.announcement : nil
        }
        guard !first, old != new else { return nil }
        if case .quiet(let since, _) = new {
            if case .quiet = old { return nil }
            return "No word from your Mac for \(RunClock.spoken(now.timeIntervalSince(since))). The thread may be out of date."
        }
        switch old {
        case .offline, .catchingUp, .quiet, .ended:
            return nil
        case nil:
            // The row brings the outcome after the thread's frame put it at rest, later than StatusAnnouncer waited.
            if case .ended(let outcome) = new, !(cardClosed && outcome.kind == .stopped) { return ThreadStatus.outcome(outcome) }
            if case .orphaned = new { return new?.spoken(now: now) }
            return nil
        case .needsYou(let card, _):
            // Stop closes an open permission card, and that card says so itself (ChatItems announcesClose). A plan or a
            // question says only that it closed, so the stop is still news (F-SES-178).
            if case .ended(let outcome) = new, outcome.kind != .stopped || card.kinds != [.permission] { return ThreadStatus.outcome(outcome) }
            if case .orphaned = new { return new?.spoken(now: now) }
            return nil
        case let .orphaned(outcome, was):
            switch new {
            case nil: return ended("Background work ended.", was, [], name)
            case .ended(let ending) where ending == outcome: return ended("Background work ended.", was, [], name)
            case .ended(let ending): return ThreadStatus.outcome(ending)
            case .orphaned(_, let live), .working(_, let live), .background(_, let live): return ended("Ended in background.", was, live, name)
            case .offline, .catchingUp, .quiet, .needsYou: return nil
            }
        case let .working(_, was), let .background(_, was):
            switch new {
            case nil:
                if case .working = old { return "Claude finished." }
                return ended("Background work ended.", was, [], name)
            case .ended(let outcome):
                return ThreadStatus.outcome(outcome)
            case .orphaned:
                return new?.spoken(now: now)
            case .background(_, let live):
                if case .working = old { return "Claude finished its turn. " + (ThreadStatus.outlives(live) ? "Still running after Claude Code stopped: " : "Still running in background: ") + live.map(\.label).joined(separator: ", ") + "." }
                return ended("Ended in background.", was.filter(\.background), live, name)
            case .working(_, let live):
                return ended("Ended in background.", was.filter(\.background), live, name)
            case .offline, .catchingUp, .quiet, .needsYou:
                return nil
            }
        }
    }

    /// Tasks that were live and are gone, one sentence each: "Ended in background. Sleep 75 seconds, done." Subagents
    /// of the turn come and go too often to speak each one, so the caller passes only the work worth naming. A task
    /// the bridge can no longer follow is not called ended.
    private static func ended(_ head: String, _ was: [SessionTask], _ now: [SessionTask], _ name: (SessionTask) -> EndedTask) -> String? {
        let live = Set(now.map(\.id))
        let gone = was.filter { !live.contains($0.id) }.map(name)
        let over = gone.filter { !$0.mayStillRun }.map(\.spoken)
        let unsure = gone.filter(\.mayStillRun).map { $0.title + " may still run on your Mac." }
        let sentences = (over.isEmpty ? [] : [head] + over) + unsure
        return sentences.isEmpty ? nil : sentences.joined(separator: " ")
    }

    /// A task by its step's title, which names a command in words, and how the step ended (F-SES-232). A step the
    /// thread still shows as running says nothing about how it ended.
    static func name(_ task: SessionTask, in items: [SessionItem]) -> EndedTask {
        var step: ToolStep?
        for case let .work(_, _, steps) in items {
            if let found = steps.first(where: { $0.id == task.stepId }) { step = found }
        }
        guard let step else { return EndedTask(title: task.label) }
        let title = task.kind == .command ? step.label : task.label
        let how: String? = switch step.state {
        case .ok: "done"
        case .error: "failed"
        case .stopped: "stopped"
        case .denied: "denied"
        case .ended: "ended, result unknown"
        case .unsure, .running, .waiting, .unknown: nil
        }
        return EndedTask(title: title, how: how, mayStillRun: step.state == .unsure)
    }
}

/// A task that left the running list, as it is spoken.
struct EndedTask: Equatable, Sendable {
    let title: String
    var how: String?
    var mayStillRun = false

    /// "Sleep 75 seconds, done."
    var spoken: String { title + (how.map { ", " + $0 } ?? "") + "." }
}

/// Decides when a thread's status is spoken. A status is spoken once it has held for `settle`. A run that comes to
/// rest waits `rest` instead: its outcome comes on the Sessions row, which the bridge coalesces on a 500 ms timer, so
/// speaking at rest any sooner would call a failed run finished.
@MainActor
final class StatusAnnouncer {
    private let settle: Duration
    private let rest: Duration
    /// The text, and whether the thread just opened.
    private let speak: (String, Bool) -> Void
    /// A task as it is spoken once it ended. Read when the status lands, so a step's end that came meanwhile counts.
    var name: (SessionTask) -> EndedTask = { EndedTask(title: $0.label) }
    private var spoken: ThreadStatus?
    private var once = false
    private var heardCard: ItemID?
    /// The last run came to rest from an open permission card. A Stop closes the card, and the card says so itself.
    private var cardClosed = false
    private var pending: Task<Void, Never>?

    init(settle: Duration = .milliseconds(500), rest: Duration = .milliseconds(1500), speak: @escaping (String, Bool) -> Void) {
        self.settle = settle
        self.rest = rest
        self.speak = speak
    }

    /// Call when the status's announcement key changes. What it replaces before it settles is never spoken.
    func update(_ status: ThreadStatus?) {
        pending?.cancel()
        let live = switch spoken {
        case .working, .background, .needsYou, .orphaned: true
        default: false
        }
        // A turn that ends and leaves work running may be a crash whose outcome the row brings later, like a rest.
        let turnEnded = if case .working = spoken, case .background = status { true } else { false }
        let wait = (status == nil && live) || turnEnded ? rest : settle
        pending = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            self?.land(status)
        }
    }

    private func land(_ status: ThreadStatus?) {
        let first = !once
        if let text = ThreadAnnouncement.of(from: spoken, to: status, first: first, heard: heardCard, cardClosed: cardClosed, name: name) {
            speak(text, first)
        }
        switch status {
        case .needsYou(let card, _):
            heardCard = card.id
            cardClosed = false
        case .working, .background, .orphaned:
            cardClosed = false
        case nil, .ended, .offline, .catchingUp, .quiet:
            if case .needsYou(let card, _) = spoken, card.kinds == [.permission] { cardClosed = true }
        }
        spoken = status
        once = true
    }
}

/// Sessions other than the one on screen that the user should know about while a wide layout hides the list: what
/// waits on them, what runs, what broke, and a stop they have not seen. It reads the list with its freshness, so a list
/// the Mac no longer answers for never claims anything runs (P-ALIVE-3): a working row becomes last known, with no
/// count and no ring.
struct SessionsAtWork: Equatable {
    enum Kind: Hashable {
        case needsYou, working, lastKnownWorking, failed, stopped
    }

    struct Entry: Equatable, Identifiable {
        let row: SessionRow
        let kind: Kind
        var id: SessionID { row.id }
    }

    let freshness: ListFreshness
    /// Needs you, then working, then failed, then stopped.
    let entries: [Entry]

    /// A hidden row still counts while it runs or waits on the user: attention beats the user's tidy-up (F-SES-308).
    /// A stop counts only until the user has seen it, so their own stops do not pile up here.
    init(_ rows: some Sequence<SessionRow>, freshness: ListFreshness, excluding: SessionID? = nil) {
        self.freshness = freshness
        var needsYou: [SessionRow] = [], working: [SessionRow] = [], failed: [SessionRow] = [], stopped: [SessionRow] = []
        for row in rows where row.id != excluding {
            if row.needsYou { needsYou.append(row) }
            else if row.status == .working { working.append(row) }
            else if row.hidden { continue }
            else if row.status == .failed { failed.append(row) }
            else if row.outcome?.kind == .stopped, row.unread { stopped.append(row) }
        }
        let live = freshness == .live
        entries = needsYou.sorted { $0.lastAt > $1.lastAt }.map { Entry(row: $0, kind: .needsYou) }
            + working.sorted { ($0.since ?? $0.lastAt) > ($1.since ?? $1.lastAt) }.map { Entry(row: $0, kind: live ? .working : .lastKnownWorking) }
            + failed.sorted { ($0.outcome?.at ?? $0.lastAt) > ($1.outcome?.at ?? $1.lastAt) }.map { Entry(row: $0, kind: .failed) }
            + stopped.sorted { ($0.outcome?.at ?? $0.lastAt) > ($1.outcome?.at ?? $1.lastAt) }.map { Entry(row: $0, kind: .stopped) }
    }

    var isEmpty: Bool { entries.isEmpty }

    private func count(_ kind: Kind) -> Int { entries.count { $0.kind == kind } }

    /// "2 working · 1 needs you · 1 failed". A list kept from before the Mac went out of reach has no working count and
    /// says how old it is: "1 needs you · as of 5m ago".
    func summary(now: Date) -> String? { summary(now: now, spoken: false) }

    /// "2 working, running 3 agents and 1 command, 1 needs you, 1 failed".
    func spoken(now: Date) -> String? { summary(now: now, spoken: true) }

    private func summary(now: Date, spoken: Bool) -> String? {
        guard !isEmpty else { return nil }
        let working = count(.working), needs = count(.needsYou), failed = count(.failed), stopped = count(.stopped)
        let running = spoken ? runningTotal.map { "running " + $0 } : nil
        let parts = [
            working > 0 ? "\(working) working" : nil, running,
            needs > 0 ? "\(needs) \(needs == 1 ? "needs" : "need") you" : nil,
            failed > 0 ? "\(failed) failed" : nil,
            stopped > 0 ? "\(stopped) stopped" : nil,
        ].compactMap { $0 }
        guard let asOf = freshness.asOf(now: now, spoken: spoken) else { return parts.joined(separator: spoken ? ", " : " · ") }
        return parts.isEmpty ? "Sessions " + asOf : (parts + [asOf]).joined(separator: spoken ? ", " : " · ")
    }

    /// What the working sessions run, as the list rows count it: "3 agents and 1 command". Nil when the list is not live.
    var runningTotal: String? {
        let rows = entries.filter { $0.kind == .working }.compactMap(\.row.running)
        let agents = rows.map(\.agents).reduce(0, +), commands = rows.map(\.commands).reduce(0, +)
        let parts = [agents > 0 ? WorkSummary.plural(agents, "agent") : nil, commands > 0 ? WorkSummary.plural(commands, "command") : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " and ")
    }

    /// An entry's second line: "Working 4m 05s · 3 agents, 1 command · Run npm test", "Waiting for approval: Bash",
    /// "Working for 4m 05s when last updated", "Claude Code stopped unexpectedly · 5m ago".
    func line(_ entry: Entry, now: Date, spoken: Bool = false) -> String {
        let row = entry.row
        let clock = spoken ? RunClock.spoken : RunClock.short
        let ago = { (date: Date) in SessionAge(date, now: now).ago(spoken: spoken) }
        let parts: [String?] = switch entry.kind {
        case .needsYou:
            [row.activity ?? "Needs you"]
        case .working:
            ["Working" + (row.since.map { " " + clock(now.timeIntervalSince($0)) } ?? ""), row.running.flatMap(SessionText.running), row.activity]
        case .lastKnownWorking:
            ["Working" + (row.since.map { " for " + clock(freshness.ageReference(now: now).timeIntervalSince($0)) } ?? "") + " when last updated"]
        case .failed:
            [row.outcome?.text ?? "Failed", ago(row.outcome?.at ?? row.lastAt)]
        case .stopped:
            [row.outcome?.text ?? "Stopped", ago(row.outcome?.at ?? row.lastAt)]
        }
        return (parts.compactMap { $0 } + (row.hidden ? ["hidden"] : [])).joined(separator: spoken ? ", " : " · ")
    }
}

extension Date {
    /// A timestamp as the bridge writes it, with or without fractional seconds.
    init?(wire: String) {
        guard let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(wire)) ?? (try? Date.ISO8601FormatStyle().parse(wire)) else { return nil }
        self = date
    }
}
