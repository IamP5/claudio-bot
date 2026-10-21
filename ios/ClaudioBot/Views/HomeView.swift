import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @State private var searching = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @State private var renaming: Bot?
    @State private var newName = ""
    /// The bot the user asked to delete. The dialog waits for its details, which say which worktrees stay behind.
    @State private var deleting: Bot?
    @State private var detailsLate = false
    @State private var lastRetryFailed = false

    private var deletion: Deletion? {
        deleting.flatMap { Deletion($0, details: store.details[$0.id], detailsLate: detailsLate) }
    }

    /// On the Mac the search field always shows, so a query in it is what searching means.
    private var isSearching: Bool {
        #if os(macOS)
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        #else
        searching
        #endif
    }

    private var bots: [Bot] {
        isSearching ? store.bots(matching: query) : store.homeBots
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var router = router
        List(selection: $router.selection) {
            if store.connection == .unrecognized {
                UnrecognizedBanner()
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if store.machine == nil {
                ConnectionBanner(state: store.connection, lastRetryFailed: $lastRetryFailed)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let mismatch = store.protocolMismatch {
                UpdateBanner(mismatch: mismatch)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            #if os(iOS)
            if searching {
                searchField
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            #endif
            ForEach(bots) { bot in
                BotRow(bot: bot)
                    .tag(Selection.bot(bot.id))
                    .listRowSeparator(.hidden)
                    #if os(macOS)
                    .sidebarHover(selected: router.selection == .bot(bot.id))
                    #else
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    .listRowBackground(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(router.selection == .bot(bot.id) ? Theme.card : .clear)
                            .padding(.horizontal, 6)
                    )
                    #endif
                    .contextMenu { menu(for: bot) }
            }
            if bots.isEmpty && store.machine != nil {
                Text(isSearching ? "No bots match." : Self.emptyText)
                    .font(.subheadline)
                    .foregroundStyle(Theme.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        #if os(macOS)
        // The sidebar style draws the only selection, and leaves the column's glass uncovered.
        .listStyle(.sidebar)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: bots.map(\.id))
        .searchable(text: $query, placement: .sidebar, prompt: "Search")
        .searchFocused($searchFocused)
        .focusedSceneValue(\.sidebarSearch, SidebarSearch { searchFocused = true })
        #else
        .listStyle(.plain)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: bots.map(\.id))
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        #endif
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onChange(of: store.machine) { lastRetryFailed = false }
        .alert("Rename Bot", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                if let bot = renaming, !name.isEmpty { client.send(.updateBot(botId: bot.id, patch: BotPatch(name: name))) }
            }
        }
        .overlay(alignment: .bottom) {
            if let bot = deleting, deletion == nil {
                Label {
                    Text("Checking \(bot.name)'s agents…")
                } icon: {
                    ProgressView()
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.bottom, 16)
                .onTapGesture { deleting = nil }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Cancels deleting the bot")
                .task(id: bot.id) {
                    try? await Task.sleep(for: Deletion.patience)
                    if !Task.isCancelled { detailsLate = true }
                }
            }
        }
        .confirmationDialog(
            "Delete \(deleting?.name ?? "Bot")?",
            isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deletion
        ) { deletion in
            Button("Delete", role: .destructive) {
                if router.selection == .bot(deletion.botId) { router.selection = nil }
                client.send(deletion.request)
            }
        } message: { deletion in
            Text(deletion.message)
        }
    }

    /// What deleting a bot says and sends. Nil while the bot's details, which list its agents' worktrees, are on their
    /// way. Once they are late (an older bridge, or offline) it falls back to the text without worktrees.
    struct Deletion: Equatable {
        /// How long the dialog waits for details before offering Delete without them.
        static let patience: Duration = .seconds(3)

        let botId: BotID
        let message: String
        let request: ClientMessage

        init?(_ bot: Bot, details: BotDetails?, detailsLate: Bool) {
            // A group has no agents, so there are no worktrees to wait for.
            guard details != nil || detailsLate || bot.isGroup else { return nil }
            let worktrees = details?.agents.compactMap(\.worktree) ?? []
            botId = bot.id
            message = HomeView.deleteMessage(bot, worktrees: worktrees)
            // The bridge refuses a bot whose agents hold worktrees unless forced. The message says they stay on the Mac.
            request = .deleteBot(botId: bot.id, force: !worktrees.isEmpty)
        }
    }

    /// The bridge moves the bot's home to its trash folder and keeps every agent worktree until the user removes it.
    nonisolated static func deleteMessage(_ bot: Bot, worktrees: [Worktree]) -> String {
        if bot.isGroup { return "Deletes the group \(bot.name) and its chat. Its bots and their own chats stay." }
        let base = "Deletes \(bot.name) and its chat. Its folder, with its files and memory, moves to the bridge's trash folder on your Mac, where you can recover it."
        switch worktrees.count {
        case 0: return base
        case 1: return base + " Its agent's worktree on \(worktrees[0].branch) stays on your Mac. Remove it from the agent first if you no longer need it."
        default: return base + " Its agents' \(worktrees.count) worktrees stay on your Mac. Remove them from each agent first if you no longer need them."
        }
    }

    static var emptyText: String {
        #if os(macOS)
        "No bots yet. Click + to make one."
        #else
        "No bots yet. Tap + to make one."
        #endif
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        SidebarAccountItems(name: store.userName, proposals: store.proposedFacts.count, usage: store.usage, hasUsage: store.has(.usage)) {
            router.showingSettings = true
        } showUsage: {
            router.showingUsage = true
        }
        #if os(iOS)
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                withAnimation { searching.toggle() }
                query = ""
                searchFocused = searching
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .accessibilityLabel("Search")
        }
        #endif
        ToolbarSpacerIfAvailable()
        ToolbarItem(placement: .topBarTrailing) {
            Button { router.showingNewChat = true } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("New chat")
            .help("New Chat")
        }
    }

    #if os(iOS)
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.tertiary)
            TextField("Search", text: $query)
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel") {
                withAnimation { searching = false }
                query = ""
            }
            .foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.card, in: Capsule())
    }
    #endif

    @ViewBuilder
    private func menu(for bot: Bot) -> some View {
        OpenInNewWindowButton(selection: .bot(bot.id))
        Button {
            client.send(.updateBot(botId: bot.id, patch: BotPatch(pinned: !bot.pinned)))
        } label: {
            Label(bot.pinned ? "Unpin" : "Pin", systemImage: bot.pinned ? "pin.slash" : "pin")
        }
        Button {
            if router.selection == .bot(bot.id) { router.selection = nil }
            client.send(.markUnread(botId: bot.id))
        } label: {
            Label("Mark as Unread", systemImage: "message.badge")
        }
        Button {
            newName = bot.name
            renaming = bot
        } label: {
            Label(bot.isGroup ? "Rename Group" : "Rename Bot", systemImage: "pencil")
        }
        Divider()
        Button {
            client.send(.updateBot(botId: bot.id, patch: BotPatch(hidden: !bot.hidden)))
        } label: {
            Label(bot.hidden ? "Show in Sidebar" : "Hide from Sidebar", systemImage: bot.hidden ? "eye" : "eye.slash")
        }
        Button(role: .destructive) {
            detailsLate = false
            deleting = bot
            // The agents and their worktrees, so the dialog can say which stay behind.
            if store.details[bot.id] == nil { client.send(.details(botId: bot.id)) }
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }
}

struct BotRow: View {
    let bot: Bot

    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    #if os(macOS)
    /// Grok's sidebar row: a 36 avatar and a 54 tall row, with the name in regular weight.
    private static let avatar: CGFloat = 36, gap: CGFloat = 8, lineGap: CGFloat = 2, inset: CGFloat = 9
    private static let nameWeight: Font.Weight = .regular
    #else
    private static let avatar: CGFloat = 46, gap: CGFloat = 14, lineGap: CGFloat = 4, inset: CGFloat = 16
    private static let nameWeight: Font.Weight = .semibold
    #endif

    var body: some View {
        let display = RowDisplay(bot)
        let activity = bot.status == .working ? ActivityLine.text(in: store, botId: bot.id) : nil
        HStack(spacing: Self.gap) {
            BotAvatar(bot: bot, size: Self.avatar, needsAttention: display.needsAttention, motion: bot.motion)
            VStack(alignment: .leading, spacing: Self.lineGap) {
                HStack(alignment: .firstTextBaseline) {
                    Text(bot.name)
                        .font(.ui(size: 16, weight: Self.nameWeight))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .layoutPriority(1)
                    #if os(iOS)
                    BotStatusChip(status: bot.status)
                    #endif
                    Spacer(minLength: 8)
                    if bot.pinned {
                        Image(systemName: "pin.fill").font(.ui(size: 10)).foregroundStyle(Theme.tertiary)
                    }
                    Text(TimeLabel.home(bot.lastAt))
                        .font(.ui(size: 13))
                        .foregroundStyle(Theme.tertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
                HStack(spacing: 6) {
                    preview(display, activity: activity)
                    .font(.ui(size: 14))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
                    Spacer(minLength: 4)
                    if display.unreadDot {
                        Circle().fill(Theme.unread).frame(width: 8, height: 8)
                            .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
                    }
                }
            }
        }
        .padding(.vertical, Self.inset)
        .animation(.snappy(duration: 0.2), value: display.unreadDot)
        .animation(.snappy(duration: 0.2), value: display.needsAttention)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(display.unreadDot ? "Unread" : "")
    }

    private func preview(_ display: RowDisplay, activity: String?) -> Text {
        let text = if let activity {
            Text(activity).italic()
        } else if display.previewIsQuestion {
            Text(Image(systemName: "list.bullet.rectangle")) + Text(" ") + Text(display.preview)
        } else {
            Text(display.preview)
        }
        #if os(macOS)
        // A sidebar row is too narrow for a pill beside the name, so the status leads the preview line.
        if let chip = bot.status.chip {
            return Text(chip).fontWeight(.medium).foregroundStyle(Self.chipColor(bot.status)) + Text(" · ") + text
        }
        #endif
        return text
    }

    #if os(macOS)
    /// BotStatusChip's colors.
    private static func chipColor(_ status: BotStatus) -> Color {
        switch status {
        case .awaitingApproval: Theme.attention
        case .unavailable: AvatarColor.red.color
        default: Theme.secondary
        }
    }
    #endif
}

struct ConnectionBanner: View {
    let state: ConnectionState
    var staleSince: Date?
    @Binding var lastRetryFailed: Bool
    @Environment(AppModel.self) private var app
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var editingAddress = false

    /// `brief` drops the advice, which at accessibility sizes would push the buttons and the list off the screen.
    static func cause(_ reach: Reach, address: String?, lastRetryFailed: Bool, brief: Bool = false) -> String {
        let at = address.map { " at \($0)" } ?? ""
        switch reach {
        case .firstConnect:
            return "Connecting to your Mac\(at)."
        case .unreachable, .retrying:
            let head = lastRetryFailed ? "Still no answer from your Mac\(at)." : "Your Mac isn't answering\(at)."
            return brief ? head : head + " Check the bridge is running. Away from home, connect with your Mac's Tailscale name, or pair again."
        case .connected, .unrecognized, .unpaired:
            return "ClaudioBot needs the bridge running on your Mac. Your bots keep working there while this \(ThisDevice.casualNoun) is away."
        }
    }

    static func retry(_ client: BridgeClient) async -> Bool {
        let answered = await client.retryNowAndWait()
        if !answered { AccessibilityNotification.Announcement("Still no answer from your Mac.").post() }
        return answered
    }

    var body: some View {
        let reach = Reach(state, failures: client.failures, greeted: store.bridgeProtocol != nil)
        VStack(alignment: .leading, spacing: 8) {
            ConnectionBadge(state: state)
            Text(Self.cause(reach, address: client.pairing?.url.bridgeAddress, lastRetryFailed: lastRetryFailed, brief: typeSize.isAccessibilitySize))
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let staleSince {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(SessionText.updated(staleSince, now: context.date) + (typeSize.isAccessibilitySize ? "." : ". Rows show what your Mac said then."))
                        .font(.footnote)
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if reach.lost {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { actions(trying: reach == .retrying) }
                    VStack(alignment: .leading, spacing: 8) { actions(trying: reach == .retrying) }
                }
                .font(.footnote.weight(.semibold))
                .controlSize(.small)
            }
        }
        .sheet(isPresented: $editingAddress) { EditAddressView() }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func actions(trying: Bool) -> some View {
        Button("Retry now") {
            Task { lastRetryFailed = !(await Self.retry(client)) }
        }
        .bannerProminent()
        .disabled(trying)
        Button("Edit address") { editingAddress = true }
            .buttonStyle(.bordered)
        Button("Pair again") { app.beginPairing() }
            .buttonStyle(.bordered)
    }
}

/// The bridge answered with 401. The pairing is kept: this may be another network, or the Mac may need a new code.
struct UnrecognizedBanner: View {
    @Environment(AppModel.self) private var app
    @Environment(BridgeClient.self) private var client

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ConnectionBadge(state: .unrecognized)
            Text("This bridge doesn't recognize this \(ThisDevice.noun). Pair again, or retry once you are back on your Mac's network.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            HStack(spacing: 8) {
                Button("Pair again") { app.beginPairing() }
                    .bannerProminent()
                Button("Retry") { client.retryNow() }
                    .buttonStyle(.bordered)
            }
            .font(.footnote.weight(.semibold))
            .controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The bridge and the app speak protocols too far apart for everything to work.
struct UpdateBanner: View {
    let mismatch: ProtocolMismatch

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(mismatch == .updateBridge ? "Update the bridge" : "Update the app", systemImage: "arrow.triangle.2.circlepath")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.attention)
            Text(mismatch == .updateBridge
                 ? "The bridge on your Mac is older than this app. Approvals, Stop and paired devices need the new bridge."
                 : "The bridge on your Mac is newer than this app. Update ClaudioBot so nothing is missing.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private extension View {
    /// The banner's main button: a white pill on iOS, the app's accent on the Mac like any default button.
    func bannerProminent() -> some View {
        #if os(macOS)
        buttonStyle(.borderedProminent).tint(.accentColor)
        #else
        buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
        #endif
    }
}

/// The account and the plan usage, at the head of either sidebar. On iOS the usage is the centered title.
/// On the Mac, Settings lives in the app menu and nothing may claim the window's one centered slot, so the initials
/// show only while proposed facts wait for review, and the usage sits with the sidebar's other buttons.
struct SidebarAccountItems: ToolbarContent {
    let name: String
    let proposals: Int
    let usage: PlanUsage?
    let hasUsage: Bool
    let showSettings: () -> Void
    let showUsage: () -> Void

    var body: some ToolbarContent {
        #if os(macOS)
        if proposals > 0 {
            InitialsItem(name: name, proposals: proposals, action: showSettings)
        }
        if hasUsage {
            ToolbarItem(placement: .primaryAction) {
                SessionUsageButton(usage: usage, action: showUsage)
                    .help("Plan Usage")
            }
        }
        #else
        InitialsItem(name: name, proposals: proposals, action: showSettings)
        if hasUsage {
            ToolbarItem(placement: .principal) {
                SessionUsageButton(usage: usage, action: showUsage)
            }
        }
        #endif
    }
}

/// The account initials that open Settings. On iOS 26 it opts out of the shared glass because it brings its own fill.
struct InitialsItem: ToolbarContent {
    let name: String
    /// Facts bots proposed that wait for the user, badged on the button that leads to them.
    let proposals: Int
    let action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { button }
    }

    private var button: some View {
        Button(action: action) {
            Text(Initials.of(name.isEmpty ? "Me" : name))
                .font(.ui(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                // On iOS 26 the toolbar's glass is the circle, matching search and + beside it.
                .background {
                    if #unavailable(iOS 26.0) { Circle().fill(Theme.letter) }
                }
                .overlay(alignment: .topTrailing) {
                    if proposals > 0 {
                        Text("\(proposals)")
                            .font(.ui(size: 11, weight: .bold).monospacedDigit())
                            .foregroundStyle(.black)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Theme.attention, in: Capsule())
                            .offset(x: 5, y: -5)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Settings")
        .accessibilityValue(proposals > 0 ? "\(proposals) to review in Memory" : "")
        .help(proposals > 0 ? "Review \(proposals) proposed \(proposals == 1 ? "fact" : "facts") in Settings" : "Settings")
    }
}

#if os(macOS)
/// Puts the cursor in the search field of the sidebar on screen, for the Find command.
struct SidebarSearch {
    let focus: () -> Void
}

extension FocusedValues {
    @Entry var sidebarSearch: SidebarSearch?
}

/// The system draws a sidebar row's selection but nothing under the pointer, so an unselected row gets a quiet fill.
private struct SidebarHover: ViewModifier {
    let selected: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .onHover { inside in
                withAnimation(.easeOut(duration: 0.14)) { hovering = inside }
            }
            .listRowBackground(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(hovering && !selected ? 0.06 : 0))
                    .padding(.horizontal, 10)
            )
    }
}

extension View {
    func sidebarHover(selected: Bool) -> some View {
        modifier(SidebarHover(selected: selected))
    }
}
#endif

/// Splits the search and + buttons into two glass circles on iOS 26.
struct ToolbarSpacerIfAvailable: ToolbarContent {
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
        }
    }
}
