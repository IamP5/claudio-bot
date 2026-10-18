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
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Text("To:").foregroundStyle(Theme.secondary)
                    TextField("Start a chat with…", text: $query)
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .font(.system(size: 16))
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                Divider().overlay(Theme.hairline)

                ScrollView {
                    VStack(spacing: 2) {
                        if query.isEmpty {
                            row {
                                Image(systemName: "plus")
                                    .font(.system(size: 15, weight: .medium))
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
                                            .font(.system(size: 13, weight: .medium))
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
    }

    private func row<Label: View>(@ViewBuilder _ label: () -> Label, action: @escaping () -> Void) -> some View {
        Button(action: action) { rowLabel(label) }
            .buttonStyle(.plain)
    }

    private func rowLabel<Label: View>(@ViewBuilder _ label: () -> Label) -> some View {
        HStack(spacing: 12) {
            label()
            Spacer()
        }
        .font(.system(size: 16))
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}
