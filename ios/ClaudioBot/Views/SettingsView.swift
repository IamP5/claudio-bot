import CoreImage.CIFilterBuiltins
import SwiftUI

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Notifier.enabledKey) private var notificationsEnabled = true
    @State private var confirmingUnpair = false
    @State private var revoking: Device?
    @State private var pairingAnother = false
    @State private var editingAddress = false

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
                        Button("Change address") { editingAddress = true }
                    }
                    LabeledContent("Bots", value: "\(store.bots.count)")
                }

                PlanUsageSection()

                devices

                MemorySection()

                Section {
                    Toggle("Notifications", isOn: $notificationsEnabled)
                        .tint(AvatarColor.green.color)
                } footer: {
                    Text("Alerts for bot messages, questions and approvals arrive while ClaudioBot is connected to your Mac. A question alert lets you pick one of its first two answers.")
                }

                Section {
                    Button("Unpair this Mac", role: .destructive) { confirmingUnpair = true }
                } footer: {
                    Text("Removes this iPhone from your Mac when it is connected, then deletes the bridge address and token from this iPhone.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .refreshable { await PlanUsageSection.refresh(store, client) }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task(id: store.bridgeManagesDevices) {
                if store.bridgeManagesDevices { client.send(.devices) }
            }
            .confirmationDialog("Unpair this Mac?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    Task { await client.unpair() }
                }
            } message: {
                Text("You will need a new pairing code from your Mac.")
            }
            .confirmationDialog(
                "Revoke \(revoking?.name ?? "device")?",
                isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
                titleVisibility: .visible,
                presenting: revoking
            ) { device in
                Button("Revoke", role: .destructive) {
                    client.send(.revokeDevice(deviceId: device.id))
                    client.send(.devices)
                }
            } message: { _ in
                Text("That device disconnects at once and can no longer reach your bots.")
            }
            .sheet(isPresented: $pairingAnother) { PairAnotherView() }
            .sheet(isPresented: $editingAddress) { EditAddressView() }
        }
    }

    private var devices: some View {
        Section {
            if !store.bridgeManagesDevices {
                Text(store.bridgeProtocol == nil
                     ? "Connect to your Mac to see the devices paired with it."
                     : "Update the bridge on your Mac to see and revoke paired devices.")
                    .foregroundStyle(Theme.secondary)
            } else if let devices = store.devices {
                ForEach(devices) { device in
                    DeviceRow(device: device) { revoking = device }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            if store.bridgeManagesDevices {
                Button("Pair another device") { pairingAnother = true }
                    .disabled(store.machine == nil)
            }
        } header: {
            Text("Paired devices")
        } footer: {
            Text("Each phone has its own token. Revoking one leaves the others paired.")
        }
    }
}

private struct DeviceRow: View {
    let device: Device
    let onRevoke: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }
            Spacer(minLength: 8)
            if !device.current {
                Button("Revoke", role: .destructive, action: onRevoke)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.danger)
            }
        }
    }

    private var caption: String {
        if device.current { return "This iPhone" }
        let seen = device.lastSeenAt.map { "Last seen \(TimeLabel.home($0))" } ?? "Never connected"
        return device.legacy ? "\(seen) · paired with the old shared token" : seen
    }
}

/// Shows a one-time code, as text and as the QR code another phone scans.
private struct PairAnotherView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if let code = store.pairCode, let url = client.pairing?.url {
                    TimelineView(.deadline(code.expiresAt)) { _ in
                        if Date.now < code.expiresAt {
                            live(code, invite: PairInvite(url: url, code: code.code))
                        } else {
                            expired
                        }
                    }
                } else {
                    ProgressView().frame(maxHeight: .infinity)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .navigationTitle("Pair another device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear(perform: request)
        }
    }

    private func request() {
        store.discardPairCode()
        client.send(.pairCode)
    }

    private func live(_ code: PairCode, invite: PairInvite) -> some View {
        VStack(spacing: 20) {
            QRCode(text: invite.link.absoluteString)
                .frame(width: 220, height: 220)
                .padding(14)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(code.code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires in \(Text(code.expiresAt, style: .relative))")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            Text("On the other phone, open ClaudioBot and scan this code. Or enter \(invite.url.absoluteString) and the code by hand.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
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

private struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.render(text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .accessibilityLabel("Pairing QR code")
        }
    }

    private static func render(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent)
        else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
