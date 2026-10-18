import Foundation
import Observation

/// The quick filters above the Sessions list.
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

/// What the user typed and picked above the list. Narrowed lists show every match flat, without nesting or "Show more".
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
}

/// One project's rows as the list shows them.
struct ProjectSection: Equatable, Identifiable, Sendable {
    let project: SessionProject
    /// Newest activity first. A root's activity includes its descendants', so a parent with a busy child rises.
    let trees: [SessionTree]
    var id: ProjectID { project.id }
}

extension SessionRow {
    /// An approval, plan or question waits on the user.
    var needsYou: Bool { status == .awaitingApproval || status == .awaitingInput }
}

/// The Sessions list as the bridge last sent it. AppStore holds it as a `let`, so a change here re-renders the
/// sessions views only, never the bot list.
@Observable
@MainActor
final class SessionIndex {
    private(set) var projects: [ProjectID: SessionProject] = [:]
    private(set) var rows: [SessionID: SessionRow] = [:]
    /// The "Show agent sessions in the Claude app" setting, from the last list frame.
    private(set) var mirror: MirrorPref?
    /// When the last list frame arrived. Nil until the first one, so the list can tell loading from empty.
    private(set) var updatedAt: Date?
    /// The session each `session_create` ref became, so the sheet that asked can open it.
    private(set) var created: [String: SessionID] = [:]
    /// Bumped by every change to rows or projects. The section memo is valid for one revision.
    private(set) var revision = 0
    @ObservationIgnored private var memo: (revision: Int, query: SessionQuery, sections: [ProjectSection])?

    var loaded: Bool { updatedAt != nil }

    func apply(_ frame: SessionsFrame, at now: Date = .now) {
        switch frame {
        case let .list(projects, rows, mirror):
            self.projects = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            self.rows = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            self.mirror = mirror
        case let .changed(rows, removed, projects):
            for project in projects { self.projects[project.id] = project }
            for row in rows { self.rows[row.id] = row }
            for id in removed { self.rows[id] = nil }
        }
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
        revision += 1
        memo = nil
    }

    func project(of row: SessionRow) -> SessionProject? {
        projects[row.projectId]
    }

    /// Every project, newest activity first, for the new-session picker.
    var orderedProjects: [SessionProject] {
        projects.values.sorted(by: Self.projectOrder)
    }

    /// Visible rows per filter, for the chips' counts.
    var counts: [SessionFilter: Int] {
        let visible = rows.values.filter { !$0.hidden }
        return Dictionary(uniqueKeysWithValues: SessionFilter.allCases.map { filter in (filter, visible.count(where: filter.matches)) })
    }

    var hiddenCount: Int {
        rows.values.count(where: \.hidden)
    }

    /// Computed once per revision and query, so a body that asks twice pays once.
    func sections(_ query: SessionQuery) -> [ProjectSection] {
        if let memo, memo.revision == revision, memo.query == query { return memo.sections }
        let sections = Self.sections(rows: rows, projects: projects, query: query)
        memo = (revision, query, sections)
        return sections
    }

    /// The pure rule behind the list: which rows show, under which project, nested how, in what order.
    nonisolated static func sections(rows: [SessionID: SessionRow], projects: [ProjectID: SessionProject], query: SessionQuery) -> [ProjectSection] {
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
        return trees.compactMap { projectId, list -> ProjectSection? in
            guard let project = projects[projectId] else { return nil }
            return ProjectSection(project: project, trees: list.sorted(by: treeOrder))
        }
        .sorted { a, b in
            let (x, y) = (a.trees.first.map(activity) ?? .distantPast, b.trees.first.map(activity) ?? .distantPast)
            return x != y ? x > y : projectOrder(a.project, b.project)
        }
    }

    nonisolated private static func matches(_ row: SessionRow, _ needle: String, project: SessionProject?) -> Bool {
        guard !needle.isEmpty else { return true }
        return [row.title, project?.name ?? "", row.branch ?? ""].contains { $0.localizedCaseInsensitiveContains(needle) }
    }

    nonisolated private static func activity(_ tree: SessionTree) -> Date {
        tree.descendants.reduce(tree.row.lastAt) { max($0, $1.row.lastAt) }
    }

    nonisolated private static func treeOrder(_ a: SessionTree, _ b: SessionTree) -> Bool {
        let (x, y) = (activity(a), activity(b))
        return x != y ? x > y : a.row.id.rawValue < b.row.id.rawValue
    }

    nonisolated static func projectOrder(_ a: SessionProject, _ b: SessionProject) -> Bool {
        let (x, y) = (a.lastAt ?? .distantPast, b.lastAt ?? .distantPast)
        return x != y ? x > y : a.name.localizedStandardCompare(b.name) == .orderedAscending
    }
}

/// The single status mark a row wears, most urgent first. Each has its own symbol, so none is color alone.
enum SessionMark: Equatable, Sendable {
    case needsYou, working, failed, parked, unread

    init?(_ row: SessionRow) {
        if row.needsYou { self = .needsYou }
        else if row.status == .working { self = .working }
        else if row.status == .failed || row.status == .unavailable { self = .failed }
        else if row.status == .parked { self = .parked }
        else if row.unread { self = .unread }
        else { return nil }
    }

    var spoken: String {
        switch self {
        case .needsYou: "needs you"
        case .working: "working"
        case .failed: "failed"
        case .parked: "parked"
        case .unread: "unread"
        }
    }
}

enum SessionText {
    /// "5m", "3h", "2d", then "Oct 9": short enough to sit beside a title.
    static func age(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "now"
        case ..<3600: return "\(Int(seconds / 60))m"
        case ..<86_400: return "\(Int(seconds / 3600))h"
        case ..<(7 * 86_400): return "\(Int(seconds / 86_400))d"
        default:
            var style = Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()
            if calendar.component(.year, from: date) != calendar.component(.year, from: now) { style = style.year() }
            return date.formatted(style)
        }
    }

    /// "Last updated just now", then "Last updated 3 min ago". A list newer than the clock reads as just now.
    static func updated(_ date: Date, now: Date = .now) -> String {
        guard now.timeIntervalSince(date) >= 60 else { return "Last updated just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return "Last updated \(formatter.localizedString(for: date, relativeTo: now))"
    }

    static func origin(_ origin: SessionOrigin, botName: String?) -> String {
        switch origin {
        case .phone: "started on this phone"
        case .agent: botName.map { "by \($0)'s agent" } ?? "by a bot's agent"
        case .desktop: "from the Claude app"
        case .terminal: "from a terminal"
        case .sdk: "from an SDK script"
        case .cloud: "in the cloud"
        case .unknown: ""
        }
    }

    /// One VoiceOver sentence per row: "solta-o-som, Update README, working, by Claudio Bot's agent, PR 87 open, 5 minutes ago".
    static func spoken(_ row: SessionRow, project: String?, botName: String?, now: Date = .now) -> String {
        var parts = [project, row.title].compactMap { $0 }
        if let mark = SessionMark(row) { parts.append(mark.spoken) }
        let origin = origin(row.origin, botName: botName)
        if !origin.isEmpty { parts.append(origin) }
        if let pr = row.pr { parts.append("PR \(pr.number)" + (pr.state.map { " \($0.rawValue)" } ?? "")) }
        if row.hidden { parts.append("hidden") }
        parts.append(RelativeDateTimeFormatter().localizedString(for: row.lastAt, relativeTo: now))
        return parts.joined(separator: ", ")
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
        case .tap: "When I tap"
        case .never: "Never"
        case .unknown(let raw): raw
        }
    }
}
