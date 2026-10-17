import SwiftUI

struct ProfileView: View {
    let botId: BotID

    enum Tab: String, CaseIterable {
        case info = "Info", library = "Library", agents = "Agents", links = "Links"
    }

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var tab: Tab
    @State private var name = ""
    @State private var label = ""
    @FocusState private var editing: Bool

    init(botId: BotID, tab: Tab = .info) {
        self.botId = botId
        _tab = State(initialValue: tab)
    }

    var body: some View {
        if let bot = store.bots[botId] {
            ScrollView {
                VStack(spacing: 20) {
                    AvatarView(avatar: bot.avatar, size: 96, needsAttention: bot.question != nil, animated: bot.status == .working)
                        .padding(.top, 8)
                    nameCard(bot)
                    tabBar
                    content(bot)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // On iPad the profile sits beside the chat, whose own menu already fills this slot.
                if sizeClass == .compact {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                client.send(.updateBot(botId: botId, patch: BotPatch(pinned: !bot.pinned)))
                            } label: {
                                Label(bot.pinned ? "Unpin" : "Pin", systemImage: bot.pinned ? "pin.slash" : "pin")
                            }
                            Button {
                                client.send(.updateBot(botId: botId, patch: BotPatch(hidden: !bot.hidden)))
                            } label: {
                                Label(bot.hidden ? "Show in sidebar" : "Hide from sidebar", systemImage: bot.hidden ? "eye" : "eye.slash")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .accessibilityLabel("More")
                    }
                }
            }
            .onAppear {
                name = bot.name
                label = bot.title ?? ""
                client.send(.details(botId: botId))
            }
            .onChange(of: bot.name) { _, new in if !editing { name = new } }
            .onChange(of: bot.title) { _, new in if !editing { label = new ?? "" } }
            .onChange(of: editing) { _, now in if !now { commit(bot) } }
        }
    }

    private func nameCard(_ bot: Bot) -> some View {
        VStack(spacing: 0) {
            TextField("Name", text: $name)
                .font(.system(size: 22, weight: .bold))
                .multilineTextAlignment(.center)
                .focused($editing)
                .submitLabel(.done)
                .padding(.vertical, 16)
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.horizontal, 16)
            TextField("Add a label", text: $label)
                .font(.system(size: 16))
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
                .focused($editing)
                .submitLabel(.done)
                .padding(.vertical, 14)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func commit(_ bot: Bot) {
        let newName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let newLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        var patch = BotPatch()
        if !newName.isEmpty, newName != bot.name { patch.name = newName }
        if newLabel != (bot.title ?? "") { patch.title = .some(newLabel.isEmpty ? nil : newLabel) }
        if newName.isEmpty { name = bot.name }
        if patch != BotPatch() { client.send(.updateBot(botId: botId, patch: patch)) }
    }

    private var tabBar: some View {
        HStack(spacing: 24) {
            ForEach(Tab.allCases, id: \.self) { item in
                Button {
                    tab = item
                } label: {
                    VStack(spacing: 8) {
                        Text(item.rawValue)
                            .font(.system(size: 16, weight: tab == item ? .semibold : .regular))
                            .foregroundStyle(tab == item ? .white : Theme.tertiary)
                        Rectangle()
                            .fill(tab == item ? Color.white : .clear)
                            .frame(height: 2)
                    }
                    .fixedSize()
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
    }

    @ViewBuilder
    private func content(_ bot: Bot) -> some View {
        let details = store.details[botId]
        switch tab {
        case .info:
            InfoTab(bot: bot)
        case .library:
            LibraryTab(botId: botId, files: details?.library)
        case .agents:
            AgentsTab(agents: details?.agents)
        case .links:
            LinksTab(links: details?.links)
        }
    }
}

private struct CardSection<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 14))
                .foregroundStyle(Theme.tertiary)
                .padding(.horizontal, 16)
            VStack(spacing: 0) { content }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            if let footer {
                Text(footer)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.tertiary)
                    .padding(.horizontal, 16)
            }
        }
    }
}

private struct Placeholder: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 15))
            .foregroundStyle(Theme.tertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .padding(.horizontal, 20)
    }
}

private struct Loading: View {
    var body: some View {
        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
    }
}

private struct InfoTab: View {
    let bot: Bot
    @Environment(BridgeClient.self) private var client

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            // A bot without routines leads with its look, the way the reference does.
            if bot.routines.isEmpty {
                character
                routines
            } else {
                routines
                character
            }
        }
    }

    private var routines: some View {
        CardSection(title: "Routines") {
            if bot.routines.isEmpty {
                Placeholder(text: "Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.")
            } else {
                ForEach(Array(bot.routines.enumerated()), id: \.element.id) { index, routine in
                    if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16) }
                    Toggle(isOn: Binding(
                        get: { routine.enabled },
                        set: { client.send(.setRoutine(botId: bot.id, routineId: routine.id, enabled: $0)) }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(routine.name).font(.system(size: 16)).foregroundStyle(.white)
                            Text(routine.enabled ? routine.describe : "Paused")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.secondary)
                        }
                    }
                    .tint(AvatarColor.teal.color)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
        }
    }

    private var character: some View {
        CardSection(title: "Character", footer: "How this Bot looks everywhere: the list, the chat, and the color of your messages.") {
            AvatarPicker(bot: bot)
        }
    }
}

struct AvatarPicker: View {
    let bot: Bot
    @Environment(BridgeClient.self) private var client

    private func set(_ avatar: Avatar) {
        client.send(.updateBot(botId: bot.id, patch: BotPatch(avatar: avatar)))
    }

    var body: some View {
        VStack(spacing: 0) {
            CenteredRows(AvatarShape.allCases, perRow: 5, cell: 64, spacing: 8) { shape in
                    Button { set(Avatar(shape: shape, color: bot.avatar.color)) } label: {
                        AvatarBody(shape: shape)
                            .fill(bot.avatar.color.color)
                            .frame(width: 40, height: 40)
                            .padding(5)
                            .overlay(Circle().strokeBorder(bot.avatar.shape == shape ? Theme.secondary : .clear, lineWidth: 2).padding(-2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(shape.rawValue)
                    .accessibilityAddTraits(bot.avatar.shape == shape ? .isSelected : [])
            }
            .padding(.top, 18)
            .padding(.horizontal, 12)

            CenteredRows(AvatarColor.allCases, perRow: 6, cell: 54, spacing: 8) { color in
                    Button { set(Avatar(shape: bot.avatar.shape, color: color)) } label: {
                        Circle()
                            .fill(color.color)
                            .frame(width: 30, height: 30)
                            .padding(4)
                            .overlay(Circle().strokeBorder(bot.avatar.color == color ? Theme.secondary : .clear, lineWidth: 2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(color.rawValue)
                    .accessibilityAddTraits(bot.avatar.color == color ? .isSelected : [])
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 22)

            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.horizontal, 16)
            Button("Restore default") { set(.standard) }
                .font(.system(size: 16))
                .foregroundStyle(Theme.link)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .disabled(bot.avatar == .standard)
        }
    }
}

/// A grid whose short last row is centered, like the reference picker.
private struct CenteredRows<Item: Hashable, Cell: View>: View {
    let rows: [[Item]]
    let cell: CGFloat
    let spacing: CGFloat
    let content: (Item) -> Cell

    init(_ items: [Item], perRow: Int, cell: CGFloat, spacing: CGFloat, @ViewBuilder content: @escaping (Item) -> Cell) {
        rows = stride(from: 0, to: items.count, by: perRow).map { Array(items[$0..<min($0 + perRow, items.count)]) }
        self.cell = cell
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        VStack(spacing: spacing) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(row, id: \.self) { item in
                        content(item).frame(width: cell, height: cell)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct LibraryTab: View {
    let botId: BotID
    let files: [LibraryFile]?
    @Environment(Router.self) private var router

    var body: some View {
        if let files {
            if files.isEmpty {
                Placeholder(text: "Pages, files, and apps this Bot makes show up here.")
            } else {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(Library.groups(files), id: \.title) { group in
                        CardSection(title: group.title) {
                            ForEach(Array(group.files.enumerated()), id: \.element.path) { index, file in
                                if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 52) }
                                Button { router.path.append(.file(botId, path: file.path)) } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: FileView.symbol(for: file.path))
                                            .font(.system(size: 18))
                                            .foregroundStyle(Theme.secondary)
                                            .frame(width: 24)
                                        Text((file.path as NSString).lastPathComponent).font(.system(size: 16)).foregroundStyle(.white).lineLimit(1)
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                                    }
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 14)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        } else {
            Loading()
        }
    }
}

private struct AgentsTab: View {
    let agents: [Agent]?
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let agents {
            if agents.isEmpty {
                Placeholder(text: "Agents this Bot starts for coding work show up here.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(agents.sorted { $0.updatedAt > $1.updatedAt }.enumerated()), id: \.element.id) { index, agent in
                        if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16) }
                        Button { router.path.append(.exchange(agent.id)) } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(alignment: .firstTextBaseline) {
                                    Text(agent.title).font(.system(size: 16, weight: .medium)).foregroundStyle(.white).lineLimit(2)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                                }
                                HStack(spacing: 8) {
                                    AgentStatusPill(status: agent.status)
                                    Label(agent.projectName, systemImage: agent.where == .cloud ? "cloud" : "laptopcomputer")
                                        .font(.system(size: 13))
                                        .foregroundStyle(Theme.secondary)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                    if let url = agent.url {
                                        Button("Open in Claude") { openURL(url) }
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(Theme.link)
                                    }
                                }
                            }
                            .padding(16)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
        } else {
            Loading()
        }
    }
}

private struct LinksTab: View {
    let links: [BotLink]?
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let links {
            if links.isEmpty {
                Placeholder(text: "Links from this chat show up here.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(links.enumerated()), id: \.element.url) { index, link in
                        if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 60) }
                        Button { openURL(link.url) } label: {
                            HStack(spacing: 14) {
                                Image(systemName: Self.symbol(for: link.host))
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(.black)
                                    .frame(width: 30, height: 30)
                                    .background(.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(link.host).font(.system(size: 16, weight: .medium)).foregroundStyle(.white)
                                    Text(link.url.absoluteString)
                                        .font(.system(size: 13))
                                        .foregroundStyle(Theme.secondary)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
        } else {
            Loading()
        }
    }

    static func symbol(for host: String) -> String {
        switch host {
        case "github.com": "chevron.left.forwardslash.chevron.right"
        case "claude.ai": "sparkle"
        default: "link"
        }
    }
}
