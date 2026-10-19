import SwiftUI

/// The bot's saved skills in its profile. Shown when the bridge lists .skills.
struct SkillsSection: View {
    let bot: Bot
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @State private var deleting: Skill?

    enum Content: Equatable {
        case hidden
        case loading
        case skills([Skill])
    }

    static func content(_ store: AppStore, bot: BotID) -> Content {
        guard store.has(.skills) else { return .hidden }
        guard let skills = store.skills[bot] else { return .loading }
        return .skills(skills)
    }

    var body: some View {
        let content = Self.content(store, bot: bot.id)
        if content != .hidden {
            CardSection(title: "Skills", footer: "Instructions this Bot saved to reuse in later chats. Deleting one only removes it from this Bot.") {
                switch content {
                case .hidden:
                    EmptyView()
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
                case let .skills(skills) where skills.isEmpty:
                    Placeholder(text: "No skills yet. Ask this Bot in chat to save one for a task you repeat.")
                case let .skills(skills):
                    ForEach(Array(skills.enumerated()), id: \.element.id) { index, skill in
                        if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16) }
                        row(skill)
                    }
                }
            }
            .task(id: bot.id) { client.send(.skills(botId: bot.id)) }
            .confirmationDialog(
                "Delete the skill \(deleting?.name ?? "")?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible,
                presenting: deleting
            ) { skill in
                Button("Delete Skill", role: .destructive) { client.send(.deleteSkill(botId: bot.id, name: skill.name)) }
            } message: { _ in
                Text("\(bot.name) will no longer load it.")
            }
        } else if store.lacks(.skills) {
            NeedsNewerBridge(title: "Skills", what: "see and delete the skills this Bot saved")
        }
    }

    private func row(_ skill: Skill) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name).font(.ui(size: 16)).foregroundStyle(.white)
                Text(skill.description)
                    .font(.ui(size: 13))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(2)
                Text("Saved \(skill.updatedAt.formatted(.relative(presentation: .named)))")
                    .font(.ui(size: 12))
                    .foregroundStyle(Theme.tertiary)
            }
            Spacer(minLength: 0)
            Button { deleting = skill } label: {
                Image(systemName: "trash").font(.ui(size: 15)).foregroundStyle(Theme.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete \(skill.name)")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
