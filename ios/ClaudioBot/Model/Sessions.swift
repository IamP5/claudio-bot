import Foundation
import Observation

enum SessionFilter: String, CaseIterable, Hashable, Sendable {
    case all, working, needsYou, unread

    var title: String {
        switch self {
        case .all: "All"
        case .working: "Working"
        case .needsYou: "Needs you"
        case .unread: "Unread"
        }
    }

    func matches(_ row: SessionRow) -> Bool {
        switch self {
        case .all: true
        case .working: row.status == .working
        case .needsYou: row.needsYou
        case .unread: row.unread
        }
    }
}

struct SessionQuery: Hashable, Sendable {
    var text = ""
    var filter = SessionFilter.all
    var showHidden = false

    var needle: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    var isNarrowed: Bool { !needle.isEmpty || filter != .all }
}

/// A top-level row and the sessions spawned from it, depth first, oldest first at each level.
struct SessionTree: Equatable, Identifiable, Sendable {
    struct Descendant: Equatable, Sendable {
        let row: SessionRow
        /// 1 for a direct child.
        let depth: Int
        /// The last row under its root, where the indent guide turns.
        let isLast: Bool
    }

    let row: SessionRow
    let descendants: [Descendant]
    var id: SessionID { row.id }

    /// A row in it needs the user or runs, so no fold may hide it.
    var isActive: Bool {
        ListOrder.Rank(row) != .rest || descendants.contains { ListOrder.Rank($0.row) != .rest }
    }
}

struct ProjectSection: Equatable, Identifiable, Sendable {
    let project: SessionProject
    /// In list order (`ListOrder`). A root sits where its highest row would, so a parent with a busy child rises.
    let trees: [SessionTree]
    var id: ProjectID { project.id }

    /// Every row the section holds, children included.
    var rows: [SessionRow] { trees.flatMap { [$0.row] + $0.descendants.map(\.row) } }
}

/// What a project header counts: every row, children included, and how many of them run or need the user.
struct SectionTally: Equatable, Sendable {
    let total: Int
    let working: Int
    let needsYou: Int

    init(_ rows: [SessionRow]) {
        total = rows.count
        working = rows.count { $0.status == .working }
        needsYou = rows.count(where: \.needsYou)
    }

    /// Offline the working count is a guess, so it is left out, as the Working chip leaves out its count. Each phrase
    /// holds together with no-break spaces, so a wrapped header never splits "4 working".
    private func parts(_ freshness: ListFreshness) -> [String] {
        [
            freshness == .live && working > 0 ? "\(working) working" : nil,
            needsYou > 0 ? "\(needsYou) \(needsYou == 1 ? "needs" : "need") you" : nil,
        ].compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }
    }

    /// "12 · 4 working · 1 needs you"
    func shown(_ freshness: ListFreshness) -> String {
        (["\(total)"] + parts(freshness)).joined(separator: " · ")
    }

    /// "12 sessions, 4 working, 1 needs you"
    func spoken(_ freshness: ListFreshness) -> String {
        (["\(total) \(total == 1 ? "session" : "sessions")"] + parts(freshness)).joined(separator: ", ")
    }
}

extension SessionRow {
    var needsYou: Bool { status == .awaitingApproval || status == .awaitingInput }
}

enum ListFreshness: Equatable, Sendable {
    case live
    case asOf(Date)

    func ageReference(now: Date) -> Date {
        switch self {
        case .live: now
        case .asOf(let date): date
        }
    }

    func visibleCounts(_ counts: [SessionFilter: Int]) -> [SessionFilter: Int] {
        guard case .asOf = self else { return counts }
        return counts.filter { $0.key != .working }
    }
}

/// Where each row sits in the list: needs you, then working, then the rest, newest first within each. A row is placed
/// when it first shows and again only when its rank changes, so a transcript write, a title rewrite or a ticking age
/// never moves it, and a status change moves only the row that changed.
struct ListOrder: Equatable, Sendable {
    enum Rank: Int, Comparable, Sendable {
        case needsYou, working, rest

        init(_ row: SessionRow) {
            self = row.needsYou ? .needsYou : row.status == .working ? .working : .rest
        }

        static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    struct Place: Comparable, Sendable {
        let rank: Rank
        /// When the run started for a working row, its last activity otherwise.
        let at: Date

        init(_ row: SessionRow) {
            rank = Rank(row)
            at = rank == .working ? row.since ?? row.lastAt : row.lastAt
        }

        /// Higher in the list first.
        static func < (a: Self, b: Self) -> Bool {
            a.rank != b.rank ? a.rank < b.rank : a.at > b.at
        }
    }

    private(set) var places: [SessionID: Place] = [:]

    func place(_ row: SessionRow) -> Place {
        places[row.id] ?? Place(row)
    }

    /// Places new rows and rows whose rank changed, and forgets rows that left. The others keep their places.
    mutating func settle(_ rows: [SessionID: SessionRow]) {
        places = rows.mapValues { row in
            if let kept = places[row.id], kept.rank == Rank(row) { kept } else { Place(row) }
        }
    }

    /// Places every row afresh, for a list the user is not looking at yet.
    mutating func resort(_ rows: [SessionID: SessionRow]) {
        places = rows.mapValues(Place.init)
    }
}

/// The Sessions list as the bridge last sent it. AppStore holds it as a `let`, so a change here re-renders the
/// sessions views only, never the bot list.
@Observable
@MainActor
final class SessionIndex {
    private(set) var projects: [ProjectID: SessionProject] = [:]
    private(set) var rows: [SessionID: SessionRow] = [:]
    private(set) var mirror: MirrorPref?
    /// When the last list frame arrived. Nil until the first one, so the list can tell loading from empty.
    private(set) var updatedAt: Date?
    private(set) var created: [String: SessionID] = [:]
    /// Bumped by every change to rows or projects. The section memo is valid for one revision.
    private(set) var revision = 0
    private(set) var order = ListOrder()
    /// The connection dropped after these rows came, and no whole list has come since, so they are last known.
    private(set) var stale = false
    @ObservationIgnored private var holding = false
    @ObservationIgnored private var memo: (revision: Int, query: SessionQuery, sections: [ProjectSection])?

    var loaded: Bool { updatedAt != nil }

    func freshness(online: Bool) -> ListFreshness {
        guard !online || stale, let updatedAt else { return .live }
        return .asOf(updatedAt)
    }

    func markStale() {
        stale = true
    }

    /// While the user scrolls, rows keep their places, and the ones whose status changed move once it comes to rest.
    func holdOrder(_ hold: Bool) {
        guard hold != holding else { return }
        holding = hold
        if !hold { reorder { $0.settle(rows) } }
    }

    /// For a list coming on screen, when no row can move under the user. A hold the last showing left behind ends here.
    func resort() {
        holding = false
        reorder { $0.resort(rows) }
    }

    private func reorder(_ change: (inout ListOrder) -> Void) {
        let before = order
        change(&order)
        if order != before { revision += 1 }
    }

    func apply(_ frame: SessionsFrame, at now: Date = .now) {
        switch frame {
        case let .list(projects, rows, mirror):
            self.projects = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            self.rows = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            self.mirror = mirror
            stale = false
        case let .changed(rows, removed, projects):
            for project in projects { self.projects[project.id] = project }
            for row in rows { self.rows[row.id] = row }
            for id in removed { self.rows[id] = nil }
        }
        if !holding { order.settle(rows) }
        updatedAt = now
        revision += 1
    }

    func recordCreated(ref: String, sessionId: SessionID) {
        created[ref] = sessionId
    }

    /// Shown at once; the bridge's next list frame confirms it.
    func setMirror(_ pref: MirrorPref) {
        mirror = pref
    }

    func reset() {
        projects = [:]
        rows = [:]
        mirror = nil
        updatedAt = nil
        created = [:]
        order = ListOrder()
        stale = false
        revision += 1
        memo = nil
    }

    func project(of row: SessionRow) -> SessionProject? {
        projects[row.projectId]
    }

    var orderedProjects: [SessionProject] {
        projects.values.sorted(by: Self.projectOrder)
    }

    var counts: [SessionFilter: Int] {
        let visible = rows.values.filter { !$0.hidden }
        return Dictionary(uniqueKeysWithValues: SessionFilter.allCases.map { filter in (filter, visible.count(where: filter.matches)) })
    }

    var hiddenCount: Int {
        rows.values.count(where: \.hidden)
    }

    /// The shown rows that need the user, so a folded project holding one can open when it first asks.
    var needingYou: Set<SessionID> {
        Set(rows.values.filter { $0.needsYou && !$0.hidden }.map(\.id))
    }

    func sections(_ query: SessionQuery) -> [ProjectSection] {
        if let memo, memo.revision == revision, memo.query == query { return memo.sections }
        let sections = Self.sections(rows: rows, projects: projects, query: query, order: order)
        memo = (revision, query, sections)
        return sections
    }

    nonisolated static func sections(
        rows: [SessionID: SessionRow], projects: [ProjectID: SessionProject], query: SessionQuery, order: ListOrder = ListOrder()
    ) -> [ProjectSection] {
        let shown = rows.values.filter { row in
            (query.showHidden || !row.hidden) && query.filter.matches(row) && matches(row, query.needle, project: projects[row.projectId])
        }
        var trees: [ProjectID: [SessionTree]] = [:]
        if query.isNarrowed {
            for row in shown { trees[row.projectId, default: []].append(SessionTree(row: row, descendants: [])) }
        } else {
            let byId = Dictionary(shown.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            var children: [SessionID: [SessionRow]] = [:]
            var roots: [SessionRow] = []
            for row in shown {
                if let parent = row.parentId, parent != row.id, let up = byId[parent], up.projectId == row.projectId {
                    children[parent, default: []].append(row)
                } else {
                    roots.append(row)
                }
            }
            for list in children.keys { children[list]?.sort { ($0.createdAt, $0.id.rawValue) < ($1.createdAt, $1.id.rawValue) } }
            for root in roots {
                var descendants: [SessionTree.Descendant] = []
                var seen: Set<SessionID> = [root.id]
                func walk(_ id: SessionID, depth: Int) {
                    for child in children[id] ?? [] where seen.insert(child.id).inserted {
                        descendants.append(SessionTree.Descendant(row: child, depth: depth, isLast: false))
                        walk(child.id, depth: depth + 1)
                    }
                }
                walk(root.id, depth: 1)
                if let last = descendants.indices.last {
                    descendants[last] = SessionTree.Descendant(row: descendants[last].row, depth: descendants[last].depth, isLast: true)
                }
                trees[root.projectId, default: []].append(SessionTree(row: root, descendants: descendants))
            }
        }
        func place(_ tree: SessionTree) -> ListOrder.Place {
            tree.descendants.map { order.place($0.row) }.reduce(order.place(tree.row), min)
        }
        return trees.compactMap { projectId, list -> (section: ProjectSection, top: ListOrder.Place)? in
            guard let project = projects[projectId] else { return nil }
            let placed = list.map { (tree: $0, place: place($0)) }
                .sorted { a, b in a.place != b.place ? a.place < b.place : a.tree.row.id.rawValue < b.tree.row.id.rawValue }
            guard let top = placed.first?.place else { return nil }
            return (ProjectSection(project: project, trees: placed.map(\.tree)), top)
        }
        .sorted { a, b in a.top != b.top ? a.top < b.top : projectOrder(a.section.project, b.section.project) }
        .map(\.section)
    }

    nonisolated private static func matches(_ row: SessionRow, _ needle: String, project: SessionProject?) -> Bool {
        guard !needle.isEmpty else { return true }
        return [row.title, project?.name ?? "", row.branch ?? ""].contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    nonisolated static func projectOrder(_ a: SessionProject, _ b: SessionProject) -> Bool {
        let (x, y) = (a.lastAt ?? .distantPast, b.lastAt ?? .distantPast)
        return x != y ? x > y : a.name.localizedStandardCompare(b.name) == .orderedAscending
    }
}

/// The status mark a row wears. Each has its own symbol, so none is color alone. Unread is not a status: a row shows
/// its unread dot beside whichever mark it wears.
enum SessionMark: Equatable, Sendable {
    case needsYou, working, lastKnownWorking, failed, unavailable, parked

    init?(_ row: SessionRow, freshness: ListFreshness = .live) {
        if row.needsYou { self = .needsYou }
        else if row.status == .working { self = freshness == .live ? .working : .lastKnownWorking }
        else if row.status == .failed { self = .failed }
        else if row.status == .unavailable { self = .unavailable }
        else if row.status == .parked { self = .parked }
        else { return nil }
    }

    var spoken: String {
        switch self {
        case .needsYou: "needs you"
        case .working: "working"
        case .lastKnownWorking: "working when last updated"
        case .failed: "failed"
        case .unavailable: "unavailable"
        case .parked: "parked"
        }
    }
}

/// A row's age, or a run's length, in the buckets the row shows, so what VoiceOver says matches what is on screen.
enum SessionAge: Equatable, Sendable {
    case now, minutes(Int), hours(Int), days(Int), date(String)

    /// A time ahead of the phone's clock, from a Mac whose clock runs ahead, reads as now.
    init(_ date: Date, now: Date, calendar: Calendar = .current) {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: self = .now
        case ..<3600: self = .minutes(Int(seconds / 60))
        case ..<86_400: self = .hours(Int(seconds / 3600))
        case ..<(7 * 86_400): self = .days(Int(seconds / 86_400))
        default:
            var style = Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()
            if calendar.component(.year, from: date) != calendar.component(.year, from: now) { style = style.year() }
            self = .date(date.formatted(style))
        }
    }

    var short: String {
        switch self {
        case .now: "now"
        case .minutes(let n): "\(n)m"
        case .hours(let n): "\(n)h"
        case .days(let n): "\(n)d"
        case .date(let text): text
        }
    }

    /// "just now", "5 minutes ago", "on Oct 3"
    var ago: String {
        switch self {
        case .now: "just now"
        case .date(let text): "on \(text)"
        default: "\(span) ago"
        }
    }

    /// How long a run has gone: "under a minute", "5 minutes".
    var span: String {
        switch self {
        case .now: "under a minute"
        case .minutes(let n): n == 1 ? "1 minute" : "\(n) minutes"
        case .hours(let n): n == 1 ? "1 hour" : "\(n) hours"
        case .days(let n): n == 1 ? "1 day" : "\(n) days"
        case .date(let text): "since \(text)"
        }
    }
}

/// The time a row shows: how long its run has gone while it works, how long since its last activity otherwise.
enum RowTime: Equatable, Sendable {
    case running(SessionAge)
    case ago(SessionAge)

    init(_ row: SessionRow, now: Date) {
        if row.status == .working, let since = row.since {
            self = .running(SessionAge(since, now: now))
        } else {
            self = .ago(SessionAge(row.lastAt, now: now))
        }
    }

    var short: String {
        switch self {
        case .running(.now): "<1m"
        case .running(let age), .ago(let age): age.short
        }
    }
}

/// The row's second line: what runs or waits while it is busy, or how its last run ended.
struct RowDetail: Equatable, Sendable {
    enum Tone: Sendable { case quiet, alarm }

    let parts: [String]
    let tone: Tone

    /// A finished run is news only until the user has seen it. A failure or a stop stays until the next send.
    init?(_ row: SessionRow) {
        if row.status == .parked {
            parts = [SessionText.parked(row.holder)]
            tone = .quiet
        } else if row.status == .working || row.needsYou {
            parts = [row.running.flatMap(SessionText.running), row.activity].compactMap { $0 }
            tone = .quiet
        } else if let outcome = row.outcome, outcome.kind != .finished || row.unread {
            parts = [outcome.text]
            tone = outcome.kind == .failed || outcome.kind == .lost ? .alarm : .quiet
        } else {
            return nil
        }
        if parts.isEmpty { return nil }
    }

    var shown: String { parts.joined(separator: " · ") }
}

enum SessionText {
    static func age(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        SessionAge(date, now: now, calendar: calendar).short
    }

    /// "3 agents, 1 command", or nil when nothing is counted.
    static func running(_ running: SessionRunning) -> String? {
        let parts = [
            running.agents > 0 ? "\(running.agents) \(running.agents == 1 ? "agent" : "agents")" : nil,
            running.commands > 0 ? "\(running.commands) \(running.commands == 1 ? "command" : "commands")" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// What the Bots side says about the sessions: ["2 working", "1 needs you"], empty when nothing runs or waits.
    static func elsewhere(_ counts: [SessionFilter: Int]) -> [String] {
        let working = counts[.working, default: 0], needs = counts[.needsYou, default: 0]
        return [working > 0 ? "\(working) working" : nil, needs > 0 ? "\(needs) \(needs == 1 ? "needs" : "need") you" : nil].compactMap { $0 }
    }

    /// What VoiceOver says once a filter or search has changed the list: "2 working sessions", "No sessions match".
    static func matches(_ count: Int, query: SessionQuery) -> String {
        let noun = count == 1 ? "session" : "sessions"
        switch query.filter {
        case .all where query.needle.isEmpty: return "\(count) \(noun)"
        case .all: return count == 0 ? "No sessions match" : "\(count) \(noun) match"
        case .working: return count == 0 ? "No working sessions" : "\(count) working \(noun)"
        case .needsYou: return count == 0 ? "No sessions need you" : "\(count) \(noun) \(count == 1 ? "needs" : "need") you"
        case .unread: return count == 0 ? "No unread sessions" : "\(count) unread \(noun)"
        }
    }

    static func updated(_ date: Date, now: Date = .now) -> String {
        guard now.timeIntervalSince(date) >= 60 else { return "Last updated just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return "Last updated \(formatter.localizedString(for: date, relativeTo: now))"
    }

    static func origin(_ origin: SessionOrigin, botName: String?) -> String {
        switch origin {
        case .phone: "started in ClaudioBot"
        case .agent: botName.map { "by \($0)'s agent" } ?? "by a bot's agent"
        case .desktop: "from the Claude app"
        case .terminal: "from a terminal"
        case .sdk: "from an SDK script"
        case .cloud: "in the cloud"
        case .unknown: ""
        }
    }

    /// Every state the row shows, in the words and time buckets it shows them: "demo, Fix the fade, working for
    /// 2 minutes, 3 agents, Run npm test, unread, from a terminal".
    static func spoken(
        _ row: SessionRow, project: String?, botName: String?, parent: String? = nil, now: Date = .now, freshness: ListFreshness = .live
    ) -> String {
        var parts = [project, row.title, parent.map { "started from \($0)" }].compactMap { $0 }
        let time = RowTime(row, now: freshness.ageReference(now: now))
        if let mark = SessionMark(row, freshness: freshness), mark != .parked {
            switch (mark, time) {
            case (.working, .running(let age)): parts.append("working for \(age.span)")
            case (.lastKnownWorking, .running(let age)): parts.append("working for \(age.span) when last updated")
            default: parts.append(mark.spoken)
            }
        }
        if let detail = RowDetail(row) { parts += detail.parts }
        if row.unread { parts.append("unread") }
        let origin = origin(row.origin, botName: botName)
        if !origin.isEmpty { parts.append(origin) }
        if let pr = row.pr { parts.append("PR \(pr.number)" + (pr.state.map { " \($0.rawValue)" } ?? "")) }
        if row.mirror == .failed { parts.append(mirrorFailed) }
        if row.hidden { parts.append("hidden") }
        if case .ago(let age) = time { parts.append(age.ago) }
        return parts.joined(separator: ", ")
    }

    static let mirrorFailed = "couldn't add to the Claude app"

    /// Why a parked session waits: another Claude Code holds it, and the phone's message runs once it lets go.
    static func parked(_ holder: SessionHolder) -> String {
        switch holder {
        case .desktop: "Waiting for the Claude app to finish"
        case .terminal: "Waiting for the terminal to finish"
        default: "Waiting for the other Claude Code to finish"
        }
    }

    static func mode(_ mode: PermissionMode) -> String {
        switch mode {
        case .default: "Ask before edits"
        case .acceptEdits: "Accept edits"
        case .plan: "Plan"
        case .dontAsk: "Don't ask"
        case .auto: "Auto"
        case .bypassPermissions: "Bypass permissions"
        case .unknown(let raw): raw
        }
    }

    static func modeSymbol(_ mode: PermissionMode) -> String {
        switch mode {
        case .default: "hand.raised"
        case .acceptEdits: "pencil.and.outline"
        case .plan: "list.bullet.clipboard"
        case .dontAsk: "checkmark.shield"
        case .auto: "sparkles"
        case .bypassPermissions, .unknown: "exclamationmark.shield"
        }
    }

    /// The modes the phone may pick, as protocol.ts's PHONE_MODES lists them.
    static let phoneModes: [PermissionMode] = [.default, .acceptEdits, .plan, .dontAsk, .auto]

    static func mirror(_ pref: MirrorPref) -> String {
        switch pref {
        case .auto: "Automatically"
        case .tap: "When I \(ThisDevice.tapVerb)"
        case .never: "Never"
        case .unknown(let raw): raw
        }
    }
}
