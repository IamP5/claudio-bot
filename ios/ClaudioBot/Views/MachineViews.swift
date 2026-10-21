import SwiftUI

/// Settings > Machines on a bridge with machines: every computer that runs this world's agents, and a code to add one.
struct MachinesSection: View {
    let onAdd: () -> Void
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @State private var removing: Machine?

    var body: some View {
        if store.has(.machines) {
            Section {
                ForEach(store.machines) { machine in
                    MachineRow(machine: machine)
                        .swipeActions {
                            if MachineText.removal(machine) != nil {
                                Button("Remove", role: .destructive) { removing = machine }
                            }
                        }
                        .contextMenu {
                            if MachineText.removal(machine) != nil {
                                Button("Remove", systemImage: "trash", role: .destructive) { removing = machine }
                            }
                        }
                }
                Button("Add a computer", action: onAdd)
                    .disabled(store.machine == nil)
            } header: {
                Text("Machines")
            } footer: {
                Text("Agents run on the computer a bot picks, or the one you choose, with that computer's projects, connectors and access.")
            }
            .alert(
                removing.flatMap(MachineText.removal)?.title ?? "",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                presenting: removing
            ) { machine in
                Button("Remove", role: .destructive) { client.send(.removeMachine(machineId: machine.id)) }
                Button("Cancel", role: .cancel) {}
            } message: { machine in
                Text(MachineText.removal(machine)?.message ?? "")
            }
        }
    }
}

struct MachineRow: View {
    let machine: Machine

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                StatusDot(color: machine.online ? AvatarColor.green.color : Theme.tertiary)
                Text(machine.name).lineLimit(1)
                if machine.role == .home { TagChip(text: "home") }
            }
            Text("\(MachineText.presence(machine)) · \(MachineText.platform(machine.platform))")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            HStack(spacing: 6) {
                TagChip(text: MachineText.access(machine.access), color: machine.access.full ? Theme.attention : Theme.secondary)
                ForEach(MachineText.connectorChips(machine.connectors), id: \.self) { TagChip(text: $0) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct TagChip: View {
    let text: String
    var color: Color = Theme.secondary
    var symbol: String?

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.caption2.weight(.semibold)) }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .lineLimit(1)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
        .fixedSize()
    }
}

/// The machine an agent or session runs on, beside it when the world has several.
struct MachineChip: View {
    let name: String
    /// A session row's chip: the glyph and the name in caption type, or the glyph alone when the title needs the room,
    /// never a name cut to a letter.
    var compact = false

    var body: some View {
        Group {
            if compact {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 3) {
                        Image(systemName: "desktopcomputer").font(.caption2)
                        Text(name).font(.caption).lineLimit(1)
                    }
                    Image(systemName: "desktopcomputer").font(.caption2)
                }
                .foregroundStyle(Theme.tertiary)
            } else {
                TagChip(text: name, symbol: "desktopcomputer")
            }
        }
        .accessibilityLabel("On \(name)")
    }
}

/// A one-time code another computer enrolls with, and the exact command to run there.
struct AddMachineView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        #if os(macOS)
        MacSheet(title: "Add a computer") {
            page
        } buttons: {
            Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
        }
        #else
        NavigationStack {
            page
                .background(Theme.background)
                .navigationTitle("Add a computer")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        #endif
    }

    private var page: some View {
        VStack(spacing: 24) {
            if let code = store.machineCode {
                TimelineView(.deadline(code.expiresAt)) { _ in
                    if Date.now >= code.expiresAt {
                        expired
                    } else {
                        live(code)
                    }
                }
            } else {
                ProgressView().frame(maxHeight: .infinity)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: request)
    }

    private func request() {
        copied = false
        store.discardMachineCode()
        client.send(.machineCode)
    }

    private func live(_ code: PairCode) -> some View {
        VStack(spacing: 20) {
            Text(code.code)
                .font(.ui(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires in \(Text(code.expiresAt, style: .relative))")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            if let command = MachineText.enrollCommand(code) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("On the other computer, with the bridge installed, run:")
                        .font(.footnote)
                        .foregroundStyle(Theme.secondary)
                    Text(command)
                        .font(.ui(size: 14, design: .monospaced))
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        Clipboard.copy(command)
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy command", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .font(.ui(size: 14, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .tint(.white)
                    if let others = code.urls?.dropFirst(), !others.isEmpty {
                        Text("If that address does not reach this home from there, use \(others.joined(separator: " or ")) instead.")
                            .font(.footnote)
                            .foregroundStyle(Theme.tertiary)
                    }
                }
            } else {
                Text("Your home listed no address another computer can reach. Join it to Wi-Fi or Tailscale, then get a new code.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var expired: some View {
        VStack(spacing: 16) {
            Text("That code expired.")
                .foregroundStyle(Theme.secondary)
            Button("Get a new code", action: request)
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
        }
    }
}

/// Where a bot starts its agents, in its profile. Only a plain bot in a world with several machines has a choice.
struct AgentsOnSection: View {
    let bot: Bot
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client

    static func choose(_ botId: BotID, _ machine: MachineID?) -> ClientMessage {
        .updateBot(botId: botId, patch: BotPatch(agentsOn: .some(machine)))
    }

    static func label(_ bot: Bot, machines: [Machine]) -> String {
        guard let id = bot.agentsOn else { return "Let the bot choose" }
        return machines.first { $0.id == id }.map(MachineText.choice) ?? "A removed computer"
    }

    var body: some View {
        if !bot.isGroup, store.hasSeveralMachines {
            CardSection(
                title: "Agents",
                footer: "An agent runs on that computer with its projects and connectors. A bot told to use another computer still can."
            ) {
                Menu {
                    Picker("Agents run on", selection: Binding(
                        get: { bot.agentsOn },
                        set: { client.send(Self.choose(bot.id, $0)) }
                    )) {
                        Text("Let the bot choose").tag(MachineID?.none)
                        ForEach(store.machines) { Text(MachineText.choice($0)).tag(Optional($0.id)) }
                    }
                    .pickerStyle(.inline)
                } label: {
                    HStack {
                        Text("Agents run on").font(.ui(size: 16)).foregroundStyle(.white)
                        Spacer()
                        Text(Self.label(bot, machines: store.machines)).font(.ui(size: 15)).foregroundStyle(Theme.secondary)
                        Image(systemName: "chevron.up.chevron.down").font(.ui(size: 12, weight: .semibold)).foregroundStyle(Theme.tertiary)
                    }
                    .padding(16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
