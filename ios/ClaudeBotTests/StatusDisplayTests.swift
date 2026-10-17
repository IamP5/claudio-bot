import Testing
@testable import ClaudeBot

@Suite struct StatusDisplayTests {
    private let local = Target.local(ProjectID("p1"))
    private let cloud = Target.cloud(ProjectID("p1"))

    @Test func idleReadsDoneOnTheMacAndInCloudOnACloudTarget() {
        #expect(StatusDisplay.of(.idle, on: local) == StatusDisplay(title: "Done", tone: .done))
        #expect(StatusDisplay.of(.idle, on: cloud) == StatusDisplay(title: "In cloud", tone: .cloud))
    }

    @Test func everyOtherStatusReadsTheSameOnBothTargets() {
        for status in [TaskStatus.running, .needsInput, .failed, .stopped] {
            #expect(StatusDisplay.of(status, on: local) == StatusDisplay.of(status, on: cloud))
        }
    }

    @Test func titlesAndTones() {
        let rows: [(TaskStatus, String, StatusDisplay.Tone)] = [
            (.running, "Running", .running),
            (.needsInput, "Needs you", .attention),
            (.failed, "Failed", .failed),
            (.stopped, "Stopped", .stopped),
        ]
        for (status, title, tone) in rows {
            #expect(StatusDisplay.of(status, on: local) == StatusDisplay(title: title, tone: tone))
        }
    }

    @Test func unknownStatusIsNeverShownAsDone() {
        let display = StatusDisplay.of(.unknown("paused"), on: local)
        #expect(display == StatusDisplay(title: "Unknown", tone: .unknown))
        #expect(display == StatusDisplay.of(.unknown("paused"), on: cloud))
    }

    @Test func onlyRunningPulses() {
        #expect(StatusDisplay.of(.running, on: cloud).pulsing)
        #expect(!StatusDisplay.of(.idle, on: cloud).pulsing)
    }

    @Test func aTaskSummaryUsesItsOwnTarget() {
        let task = TaskSummary(
            id: TaskID("t"), title: "T", target: cloud, projectName: "p", model: "opus",
            permissionMode: .default, status: .idle, createdAt: .now, updatedAt: .now,
            preview: "", costUsd: 0, cloudUrl: nil
        )
        #expect(task.statusDisplay.title == "In cloud")
    }
}
