import Foundation
import Testing
@testable import ClaudioBot

private final class BundleToken {}

private let start = Date(timeIntervalSince1970: 1_792_152_000)

private func step(
    _ id: String, _ tool: String = "Bash", _ label: String? = nil, state: ToolStepState = .ok, started: Double? = nil, ended: Double? = nil,
    detail: String? = nil, owner: String? = nil, cause: String? = nil, diff: ToolDiff? = nil, usage: ToolUsage? = nil
) -> ToolStep {
    ToolStep(
        id: id, tool: tool, label: label ?? "Step \(id)", state: state, diff: diff, output: nil, detail: detail,
        startedAt: started.map { start + $0 }, endedAt: ended.map { start + $0 }, owner: owner, cause: cause, usage: usage
    )
}

private func controls(tasks: [SessionTask] = [], heardAt: Date? = nil) -> SessionControls {
    SessionControls(
        canSend: true, reason: nil, working: true, queued: 0, model: nil, models: [], mode: .default, modes: [.default],
        turn: SessionTurn(startedAt: "2026-10-16T12:00:00.000Z", wake: false), tasks: tasks, heardAt: heardAt
    )
}

/// The work item and controls of the fixture's run-state frame, which G0 pinned on both sides of the wire.
private func fixtureRun() throws -> (steps: [ToolStep], controls: SessionControls) {
    let url = Bundle(for: BundleToken.self).url(forResource: "protocol", withExtension: "json")!
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: [Any]]
    let frames = try root["server"]!.map { try Wire.decoder().decode(ServerFrame.self, from: JSONSerialization.data(withJSONObject: $0)) }
    for frame in frames {
        guard case let .thread(_, .items(_, items, _, controls?)) = frame.message, controls.tasks?.isEmpty == false else { continue }
        for case let .work(_, _, steps) in items { return (steps, controls) }
    }
    throw CocoaError(.fileReadCorruptFile)
}

private func date(_ wire: String) -> Date {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: wire)!
}

@Suite struct ThreadWorkTests {
    @Test func theFixtureRunNamesEveryStateClass() throws {
        let (steps, controls) = try fixtureRun()
        let run = WorkRun(steps: steps, controls: controls)
        let noon = date("2026-10-16T12:00:00.000Z")

        #expect(run.isLive)
        #expect(run.since == noon)
        #expect(run.headline() == "1 of 2 agents running · 1 waiting for approval · 1 stopped · 1 may still run · 1 ended", "sleep 60 is sleeper two's own command")
        #expect(run.failure == "List the late files failed: Exit code 1: ls: late.txt: No such file or directory")
        #expect(run.spoken(now: noon + 125) ==
            "Running: 1 of 2 agents, 1 waiting for approval, 1 stopped, 1 may still run, 1 ended, 2 minutes 5 seconds. List the late files failed: Exit code 1: ls: late.txt: No such file or directory")
    }

    @Test func eachFixtureStepSaysItsStateTimeAndOwner() throws {
        let (steps, controls) = try fixtureRun()
        let run = WorkRun(steps: steps, controls: controls)
        let now = date("2026-10-16T14:00:30.000Z")
        let byId = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, $0) })

        #expect(run.status(byId["toolu_01Ac1"]!, now: now) == ["Running · 2h 00m", "waiting for your approval", "3 tools, last Bash"])
        #expect(run.status(byId["toolu_01Ac2"]!, now: now) == ["Waiting for approval", "started by sleeper two"])
        #expect(run.status(byId["toolu_01Ac3"]!, now: now).first == "Running · 2h 00m")
        #expect(run.status(byId["toolu_01Ac3"]!, now: now).contains("started by sleeper two"))
        #expect(run.status(byId["toolu_01Ac4"]!, now: now) == ["Failed · 2h 00m"])
        #expect(run.status(byId["toolu_01Ac5"]!, now: now) == ["Stopped by you · 2h 00m", "4 tools"])
        #expect(run.status(byId["toolu_01Ac1"]!, now: now, spoken: true).first == "Running, 2 hours")
    }

    @Test func aWaitingStepKeepsTheRunLive() {
        let run = WorkRun(steps: [step("1", state: .ok), step("2", "Bash", "Remove the build folder", state: .waiting)])
        #expect(run.isLive)
        #expect(!run.isRunning)
        #expect(!run.ticks)
        #expect(run.collapsed.map(\.id) == ["2"])
        #expect(run.since == nil)
        #expect(run.headline() == "1 waiting for approval")
        #expect(run.duration == nil)
    }

    @Test func aRunWithoutAClockOrASignOfLifeDoesNotTick() {
        #expect(!WorkRun(steps: [step("1", state: .running)]).ticks)
        #expect(WorkRun(steps: [step("1", state: .running, started: 0)]).ticks)
        #expect(WorkRun(steps: [step("1", state: .running)], controls: controls(heardAt: start)).ticks)
    }

    @Test func runningCountsGroupByKind() {
        let steps = [
            step("1", "Agent", state: .running), step("2", "Agent", state: .running), step("3", "Agent", state: .running),
            step("4", "Bash", state: .running), step("5", "Read", state: .running), step("6", "Agent", state: .ok),
        ]
        #expect(WorkRun(steps: steps).headline() == "3 of 4 agents, 1 command, 1 step running · 1 done")
        #expect(WorkRun(steps: Array(steps.prefix(5))).headline() == "3 agents, 1 command, 1 step running")
    }

    @Test func theClockStartsAtTheEarliestRunningStep() {
        let run = WorkRun(steps: [
            step("1", state: .running, started: 30), step("2", state: .running, started: 10), step("3", state: .ok, started: 0, ended: 5),
        ])
        #expect(run.since == start + 10)
        #expect(run.spoken(now: start + 75) == "Running: 2 commands, 1 minute 5 seconds")
    }

    @Test func aFinishedRunStatesItsDuration() {
        let run = WorkRun(steps: [
            step("1", "Agent", state: .ok, started: 0, ended: 31), step("2", "Agent", state: .ok, started: 1, ended: 43),
            step("3", "Agent", state: .ok, started: 2, ended: 20),
        ])
        #expect(!run.isLive)
        #expect(run.headline() == "Ran 3 agents, 43s")
        #expect(run.spoken(now: start + 600) == "Ran 3 agents, 43 seconds")
        #expect(run.status(run.steps[1], now: start + 600) == ["Done · 42s"])
    }

    @Test func aFinishedAgentWithoutTimesFallsBackToItsUsage() {
        let run = WorkRun(steps: [step("1", "Agent", state: .ok, usage: ToolUsage(tools: 5, ms: 12_400))])
        #expect(run.status(run.steps[0], now: start) == ["Done · 12s", "5 tools"])
    }

    @Test func severalFailuresNameTheFirstAndCountTheRest() {
        let run = WorkRun(steps: [step("1", "Bash", "List the late files", state: .error, cause: "Exit code 1"), step("2", state: .error), step("3", state: .error)])
        #expect(run.failure == "List the late files failed: Exit code 1, and 2 more failed")
        #expect(WorkRun(steps: [step("1", "Agent", "broken helper", state: .error)]).failure == "broken helper failed")
    }

    @Test func aQuietSubagentSaysHowLongItHasBeenSilent() {
        let task = SessionTask(
            id: TaskID("t1"), stepId: "1", kind: .agent, label: "sleeper", background: true, startedAt: start, owner: nil,
            progress: TaskProgress(tools: 2, last: "Bash", at: start + 5), waiting: nil
        )
        let run = WorkRun(steps: [step("1", "Agent", "sleeper", state: .running, started: 0)], controls: controls(tasks: [task], heardAt: start + 2))
        #expect(run.quiet(run.steps[0], now: start + 60) == nil)
        #expect(run.quiet(run.steps[0], now: start + 185) == 180)
        #expect(run.status(run.steps[0], now: start + 185) == ["Running · 3m 05s", "2 tools, last Bash", "no activity for 3m"])
        #expect(run.status(run.steps[0], now: start + 185, spoken: true).last == "no activity for 3 minutes")
    }

    @Test func aStepWithoutATaskIsQuietByTheSessionsLastSignOfLife() {
        let run = WorkRun(steps: [step("1", state: .running, started: 0), step("2", state: .ok)], controls: controls(heardAt: start + 10))
        #expect(run.quiet(run.steps[0], now: start + 70) == nil)
        #expect(run.quiet(run.steps[0], now: start + 100) == 90)
        #expect(run.quiet(run.steps[1], now: start + 100) == nil)
        #expect(WorkRun(steps: run.steps).quiet(run.steps[0], now: start + 1000) == nil)
    }

    @Test func aLiveCommandIsNeverQuietFromClaudeCodesSilence() {
        let task = SessionTask(
            id: TaskID("t1"), stepId: "1", kind: .command, label: "sleep 300", background: true, startedAt: start, owner: nil,
            progress: nil, waiting: nil
        )
        let run = WorkRun(steps: [step("1", state: .running, started: 0)], controls: controls(tasks: [task], heardAt: start))
        #expect(run.quiet(run.steps[0], now: start + 120) == nil)
        #expect(run.status(run.steps[0], now: start + 120) == ["Running · 2m 00s"])
    }

    @Test func anAgentWaitingOnItsOwnCommandIsNotQuiet() {
        let command = SessionTask(
            id: TaskID("t2"), stepId: "2", kind: .command, label: "sleep 300", background: true, startedAt: start + 5, owner: "1",
            progress: nil, waiting: nil
        )
        let steps = [step("1", "Agent", "sleeper two", state: .running, started: 0), step("2", "Bash", "Sleep 5 minutes", state: .running, started: 5, owner: "1")]
        let run = WorkRun(steps: steps, controls: controls(tasks: [command], heardAt: start + 5))
        #expect(run.quiet(run.steps[0], now: start + 200) == nil)
        #expect(run.status(run.steps[0], now: start + 200) == ["Running · 3m 20s"])
    }

    @Test func anAgentIsQuietOnlyWhenItsProgressItsTasksAndTheSessionAreAllOld() {
        let agent = SessionTask(
            id: TaskID("t1"), stepId: "1", kind: .agent, label: "outer", background: true, startedAt: start, owner: nil,
            progress: TaskProgress(tools: 1, last: "Agent", at: start + 5), waiting: nil
        )
        let inner = SessionTask(
            id: TaskID("t2"), stepId: "2", kind: .agent, label: "inner", background: false, startedAt: start + 6, owner: "1",
            progress: TaskProgress(tools: 9, last: "Read", at: start + 150), waiting: nil
        )
        let steps = [step("1", "Agent", "outer", state: .running, started: 0), step("2", "Agent", "inner", state: .running, started: 6, owner: "1")]
        let busy = WorkRun(steps: steps, controls: controls(tasks: [agent, inner], heardAt: start + 10))
        #expect(busy.quiet(busy.steps[0], now: start + 200) == nil)
        let still = WorkRun(steps: steps, controls: controls(tasks: [agent], heardAt: start + 10))
        #expect(still.quiet(still.steps[0], now: start + 200) == 190)
        let chatty = WorkRun(steps: steps, controls: controls(tasks: [agent], heardAt: start + 180))
        #expect(chatty.quiet(chatty.steps[0], now: start + 200) == nil)
    }

    @Test func aFinishedAgentStaysInTheCollapsedRunWhileItsSiblingsRun() {
        let run = WorkRun(steps: [
            step("1", "Agent", "sleeper one", state: .ok, started: 0, ended: 35, usage: ToolUsage(tools: 1, ms: 35_000)),
            step("2", "Agent", "sleeper two", state: .running, started: 0), step("3", "Agent", "sleeper three", state: .running, started: 1),
            step("4", "Read", "Read notes.md", state: .ok, started: 0, ended: 1),
        ])
        #expect(run.headline() == "2 of 3 agents running · 1 done")
        #expect(run.headline(spoken: true) == "Running: 2 of 3 agents, 1 done")
        #expect(run.collapsed.map(\.id) == ["1", "2", "3"])
        #expect(run.status(run.steps[0], now: start + 60) == ["Done · 35s", "1 tool"])
        let ended = WorkRun(steps: [step("1", "Agent", state: .ok, started: 0, ended: 35), step("2", "Agent", state: .ok, started: 0, ended: 40)])
        #expect(ended.collapsed.isEmpty)
        #expect(ended.headline() == "Ran 2 agents, 40s")
    }

    @Test func anAgentRunningItsOwnForegroundCommandIsNotQuietBeforeItsTaskIsRegistered() {
        let steps = [step("1", "Agent", "sleeper two", state: .running, started: 0), step("2", "Bash", "Sleep 2 minutes", state: .running, started: 5, owner: "1")]
        let run = WorkRun(steps: steps, controls: controls(heardAt: start + 5))
        #expect(run.quiet(run.steps[0], now: start + 120) == nil)
        let after = WorkRun(steps: [steps[0], step("2", "Bash", "Sleep 2 minutes", state: .ok, started: 5, ended: 30, owner: "1")], controls: controls(heardAt: start + 30))
        #expect(after.quiet(after.steps[0], now: start + 120) == 90)
    }

    @Test func aFinishedAgentBesideOneWaitingForApprovalIsCountedAndShown() {
        let run = WorkRun(steps: [step("1", "Agent", "sleeper one", state: .ok, started: 0, ended: 20), step("2", "Agent", "sleeper two", state: .waiting)])
        #expect(run.headline() == "1 done · 1 waiting for approval")
        #expect(run.collapsed.map(\.id) == ["1", "2"])
    }

    @Test func aFoldedTurnNamesItsFirstFailureAndCountsTheRest() {
        let items: [SessionItem] = [
            .work(id: ItemID("w1"), at: start, steps: [
                step("1", "Bash", "List missing-a.txt", state: .error, started: 0, ended: 1, cause: "Exit code 1: ls: missing-a.txt: No such file or directory"),
                step("2", "Bash", "List missing-b.txt", state: .error, started: 0, ended: 1, cause: "Exit code 1: ls: missing-b.txt: No such file or directory"),
            ]),
            .assistant(id: ItemID("a1"), at: start, text: "Both failed."),
            .work(id: ItemID("w2"), at: start, steps: [step("3", "Bash", "Run echo checked", state: .ok, started: 2, ended: 3)]),
        ]
        #expect(WorkSummary.failure(items) == "List missing-a.txt failed: Exit code 1: ls: missing-a.txt: No such file or directory, and 1 more failed")
        #expect(WorkSummary.failure([.work(id: ItemID("w2"), at: start, steps: [step("3", state: .ok)])]) == nil)
    }

    @Test func aRunningStepShowsNoOutput() {
        var running = step("1", state: .running, started: 0)
        running.output = "Tool call interrupted. The outcome is unknown."
        #expect(running.shownOutput == nil)
        var failed = step("2", state: .error)
        failed.output = "ls: late.txt: No such file or directory"
        #expect(failed.shownOutput == "ls: late.txt: No such file or directory")
    }

    @Test func workThatMayStillRunSaysWhenItStarted() {
        let run = WorkRun(steps: [step("1", state: .unsure, started: 0)])
        #expect(run.status(run.steps[0], now: start + 250) == ["May still run on your Mac · started 4m ago"])
        #expect(run.status(run.steps[0], now: start + 250, spoken: true) == ["May still run on your Mac, started 4 minutes 10 seconds ago"])
        #expect(run.ages)
    }

    @Test func aStoppedCommandSaysHowLongItRan() {
        let run = WorkRun(steps: [step("1", state: .stopped, started: 0, ended: 72, cause: "Stopped by you")])
        #expect(run.status(run.steps[0], now: start + 600) == ["Stopped by you · 1m 12s"])
        #expect(run.status(run.steps[0], now: start + 600, spoken: true) == ["Stopped by you, 1 minute 12 seconds"])
    }

    @Test func oneLineChangedIsSpokenSingular() {
        #expect(DiffStat.spoken(added: 1, removed: 1) == "1 line added, 1 removed")
        #expect(DiffStat.spoken(added: 3, removed: 0) == "3 lines added, 0 removed")
    }

    @Test func aSubagentHeldByAnApprovalCardIsNeverQuiet() {
        let task = SessionTask(
            id: TaskID("t1"), stepId: "1", kind: .agent, label: "cleaner", background: true, startedAt: start, owner: nil,
            progress: TaskProgress(tools: 2, last: "Bash", at: start), waiting: MessageID("card")
        )
        let run = WorkRun(steps: [step("1", "Agent", state: .running, started: 0)], controls: controls(tasks: [task], heardAt: start))
        #expect(run.quiet(run.steps[0], now: start + 600) == nil)
        #expect(run.status(run.steps[0], now: start + 600) == ["Running · 10m 00s", "waiting for your approval", "2 tools, last Bash"])
    }

    @Test func aFailedWriteIsNotCountedAsAnEdit() {
        let steps = (1...10).map { step("\($0)", "Write", state: .ok, diff: ToolDiff(path: "f\($0)", added: 1, removed: 0)) }
            + [step("11", "Write", state: .error, diff: ToolDiff(path: "f11", added: 1, removed: 0))]
        #expect(WorkSummary.text(steps) == "Edited 10 files")
        #expect(WorkSummary.diff(steps)?.added == 10)
        #expect(WorkSummary.errors(steps) == 1)
        #expect(WorkSummary.text([step("1", "Edit", state: .error)]) == "1 step")
        #expect(WorkSummary.diff([step("1", "Edit", state: .stopped, diff: ToolDiff(path: "a", added: 3, removed: 1))]) == nil)
    }

    @Test func liveWorkStaysOutOfAFinishedTurnsFold() {
        let items: [SessionItem] = [
            .user(id: ItemID("u"), at: start, text: "Go", from: .user, queued: false),
            .thinking(id: ItemID("t"), at: start, text: "Hmm", ms: 900),
            .work(id: ItemID("w1"), at: start, steps: [step("1", state: .ok)]),
            .work(id: ItemID("w2"), at: start, steps: [step("2", "Agent", state: .running, started: 0)]),
            .assistant(id: ItemID("a1"), at: start, text: "Started an agent."),
            .assistant(id: ItemID("a2"), at: start, text: "It runs in the background."),
        ]
        let rows = ThreadLayout.rows(items, expanded: [], working: false)
        #expect(rows.map(\.id.rawValue) == ["u", "fold:t", "w2", "a1", "a2"])
    }

    @Test func clockFormats() {
        #expect(RunClock.short(0) == "0s")
        #expect(RunClock.short(43.9) == "43s")
        #expect(RunClock.short(125) == "2m 05s")
        #expect(RunClock.short(3725) == "1h 02m")
        #expect(RunClock.short(-4) == "0s")
        #expect(RunClock.spoken(1) == "1 second")
        #expect(RunClock.spoken(120) == "2 minutes")
        #expect(RunClock.spoken(125) == "2 minutes 5 seconds")
        #expect(RunClock.spoken(3725) == "1 hour 2 minutes")
        #expect(RunClock.coarse(45) == "45s")
        #expect(RunClock.coarse(185) == "3m")
        #expect(RunClock.coarse(4200) == "1h 10m")
    }
}

@Suite struct UnsureStepTests {
    @Test func aStepTheBridgeCannotFollowReadsMayStillRunNeitherStoppedNorRunning() throws {
        let run = WorkRun(steps: [step("1", state: .unsure, started: 0, cause: "Can't tell whether this still runs on your Mac")])
        #expect(!run.isLive && !run.isRunning && !run.ticks)
        #expect(run.headline() == "1 may still run")
        #expect(run.headline(spoken: true) == "1 may still run")
        let mixed = WorkRun(steps: [step("1", state: .ok), step("2", state: .unsure, cause: "Can't tell whether this still runs on your Mac")])
        #expect(mixed.headline() == "Ran 1 command · 1 may still run")
        #expect(run.status(run.steps[0], now: start + 60) == ["May still run on your Mac · started 1m ago"])
        #expect(run.status(run.steps[0], now: start + 60, spoken: true) == ["May still run on your Mac, started 1 minute ago"])
    }

    @Test func aCommandThatEndedUnseenReadsEndedWithResultUnknownNeitherStoppedNorDone() throws {
        let run = WorkRun(steps: [step("1", state: .ended, started: 0, cause: "It ended without a result")])
        #expect(!run.isLive && !run.isRunning)
        #expect(run.headline().hasSuffix(" · 1 ended") && !run.headline().contains("stopped"))
        #expect(run.status(run.steps[0], now: start + 60) == ["Ended · result unknown"])
        #expect(run.status(run.steps[0], now: start + 60, spoken: true) == ["Ended, result unknown"])
        #expect(ToolStepState(wire: "ended") == .ended)
    }

    @Test func theWireStateDecodesAndAnOlderUnknownOneStillDegrades() throws {
        #expect(ToolStepState(wire: "unsure") == .unsure && ToolStepState.unsure.rawValue == "unsure")
        #expect(ToolStepState(wire: "paused") == .unknown("paused"))
    }
}

@Suite struct ThreadWorkStaleTests {
    @Test func anOutOfDateRunSaysItsClockIsFromTheLastUpdate() {
        let run = WorkRun(steps: [step("1", "Agent", "sleeper one", state: .running, started: 0), step("2", "Agent", "sleeper two", state: .running, started: 0)])
        #expect(run.spoken(now: start + 125, stale: true) == "Running when last updated: 2 agents, 2 minutes 5 seconds")
        #expect(run.spoken(now: start + 125) == "Running: 2 agents, 2 minutes 5 seconds")
        #expect(run.status(run.steps[0], now: start + 72, spoken: true, stale: true).first == "Running when last updated, 1 minute 12 seconds")
        #expect(run.status(run.steps[0], now: start + 72, stale: true).first == "Running · 1m 12s", "the shown line keeps its words; the dimmed marks say it is old")
    }

    @Test func aCommandARunningAgentMakesIsNotCountedAgain() {
        let steps = [
            step("a1", "Agent", state: .running), step("a2", "Agent", state: .running),
            step("c1", "Bash", state: .running, owner: "a1"), step("c2", "Bash", state: .running, owner: "a2"), step("c3", "Bash", state: .running),
        ]
        #expect(WorkRun(steps: steps).headline() == "2 agents, 1 command running")
        let ended = [step("a1", "Agent", state: .ok), step("c1", "Bash", state: .running, owner: "a1")]
        #expect(WorkRun(steps: ended).headline() == "1 command running", "an agent that ended no longer holds its command")
    }
}
