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

                if store.has(.sessions) {
                    Section {
                        Picker("Show agent sessions in the Claude app", selection: Binding(
                            get: { store.sessions.mirror ?? .auto },
                            set: { pref in
                                store.sessions.setMirror(pref)
                                client.send(.sessionPrefs(mirror: pref))
                            }
                        )) {
                            ForEach(MirrorPref.allCases, id: \.self) { Text(SessionText.mirror($0)).tag($0) }
                        }
                        .pickerStyle(.navigationLink)
                    } header: {
                        Text("Sessions")
                    } footer: {
                        Text("Sessions your bots' agents and this \(ThisDevice.casualNoun) start can appear in the Claude app on your Mac. Automatically adds them while you're away from the Mac; When I tap adds one when you choose Open in Claude app.")
                    }
                }

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
                    Text("Removes this \(ThisDevice.noun) from your Mac when it is connected, then deletes the bridge address and token from this \(ThisDevice.noun).")
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
        if device.current { return "This \(ThisDevice.noun)" }
        let seen = device.lastSeenAt.map { "Last seen \(TimeLabel.home($0))" } ?? "Never connected"
        return device.legacy ? "\(seen) · paired with the old shared token" : seen
    }
}

/// Shows a one-time code, as text and as the QR code another phone scans, with every address the bridge listed.
struct PairAnotherView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if let code = store.pairCode {
                    TimelineView(.deadline(code.expiresAt)) { _ in
                        if Date.now >= code.expiresAt {
                            expired
                        } else if let invite = code.invite(fallingBackTo: client.pairing?.url) {
                            live(code, invite: invite)
                        } else {
                            unreachable
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

    private var unreachable: some View {
        ContentUnavailableView(
            "No address to share",
            systemImage: "network.slash",
            description: Text("Your Mac reported only addresses another device cannot reach. Join it to Wi-Fi or Tailscale, then get a new code.")
        )
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
            Image(image, scale: 1, label: Text("Pairing QR code"))
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        }
    }

    private static func render(_ text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}
