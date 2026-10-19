import SwiftUI

/// "To: Start a chat with…": Create new Bot, Create group chat, then every bot, hidden ones included.
struct NewChatView: View {
    @Environment(AppModel.self) private var app
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    #if DEBUG
    @State private var creatingGroup = Demo.groupPick != nil
    #else
    @State private var creatingGroup = false
    #endif
    @FocusState private var focused: Bool

    var body: some View {
        #if os(macOS)
        // Both pages share one fixed size, so typing a filter or going to New group never resizes the sheet.
        Group {
            if creatingGroup {
                NewGroupView { creatingGroup = false }
            } else {
                MacSheet(title: "New chat") {
                    VStack(spacing: 0) {
                        toField
                        Divider()
                        ScrollView { choices.padding(8) }
                    }
                } buttons: {
                    Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                }
                .defaultFocus($focused, true)
            }
        }
        .frame(width: 440, height: 520)
        #else
        NavigationStack {
            VStack(spacing: 0) {
                toField
                Divider().overlay(Theme.hairline)

                ScrollView {
                    choices
                        .padding(8)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .padding(12)
                }
            }
            .background(Theme.background)
            .navigationDestination(isPresented: $creatingGroup) { NewGroupView() }
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.background)
        #endif
    }

    private var toField: some View {
        HStack(spacing: 6) {
            Text("To:").foregroundStyle(Theme.secondary)
            TextField("Start a chat with…", text: $query)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                #if os(macOS)
                .textFieldStyle(.plain)
                .focusEffectDisabled()
                #endif
        }
        .font(.ui(size: 16))
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var choices: some View {
        VStack(spacing: 2) {
            if query.isEmpty {
                row {
                    Image(systemName: "plus")
                        .font(.ui(size: 15, weight: .medium))
                        .foregroundStyle(Theme.secondary)
                        .frame(width: 30, height: 30)
                        .background(Theme.raised, in: Circle())
                    Text("Create new Bot")
                } action: {
                    dismiss()
                    app.createBot()
                }
                if store.has(.groups) {
                    row {
                        Image(systemName: "person.2")
                            .font(.ui(size: 13, weight: .medium))
                            .foregroundStyle(Theme.secondary)
                            .frame(width: 30, height: 30)
                            .background(Theme.raised, in: Circle())
                        Text("Create group chat")
                    } action: {
                        creatingGroup = true
                    }
                }
            }
            ForEach(store.bots(matching: query)) { bot in
                row {
                    BotAvatar(bot: bot, size: 30)
                    Text(bot.name)
                    if bot.hidden {
                        Text("Hidden").font(.caption).foregroundStyle(Theme.tertiary)
                    }
                } action: {
                    router.open(bot.id)
                }
            }
        }
    }

    private func row<Label: View>(@ViewBuilder _ label: () -> Label, action: @escaping () -> Void) -> some View {
        Button(action: action) { rowLabel(label) }
            #if os(macOS)
            .buttonStyle(HoverRowStyle())
            #else
            .buttonStyle(.plain)
            #endif
    }

    private func rowLabel<Label: View>(@ViewBuilder _ label: () -> Label) -> some View {
        HStack(spacing: 12) {
            label()
            Spacer()
        }
        .font(.ui(size: 16))
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}

#if os(macOS)
/// A list row that lights up under the pointer and while pressed, as menu and picker rows do on a Mac.
private struct HoverRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(
                    Color.white.opacity(configuration.isPressed ? 0.12 : hovering ? 0.07 : 0),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
                .onHover { hovering = $0 }
        }
    }
}
#endif
