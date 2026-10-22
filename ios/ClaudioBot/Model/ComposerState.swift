import Foundation

/// A queued message the user took back, from the tap until the bridge drops it or refuses (F-SES-040).
struct Withdrawal: Equatable, Sendable {
    /// As long as a Stop waits before it says it is unconfirmed.
    static let patience = StopRequest.patience
    let at: Date
    /// Its text went to the composer.
    let edited: Bool
    /// No word from the Mac within the patience: the message may still be queued.
    var lapsed = false
}

/// What the composer's Stop ends (P-A11Y-2): the turn, if one runs, and every live task.
struct StopScope: Equatable, Sendable {
    let turn: Bool
    private(set) var tasks: [SessionTask]

    init(_ controls: SessionControls) {
        turn = controls.turn != nil || controls.tasks == nil
        tasks = controls.tasks ?? []
    }

    /// What a stop asked for ends, as against all that runs: the turn alone takes only its own subagents with it.
    init(_ controls: SessionControls, target: StopTarget) {
        self.init(controls)
        if target == .turn { tasks = tasks.filter { !$0.background } }
    }

    var background: [SessionTask] { tasks.filter(\.background) }

    /// Background work would end with this Stop, so it asks first (P-STOP-3). A turn and its subagents stop at once.
    var asks: Bool { !background.isEmpty }

    /// "the turn, 2 agents and 1 command", "1 command".
    var what: String {
        let parts = (turn ? ["the turn"] : []) + (ThreadStatus.nouns(tasks).map { $0.components(separatedBy: ", ") } ?? [])
        return Self.listed(parts.isEmpty ? ["Claude"] : parts)
    }

    /// The control's spoken label: "Stop the turn, 2 agents and 1 command".
    var label: String { "Stop " + what }

    /// "sleep 75", "sleep 75 and sleeper two", "3 background tasks".
    var backgroundWhat: String {
        let work = background
        return work.count <= 2 ? Self.listed(work.map { OpenCard.firstLine($0.label, limit: 40) ?? $0.label }) : "\(work.count) background tasks"
    }

    static func listed(_ parts: [String]) -> String {
        switch parts.count {
        case 0: ""
        case 1: parts[0]
        default: parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1]
        }
    }
}

/// A Stop this phone asked for, from the tap until the Mac shows it took effect or says it did not (P-STOP-4).
struct StopRequest: Equatable, Sendable {
    enum State: Equatable, Sendable {
        case pending
        case confirmed
        /// The Mac's refusal, in its words: "Claude Code did not stop sleep 75."
        case refused(String)
    }

    let target: StopTarget
    let turnStartedAt: String?
    /// The tasks live when the stop was asked for. A stop of everything has landed once none of them is left.
    var tasks: Set<TaskID> = []
    let at: Date
    var state = State.pending

    /// How long a stop may stay unconfirmed before the control offers to stop again.
    static let patience: TimeInterval = 10

    /// The run on screen is still the one this stop was aimed at: no newer turn has started since. Stop again may only
    /// retry it while that holds; a newer turn goes through Stop and its confirmation like any other.
    func covers(_ controls: SessionControls) -> Bool {
        controls.turn == nil || controls.turn?.startedAt == turnStartedAt
    }

    /// The work this stop was aimed at no longer runs. A wake turn that starts after it is new work, not this stop's.
    func landed(in controls: SessionControls) -> Bool {
        let turnEnded = turnStartedAt == nil || controls.turn?.startedAt != turnStartedAt
        switch target {
        case .all:
            guard let live = controls.tasks else { return !controls.working }
            return turnEnded && tasks.isDisjoint(with: live.map(\.id))
        case .turn: return controls.turn == nil || turnEnded
        case .task(let id): return controls.tasks.map { !$0.contains { $0.id == id } } ?? !controls.working
        }
    }
}

/// What the composer shows for a stop at one moment.
enum StopPhase: Equatable, Sendable {
    case ready
    case stopping
    /// No word from the Mac within `StopRequest.patience`: it may not have stopped.
    case unconfirmed
    case refused(String)

    init(_ request: StopRequest?, at now: Date) {
        guard let request else { self = .ready; return }
        switch request.state {
        case .confirmed: self = .ready
        case .refused(let why): self = .refused(why)
        case .pending: self = now.timeIntervalSince(request.at) >= StopRequest.patience ? .unconfirmed : .stopping
        }
    }

    var retries: Bool {
        switch self {
        case .unconfirmed, .refused: true
        case .ready, .stopping: false
        }
    }
}

/// A model or mode change this phone asked for, until controls show the new value or the Mac refuses it (F-SES-140).
struct SetRequest: Equatable, Sendable {
    enum Change: Equatable, Sendable {
        case model(id: String, label: String)
        case mode(PermissionMode)
    }

    let change: Change
    let at: Date

    /// A change that neither lands nor is refused reads as not confirmed after this long.
    static let patience: TimeInterval = 15

    func landed(in controls: SessionControls) -> Bool {
        switch change {
        case .model(let id, _): controls.model == id
        case .mode(let mode): controls.mode == mode
        }
    }

    private var field: String {
        if case .model = change { "model" } else { "mode" }
    }

    private var target: String {
        switch change {
        case .model(_, let label): label
        case .mode(let mode): SessionText.mode(mode)
        }
    }

    /// "Changing the mode to Accept edits…".
    var line: String { "Changing the \(field) to \(target)…" }

    /// The change took too long: what still runs. kept: the value the controls show.
    func unconfirmed(kept: String) -> String {
        "Claude Code has not taken the change to \(target) yet. The \(field) stays \(kept)."
    }

    /// Spoken once the controls carry it.
    var landedLine: String { "The \(field) is now \(target)." }

    /// The value the controls show for this change's field.
    func kept(_ controls: SessionControls) -> String {
        if case .model = change { controls.modelLabel } else { SessionText.mode(controls.mode) }
    }
}

/// A session request the Mac refused, shown under that session's composer instead of as a toast.
/// text: "Couldn't stop. Claude Code did not stop sleep 75.", "The mode stays Ask before edits. Claude Code did not take the change: …".
struct SessionError: Equatable, Sendable, Identifiable {
    enum Kind: Equatable, Sendable { case stop, set, send }

    let id = UUID()
    let kind: Kind
    let text: String
}

extension SessionControls {
    /// The chip's short name: "Default (Opus 5.5)" reads "Default"; the menu keeps the whole label.
    var modelLabel: String {
        let id = model ?? models.first?.id
        let label = models.first { $0.id == id }?.label ?? model ?? "Model"
        return label.replacing(/\s*\(.*\)$/, with: "")
    }
}

/// The composer's controls at one moment: the slot at the end of the field and the Stop beside it. The slot is always
/// drawn, so a VoiceOver user's focus keeps its place from Send to Sent to Stop (F-SES-146).
struct ComposerState: Equatable, Sendable {
    enum Send: Equatable, Sendable {
        /// No draft: Send is drawn but does nothing.
        case empty
        /// No turn runs, so the message goes now. Background work alone does not hold it.
        case now
        /// A turn runs, so the message waits for it. Held, the control offers Stop turn and send.
        case queue
        /// The draft just went. It reads Sent until work starts or the field changes.
        case sent(queued: Bool)
    }

    enum Slot: Equatable, Sendable {
        case send(Send)
        case stop(StopScope, StopPhase)
    }

    let send: Send
    /// nil while nothing runs, or for a session this phone cannot stop.
    let stop: (scope: StopScope, phase: StopPhase)?

    /// lastSend: when the field was last sent, and whether it queued. stop: the newest stop this phone asked for.
    init(controls: SessionControls?, hasText: Bool, canStop: Bool, lastSend: (at: Date, queued: Bool)?, stop: StopRequest?, now: Date) {
        let queues = Self.queues(controls)
        if hasText {
            send = queues ? .queue : .now
        } else if let lastSend, now.timeIntervalSince(lastSend.at) < Self.sentShown {
            send = .sent(queued: lastSend.queued)
        } else {
            send = .empty
        }
        if let controls, controls.working, canStop {
            let request = stop.flatMap { $0.covers(controls) ? $0 : nil }
            let phase = StopPhase(request, at: now)
            // While a stop is on its way or refused, the control speaks of what that stop asked for.
            let scope = phase == .ready ? StopScope(controls) : StopScope(controls, target: request?.target ?? .all)
            self.stop = (scope, phase)
        } else {
            self.stop = nil
        }
    }

    static func == (a: Self, b: Self) -> Bool {
        a.send == b.send && a.stop?.scope == b.stop?.scope && a.stop?.phase == b.stop?.phase
    }

    /// How long Sent stays in the slot when no work starts.
    static let sentShown: TimeInterval = 4

    /// A message waits only behind a turn. A bridge without tasks says only that work runs, which is the turn.
    static func queues(_ controls: SessionControls?) -> Bool {
        guard let controls else { return false }
        return controls.tasks == nil ? controls.working : controls.turn != nil
    }

    var slot: Slot {
        if let stop, !send.drafts { return .stop(stop.scope, stop.phase) }
        return .send(send)
    }

    /// A draft waits while work runs, so Stop gets a control of its own beside Send (F-SES-093).
    var stopBeside: (scope: StopScope, phase: StopPhase)? {
        send.drafts ? stop : nil
    }

    /// What Send says it does, for the field's label and the placeholder (F-SES-088).
    static func placeholder(_ controls: SessionControls?) -> String {
        queues(controls) ? "Queue a message" : "Message Claude"
    }

    static func fieldLabel(_ controls: SessionControls?) -> String {
        queues(controls) ? "Message, waits for the current turn" : "Message"
    }

    /// Spoken once Send lands (F-SES-146).
    static func sentAnnouncement(queued: Bool, interrupt: Bool = false) -> String {
        interrupt ? "Stopping the turn. Your message goes next." : queued ? "Queued behind the current turn." : "Sent."
    }

    /// The stop's progress, spoken. The outcome itself is the status line's (StatusAnnouncer), so success says nothing.
    static func announcement(_ phase: StopPhase, _ scope: StopScope) -> String? {
        switch phase {
        case .ready: nil
        case .stopping: "Stopping \(scope.what)."
        case .unconfirmed: "Your Mac has not confirmed the stop. Stop again to retry."
        case .refused(let why): "Couldn't stop. " + why
        }
    }

    /// "1 message queued", "2 messages queued" (F-SES-083).
    static func queuedLabel(_ count: Int) -> String {
        WorkSummary.plural(count, "message") + " queued"
    }
}

extension ComposerState.Send {
    var drafts: Bool {
        switch self {
        case .now, .queue: true
        case .empty, .sent: false
        }
    }
}

extension ComposerState.Slot {
    /// Whether a tap does anything. A slot that does not still holds VoiceOver's focus, dimmed.
    var acts: Bool {
        switch self {
        case .send(.now), .send(.queue): true
        case .send(.empty), .send(.sent): false
        case .stop(_, .stopping): false
        case .stop: true
        }
    }

    /// A stop on its way shows a spinner in place of its glyph.
    var spins: Bool {
        if case .stop(_, .stopping) = self { true } else { false }
    }

    var symbol: String {
        switch self {
        case .send(.sent): "checkmark"
        case .send: "arrow.up"
        case .stop: "stop.fill"
        }
    }

    var label: String {
        switch self {
        case .send(.empty), .send(.now): "Send"
        case .send(.queue): "Queue message"
        case .send(.sent(let queued)): queued ? "Queued" : "Sent"
        case .stop(let scope, .ready): scope.label
        case .stop(let scope, .stopping): "Stopping \(scope.what)"
        case .stop(let scope, .unconfirmed), .stop(let scope, .refused): "Stop again: \(scope.what)"
        }
    }

    var hint: String? {
        switch self {
        case .send(.queue): "Sends when the current turn ends. Hold for Stop turn and send."
        case .stop(let scope, .ready): scope.asks ? "Asks before it stops background work." : nil
        case .stop(_, .unconfirmed): "Your Mac has not confirmed the stop."
        case .stop(_, .refused(let why)): why
        case .send, .stop(_, .stopping): nil
        }
    }
}

extension StopScope {
    /// The confirmation's title, when background work would end too (P-STOP-3).
    var confirmTitle: String {
        turn ? "Stop background work too?" : "Stop background work?"
    }

    /// queued: messages that wait for the turn. They survive a stop and run next.
    func confirmMessage(queued: Int) -> String {
        let keeps = background.count == 1 ? "keeps" : "keep"
        let work = turn ? "\(backgroundWhat) \(keeps) running in the background unless you stop everything." : "This stops \(backgroundWhat)."
        guard queued > 0 else { return work }
        return work + " " + (queued == 1 ? "Your queued message still runs." : "Your \(queued) queued messages still run.")
    }

    var confirmAll: String {
        turn ? "Stop everything" : "Stop \(backgroundWhat)"
    }
}

/// The one line under the composer: what the Mac refused, a stop on its way or unconfirmed, or a change in flight.
enum ComposerNote: Equatable, Sendable {
    case error(SessionError)
    case stopping(StopScope)
    case unconfirmed
    case changing(SetRequest)
    /// The change took longer than SetRequest.patience. text: what still runs.
    case changeUnconfirmed(SetRequest, text: String)

    static func of(
        error: SessionError?, stop: (scope: StopScope, phase: StopPhase)?, set: SetRequest?, controls: SessionControls?, now: Date
    ) -> ComposerNote? {
        if let error { return .error(error) }
        if let stop, stop.phase == .stopping { return .stopping(stop.scope) }
        if stop?.phase == .unconfirmed { return .unconfirmed }
        guard let set else { return nil }
        if now.timeIntervalSince(set.at) < SetRequest.patience { return .changing(set) }
        return controls.map { .changeUnconfirmed(set, text: set.unconfirmed(kept: set.kept($0))) }
    }

    var text: String {
        switch self {
        case .error(let error): error.text
        case .stopping(let scope): "Stopping \(scope.what)…"
        case .unconfirmed: "Your Mac has not confirmed the stop. It may still be running."
        case .changing(let set): set.line
        case .changeUnconfirmed(_, let text): text
        }
    }

    /// P-A11Y-1: an error says so in words, not only in red.
    var spoken: String {
        if case .error = self { "Error: " + text } else { text }
    }
}

/// The user's prompts in a thread that a stop ended before Claude answered, so they can be edited and sent again
/// (F-SES-143): a prompt with a stop notice after it and no reply, step or thinking before the next prompt. A refusal
/// to stop is not a stop. turnRuns: the newest prompt may still get its reply, so it does not count yet.
enum UnansweredPrompts {
    static func of(_ items: [SessionItem], turnRuns: Bool) -> Set<ItemID> {
        var found: Set<ItemID> = []
        var open: ItemID?
        var stopped = false
        func close() {
            if let open, stopped { found.insert(open) }
        }
        for item in items {
            switch item {
            case .user(_, _, _, .system, _):
                continue
            case let .user(id, _, _, from, queued):
                close()
                open = from == .user && !queued ? id : nil
                stopped = false
            case let .notice(_, _, _, tone, .stop?):
                if tone != .error { stopped = true }
            case .assistant, .work, .thinking, .plan, .ask, .todo:
                open = nil
            case .permission, .notice, .compaction, .unknown:
                continue
            }
        }
        if !turnRuns { close() }
        return found
    }
}

/// How much the thread's bottom bar shows, from the height it has (not from the keyboard or the text size, so a
/// hardware keyboard, an iPad's floating keyboard and a thread opened with the keyboard up all fit the same way). Each
/// level gives up a little more: the chips' words, then the status line's extra lines, then the note's, then the field's.
enum BarDensity: Int, Comparable, CaseIterable, Sendable {
    case full, iconChips, oneLineStatus, shortNote, shortField

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    var next: BarDensity? { BarDensity(rawValue: rawValue + 1) }

    var previous: BarDensity? { BarDensity(rawValue: rawValue - 1) }

    var chipWords: Bool { self < .iconChips }

    var statusLines: Int { self < .oneLineStatus ? 3 : 1 }

    /// The note's lines before More: fewer at accessibility sizes, where each line is tall.
    func noteLines(accessibility: Bool) -> Int {
        self >= .shortNote ? 1 : accessibility ? 2 : 3
    }

    /// The lines the field shows before it scrolls.
    func fieldLines(accessibility: Bool) -> Int {
        self < .shortField ? (accessibility ? 2 : 6) : (accessibility ? 1 : 3)
    }
}

/// Picks the density that fits the room the screen leaves the bar. While the rows need more than the room, it climbs
/// one level per measurement. While they fit, it tries the level below, unless that level already needed more than
/// this room. What each level needed is forgotten when the room or the rows change (the keyboard went down, a note
/// went away), so the bar opens back up step by step, and it cannot swing between two levels at a room that stays.
struct BarFit: Equatable, Sendable {
    private(set) var density = BarDensity.full
    /// What the rows needed at each level, at this room.
    private var needs: [BarDensity: CGFloat] = [:]
    private var room: CGFloat = 0

    /// content: what the bar's rows need. room: the most the screen gives the bar.
    mutating func measured(content: CGFloat, room: CGFloat) {
        guard content > 0, room > 0 else { return }
        if abs(room - self.room) > 1 || needs[density].map({ abs($0 - content) > 1 }) == true { needs = [:] }
        self.room = room
        needs[density] = content
        if content > room + 0.5 {
            if let next = density.next { density = next }
        } else if let previous = density.previous, needs[previous].map({ $0 <= room + 0.5 }) ?? true {
            density = previous
        }
    }
}
