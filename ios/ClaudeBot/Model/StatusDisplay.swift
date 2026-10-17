import Foundation

/// How a task's status reads on screen. Every surface takes its label and tone from here.
struct StatusDisplay: Equatable, Sendable {
    enum Tone: Equatable, Sendable {
        case running, attention, done, cloud, failed, stopped, unknown
    }

    let title: String
    let tone: Tone

    var pulsing: Bool { tone == .running }

    /// A cloud session is never "done" from here: the bridge reports idle as soon as it is dispatched
    /// or a follow-up is queued, and the work continues in claude.ai.
    static func of(_ status: TaskStatus, on target: Target) -> StatusDisplay {
        switch status {
        case .running: StatusDisplay(title: "Running", tone: .running)
        case .needsInput: StatusDisplay(title: "Needs you", tone: .attention)
        case .idle: target.isCloud
            ? StatusDisplay(title: "In cloud", tone: .cloud)
            : StatusDisplay(title: "Done", tone: .done)
        case .failed: StatusDisplay(title: "Failed", tone: .failed)
        case .stopped: StatusDisplay(title: "Stopped", tone: .stopped)
        case .unknown: StatusDisplay(title: "Unknown", tone: .unknown)
        }
    }
}

extension TaskSummary {
    var statusDisplay: StatusDisplay { .of(status, on: target) }
}
