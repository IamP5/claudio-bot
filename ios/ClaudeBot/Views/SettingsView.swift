import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Notifier.enabledKey) private var notificationsEnabled = true
    @State private var confirmingUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Mac") {
                    LabeledContent("Status", value: store.connection.summary)
                    LabeledContent("Machine", value: store.machine ?? "Unknown")
                    if let url = client.pairing?.url {
                        LabeledContent("Bridge") {
                            Text(url.absoluteString)
                                .font(.footnote.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    LabeledContent("Projects", value: "\(store.projects.count)")
                }

                Section {
                    Toggle("Notifications", isOn: $notificationsEnabled)
                } footer: {
                    Text("Alerts for approvals, questions and finished tasks arrive while ClaudeBot is connected to your Mac.")
                }

                Section {
                    Button("Unpair this Mac", role: .destructive) { confirmingUnpair = true }
                } footer: {
                    Text("Removes the bridge address and token from this iPhone.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Unpair this Mac?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    client.unpair()
                }
            } message: {
                Text("You will need to scan the pairing code again.")
            }
        }
    }
}
