import SwiftUI

/// A bot's avatar, or for a group its first members stacked.
struct BotAvatar: View {
    let bot: Bot
    var size: CGFloat = 40
    var needsAttention = false
    var motion = AvatarMotion.still

    @Environment(AppStore.self) private var store

    var body: some View {
        if bot.isGroup {
            GroupAvatar(avatars: store.members(of: bot).prefix(3).map(\.avatar), size: size)
        } else {
            AvatarView(avatar: bot.avatar, size: size, needsAttention: needsAttention, motion: motion, seed: bot.id.hashValue)
        }
    }
}

/// Two or three member avatars in one square: two on a diagonal, three in a triangle.
struct GroupAvatar: View {
    let avatars: [Avatar]
    var size: CGFloat = 40

    var body: some View {
        let small = size * (avatars.count > 2 ? 0.56 : 0.66)
        ZStack {
            switch avatars.count {
            case 0:
                Image(systemName: "person.2.fill").font(.ui(size: size * 0.4)).foregroundStyle(Theme.secondary)
            case 1:
                AvatarView(avatar: avatars[0], size: size)
            case 2:
                member(avatars[0], small).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                member(avatars[1], small).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            default:
                member(avatars[0], small).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                member(avatars[1], small).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                member(avatars[2], small).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func member(_ avatar: Avatar, _ side: CGFloat) -> some View {
        AvatarView(avatar: avatar, size: side)
            .background(Circle().fill(Theme.background).padding(-side * 0.06))
    }
}

/// A message from one bot among several: its avatar beside the first bubble of a run, its name above in its color.
struct MemberBubble: View {
    let sender: Bot?
    let text: String
    var members: [Bot] = []
    let opensRun: Bool
    var onSender: (BotID) -> Void = { _ in }

    private static let avatar: CGFloat = 28

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if opensRun {
                Button { if let sender { onSender(sender.id) } } label: {
                    AvatarView(avatar: sender?.avatar ?? .standard, size: Self.avatar)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(sender.map { "Open \($0.name)" } ?? "Unknown bot")
            } else {
                Color.clear.frame(width: Self.avatar, height: 1)
            }
            VStack(alignment: .leading, spacing: 4) {
                if opensRun {
                    Text(sender?.name ?? "A deleted bot")
                        .font(.ui(size: 13, weight: .semibold))
                        .foregroundStyle(sender?.avatar.color.accent ?? Theme.secondary)
                        .padding(.leading, 4)
                }
                BotBubble(text: text, members: members)
            }
        }
    }
}

/// "Create group chat": pick 2 to 8 bots and name the group. The chat opens once the bridge made it.
struct NewGroupView: View {
    /// On a Mac the sheet swaps pages instead of pushing, so the page offers its own way back.
    var back: (() -> Void)?

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    #if DEBUG
    @State private var picked: [BotID] = Demo.groupPick ?? []
    #else
    @State private var picked: [BotID] = []
    #endif
    @State private var name = ""

    private var suggested: String {
        GroupRules.suggestedName(picked.compactMap { store.bots[$0]?.name })
    }

    var body: some View {
        #if os(macOS)
        MacSheet(title: "New group", back: back) {
            Form {
                Section {
                    TextField("Group name", text: $name, prompt: Text(picked.count < 2 ? "Group name" : suggested))
                        .labelsHidden()
                        .textFieldStyle(.plain)
                        .focusEffectDisabled()
                }
                Section {
                    BotChecklist(picked: $picked, limit: GroupRules.members.upperBound)
                } header: {
                    Text("Members")
                } footer: {
                    Text("Pick 2 to 8 bots.")
                }
            }
            .formStyle(.grouped)
        } buttons: {
            Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            Button("Create", action: create)
                .keyboardShortcut(.defaultAction)
                .disabled(!GroupRules.members.contains(picked.count))
        }
        #else
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                TextField(picked.count < 2 ? "Group name" : suggested, text: $name)
                    .font(.ui(size: 17))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                CardSection(title: "Members", footer: "Pick 2 to 8 bots.") {
                    BotChecklist(picked: $picked, limit: GroupRules.members.upperBound)
                }
            }
            .padding(16)
        }
        .background(Theme.background)
        .navigationTitle("New group")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Create", action: create)
                    .fontWeight(.semibold)
                    .disabled(!GroupRules.members.contains(picked.count))
            }
        }
        #endif
    }

    private func create() {
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let ref = UUID().uuidString
        router.pendingCreate = ref
        router.showingNewChat = false
        client.send(.createGroup(ref: ref, name: typed.isEmpty ? suggested : String(typed.prefix(GroupRules.nameLimit)), members: picked))
    }
}

/// Plain bots with a checkmark each, in the order they were ticked. Ticking stops at the limit.
struct BotChecklist: View {
    @Binding var picked: [BotID]
    let limit: Int
    var excluded: Set<BotID> = []

    @Environment(AppStore.self) private var store

    private var bots: [Bot] {
        store.bots(matching: "").filter { !$0.isGroup && !excluded.contains($0.id) }
    }

    var body: some View {
        #if os(macOS)
        // Form rows with checkboxes: the Form draws the separators.
        ForEach(bots) { bot in
            let on = picked.contains(bot.id)
            Toggle(isOn: Binding(
                get: { on },
                set: { if $0 { if picked.count < limit { picked.append(bot.id) } } else { picked.removeAll { $0 == bot.id } } }
            )) {
                HStack(spacing: 10) {
                    AvatarView(avatar: bot.avatar, size: 24)
                    Text(bot.name)
                }
            }
            .toggleStyle(.checkbox)
            .disabled(!on && picked.count >= limit)
        }
        #else
        ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
            if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 58) }
            let on = picked.contains(bot.id)
            Button {
                if on { picked.removeAll { $0 == bot.id } } else if picked.count < limit { picked.append(bot.id) }
            } label: {
                HStack(spacing: 12) {
                    AvatarView(avatar: bot.avatar, size: 30)
                    Text(bot.name).font(.ui(size: 16)).foregroundStyle(.white)
                    Spacer()
                    Image(systemName: on ? "checkmark.circle.fill" : "circle")
                        .font(.ui(size: 21))
                        .foregroundStyle(on ? Color.white : Theme.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
                .opacity(on || picked.count < limit ? 1 : 0.4)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
        }
        #endif
    }
}

/// A group's profile: its name, its members, notifications and Delete. A group has no routines, files, computer,
/// skills, connectors or spend of its own.
struct GroupDetails: View {
    let group: Bot

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @State private var adding = false
    @State private var deleting = false

    private var editable: Bool { store.has(.groups) }

    var body: some View {
        let members = store.members(of: group)
        VStack(alignment: .leading, spacing: ProfileMetrics.sectionSpacing) {
            CardSection(title: "Members", footer: editable ? "A group keeps at least 2 bots." : nil) {
                ForEach(Array(members.enumerated()), id: \.element.id) { index, member in
                    if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 62) }
                    HStack(spacing: 12) {
                        Button { router.open(member.id) } label: {
                            HStack(spacing: 12) {
                                AvatarView(avatar: member.avatar, size: 34)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.name).font(.ui(size: 16)).foregroundStyle(.white)
                                    if let title = member.title {
                                        Text(title).font(.ui(size: 13)).foregroundStyle(Theme.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if editable {
                            Button { set(group.members.filter { $0 != member.id }) } label: {
                                Image(systemName: "minus.circle.fill").font(.ui(size: 20)).foregroundStyle(Theme.danger)
                            }
                            .buttonStyle(.plain)
                            .disabled(group.members.count <= GroupRules.members.lowerBound)
                            .opacity(group.members.count <= GroupRules.members.lowerBound ? 0.35 : 1)
                            .accessibilityLabel("Remove \(member.name)")
                            .help("Remove \(member.name)")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
                if editable && group.members.count < GroupRules.members.upperBound {
                    Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16)
                    Button { adding = true } label: {
                        Label("Add members", systemImage: "plus")
                            .font(.ui(size: 16))
                            .foregroundStyle(Theme.link)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            if store.has(.mute) { MuteSection(bot: group) }
            if editable {
                Button(role: .destructive) { deleting = true } label: {
                    Text("Delete Group")
                        .font(.ui(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: ProfileMetrics.buttonRadius, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $adding) { AddMembersView(group: group) }
        .confirmationDialog("Delete \(group.name)?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                router.path = []
                router.selection = nil
                client.send(.deleteBot(botId: group.id, force: false))
            }
        } message: {
            Text(HomeView.deleteMessage(group, home: store.computerName()))
        }
    }

    private func set(_ members: [BotID]) {
        client.send(.updateBot(botId: group.id, patch: BotPatch(members: members)))
    }
}

private struct AddMembersView: View {
    let group: Bot

    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var picked: [BotID] = []

    private func add() {
        client.send(.updateBot(botId: group.id, patch: BotPatch(members: group.members + picked)))
        dismiss()
    }

    var body: some View {
        #if os(macOS)
        MacSheet(title: "Add members") {
            Form {
                Section("Bots") {
                    BotChecklist(picked: $picked, limit: GroupRules.members.upperBound - group.members.count, excluded: Set(group.members))
                }
            }
            .formStyle(.grouped)
        } buttons: {
            Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            Button("Add", action: add)
                .keyboardShortcut(.defaultAction)
                .disabled(picked.isEmpty)
        }
        .frame(width: 400, height: 460)
        #else
        NavigationStack {
            ScrollView {
                CardSection(title: "Bots") {
                    BotChecklist(picked: $picked, limit: GroupRules.members.upperBound - group.members.count, excluded: Set(group.members))
                }
                .padding(16)
            }
            .background(Theme.background)
            .navigationTitle("Add members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: add)
                        .fontWeight(.semibold)
                        .disabled(picked.isEmpty)
                }
            }
        }
        .presentationBackground(Theme.background)
        #endif
    }
}
