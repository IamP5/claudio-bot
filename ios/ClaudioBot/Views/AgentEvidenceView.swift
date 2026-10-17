import SwiftUI

/// What the section shows for one agent: git's facts as the bridge read them after the agent's last turn.
struct AgentEvidenceSummary: Equatable {
    var place: String
    var work: String
    var dirty: Bool
    var pr: URL?
    var checkedAt: Date

    /// Nil when the bridge does not list .worktrees or has read nothing for this agent.
    static func of(_ agent: Agent, features: Set<Feature>) -> AgentEvidenceSummary? {
        guard features.contains(.worktrees), let e = agent.evidence else { return nil }
        let head = e.head.map { " at \($0)" } ?? ""
        let commits = e.ahead == 1 ? "1 commit" : "\(e.ahead) commits"
        let files = e.changed == 1 ? "1 file" : "\(e.changed) files"
        return AgentEvidenceSummary(
            place: e.branch.map { "On \($0)\(head)" } ?? "Detached\(head)",
            work: "\(commits) ahead, \(files) changed (+\(e.insertions) −\(e.deletions))",
            dirty: e.dirty,
            pr: e.pr,
            checkedAt: e.at
        )
    }
}

/// What the bridge read from git after the agent's turn, and its worktree with a remove button. Shown when the bridge lists .worktrees.
struct AgentEvidenceSection: View {
    let agent: Agent

    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let summary = AgentEvidenceSummary.of(agent, features: store.features) {
            VStack(alignment: .leading, spacing: 6) {
                Label(summary.place, systemImage: "arrow.triangle.branch")
                    .foregroundStyle(.white)
                Text(summary.work)
                    .foregroundStyle(Theme.secondary)
                if summary.dirty {
                    Label("Uncommitted changes", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.danger)
                }
                if let pr = summary.pr {
                    Button { openURL(pr) } label: {
                        Label(pr.lastPathComponent.isEmpty ? "Pull request" : "Pull request #\(pr.lastPathComponent)", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                }
                Text("Read from git \(summary.checkedAt, style: .relative) ago")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.tertiary)
            }
            .font(.system(size: 14))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
}
