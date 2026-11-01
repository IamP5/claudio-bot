import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func row(
    _ id: String, _ status: SessionStatus, hidden: Bool = false, unread: Bool = false, since: Date? = nil, running: SessionRunning? = nil,
    activity: String? = nil, outcome: SessionOutcome? = nil, lastAt: Date = at
) -> SessionRow {
    var row = SessionRow(
        id: SessionID(id), projectId: ProjectID("p"), parentId: nil, title: id, origin: .phone, agent: nil, status: status, holder: .claudio,
        unread: unread, branch: nil, worktree: false, pr: nil, mirror: .notMirrored, hidden: hidden, url: nil, createdAt: at - 3600, lastAt: lastAt
    )
    row.since = since
    row.running = running
    row.activity = activity
    row.outcome = outcome
    return row
}

private let crash = SessionOutcome(kind: .failed, text: "Claude Code stopped unexpectedly (exit 1).", at: at - 300)

@Suite struct SessionsAtWorkTests {
    @Test func aLiveListCountsWhatRunsWaitsAndBroke() {
        let rows = [
            row("a", .working, since: at - 245), row("b", .working, since: at - 30), row("c", .awaitingApproval),
            row("d", .idle), row("f", .working), row("g", .failed, outcome: crash),
        ]
        let atWork = SessionsAtWork(rows, freshness: .live, excluding: SessionID("f"))
        #expect(atWork.summary(now: at) == "2 working · 1 needs you · 1 failed")
        #expect(atWork.entries.map(\.id.rawValue) == ["c", "b", "a", "g"])
        #expect(SessionsAtWork([row("a", .awaitingInput), row("b", .awaitingApproval)], freshness: .live).summary(now: at) == "2 need you")
        #expect(SessionsAtWork([row("d", .idle)], freshness: .live).summary(now: at) == nil)
    }

    @Test func aListTheMacNoLongerAnswersForClaimsNothingRuns() {
        let rows = [row("a", .working, since: at - 600), row("b", .working), row("c", .awaitingInput)]
        let stale = SessionsAtWork(rows, freshness: .asOf(at - 300), excluding: nil)
        #expect(stale.summary(now: at) == "1 needs you · as of 5m ago")
        #expect(stale.spoken(now: at) == "1 needs you, as of 5 minutes ago")
        #expect(stale.entries.filter { $0.kind == .working }.isEmpty)
        let a = stale.entries.first { $0.id == SessionID("a") }!
        #expect(a.kind == .lastKnownWorking)
        #expect(stale.line(a, now: at) == "Working for 5m 00s when last updated", "the run clock stops at the last update")
        let onlyWorking = SessionsAtWork([row("a", .working)], freshness: .asOf(at - 20))
        #expect(onlyWorking.summary(now: at) == "Sessions as of just now")
    }

    @Test func aWorkingRowShowsHowLongItRunsAndWhat() {
        let working = row("a", .working, since: at - 245, running: SessionRunning(agents: 3, commands: 1), activity: "Run npm test")
        let atWork = SessionsAtWork([working, row("b", .working, running: SessionRunning(agents: 0, commands: 2))], freshness: .live)
        let entry = atWork.entries.first { $0.id == SessionID("a") }!
        #expect(atWork.line(entry, now: at) == "Working 4m 05s · 3 agents, 1 command · Run npm test")
        #expect(atWork.line(entry, now: at, spoken: true) == "Working 4 minutes 5 seconds, 3 agents, 1 command, Run npm test")
        #expect(atWork.spoken(now: at) == "2 working, running 3 agents and 3 commands")
    }

    @Test func aNeedsYouRowSaysWhatItWaitsFor() {
        let atWork = SessionsAtWork([row("a", .awaitingApproval, activity: "Waiting for approval: Bash"), row("b", .awaitingInput)], freshness: .live)
        #expect(atWork.entries.map { atWork.line($0, now: at) } == ["Waiting for approval: Bash", "Needs you"])
    }

    @Test func aFailedRowSaysHowAndWhenItEnded() {
        let atWork = SessionsAtWork([row("g", .failed, outcome: crash)], freshness: .asOf(at - 60))
        #expect(atWork.line(atWork.entries[0], now: at) == "Claude Code stopped unexpectedly (exit 1). · 5m ago")
        #expect(atWork.summary(now: at) == "1 failed · as of 1m ago", "a failure is a past fact, so a stale list keeps it")
    }

    @Test func aStopCountsUntilTheUserHasSeenIt() {
        let stop = SessionOutcome(kind: .stopped, text: "Stopped", at: at - 120)
        let atWork = SessionsAtWork([row("s", .idle, unread: true, outcome: stop), row("t", .idle, outcome: stop)], freshness: .live)
        #expect(atWork.summary(now: at) == "1 stopped")
        #expect(atWork.line(atWork.entries[0], now: at) == "Stopped · 2m ago")
    }

    @Test func aHiddenSessionCountsWhileItRunsOrWaits() {
        let rows = [row("a", .working, hidden: true), row("b", .awaitingApproval, hidden: true), row("c", .failed, hidden: true, outcome: crash), row("d", .idle, hidden: true)]
        let atWork = SessionsAtWork(rows, freshness: .live)
        #expect(atWork.summary(now: at) == "1 working · 1 needs you")
        #expect(atWork.line(atWork.entries[1], now: at) == "Working · hidden")
    }
}
