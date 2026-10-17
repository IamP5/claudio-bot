import SwiftUI

extension Color {
    static let claude = Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
}

enum ModelChoice: String, CaseIterable, Identifiable {
    case opus, sonnet, haiku, fable
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

extension PermissionMode {
    static let choices: [PermissionMode] = [.default, .acceptEdits, .plan, .auto]

    var title: String {
        switch self {
        case .default: "Ask before edits"
        case .acceptEdits: "Auto-accept edits"
        case .plan: "Plan only"
        case .auto: "Auto"
        case .bypassPermissions: "Bypass permissions"
        }
    }

    var explanation: String {
        switch self {
        case .default: "Claude asks you before it edits a file or runs a command."
        case .acceptEdits: "File edits apply right away. Commands still ask first."
        case .plan: "Claude reads and proposes a plan. Nothing on disk changes."
        case .auto: "Claude runs what looks safe and asks only for risky actions."
        case .bypassPermissions: "Claude never asks. Use only in a sandbox."
        }
    }
}

extension TaskStatus {
    var title: String {
        switch self {
        case .running: "Running"
        case .needsInput: "Needs you"
        case .idle: "Done"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }

    var color: Color {
        switch self {
        case .running: .claude
        case .needsInput: .yellow
        case .idle: .green
        case .failed: .red
        case .stopped: .gray
        }
    }
}

enum ToolSymbol {
    private static let table: [String: String] = [
        "Bash": "terminal",
        "Read": "doc.text",
        "Edit": "pencil",
        "MultiEdit": "pencil",
        "Write": "pencil",
        "NotebookEdit": "pencil",
        "Grep": "magnifyingglass",
        "Glob": "magnifyingglass",
        "Task": "person.2",
        "Agent": "person.2",
        "TodoWrite": "checklist",
    ]

    static func name(for tool: String) -> String {
        if let symbol = table[tool] { return symbol }
        if tool.hasPrefix("Web") { return "globe" }
        if tool.hasPrefix("mcp__") { return "puzzlepiece.extension" }
        return "wrench.and.screwdriver"
    }
}

struct TargetBadge: View {
    let target: Target

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: target.isCloud ? "cloud" : "laptopcomputer")
            Text(target.isCloud ? "Cloud" : "Mac")
        }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(.secondary)
            .background(.fill.tertiary, in: Capsule())
    }
}

struct StatusPill: View {
    let status: TaskStatus

    var body: some View {
        HStack(spacing: 5) {
            StatusDot(color: status.color, pulsing: status == .running)
            Text(status.title)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(status == .needsInput ? Color.primary : status.color)
        .background(status.color.opacity(0.16), in: Capsule())
    }
}

struct StatusDot: View {
    let color: Color
    var pulsing = false
    @State private var expanded = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .background {
                if pulsing {
                    Circle()
                        .fill(color.opacity(0.5))
                        .scaleEffect(expanded ? 2.4 : 1)
                        .opacity(expanded ? 0 : 1)
                        .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: expanded)
                        .onAppear { expanded = true }
                }
            }
    }
}

struct ConnectionBadge: View {
    let state: ConnectionState

    var body: some View {
        HStack(spacing: 6) {
            switch state {
            case .connected(let machine):
                StatusDot(color: .green)
                Text(machine)
            case .connecting:
                ProgressView().controlSize(.mini)
                Text("Connecting")
            case .disconnected(let retryAt):
                StatusDot(color: .orange)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = Int(max(0, retryAt.timeIntervalSince(context.date)).rounded(.up))
                    Text(seconds > 0 ? "Retrying in \(seconds)s" : "Reconnecting")
                        .monospacedDigit()
                }
            case .unpaired:
                StatusDot(color: .gray)
                Text("Not paired")
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.primary)
        .lineLimit(1)
    }
}

extension ConnectionState {
    var summary: String {
        switch self {
        case .unpaired: "Not paired"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .disconnected: "Reconnecting"
        }
    }
}

enum Format {
    static func cost(_ usd: Double) -> String {
        usd < 0.01 && usd > 0 ? String(format: "$%.4f", usd) : String(format: "$%.3f", usd)
    }

    static func duration(ms: Double) -> String {
        let seconds = ms / 1000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        let whole = Int(seconds.rounded())
        return "\(whole / 60)m \(String(format: "%02d", whole % 60))s"
    }
}
