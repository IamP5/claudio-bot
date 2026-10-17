import SwiftUI

/// Another address for the paired Mac, such as its Tailscale name when away from home. The bridge there proves it is
/// the same Mac before the token is sent, and the address is saved once it says hello.
struct EditAddressView: View {
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var failure: String?
    @State private var trying = false

    /// A pairing from before protocol 3 has no device the bridge can prove itself to.
    private var isLegacy: Bool {
        if case .legacy? = client.pairing?.credential { true } else { false }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ws://mac.tailnet.ts.net:7878/ws", text: $text)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } footer: {
                    Text(failure ?? (isLegacy ? Pairing.AddressChange.legacy.localizedDescription : nil) ?? "Your Mac prints its addresses when the bridge starts, and claudiobot doctor shows its Tailscale address. A *.ts.net name works from anywhere your phone runs Tailscale.")
                        .foregroundStyle(failure == nil && !isLegacy ? Theme.secondary : Theme.danger)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Bridge address")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(trying) }
                ToolbarItem(placement: .confirmationAction) {
                    if trying {
                        ProgressView()
                    } else {
                        Button("Connect", action: connect).disabled(isLegacy)
                    }
                }
            }
            .onAppear { text = client.pairing?.url.absoluteString ?? "" }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(trying)
    }

    private func connect() {
        let url: URL
        do {
            url = try PairInvite.bridgeURL(text)
        } catch {
            failure = error.localizedDescription
            return
        }
        trying = true
        failure = nil
        Task {
            do {
                try await client.changeAddress(to: url)
                dismiss()
            } catch {
                failure = error.localizedDescription
            }
            trying = false
        }
    }
}
