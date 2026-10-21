import Foundation

/// The newest card in a thread that waits on the user, as the status line shows it and VoiceOver announces it.
struct OpenCard: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case permission, ask, plan }

    let id: ItemID
    let kind: Kind
    /// "Needs your approval: Bash in sleeper two".
    let line: String
    /// "Approval needed. sleeper two wants to run Bash: perl -e 'sleep 30'".
    let announcement: String
    /// When the card stops counting as open without a frame saying so.
    let expiresAt: Date?

    /// A permission card whose deadline passed is no longer open, so it no longer hides the run's state.
    static func newest(in items: [SessionItem], at now: Date) -> OpenCard? {
        for item in items.reversed() {
            switch item {
            case let .permission(id, _, permission) where permission.card.answer(at: now) == nil:
                let card = permission.card
                let who = permission.subagent.map { " in \($0)" } ?? ""
                let asker = permission.subagent ?? "Claude"
                return OpenCard(
                    id: id, kind: .permission, line: "Needs your approval: \(card.tool)\(who)",
                    announcement: "Approval needed. \(asker) wants to run \(card.tool)" + (Self.firstLine(card.detail).map { ": " + $0 } ?? "."),
                    expiresAt: card.expiresAt
                )
            case let .ask(id, _, questions, nil, _?):
                let first = questions.first?.question ?? ""
                return OpenCard(
                    id: id, kind: .ask,
                    line: questions.count == 1 ? "Claude asks you a question" : "Claude asks you \(questions.count) questions",
                    announcement: questions.count == 1 ? "Question: \(first)" : "\(questions.count) questions. First: \(first)",
                    expiresAt: nil
                )
            case let .plan(id, _, text, .proposed, _?):
                return OpenCard(
                    id: id, kind: .plan, line: "A plan needs your approval",
                    announcement: "Plan ready for your approval" + (Self.heading(text).map { ": " + $0 } ?? "."),
                    expiresAt: nil
                )
            default:
                continue
            }
        }
        return nil
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

/// The thread's one status line (P-STATE-5). The highest level that holds wins: a dead socket never shows a live
/// clock, and a run held by a card never reads as busy.
enum ThreadStatus: Equatable, Sendable {
    /// The Mac is out of reach. lastUpdate: when the app last heard from it; nil when this thread never loaded.
    case offline(Reach, lastUpdate: Date?)
    /// The socket is up, but the Mac has sent nothing for a while although this thread works.
    case quiet(since: Date)
    case needsYou(OpenCard)
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
        since: Date?, outcome: SessionOutcome?
    ) -> ThreadStatus? {
        switch reach {
        case .connected, .unpaired: break
        case .firstConnect, .unreachable, .retrying, .unrecognized: return .offline(reach, lastUpdate: lastUpdate)
        }
        let working = controls?.working ?? false
        if working, let quietSince { return .quiet(since: quietSince) }
        if let card { return .needsYou(card) }
        let tasks = controls?.tasks ?? []
        if let turn = controls?.turn { return .working(since: Date(wire: turn.startedAt), tasks: tasks) }
        if let start = tasks.map(\.startedAt).min() { return .background(since: start, tasks: tasks) }
        if working { return .working(since: since, tasks: []) }
        if let outcome, outcome.kind != .finished { return .ended(outcome) }
        return nil
    }

    /// Where running marks stop and dim: the last moment the thread's state was known true.
    var staleAt: Date? {
        switch self {
        case .offline(_, let lastUpdate): lastUpdate
        case .quiet(let since): since
        case .needsYou, .working, .background, .ended: nil
        }
    }

    var tasks: [SessionTask] {
        switch self {
        case .working(_, let tasks), .background(_, let tasks): tasks
        case .offline, .quiet, .needsYou, .ended: []
        }
    }

    /// The thread header's state, in one or two words.
    var word: String {
        switch self {
        case .offline(.firstConnect, _): "Connecting"
        case .offline: "Offline"
        case .quiet: "No word from your Mac"
        case .needsYou(let card): card.kind == .ask ? "Needs your answer" : "Needs your approval"
        case .working: "Working"
        case .background: "Running in background"
        case .ended(let outcome): Self.word(outcome.kind)
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
        line(now: now, cause: cause, clock: RunClock.short)
    }

    /// The line as VoiceOver reads it: whole words for times.
    func spoken(now: Date, cause: String = "") -> String {
        line(now: now, cause: cause, clock: RunClock.spoken)
    }

    private func line(now: Date, cause: String, clock: (TimeInterval) -> String) -> String {
        switch self {
        case let .offline(reach, lastUpdate):
            let head = reach == .firstConnect ? "Connecting to your Mac…" : cause
            guard let lastUpdate else { return head + " This session loads when your Mac is back." }
            return head + " Last update \(clock(now.timeIntervalSince(lastUpdate))) ago."
        case .quiet(let since):
            return "No word from your Mac for \(clock(now.timeIntervalSince(since)))"
        case .needsYou(let card):
            return card.line
        case let .working(since, tasks):
            let what = Self.nouns(tasks)
            return ["Working" + (since.map { " " + clock(now.timeIntervalSince($0)) } ?? ""), what].compactMap { $0 }.joined(separator: " · ")
        case let .background(since, tasks):
            // One task is named, cut short so the clock stays in view. The sheet has the whole label.
            let what = tasks.count == 1 ? OpenCard.firstLine(tasks[0].label, limit: 40) ?? "" : Self.nouns(tasks) ?? ""
            return "Running in background: \(what) · " + clock(now.timeIntervalSince(since))
        case .ended(let outcome):
            return Self.outcome(outcome)
        }
    }

    /// A run that failed or was cut off says how to go on.
    static func outcome(_ outcome: SessionOutcome) -> String {
        switch outcome.kind {
        case .failed, .lost: outcome.text + (outcome.text.hasSuffix(".") ? "" : ".") + " Send a message to start it again."
        case .stopped, .finished, .unknown: outcome.text
        }
    }

    /// "3 agents", "2 agents, 1 command"; nil for none.
    static func nouns(_ tasks: [SessionTask]) -> String? {
        var counts: [(noun: String, n: Int)] = []
        for task in tasks {
            let noun = switch task.kind {
            case .agent: "agent"
            case .command: "command"
            case .other, .unknown: "task"
            }
            if let at = counts.firstIndex(where: { $0.noun == noun }) { counts[at].n += 1 } else { counts.append((noun, 1)) }
        }
        return counts.isEmpty ? nil : counts.map { WorkSummary.plural($0.n, $0.noun) }.joined(separator: ", ")
    }
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
        case .quiet: "quiet"
        case .needsYou(let card): "card " + card.id.rawValue
        case .working(_, let tasks): "working " + tasks.map(\.id.rawValue).joined(separator: " ")
        case .background(_, let tasks): "background " + tasks.map(\.id.rawValue).joined(separator: " ")
        case .ended(let outcome): "ended \(outcome.kind.rawValue) \(outcome.at.timeIntervalSince1970)"
        }
    }

    /// heard: the last card spoken in this thread.
    /// cardClosed: the run came to rest from an open card, whose close the card spoke itself.
    static func of(from old: ThreadStatus?, to new: ThreadStatus?, first: Bool = false, heard: ItemID? = nil, cardClosed: Bool = false) -> String? {
        if case .needsYou(let card) = new {
            return first || card.id != heard ? card.announcement : nil
        }
        guard !first, old != new else { return nil }
        switch old {
        case .offline, .quiet, .ended:
            return nil
        case nil:
            // The row brings the outcome after the thread's frame put it at rest, later than StatusAnnouncer waited.
            if case .ended(let outcome) = new, !(cardClosed && outcome.kind == .stopped) { return ThreadStatus.outcome(outcome) }
            return nil
        case .needsYou:
            // Stop closes the open card, and the card says so itself (ChatItems announcesClose).
            if case .ended(let outcome) = new, outcome.kind != .stopped { return ThreadStatus.outcome(outcome) }
            return nil
        case let .working(_, was), let .background(_, was):
            switch new {
            case nil:
                if case .working = old { return "Claude finished." }
                return "Background work ended: " + labels(was) + "."
            case .ended(let outcome):
                return ThreadStatus.outcome(outcome)
            case .background(_, let now):
                if case .working = old { return "Claude finished its turn. Still running in background: " + labels(now) + "." }
                return ended(was, now)
            case .working(_, let now):
                return ended(was, now)
            case .offline, .quiet, .needsYou:
                return nil
            }
        }
    }

    /// Background tasks that were live and are gone. Subagents of the turn come and go too often to speak each one.
    private static func ended(_ was: [SessionTask], _ now: [SessionTask]) -> String? {
        let live = Set(now.map(\.id))
        let gone = was.filter { $0.background && !live.contains($0.id) }
        return gone.isEmpty ? nil : "Ended in background: " + labels(gone) + "."
    }

    private static func labels(_ tasks: [SessionTask]) -> String {
        tasks.map(\.label).joined(separator: ", ")
    }
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
    private var spoken: ThreadStatus?
    private var once = false
    private var heardCard: ItemID?
    /// The last run came to rest from an open card. A Stop closes the card, and the card says so itself.
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
        case .working, .background, .needsYou: true
        default: false
        }
        let wait = status == nil && live ? rest : settle
        pending = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            self?.land(status)
        }
    }

    private func land(_ status: ThreadStatus?) {
        let first = !once
        if let text = ThreadAnnouncement.of(from: spoken, to: status, first: first, heard: heardCard, cardClosed: cardClosed) {
            speak(text, first)
        }
        switch status {
        case .needsYou(let card):
            heardCard = card.id
            cardClosed = false
        case .working, .background:
            cardClosed = false
        case nil, .ended, .offline, .quiet:
            if case .needsYou = spoken { cardClosed = true }
        }
        spoken = status
        once = true
    }
}

/// Sessions other than the one on screen that run or wait on the user, for a layout that hides the list.
struct SessionsAtWork: Equatable {
    let needsYou: [SessionRow]
    let working: [SessionRow]

    init(_ rows: some Sequence<SessionRow>, excluding: SessionID? = nil) {
        let shown = rows.filter { $0.id != excluding && !$0.hidden }.sorted { $0.lastAt > $1.lastAt }
        needsYou = shown.filter { $0.status == .awaitingApproval || $0.status == .awaitingInput }
        working = shown.filter { $0.status == .working }
    }

    var isEmpty: Bool { needsYou.isEmpty && working.isEmpty }

    /// "2 working · 1 needs you".
    var summary: String? {
        let parts = [working.isEmpty ? nil : "\(working.count) working", needsYou.isEmpty ? nil : "\(needsYou.count) need\(needsYou.count == 1 ? "s" : "") you"]
        let text = parts.compactMap { $0 }.joined(separator: " · ")
        return text.isEmpty ? nil : text
    }
}

extension Date {
    /// A timestamp as the bridge writes it, with or without fractional seconds.
    init?(wire: String) {
        guard let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(wire)) ?? (try? Date.ISO8601FormatStyle().parse(wire)) else { return nil }
        self = date
    }
}
