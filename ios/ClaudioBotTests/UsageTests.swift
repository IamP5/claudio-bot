import Foundation
import Testing
@testable import ClaudioBot

private let now = Date(timeIntervalSince1970: 1_792_152_000)
private let us = Locale(identifier: "en_US")
private let saoPaulo = TimeZone(identifier: "America/Sao_Paulo")!

private func window(_ utilization: Double, resetsIn seconds: TimeInterval?, label: String = "Current session", kind: UsageWindowKind = .session) -> UsageWindow {
    UsageWindow(id: kind.rawValue, kind: kind, label: label, utilization: utilization, resetsAt: seconds.map { now + $0 }, severity: .normal)
}

@Suite struct UsageTests {
    static let shares: [(Double, String)] = [(0, "0% used"), (0.37, "37% used"), (0.374, "37% used"), (0.996, "99% used"), (1, "100% used"), (1.04, "104% used"), (-0.2, "0% used")]
    static let relative: [(TimeInterval, String)] = [
        (30, "Resets in under a minute"),
        (-5, "Resets in under a minute"),
        (14 * 60, "Resets in 14 min"),
        (14 * 60 + 1, "Resets in 15 min"),
        (2 * 3600, "Resets in 2 h"),
        (2 * 3600 + 14 * 60, "Resets in 2 h 14 min"),
        (23 * 3600 + 59 * 60, "Resets in 23 h 59 min"),
    ]

    @Test(arguments: shares)
    func theShareUsedReadsAsAPercentThatNeverRoundsToTheLimit(utilization: Double, text: String) {
        #expect(UsageText.used(utilization) == text)
    }

    @Test(arguments: relative)
    func aResetUnderADayIsRelative(seconds: TimeInterval, text: String) {
        #expect(UsageText.resets(now + seconds, now: now, locale: us, timeZone: saoPaulo) == text)
    }

    // Foundation puts a narrow no-break space before AM and PM.
    @Test func aResetADayOrMoreAwayNamesTheWeekdayAndLocalTimeAndPastSixDaysTheDate() {
        // now is Friday 2026-10-16, 9:00 AM in São Paulo.
        #expect(UsageText.resets(now + 2 * 86_400 + 3 * 3600, now: now, locale: us, timeZone: saoPaulo) == "Resets Sun 12:00\u{202F}PM")
        #expect(UsageText.resets(now + 10 * 86_400, now: now, locale: us, timeZone: saoPaulo) == "Resets Oct 26 at 9:00\u{202F}AM")
        #expect(UsageText.resets(nil, now: now) == nil)
    }

    @Test func voiceOverHearsTheWindowItsShareAndItsResetInWords() {
        #expect(UsageText.spoken(window(0.37, resetsIn: 2 * 3600 + 14 * 60), now: now) == "Current session, 37 percent used, resets in 2 hours 14 minutes")
        #expect(UsageText.spoken(window(0.37, resetsIn: 3600 + 60), now: now) == "Current session, 37 percent used, resets in 1 hour 1 minute")
        #expect(UsageText.spoken(window(0.8, resetsIn: nil, label: "Weekly · Fable", kind: .weeklyModel), now: now) == "Weekly, Fable, 80 percent used")
        let weekly = window(0.1, resetsIn: 3 * 86_400, label: "Weekly · all models", kind: .weekly)
        #expect(UsageText.spoken(weekly, now: now, locale: us, timeZone: saoPaulo) == "Weekly, all models, 10 percent used, resets Monday 9:00\u{202F}AM")
    }

    @Test func theStatusSaysWhenTheNumbersWereReadAndWhenTheLastReadsFailed() {
        let fresh = PlanUsage.ok(plan: "max", fetchedAt: now - 20, stale: false, windows: [])
        let old = PlanUsage.ok(plan: "max", fetchedAt: now - 12 * 60, stale: true, windows: [])
        #expect(UsageText.status(fresh, now: now) == "Updated just now")
        #expect(UsageText.status(old, now: now) == "Couldn't refresh. Updated 12 min ago.")
        #expect(UsageText.updated(now - 3 * 3600, now: now) == "Updated 3 h ago")
        #expect(UsageText.updated(now - 2 * 86_400, now: now) == "Updated 2 d ago")
        #expect(UsageText.plan("max") == "Claude Max")
        #expect(UsageText.plan(nil) == nil)
    }

    @Test func eachReasonForNoLimitsSaysHowToFixIt() {
        #expect(UsageText.unavailable(.loggedOut, on: "omarchy") == "Log in to Claude Code on omarchy with your Claude subscription.")
        #expect(UsageText.unavailable(.unknown("paused"), on: "omarchy") == UsageText.unavailable(.failed, on: "omarchy"))
        for reason in UsageUnavailable.allCases { #expect(!UsageText.unavailable(reason, on: "omarchy").isEmpty) }
    }

    @MainActor @Test func theStoreKeepsTheLatestUsageAcrossReconnectsAndDropsItForABridgeWithoutTheFeature() {
        let store = AppStore()
        let usage = PlanUsage.ok(plan: "max", fetchedAt: now, stale: false, windows: [window(0.37, resetsIn: 3600)])
        store.apply(.hello(Hello(features: [.usage], machine: "Mac", userName: "Alex", bots: [])))
        store.apply(.usage(usage))
        #expect(store.usage == usage)
        #expect(store.usage?.session?.utilization == 0.37)
        store.apply(.hello(Hello(features: [.usage], machine: "Mac", userName: "Alex", bots: [])))
        #expect(store.usage == usage, "a reconnect keeps the last numbers until the greeting replaces them")
        store.apply(.hello(Hello(features: [.memory], machine: "Mac", userName: "Alex", bots: [])))
        #expect(store.usage == nil)
        store.apply(.usage(usage))
        store.setConnection(.unpaired)
        #expect(store.usage == nil)
    }

    @Test func refreshUsageEncodesAsTheBridgeReadsIt() throws {
        #expect(String(decoding: try Wire.encoder().encode(ClientMessage.refreshUsage), as: UTF8.self) == #"{"type":"refresh_usage"}"#)
    }
}
