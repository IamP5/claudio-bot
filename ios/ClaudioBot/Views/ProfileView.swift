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
    @Namespace private var tabs
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(botId: BotID, tab: Tab = .info) {
        self.botId = botId
        _tab = State(initialValue: tab)
    }

    var body: some View {
        if let bot = store.bots[botId] {
            ScrollView {
                VStack(spacing: ProfileMetrics.stackSpacing) {
                    header(bot)
                    if bot.isGroup {
                        GroupDetails(group: bot)
                    } else {
                        tabBar
                        content(bot)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            #if os(macOS)
            // The window's toolbar floats over the inspector column; a hard edge keeps scrolled rows from showing through it.
            .scrollEdgeEffectStyle(.hard, for: .top)
            #endif
            .background(Theme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // On iPad the profile sits beside the chat, whose own menu already fills this slot.
                if sizeClass == .compact {
                    ToolbarItem(placement: Self.menuPlacement) {
                        Menu {
                            Button {
                                client.send(.updateBot(botId: botId, patch: BotPatch(pinned: !bot.pinned)))
                            } label: {
                                Label(bot.pinned ? "Unpin" : "Pin", systemImage: bot.pinned ? "pin.slash" : "pin")
                            }
                            Button {
                                client.send(.updateBot(botId: botId, patch: BotPatch(hidden: !bot.hidden)))
                            } label: {
                                Label(bot.hidden ? Self.showLabel : Self.hideLabel, systemImage: bot.hidden ? "eye" : "eye.slash")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .accessibilityLabel("More")
                        .help("More")
                    }
                }
            }
            .onAppear {
                name = bot.name
                label = bot.title ?? ""
                if !bot.isGroup { client.send(.details(botId: botId)) }
            }
            .onChange(of: bot.name) { _, new in if !editing { name = new } }
            .onChange(of: bot.title) { _, new in if !editing { label = new ?? "" } }
            .onChange(of: editing) { _, now in if !now { commit(bot) } }
        }
    }

    #if os(macOS)
    /// Trailing, where the chat keeps its own menu. `.primaryAction` would put it beside Back.
    private static let menuPlacement = ToolbarItemPlacement.automatic
    private static let showLabel = "Show in Sidebar", hideLabel = "Hide from Sidebar"
    #else
    private static let menuPlacement = ToolbarItemPlacement.topBarTrailing
    private static let showLabel = "Show in sidebar", hideLabel = "Hide from sidebar"
    #endif

    /// The old look leaves and the new one arrives inside a container that animates, so the two cross instead of
    /// swapping in one frame.
    private func avatar(_ bot: Bot) -> some View {
        ZStack {
            BotAvatar(bot: bot, size: ProfileMetrics.avatar, needsAttention: bot.question != nil, motion: bot.motion)
                .id(bot.avatar)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.85).combined(with: .opacity))
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25), value: bot.avatar)
    }

    #if os(macOS)
    /// Grok Bot's details header: the avatar, then the name and label as quiet fields that edit in place.
    private func header(_ bot: Bot) -> some View {
        VStack(spacing: 0) {
            avatar(bot)
            TextField("Name", text: $name)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .textFieldStyle(.plain)
                .focusEffectDisabled()
                .focused($editing)
                .padding(.top, 10)
            TextField("Add a label", text: $label)
                .font(.callout)
                .foregroundStyle(Theme.tertiary)
                .multilineTextAlignment(.center)
                .textFieldStyle(.plain)
                .focusEffectDisabled()
                .focused($editing)
                .padding(.top, 2)
        }
        .padding(.top, 16)
    }
    #else
    private func header(_ bot: Bot) -> some View {
        VStack(spacing: 20) {
            avatar(bot).padding(.top, 8)
            nameCard(bot)
        }
    }

    private func nameCard(_ bot: Bot) -> some View {
        VStack(spacing: 0) {
            TextField("Name", text: $name)
                .font(.ui(size: 22, weight: .bold))
                .multilineTextAlignment(.center)
                .focused($editing)
                .submitLabel(.done)
                .padding(.vertical, 16)
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.horizontal, 16)
            TextField("Add a label", text: $label)
                .font(.ui(size: 16))
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
                .focused($editing)
                .submitLabel(.done)
                .padding(.vertical, 14)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
    #endif

    private func commit(_ bot: Bot) {
        let newName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let newLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        var patch = BotPatch()
        if !newName.isEmpty, newName != bot.name { patch.name = newName }
        if newLabel != (bot.title ?? "") { patch.title = .some(newLabel.isEmpty ? nil : newLabel) }
        if newName.isEmpty { name = bot.name }
        if patch != BotPatch() { client.send(.updateBot(botId: botId, patch: patch)) }
    }

    #if os(macOS)
    /// Text tabs with a pill behind the selected one, as in Grok Bot's details pane. Every label keeps one weight, so
    /// selecting a tab never shifts the others. Only the pill moves; the content swaps at once.
    private var tabBar: some View {
        HStack(spacing: 2) {
            ForEach(Tab.allCases, id: \.self) { item in
                Button { tab = item } label: {
                    Text(item.rawValue)
                        .font(.ui(size: 16))
                        .foregroundStyle(tab == item ? .white : Theme.secondary)
                        .padding(.horizontal, 12)
                        .frame(height: 26)
                        .background {
                            if tab == item {
                                Capsule().fill(Theme.card).matchedGeometryEffect(id: "pill", in: tabs)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == item ? .isSelected : [])
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: tab)
    }
    #else
    private var tabBar: some View {
        HStack(spacing: 24) {
            ForEach(Tab.allCases, id: \.self) { item in
                Button {
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { tab = item }
                } label: {
                    VStack(spacing: 8) {
                        Text(item.rawValue)
                            .font(.ui(size: 16, weight: tab == item ? .semibold : .regular))
                            .foregroundStyle(tab == item ? .white : Theme.tertiary)
                        ZStack {
                            Rectangle().fill(.clear)
                            if tab == item {
                                Rectangle().fill(.white).matchedGeometryEffect(id: "underline", in: tabs)
                            }
                        }
                        .frame(height: 2)
                    }
                    .fixedSize()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
        .sensoryFeedback(.selection, trigger: tab)
    }
    #endif

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

/// The profile's measurements: an iPhone page, or on a Mac the narrow inspector column of Grok Bot's details pane.
enum ProfileMetrics {
    #if os(macOS)
    static let avatar: CGFloat = 64
    static let stackSpacing: CGFloat = 16
    static let sectionSpacing: CGFloat = 20
    static let cardRadius: CGFloat = 12
    static let buttonRadius: CGFloat = 12
    static let labelInset: CGFloat = 12
    static let labelColor = Theme.secondary
    #else
    static let avatar: CGFloat = 96
    static let stackSpacing: CGFloat = 20
    static let sectionSpacing: CGFloat = 24
    static let cardRadius: CGFloat = 22
    static let buttonRadius: CGFloat = 18
    static let labelInset: CGFloat = 16
    static let labelColor = Theme.tertiary
    #endif

    static var card: RoundedRectangle { RoundedRectangle(cornerRadius: cardRadius, style: .continuous) }
}

struct CardSection<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.ui(size: 14))
                .foregroundStyle(ProfileMetrics.labelColor)
                .padding(.horizontal, ProfileMetrics.labelInset)
            VStack(spacing: 0) { content }
                .background(Theme.card, in: ProfileMetrics.card)
            if let footer {
                Text(footer)
                    .font(.ui(size: 13))
                    .foregroundStyle(Theme.tertiary)
                    .padding(.horizontal, ProfileMetrics.labelInset)
            }
        }
    }
}

struct Placeholder: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.ui(size: 15))
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
    @Environment(Router.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: ProfileMetrics.sectionSpacing) {
            // A bot without routines leads with its look, the way the reference does.
            if bot.routines.isEmpty {
                character
                routines
            } else {
                routines
                character
            }
            SpendingSection(bot: bot)
            MuteSection(bot: bot)
            ConnectorsSection(bot: bot)
            SkillsSection(bot: bot)
        }
    }

    private var routines: some View {
        CardSection(title: "Routines") {
            if bot.routines.isEmpty {
                Placeholder(text: "Routines are recurring tasks this Bot runs on a schedule. Ask it in chat to set one up.")
            } else {
                ForEach(Array(bot.routines.enumerated()), id: \.element.id) { index, routine in
                    if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16) }
                    HStack(spacing: 12) {
                        Button { router.path.append(.routine(bot.id, routine.id)) } label: {
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(routine.name).font(.ui(size: 16)).foregroundStyle(.white)
                                    Text(routine.enabled ? routine.describe : "Paused")
                                        .font(.ui(size: 13))
                                        .foregroundStyle(Theme.secondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.ui(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Toggle(routine.name, isOn: Binding(
                            get: { routine.enabled },
                            set: { client.send(.setRoutine(botId: bot.id, routineId: routine.id, enabled: $0)) }
                        ))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .tint(AvatarColor.teal.color)
                    }
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

    /// Five shapes and six colors to a row. On a Mac they fit the inspector at its narrowest, 280 wide.
    private enum Size {
        #if os(macOS)
        static let shapeCell: CGFloat = 46, shape: CGFloat = 32, colorCell: CGFloat = 38, color: CGFloat = 24
        static let inset: CGFloat = 8, top: CGFloat = 14, colorsVertical: CGFloat = 16
        #else
        static let shapeCell: CGFloat = 64, shape: CGFloat = 40, colorCell: CGFloat = 54, color: CGFloat = 30
        static let inset: CGFloat = 12, top: CGFloat = 18, colorsVertical: CGFloat = 22
        #endif
    }

    var body: some View {
        VStack(spacing: 0) {
            CenteredRows(AvatarShape.allCases, perRow: 5, cell: Size.shapeCell, spacing: 8) { shape in
                Swatch(name: shape.spokenName, selected: bot.avatar.shape == shape, ringOutset: 2) {
                    set(Avatar(shape: shape, color: bot.avatar.color))
                } label: {
                    AvatarBody(shape: shape)
                        .fill(bot.avatar.color.color)
                        .frame(width: Size.shape, height: Size.shape)
                        .padding(5)
                }
            }
            .padding(.top, Size.top)
            .padding(.horizontal, Size.inset)

            CenteredRows(AvatarColor.allCases, perRow: 6, cell: Size.colorCell, spacing: 8) { color in
                Swatch(name: color.rawValue.capitalized, selected: bot.avatar.color == color) {
                    set(Avatar(shape: bot.avatar.shape, color: color))
                } label: {
                    Circle()
                        .fill(color.color)
                        .frame(width: Size.color, height: Size.color)
                        .padding(4)
                }
            }
            .padding(.horizontal, Size.inset)
            .padding(.vertical, Size.colorsVertical)

            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.horizontal, 16)
            restore
        }
        .animation(.snappy(duration: 0.2), value: bot.avatar)
        .sensoryFeedback(.selection, trigger: bot.avatar)
    }

    private var restore: some View {
        Button("Restore default") { set(.standard) }
            .font(.ui(size: 16))
            .foregroundStyle(Theme.link)
            #if os(macOS)
            // A plain link-colored label, centered under the centered grid, not a tinted button.
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .padding(12)
            #else
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            #endif
            .disabled(bot.avatar == .standard)
    }
}

/// One shape or color in the picker: a ring when chosen, a fainter one under the pointer, and its name as a tooltip.
private struct Swatch<Label: View>: View {
    let name: String
    let selected: Bool
    var ringOutset: CGFloat = 0
    let action: () -> Void
    @ViewBuilder let label: Label
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label.overlay(
                Circle()
                    .strokeBorder(selected ? Theme.secondary : hovering ? Theme.tertiary.opacity(0.6) : .clear, lineWidth: 2)
                    .padding(-ringOutset)
            )
        }
        .buttonStyle(.pressable)
        .onHover { hovering = $0 }
        .help(name)
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private extension AvatarShape {
    /// What VoiceOver and the tooltip say, rather than the wire name ("star4").
    var spokenName: String {
        switch self {
        case .star4: "Four-point star"
        case .star6: "Six-point star"
        case .drop: "Teardrop"
        default: rawValue.capitalized
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
                                            .font(.ui(size: 18))
                                            .foregroundStyle(Theme.secondary)
                                            .frame(width: 24)
                                        Text((file.path as NSString).lastPathComponent).font(.ui(size: 16)).foregroundStyle(.white).lineLimit(1)
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.ui(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
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
                                    Text(agent.title).font(.ui(size: 16, weight: .medium)).foregroundStyle(.white).lineLimit(2)
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.ui(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                                }
                                HStack(spacing: 8) {
                                    AgentStatusPill(status: agent.status)
                                    Label(agent.projectName, systemImage: agent.where == .cloud ? "cloud" : "laptopcomputer")
                                        .font(.ui(size: 13))
                                        .foregroundStyle(Theme.secondary)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                    if let url = agent.url {
                                        Button("Open in Claude") { openURL(url) }
                                            .font(.ui(size: 13, weight: .semibold))
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
                .background(Theme.card, in: ProfileMetrics.card)
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
                                    .font(.ui(size: 16, weight: .semibold))
                                    .foregroundStyle(.black)
                                    .frame(width: 30, height: 30)
                                    .background(.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(link.host).font(.ui(size: 16, weight: .medium)).foregroundStyle(.white)
                                    Text(link.url.absoluteString)
                                        .font(.ui(size: 13))
                                        .foregroundStyle(Theme.secondary)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.ui(size: 13, weight: .semibold)).foregroundStyle(Theme.tertiary)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Theme.card, in: ProfileMetrics.card)
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
