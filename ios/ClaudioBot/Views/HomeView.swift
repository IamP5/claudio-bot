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
    @State private var deleting: Bot?

    private var bots: [Bot] {
        searching ? store.bots(matching: query) : store.homeBots
    }

    var body: some View {
        @Bindable var router = router
        List(selection: $router.selection) {
            if store.connection == .unrecognized {
                UnrecognizedBanner()
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if store.machine == nil {
                ConnectionBanner(state: store.connection)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let mismatch = store.protocolMismatch {
                UpdateBanner(mismatch: mismatch)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if searching {
                searchField
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(bots) { bot in
                BotRow(bot: bot)
                    .tag(bot.id)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    .listRowBackground(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(router.selection == bot.id ? Theme.card : .clear)
                            .padding(.horizontal, 6)
                    )
                    .contextMenu { menu(for: bot) }
            }
            if bots.isEmpty && store.machine != nil {
                Text(searching ? "No bots match." : "No bots yet. Tap + to make one.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .alert("Rename Bot", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                if let bot = renaming, !name.isEmpty { client.send(.updateBot(botId: bot.id, patch: BotPatch(name: name))) }
            }
        }
        .confirmationDialog(
            "Delete \(deleting?.name ?? "Bot")?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { bot in
            Button("Delete", role: .destructive) {
                if router.selection == bot.id { router.selection = nil }
                client.send(.deleteBot(botId: bot.id))
            }
        } message: { bot in
            Text(Self.deleteMessage(bot, worktrees: store.details[bot.id]?.agents.compactMap(\.worktree) ?? []))
        }
    }

    /// The bridge moves the bot's home to its trash folder and keeps every agent worktree until the user removes it.
    static func deleteMessage(_ bot: Bot, worktrees: [Worktree]) -> String {
        let base = "Deletes \(bot.name) and its chat. Its folder, with its files and memory, moves to the bridge's trash folder on your Mac, where you can recover it."
        switch worktrees.count {
        case 0: return base
        case 1: return base + " Its agent's worktree on \(worktrees[0].branch) stays on your Mac. Remove it from the agent first if you no longer need it."
        default: return base + " Its agents' \(worktrees.count) worktrees stay on your Mac. Remove them from each agent first if you no longer need them."
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        InitialsItem(name: store.userName, proposals: store.proposedFacts.count) { router.showingSettings = true }
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
        ToolbarSpacerIfAvailable()
        ToolbarItem(placement: .topBarTrailing) {
            Button { router.showingNewChat = true } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("New chat")
        }
    }

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

    @ViewBuilder
    private func menu(for bot: Bot) -> some View {
        Button {
            client.send(.updateBot(botId: bot.id, patch: BotPatch(pinned: !bot.pinned)))
        } label: {
            Label(bot.pinned ? "Unpin" : "Pin", systemImage: bot.pinned ? "pin.slash" : "pin")
        }
        Button {
            if router.selection == bot.id { router.selection = nil }
            client.send(.markUnread(botId: bot.id))
        } label: {
            Label("Mark as Unread", systemImage: "message.badge")
        }
        Button {
            newName = bot.name
            renaming = bot
        } label: {
            Label("Rename Bot", systemImage: "pencil")
        }
        Divider()
        Button {
            client.send(.updateBot(botId: bot.id, patch: BotPatch(hidden: !bot.hidden)))
        } label: {
            Label(bot.hidden ? "Show in sidebar" : "Hide from sidebar", systemImage: bot.hidden ? "eye" : "eye.slash")
        }
        Button(role: .destructive) {
            deleting = bot
            // The agents and their worktrees, so the dialog can say which stay behind.
            client.send(.details(botId: bot.id))
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }
}

struct BotRow: View {
    let bot: Bot

    @Environment(AppStore.self) private var store

    var body: some View {
        let display = RowDisplay(bot)
        let activity = bot.status == .working ? ActivityLine.text(in: store, botId: bot.id) : nil
        HStack(spacing: 14) {
            AvatarView(avatar: bot.avatar, size: 46, needsAttention: display.needsAttention)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(bot.name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    BotStatusChip(status: bot.status)
                    Spacer(minLength: 8)
                    if bot.pinned {
                        Image(systemName: "pin.fill").font(.system(size: 10)).foregroundStyle(Theme.tertiary)
                    }
                    Text(TimeLabel.home(bot.lastAt))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.tertiary)
                }
                HStack(spacing: 6) {
                    Group {
                        if let activity {
                            Text(activity).italic()
                        } else if display.previewIsQuestion {
                            Text(Image(systemName: "list.bullet.rectangle")) + Text(" ") + Text(display.preview)
                        } else {
                            Text(display.preview)
                        }
                    }
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
                    Spacer(minLength: 4)
                    if display.unreadDot {
                        Circle().fill(Theme.unread).frame(width: 9, height: 9)
                    }
                }
            }
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(display.unreadDot ? "Unread" : "")
    }
}

struct ConnectionBanner: View {
    let state: ConnectionState
    @Environment(AppModel.self) private var app
    @Environment(BridgeClient.self) private var client
    @State private var editingAddress = false

    /// After a few failed connects in a row the banner stops only counting down and says what to try.
    static func help(failures: Int, address: String?) -> String? {
        guard failures >= BridgeClient.failuresBeforeHelp else { return nil }
        let at = address.map { " at \($0)" } ?? ""
        return "Your Mac isn't answering\(at). Check the bridge is running. Away from home, connect with your Mac's Tailscale name, or pair again."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ConnectionBadge(state: state)
            if let help = Self.help(failures: client.failures, address: client.pairing?.url.bridgeAddress) {
                Text(help)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
                HStack(spacing: 8) {
                    Button("Edit address") { editingAddress = true }
                        .buttonStyle(.borderedProminent)
                        .tint(.white)
                        .foregroundStyle(.black)
                    Button("Pair again") { app.beginPairing() }
                        .buttonStyle(.bordered)
                }
                .font(.footnote.weight(.semibold))
                .controlSize(.small)
            } else {
                Text("ClaudioBot needs the bridge running on your Mac. Your bots keep working there while this phone is away.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }
        }
        .sheet(isPresented: $editingAddress) { EditAddressView() }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The bridge answered with 401. The pairing is kept: this may be another network, or the Mac may need a new code.
struct UnrecognizedBanner: View {
    @Environment(AppModel.self) private var app
    @Environment(BridgeClient.self) private var client

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ConnectionBadge(state: .unrecognized)
            Text("This bridge doesn't recognize this iPhone. Pair again, or retry once you are back on your Mac's network.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            HStack(spacing: 8) {
                Button("Pair again") { app.beginPairing() }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(.black)
                Button("Retry") { client.retry() }
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

/// The account initials that open Settings. On iOS 26 it opts out of the shared glass because it brings its own fill.
private struct InitialsItem: ToolbarContent {
    let name: String
    /// Facts bots proposed that wait for the user, badged on the button that leads to them.
    let proposals: Int
    let action: () -> Void

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarLeading) { button }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { button }
        }
    }

    private var button: some View {
        Button(action: action) {
            Text(Initials.of(name.isEmpty ? "Me" : name))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Theme.letter, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if proposals > 0 {
                        Text("\(proposals)")
                            .font(.system(size: 11, weight: .bold).monospacedDigit())
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
    }
}

/// Splits the search and + buttons into two glass circles on iOS 26.
struct ToolbarSpacerIfAvailable: ToolbarContent {
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
        }
    }
}
