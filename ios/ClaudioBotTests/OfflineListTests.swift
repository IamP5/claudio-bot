import Foundation
import os
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func row(_ id: String, status: SessionStatus = .idle, minutesAgo: Double = 0) -> SessionRow {
    SessionRow(
        id: SessionID(id), projectId: ProjectID("p1"), parentId: nil, title: "Session \(id)",
        origin: .terminal, agent: nil, status: status, holder: .nobody, unread: false, branch: nil, worktree: false, pr: nil,
        mirror: .notMirrored, hidden: false, url: nil, createdAt: at - minutesAgo * 60, lastAt: at - minutesAgo * 60
    )
}

@MainActor
private func listed(_ rows: [SessionRow]) -> SessionIndex {
    let index = SessionIndex()
    index.apply(.list(projects: [SessionProject(id: ProjectID("p1"), name: "demo", path: "/tmp/demo", githubRepo: nil, lastAt: at, canCloud: false)], rows: rows, mirror: .auto), at: at)
    return index
}

private let hello = #"{"type":"hello","protocol":3,"machine":"Mac","userName":"Alex","bots":[],"epoch":"e1","seq":0,"resumed":false}"#
private let quick = BridgeClient.Timing(greeting: .seconds(1), reply: .seconds(1), legacyRetry: .milliseconds(300))

private struct TimedOut: Error, CustomStringConvertible {
    let what: String
    var description: String { "timed out waiting for \(what)" }
}

@MainActor
private func eventually(_ what: String, within timeout: Duration = .seconds(5), _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
        guard ContinuousClock.now < deadline else { throw TimedOut(what: what) }
        try await Task.sleep(for: .milliseconds(20))
    }
}

@MainActor
@Suite struct OfflineListTests {
    @Test func offlineTheListStopsAtItsLastUpdateAndWorkReadsAsLastKnown() {
        let index = listed([row("w", status: .working, minutesAgo: 3), row("i")])
        let offline = index.freshness(online: false)
        #expect(offline == .asOf(at))
        #expect(index.freshness(online: true) == .live)

        let tenMinutesLater = at + 600
        #expect(SessionText.age(row("w", minutesAgo: 3).lastAt, now: offline.ageReference(now: tenMinutesLater)) == "3m", "the age stops at the last update")
        #expect(SessionText.age(row("w", minutesAgo: 3).lastAt, now: ListFreshness.live.ageReference(now: tenMinutesLater)) == "13m")

        #expect(SessionMark(row("w", status: .working), freshness: offline) == .lastKnownWorking)
        #expect(SessionMark(row("w", status: .working), freshness: .live) == .working)
        #expect(SessionMark(row("q", status: .awaitingApproval), freshness: offline) == .needsYou)

        let spoken = SessionText.spoken(row("w", status: .working, minutesAgo: 3), project: "demo", botName: nil, now: tenMinutesLater, freshness: offline)
        #expect(spoken.hasPrefix("demo, Session w, working when last updated, from a terminal, "))
        #expect(spoken.contains("3"), "the spoken age is as of the last update too")
    }

    @Test func offlineTheWorkingChipShowsNoCount() {
        let index = listed([row("w", status: .working), row("v", status: .working), row("q", status: .awaitingInput)])
        #expect(index.freshness(online: true).visibleCounts(index.counts)[.working] == 2)
        let offline = index.freshness(online: false).visibleCounts(index.counts)
        #expect(offline[.working] == nil)
        #expect(offline[.needsYou] == 1 && offline[.all] == 3)
    }

    @Test func aListThatNeverLoadedIsNeverStale() {
        #expect(SessionIndex().freshness(online: false) == .live)
    }

    @Test func theBannerNamesTheAddressAndCauseFromTheFirstFailedTry() {
        let firstFailure = Reach(.disconnected(retryAt: at + 1), failures: 1, greeted: false)
        #expect(firstFailure == .unreachable(nextTry: at + 1))
        let cause = ConnectionBanner.cause(firstFailure, address: "10.0.0.20:7878", lastRetryFailed: false)
        #expect(cause.hasPrefix("Your Mac isn't answering at 10.0.0.20:7878."))
        #expect(ConnectionBanner.cause(firstFailure, address: "10.0.0.20:7878", lastRetryFailed: true).hasPrefix("Still no answer from your Mac at 10.0.0.20:7878."))
        #expect(ConnectionBanner.cause(firstFailure, address: "10.0.0.20:7878", lastRetryFailed: false, brief: true) == "Your Mac isn't answering at 10.0.0.20:7878.", "at accessibility sizes the advice gives way to the buttons")
        #expect(ConnectionBanner.cause(.firstConnect, address: "10.0.0.20:7878", lastRetryFailed: false) == "Connecting to your Mac at 10.0.0.20:7878.")
    }

    @Test func retriesStayUnreachableInsteadOfFlippingBackToConnecting() {
        #expect(Reach(.connecting, failures: 0, greeted: false) == .firstConnect, "the first try since launch")
        #expect(Reach(.connecting, failures: 2, greeted: false) == .retrying)
        #expect(Reach(.connecting, failures: 0, greeted: true) == .retrying, "a try after the Mac was lost")
        #expect(Reach(.connected(machine: "Mac", quietSince: at), failures: 0, greeted: true) == .connected(machine: "Mac"))
    }

    @Test func voiceOverHearsOneAnnouncementPerChangeOfMeaning() {
        let lost = Reach.unreachable(nextTry: at + 1)
        #expect(Reach.announcement(from: .connected(machine: "Mac"), to: lost) == "Can't reach your Mac. Reconnecting.")
        #expect(Reach.announcement(from: lost, to: .retrying) == nil, "a retry is not news")
        #expect(Reach.announcement(from: .retrying, to: .unreachable(nextTry: at + 30)) == nil)
        #expect(Reach.announcement(from: lost, to: .connected(machine: "Mac")) == "Reconnected to Mac.")
        #expect(Reach.announcement(from: .firstConnect, to: .connected(machine: "Mac")) == nil, "a launch that connects says nothing")
        #expect(Reach.announcement(from: .firstConnect, to: lost) != nil)
        #expect(Reach.announcement(from: lost, to: .unrecognized) != nil)
    }

    @Test func theBadgeSpeaksTheStateNotTheCountdown() {
        #expect(ConnectionState.disconnected(retryAt: at + 3).spoken == ConnectionState.disconnected(retryAt: at + 29).spoken)
        #expect(ConnectionState.disconnected(retryAt: at + 3).spoken == "Mac unreachable, reconnecting")
    }

    @Test func retryingWhileTheMacIsDownTriesAtOnceAndSaysItDidNotAnswer() async throws {
        let bridge = try FakeBridge(onUpgrade: { _ in .refuse(status: 503) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: PairingVault(service: "dev.claudiobot.tests.\(UUID().uuidString)"), timing: quick)
        client.start(pairing)
        try await eventually("three failed tries, the next 8 s away") { client.failures >= 3 }
        let tries = bridge.upgrades.count

        let started = ContinuousClock.now
        let answered = await client.retryNowAndWait()

        #expect(!answered)
        #expect(bridge.upgrades.count == tries + 1, "one more try, not a wait for the backoff")
        #expect(ContinuousClock.now - started < .seconds(3))
        client.stop()
    }

    @Test func retryingReturnsOnceTheMacAnswers() async throws {
        let refusals = OSAllocatedUnfairLock(initialState: 2)
        let bridge = try FakeBridge(
            onUpgrade: { _ in refusals.withLock { left in defer { left -= 1 }; return left > 0 ? .refuse(status: 503) : .accept } },
            onOpen: { $0.send(hello) }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: PairingVault(service: "dev.claudiobot.tests.\(UUID().uuidString)"), timing: quick)
        client.start(pairing)
        try await eventually("two failed tries") { client.failures >= 2 }

        #expect(await client.retryNowAndWait())
        #expect(client.store.machine == "Mac")
        client.stop()
    }
}
