import Foundation

/// What a home row shows for a bot.
struct RowDisplay: Equatable {
    let preview: String
    /// The preview is the open question, drawn with a list icon.
    let previewIsQuestion: Bool
    /// The orange badge on the avatar: the bot is waiting on the user.
    let needsAttention: Bool
    let unreadDot: Bool

    init(_ bot: Bot) {
        if let question = bot.question {
            preview = question
            previewIsQuestion = true
        } else {
            preview = bot.preview
            previewIsQuestion = false
        }
        needsAttention = bot.question != nil
        unreadDot = bot.unread > 0
    }
}

/// A centered system line: plain text with tappable chips in between.
enum EventSegment: Equatable {
    case text(String)
    case chip(Peer)
}

enum EventLine {
    static func exchange(peer: Peer, sent: Int, received: Int) -> [EventSegment] {
        switch (sent, received) {
        case (1, 0): [.text("Messaged "), .chip(peer)]
        case (0, 1): [.text("Message from "), .chip(peer)]
        default: [.text("\(sent + received) messages with "), .chip(peer)]
        }
    }

    /// Replaces each `{n}` with a chip for `refs[n]`. A placeholder with no ref stays as written.
    static func note(_ text: String, refs: [Peer]) -> [EventSegment] {
        var segments: [EventSegment] = []
        var pending = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{") {
            pending += rest[..<open]
            let afterOpen = rest.index(after: open)
            guard let close = rest[afterOpen...].firstIndex(of: "}"),
                  let n = Int(rest[afterOpen..<close]), refs.indices.contains(n)
            else {
                pending += "{"
                rest = rest[afterOpen...]
                continue
            }
            if !pending.isEmpty { segments.append(.text(pending)) }
            pending = ""
            segments.append(.chip(refs[n]))
            rest = rest[rest.index(after: close)...]
        }
        pending += rest
        if !pending.isEmpty { segments.append(.text(pending)) }
        return segments
    }
}

/// A row in the chat: a message, or a centered time separator before it.
enum ChatRow: Identifiable, Equatable {
    case separator(Date)
    case message(Message)

    var id: String {
        switch self {
        case .separator(let date): "sep-\(date.timeIntervalSince1970)"
        case .message(let m): m.id.rawValue
        }
    }
}

enum Timeline {
    static let gap: TimeInterval = 60 * 60

    /// The iPhone omits the question a bubble repeats right above its card; the Mac shows it, as Grok Bot does.
    static var hidesRepeatedQuestion: Bool {
        #if os(macOS)
        false
        #else
        true
        #endif
    }

    /// A separator opens the conversation and every gap longer than an hour, counted between shown messages only.
    static func rows(_ messages: [Message], hidesRepeatedQuestion: Bool = Timeline.hidesRepeatedQuestion) -> [ChatRow] {
        var rows: [ChatRow] = []
        var last: Date?
        for (index, original) in messages.enumerated() {
            let next = messages.indices.contains(index + 1) ? messages[index + 1] : nil
            guard let message = hidesRepeatedQuestion ? withoutRepeatedQuestion(original, before: next) : original else { continue }
            if last.map({ message.at.timeIntervalSince($0) > gap }) ?? true {
                rows.append(.separator(message.at))
            }
            rows.append(.message(message))
            last = message.at
        }
        return rows
    }

    /// The bubble without a closing paragraph that restates the next card's question, or nil when nothing else is left.
    /// One bubble holds a whole message, so the restated question is usually its last paragraph.
    private static func withoutRepeatedQuestion(_ message: Message, before next: Message?) -> Message? {
        guard case let .bot(id, at, text, nil) = message, case .question(_, _, let card)? = next else { return message }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let split = body.range(of: "\n\n", options: .backwards)
        let last = split.map { String(body[$0.upperBound...]) } ?? body
        guard normalized(last) == normalized(card.question) else { return message }
        guard let split else { return nil }
        return .bot(id: id, at: at, text: String(body[..<split.lowerBound]), from: nil)
    }

    /// Bots often bold the restated question, so emphasis marks don't count.
    private static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "*_")))
            .lowercased()
    }
}

/// Paces a burst of new rows so they land one at a time. The bridge can deliver several messages in one tick (a
/// turn's held bubbles, a catch-up), and inserting them all at once reads as a jump.
struct Reveal: Equatable {
    /// Every row id the chat has taken in, shown or waiting. Until the chat has rows, whatever arrives shows at once.
    private var known: Set<String>?
    /// Rows still waiting, a beat at a time, oldest first. A separator lands with the message after it.
    private(set) var pending: [[String]] = []

    var isCaughtUp: Bool { pending.isEmpty }

    /// A longer backlog, such as a catch-up after a long time offline, shows at once rather than taking seconds.
    static let longest = 6

    /// Takes in the current timeline. A lone new message, one the user sent, or `flush` shows everything at once. A burst
    /// shows its first beat at once and the rest wait for `step()`. Applying the same rows twice changes nothing.
    mutating func update(_ rows: [ChatRow], flush: Bool = false) {
        let ids = Set(rows.map(\.id))
        guard let seen = known, !seen.isEmpty else {
            known = ids
            return
        }
        let fresh = rows.filter { !seen.contains($0.id) }
        known = ids
        let wasCaughtUp = isCaughtUp
        let beats = Self.beats(fresh)
        pending = pending.map { $0.filter(ids.contains) }.filter { !$0.isEmpty } + beats
        if flush || beats.count > Self.longest || fresh.contains(where: \.isFromUser) {
            pending = []
        } else if wasCaughtUp, !pending.isEmpty {
            pending.removeFirst()
        }
    }

    mutating func step() {
        if !pending.isEmpty { pending.removeFirst() }
    }

    mutating func flush() {
        pending = []
    }

    func visible(_ rows: [ChatRow]) -> [ChatRow] {
        let waiting = Set(pending.joined())
        return waiting.isEmpty ? rows : rows.filter { !waiting.contains($0.id) }
    }

    private static func beats(_ rows: [ChatRow]) -> [[String]] {
        var beats: [[String]] = []
        var beat: [String] = []
        for row in rows {
            beat.append(row.id)
            if case .message = row {
                beats.append(beat)
                beat = []
            }
        }
        if !beat.isEmpty { beats.append(beat) }
        return beats
    }
}

extension ChatRow {
    var isFromUser: Bool {
        if case .message(.user) = self { true } else { false }
    }
}

enum TimeLabel {
    /// Home row time: "12:14 AM" today, "Yesterday", a weekday within the week, then "Oct 9".
    static func home(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone))
        }
        if calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now) {
            return "Yesterday"
        }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        var style = Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone)
        if days < 7 && days > 0 {
            style = style.weekday(.wide)
        } else if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            style = style.month(.abbreviated).day()
        } else {
            style = style.month(.abbreviated).day().year()
        }
        return date.formatted(style)
    }

    /// Chat separator: "Today 12:14 AM", "Yesterday 8:20 AM", else "Thu, Oct 15 3:08 PM".
    static func separator(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone))
        if calendar.isDate(date, inSameDayAs: now) { return "Today \(time)" }
        if calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now) {
            return "Yesterday \(time)"
        }
        let day = date.formatted(Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated).month(.abbreviated).day())
        return "\(day) \(time)"
    }
}

enum Initials {
    /// "Alex Rivera" is "AR", "Alex" is "A".
    static func of(_ name: String) -> String {
        String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
    }
}

extension AgentStatus {
    var title: String {
        switch self {
        case .working: "Working"
        case .waiting: "Waiting"
        case .failed: "Failed"
        case .inCloud: "In cloud"
        case .awaitingApproval: "Awaiting approval"
        case .parked: "Parked"
        case .unavailable: "Unavailable"
        case .capped: "Paused at cap"
        case .unknown(let raw): raw.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

extension BotStatus {
    /// The chip a bot wears in the list and the chat. Working already shows as "Typing…".
    var chip: String? {
        switch self {
        case .awaitingApproval: "Awaiting approval"
        case .parked: "Parked"
        case .unavailable: "Unavailable"
        case .idle, .working, .unknown: nil
        }
    }
}

extension PermissionChoice {
    var button: String {
        switch self {
        case .once: "Allow once"
        case .always: "Always allow"
        case .deny: "Deny"
        case .never: "Never"
        }
    }

    var outcome: String {
        switch self {
        case .once: "Allowed once"
        case .always: "Always allowed"
        case .deny: "Denied"
        case .never: "Never allowed"
        }
    }

    /// Allow once and Always run the call; Deny and Never do not.
    var allows: Bool { self == .once || self == .always }
}

/// What a closed permission card says happened. A green check only when the call was allowed and nothing cut it short.
/// short: the same in a few words, for the one line an answered card folds to.
struct PermissionOutcome: Equatable {
    enum Tone: Equatable { case allowed, refused, failed, ended, unsure }

    let short: String
    let text: String
    let tone: Tone

    var glyph: String {
        switch tone {
        case .allowed: "checkmark.circle.fill"
        case .refused: "xmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .ended: "stop.circle"
        case .unsure: "questionmark.circle"
        }
    }
}

extension PermissionAnswer {
    /// step: the call the card held back, in a session's thread. Its end can undo what "Allowed" promised.
    func outcome(step: ToolStep? = nil) -> PermissionOutcome {
        switch self {
        case .chose(let choice) where choice.allows:
            switch step?.state {
            case .stopped?:
                PermissionOutcome(
                    short: "\(choice.outcome), then stopped",
                    text: "\(choice.outcome). \(step?.cause ?? "Stopped") before it finished.", tone: .ended
                )
            case .error?:
                PermissionOutcome(short: "\(choice.outcome), then failed", text: "\(choice.outcome). It failed.", tone: .failed)
            case .unsure?:
                PermissionOutcome(short: "\(choice.outcome) · may still run", text: "\(choice.outcome). \(ToolStep.mayStillRun).", tone: .unsure)
            case .ended?:
                PermissionOutcome(short: "\(choice.outcome) · ended, result unknown", text: "\(choice.outcome). It ended; its result is unknown.", tone: .unsure)
            default:
                PermissionOutcome(short: choice.outcome, text: choice.outcome, tone: .allowed)
            }
        case .chose(let choice):
            PermissionOutcome(short: choice.outcome, text: choice.outcome, tone: .refused)
        case .expired:
            PermissionOutcome(short: "Expired", text: "Expired. It did not run.", tone: .ended)
        case .stopped:
            PermissionOutcome(short: "Stopped by you", text: "Stopped by you. It did not run.", tone: .ended)
        case .closed:
            PermissionOutcome(short: "Closed", text: "Closed. It did not run.", tone: .ended)
        }
    }
}

/// Where a permission card was raised, which decides how far Always and Never reach.
enum ApprovalScope: Equatable, Sendable {
    /// A session's own Claude Code: Always lasts until the session ends, and Never also stops the turn.
    case session
    /// A bot's chat: Always and Never write a standing rule for the bot, and the one that asked, the bot or one of its
    /// agents, is told about Deny.
    case bot(name: String, asker: String)
    /// A bot's chat card that asks to trust a repo's own Claude Code settings.
    case trust

    static func chat(_ card: PermissionCard, bot: String) -> ApprovalScope {
        if card.isTrust { return .trust }
        if case .agent(_, let title)? = card.from { return .bot(name: bot, asker: title) }
        return .bot(name: bot, asker: bot)
    }
}

extension PermissionCard {
    /// The bridge's trust card is the only one with this tool name (gate.ts `trustCard`).
    var isTrust: Bool { tool == "Claude Code settings" }

    /// The choices the card offers. Without an Always text the bridge offers no Always: it would only allow once.
    var choices: [PermissionChoice] {
        always.isEmpty ? [.once, .deny, .never] : [.once, .always, .deny, .never]
    }

    /// The command's first line, at most 60 characters, for a spoken label.
    var commandHead: String {
        let line = detail.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? detail
        return line.count > 60 ? "\(line.prefix(59))…" : line
    }

    /// What Always would cover and for how long, read before the buttons. nil when the card offers no Always.
    func scopeLine(_ scope: ApprovalScope) -> String? {
        guard !always.isEmpty else { return nil }
        return switch scope {
        case .session: "For the rest of this session, Always allow covers \(always)."
        case .bot: "From now on, Always allow covers \(always)."
        case .trust: "Always allow: \(always)."
        }
    }

    /// What VoiceOver says for a choice: the choice, then the tool and the command it decides.
    func spokenLabel(_ choice: PermissionChoice) -> String {
        "\(choice.button), \(tool) \(commandHead)"
    }
}

extension PermissionChoice {
    /// One line on what the choice does, shown under its button and spoken as its hint.
    func consequence(_ scope: ApprovalScope) -> String {
        switch (self, scope) {
        case (.once, .trust): "Trusts it for this agent only."
        case (.once, _): "Runs this call only."
        case (.always, .session): "Runs it, then stops asking about these this session."
        case (.always, .bot): "Runs it, then stops asking about it."
        case (.always, .trust): "Trusts it for every agent in this repo."
        case (.deny, .session): "Skips it. Claude carries on and may ask again."
        case (.deny, .bot(_, let asker)): "Skips it and tells \(asker) not to try it."
        case (.deny, .trust): "Keeps this agent on empty settings."
        case (.never, .session): "Skips it and stops the turn."
        case (.never, .bot(let name, _)): "Skips it and refuses it for \(name) from now on."
        case (.never, .trust): "Keeps every agent in this repo on empty settings."
        }
    }
}

extension PermissionAnswer {
    /// What VoiceOver hears when an open card closes: who closed it when it was not this device, the outcome, whether
    /// the tool ran, and the command: "Expired. Bash did not run: perl -e 'sleep 45'".
    func announcement(card: PermissionCard, step: ToolStep? = nil, here: Bool) -> String {
        let outcome = outcome(step: step)
        let allowed = if case .chose(let choice) = self { choice.allows } else { false }
        let result = switch (allowed, card.isTrust) {
        case (true, false): "\(outcome.text.trimmingCharacters(in: CharacterSet(charactersIn: "."))). \(card.tool)"
        case (false, false): "\(outcome.short). \(card.tool) did not run"
        case (true, true): "\(outcome.short). Trusted"
        case (false, true): "\(outcome.short). Nothing was trusted"
        }
        let elsewhere = if case .chose = self, !here { "Answered on another device. " } else { "" }
        return "\(elsewhere)\(result): \(card.commandHead)"
    }
}

extension SessionPermission {
    /// "sleeper two wants to run Bash" when a subagent asked, else the card's own label.
    var title: String {
        subagent.map { "\($0) wants to run \(card.tool)" } ?? card.label
    }

    /// Who asked, in the one line a folded card keeps: the subagent, or the tool when the main thread asked.
    var asker: String { subagent ?? card.tool }
}

extension RunStatus {
    var title: String {
        switch self {
        case .running: "Running"
        case .ok: "Done"
        case .quiet: "Nothing to report"
        case .failed: "Failed"
        case .skipped: "Skipped"
        case .unknown(let raw): raw.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

extension RoutineRun {
    /// "Late" and "Run now" tags, in that order.
    var tags: [String] {
        (late ? ["Late"] : []) + (manual ? ["Run now"] : [])
    }
}

enum Library {
    struct Group: Equatable {
        let title: String
        let files: [LibraryFile]
    }

    /// "This week" for the last seven days, "Earlier" for the rest, newest first, empty groups dropped.
    static func groups(_ files: [LibraryFile], now: Date = .now) -> [Group] {
        let sorted = files.sorted { $0.modifiedAt > $1.modifiedAt }
        let cutoff = now.addingTimeInterval(-7 * 24 * 60 * 60)
        return [
            Group(title: "This week", files: sorted.filter { $0.modifiedAt >= cutoff }),
            Group(title: "Earlier", files: sorted.filter { $0.modifiedAt < cutoff }),
        ].filter { !$0.files.isEmpty }
    }
}
