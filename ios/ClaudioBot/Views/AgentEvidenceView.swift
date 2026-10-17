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

/// The agent's own worktree, and whether the phone may ask to remove it now. The bridge refuses a dirty one itself.
struct AgentWorktreeRow: Equatable {
    var branch: String
    var removable: Bool

    static func of(_ agent: Agent, features: Set<Feature>) -> AgentWorktreeRow? {
        guard features.contains(.worktrees), let w = agent.worktree else { return nil }
        let busy: Set<AgentStatus> = [.working, .awaitingApproval, .parked]
        return AgentWorktreeRow(branch: w.branch, removable: !busy.contains(agent.status))
    }
}

/// What the bridge read from git after the agent's turn, and its worktree with a remove button. Shown when the bridge lists .worktrees.
struct AgentEvidenceSection: View {
    let agent: Agent

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.openURL) private var openURL
    @State private var confirming = false

    var body: some View {
        VStack(spacing: 10) {
            evidence
            worktree
        }
    }

    @ViewBuilder private var worktree: some View {
        if let row = AgentWorktreeRow.of(agent, features: store.features) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Own worktree on \(row.branch)", systemImage: "square.on.square.dashed")
                    .foregroundStyle(.white)
                Text("In ~/.claudiobot-worktrees, so your checkout stays as you left it.")
                    .foregroundStyle(Theme.secondary)
                Button(role: .destructive) { confirming = true } label: {
                    Label("Remove worktree", systemImage: "trash")
                }
                .buttonStyle(.plain)
                .foregroundStyle(row.removable ? Theme.danger : Theme.tertiary)
                .disabled(!row.removable)
                .confirmationDialog("Remove this worktree?", isPresented: $confirming, titleVisibility: .visible) {
                    Button("Remove", role: .destructive) { client.send(.removeWorktree(agentId: agent.id)) }
                } message: {
                    Text("The folder goes away. The branch \(row.branch) keeps every commit. The agent cannot continue after this.")
                }
            }
            .font(.system(size: 14))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    @ViewBuilder private var evidence: some View {
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
