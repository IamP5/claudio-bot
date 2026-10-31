import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func row(
    _ id: String, status: SessionStatus = .idle, minutesAgo: Double = 0, hidden: Bool = false, since: Date? = nil,
    running: SessionRunning? = nil, activity: String? = nil, outcome: SessionOutcome? = nil
) -> SessionRow {
    SessionRow(
        id: SessionID(id), projectId: ProjectID("p1"), parentId: nil, title: "Session \(id)", origin: .terminal, agent: nil,
        status: status, holder: .nobody, unread: false, branch: nil, worktree: false, pr: nil, mirror: .notMirrored,
        hidden: hidden, url: nil, createdAt: at - minutesAgo * 60, lastAt: at - minutesAgo * 60, since: since,
        running: running, activity: activity, outcome: outcome
    )
}

private let demo = SessionProject(id: ProjectID("p1"), name: "demo", path: "/tmp/demo", githubRepo: nil, lastAt: at, canCloud: false)

@MainActor
private func listed(_ rows: [SessionRow]) -> SessionIndex {
    let index = SessionIndex()
    index.apply(.list(projects: [demo], rows: rows, mirror: .auto), at: at)
    return index
}

private let crash = SessionOutcome(kind: .failed, text: "Claude Code stopped unexpectedly (terminated by signal SIGKILL)", at: at)

@MainActor
@Suite struct SessionsListTests {
    @Test func aListWhoseEverySessionIsHiddenSaysSoAndOffersToShowThem() {
        let index = listed([row("a", hidden: true), row("b", hidden: true)])
        #expect(index.sections(SessionQuery()).isEmpty)
        let empty = EmptyList(hidden: index.hiddenCount, query: SessionQuery())
        #expect(empty == .allHidden(2))
        #expect(empty.title == "2 hidden sessions")
        #expect(EmptyList(hidden: 1, query: SessionQuery()).title == "1 hidden session")
        #expect(EmptyList(hidden: 0, query: SessionQuery()).title == "No Claude Code sessions on this Mac yet", "none yet only when no row exists")
        #expect(EmptyList(hidden: 2, query: SessionQuery(filter: .working)).title == "No working sessions.")
    }

    @Test func failedUnavailableAndParkedRowsAreNeverFolded() {
        for status in [SessionStatus.failed, .unavailable, .parked] {
            #expect(SessionTree(row: row("x", status: status), descendants: []).isActive, "\(status) stays above Show more")
        }
        #expect(!SessionTree(row: row("x"), descendants: []).isActive)
        let child = SessionTree.Descendant(row: row("c", status: .failed), depth: 1, isLast: true)
        #expect(SessionTree(row: row("p"), descendants: [child]).isActive)
    }

    @Test func aFailedRowSortsByWhenItFailedNotByItsLastWrite() {
        let newer = (1...6).map { row("done\($0)", minutesAgo: Double($0)) }
        let failed = row("crashed", status: .failed, minutesAgo: 30, outcome: crash)
        let index = listed(newer + [failed])
        let order = index.sections(SessionQuery()).flatMap(\.trees).map(\.row.id.rawValue)
        #expect(order.first == "crashed", "it failed after the others last wrote")
        #expect(RowTime(failed, now: at + 120).short == "2m", "its time is when it failed, as its place is")
    }

    @Test func theProjectHeaderCountsBrokenRows() {
        let tally = SectionTally([row("a"), row("b", status: .failed), row("c", status: .unavailable), row("d", status: .parked)])
        let nbsp = "\u{00A0}"
        #expect(tally.shown(.live) == "4 · 1\(nbsp)failed · 1\(nbsp)unavailable · 1\(nbsp)parked")
        #expect(tally.spoken(.asOf(at)) == "4 sessions, 1\(nbsp)failed, 1\(nbsp)unavailable, 1\(nbsp)parked", "a failure stays a fact offline")
    }

    @Test func workThatOutlivesACrashKeepsTheCrashOnTheRow() {
        let outlived = row(
            "o", status: .working, since: at - 120, running: SessionRunning(agents: 0, commands: 1), activity: "Background: perl -e sleep 90",
            outcome: crash
        )
        let detail = RowDetail(outlived)
        #expect(detail?.shown == "1 command still runs · Claude Code stopped unexpectedly (terminated by signal SIGKILL)")
        #expect(detail?.tone == .alarm)

        var two = outlived
        two.running = SessionRunning(agents: 1, commands: 1)
        #expect(RowDetail(two)?.shown == "1 agent, 1 command still run · Claude Code stopped unexpectedly (terminated by signal SIGKILL)")

        var later = outlived
        later.since = at + 60
        #expect(RowDetail(later)?.shown == "1 command · Background: perl -e sleep 90", "a run started after the crash is its own")
    }

    @Test func aRunPastAWeekIsSpokenInDays() {
        let long = row("w", status: .working, since: at - 9 * 86_400)
        let spoken = SessionText.spoken(long, project: "demo", botName: nil, now: at)
        #expect(spoken.hasPrefix("demo, Session w, working for 9 days, "))
        #expect(SessionText.spoken(long, project: nil, botName: nil, now: at, freshness: .asOf(at)).contains("working for 9 days when last updated"))
    }

    @Test func aFilterCountOnAStaleListSaysHowOldItIs() {
        let query = SessionQuery(filter: .working)
        #expect(SessionText.matches(3, query: query) == "3 working sessions")
        #expect(SessionText.matches(3, query: query, freshness: .asOf(at), now: at + 12 * 60) == "3 working sessions, as of 12 minutes ago")
        #expect(SessionText.matches(0, query: query, freshness: .asOf(at), now: at + 10) == "No working sessions, as of a moment ago")
    }

    @Test func aReconnectTheAppChoseKeepsTheListLiveForItsGraceThenSaysReconnecting() async throws {
        let store = AppStore()
        store.setConnection(.connected(machine: "Mac"))
        store.apply(.sessions(.list(projects: [demo], rows: [row("w", status: .working)], mirror: .auto)))
        store.setConnection(.connecting)
        #expect(!store.sessions.stale, "no stale mark inside the grace")
        #expect(store.showsOnline)
        #expect(store.sessions.freshness(online: store.showsOnline) == .live)
        #expect(Reach(store.connection, failures: 0, greeted: true, rejoining: store.rejoin != nil) == .reconnecting)

        try await Task.sleep(for: AppStore.rejoinGrace + .milliseconds(300))
        #expect(store.rejoin == .showing)
        #expect(store.sessions.stale, "past the grace the rows are last known")
        #expect(!store.showsOnline)

        store.setConnection(.disconnected(retryAt: at))
        #expect(store.rejoin == nil, "the first failed try ends the reconnect")
        #expect(Reach(store.connection, failures: 1, greeted: true, rejoining: store.rejoin != nil) == .unreachable(nextTry: at))
    }

    @Test func aReconnectThatNeverLandsCountsAsLostAfterItsPatience() async throws {
        let store = AppStore()
        store.setConnection(.connected(machine: "Mac"))
        store.setConnection(.connecting)
        store.setConnection(.connecting)
        #expect(store.rejoin == .grace, "a try the app restarts itself keeps the reconnect")
        try await Task.sleep(for: AppStore.rejoinGrace + AppStore.rejoinPatience + .milliseconds(300))
        #expect(store.rejoin == nil)
        #expect(Reach(store.connection, failures: 0, greeted: true, rejoining: store.rejoin != nil) == .retrying, "the banner offers Retry again")
    }

    @Test func aDropThatWasNotChosenStillMarksTheListAtOnce() {
        let store = AppStore()
        store.setConnection(.connected(machine: "Mac"))
        store.apply(.sessions(.list(projects: [demo], rows: [row("w", status: .working)], mirror: .auto)))
        store.setConnection(.disconnected(retryAt: at))
        #expect(store.sessions.stale)
        store.setConnection(.connecting)
        #expect(store.rejoin == nil, "a try after a drop is not a reconnect the app chose")
        #expect(!store.showsOnline)
    }

    @Test func reconnectingIsNeitherLostNorAnnounced() {
        #expect(!Reach.reconnecting.lost)
        #expect(Reach.announcement(from: .connected(machine: "Mac"), to: .reconnecting) == nil)
        #expect(Reach.announcement(from: .reconnecting, to: .connected(machine: "Mac")) == nil)
        #expect(Reach.announcement(from: .reconnecting, to: .retrying) == "Can't reach your Mac. Reconnecting.")
        #expect(ConnectionBanner.cause(.reconnecting, address: "10.0.0.20:7878", lastRetryFailed: false) == "Reconnecting…")
    }

    @Test func aMacThatDoesNotRecognizeThisPhoneIsNeverCalledNotRunning() {
        let cause = ConnectionBanner.cause(.unrecognized, address: "10.0.0.20:7878", lastRetryFailed: false)
        #expect(cause == "This bridge doesn't recognize this \(ThisDevice.noun). Pair again, or retry once you are back on your Mac's network.")
        #expect(StartPhase.unrecognizedLabel == "Start (your Mac doesn't recognize this \(ThisDevice.noun))")
    }

    @Test func namesakeProjectsShowTheirLabelsAndSearchFindsThem() throws {
        let json = #"{"id":"p2","name":"app","path":"/Users/me/forks/app","githubRepo":"bob/app","lastAt":null,"canCloud":false,"label":"bob/app"}"#
        let project = try Wire.decoder().decode(SessionProject.self, from: Data(json.utf8))
        #expect(project.shownName == "bob/app")
        #expect(demo.shownName == "demo", "a project with its own name shows it")

        var r = row("s")
        r.projectId = project.id
        let sections = SessionIndex.sections(rows: [r.id: r], projects: [project.id: project], query: SessionQuery(text: "bob/"))
        #expect(sections.map(\.project.id) == [project.id])
    }
}
