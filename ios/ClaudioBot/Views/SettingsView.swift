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
        #if os(macOS)
        // The Settings window names itself after its tab and closes with its own button, so no title or Done here.
        form
        #else
        NavigationStack {
            form
                .scrollContentBackground(.hidden)
                .background(Theme.background)
                .navigationTitle("Settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        #endif
    }

    private var form: some View {
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
                        ForEach(MirrorPref.allCases, id: \.self) { Text(Copy.mirror($0)).tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                } header: {
                    Text("Sessions")
                } footer: {
                    Text(Copy.sessionsFooter)
                }
            }

            devices

            MemorySection()

            Section {
                Toggle("Notifications", isOn: $notificationsEnabled)
                    #if os(iOS)
                    .tint(AvatarColor.green.color)
                    #endif
                #if os(iOS)
                if store.has(.pushState) { AwayAlertsRow(push: store.pushState ?? .on) }
                #endif
            } footer: {
                Text("Alerts for bot messages, questions and approvals arrive while ClaudioBot is connected to your Mac. A question alert lets you pick one of its first two answers.")
            }

            Section {
                Button(Copy.unpair, role: .destructive) { confirmingUnpair = true }
            } footer: {
                Text(Copy.unpairFooter)
            }
        }
        .formStyle(.grouped)
        .refreshable { await PlanUsageSection.refresh(store, client) }
        .task(id: store.bridgeManagesDevices) {
            if store.bridgeManagesDevices { client.send(.devices) }
        }
        .confirmationDialog(Copy.unpairQuestion, isPresented: $confirmingUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) {
                dismiss()
                Task { await client.unpair() }
            }
        } message: {
            Text(Copy.unpairWarning)
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
        .sheet(isPresented: $pairingAnother) {
            PairAnotherView()
                #if os(macOS)
                .frame(width: 440, height: 600)
                #endif
        }
        .sheet(isPresented: $editingAddress) { EditAddressView() }
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
            Text(Copy.devicesFooter)
        }
    }

    /// Where the Mac app's words differ: it is itself the device here, and it is clicked, not tapped.
    private enum Copy {
        #if os(macOS)
        static let unpair = "Unpair from Bridge…"
        static let unpairQuestion = "Unpair from the bridge?"
        static let unpairWarning = "To reach your bots again, pair this Mac with the bridge again."
        static let unpairFooter = "The bridge forgets this Mac when it is connected, then this Mac deletes the bridge address and token."
        static let devicesFooter = "Each device has its own token. Revoking one leaves the others paired."
        static let sessionsFooter = "Sessions your bots' agents and this Mac start can appear in the Claude app on the bridge's Mac. Automatically adds them while you're away from that Mac; When I click adds one when you choose Open in Claude app."

        static func mirror(_ pref: MirrorPref) -> String {
            pref == .tap ? "When I click" : SessionText.mirror(pref)
        }
        #else
        static let unpair = "Unpair this Mac"
        static let unpairQuestion = "Unpair this Mac?"
        static let unpairWarning = "You will need a new pairing code from your Mac."
        static let unpairFooter = "Removes this \(ThisDevice.noun) from your Mac when it is connected, then deletes the bridge address and token from this \(ThisDevice.noun)."
        static let devicesFooter = "Each phone has its own token. Revoking one leaves the others paired."
        static let sessionsFooter = "Sessions your bots' agents and this \(ThisDevice.casualNoun) start can appear in the Claude app on your Mac. Automatically adds them while you're away from the Mac; When I tap adds one when you choose Open in Claude app."

        static func mirror(_ pref: MirrorPref) -> String { SessionText.mirror(pref) }
        #endif
    }
}

/// Whether the Mac's pushes reach this phone while the app is closed.
private struct AwayAlertsRow: View {
    let push: PushState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Alerts when away", value: push.value)
            if let detail = push.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(push.failing ? Theme.danger : Theme.secondary)
                    .lineLimit(4)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

extension PushState {
    /// A state a newer bridge invented reads as on.
    var value: String {
        switch self {
        case .off: "Off"
        case .failing: "Last send failed"
        case .on, .unknown: "On"
        }
    }

    var failing: Bool {
        if case .failing = self { true } else { false }
    }

    var detail: String? {
        switch self {
        case .off: "Set CLAUDIOBOT_PUSH_URL on the Mac to get alerts when the app is closed."
        case let .failing(error, at): "\(error), \(at.formatted(.relative(presentation: .named)))"
        case .on, .unknown: nil
        }
    }

    /// The Sessions list's one line, only when alerts while away do not reach the phone.
    var listNote: String? {
        switch self {
        case .off: "Alerts when away are off"
        case .failing: "Alerts when away are failing"
        case .on, .unknown: nil
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
/// Closes by itself once a device pairs, which it learns by asking for the device list while it is up.
struct PairAnotherView: View {
    static let devicePoll: Duration = .seconds(2)
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var watch = NewDeviceWatch()

    var body: some View {
        #if os(macOS)
        MacSheet(title: "Pair another device") {
            page
        } buttons: {
            Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
        }
        #else
        NavigationStack {
            page
                .background(Theme.background)
                .navigationTitle("Pair another device")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        #endif
    }

    private var page: some View {
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
        .onAppear(perform: request)
        .task {
            guard store.bridgeManagesDevices else { return }
            while !Task.isCancelled {
                // Offline, a send would queue every poll for the next hello.
                if store.machine != nil { client.send(.devices) }
                try? await Task.sleep(for: Self.devicePoll)
            }
        }
        .onChange(of: store.devicesHeard) {
            if let devices = store.devices, watch.heard(devices) { dismiss() }
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
                .font(.ui(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires in \(Text(code.expiresAt, style: .relative))")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            #if os(macOS)
            // The address on a line of its own, so it never breaks after "ws://".
            VStack(spacing: 4) {
                Text("On the other device, open ClaudioBot and scan this code. Or enter this address and the code by hand:")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                Text(invite.url.absoluteString)
                    .font(.footnote.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            #else
            Text("On the other device, open ClaudioBot and scan this code. Or enter \(invite.url.absoluteString) and the code by hand.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
            #endif
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

#if os(macOS)
/// A Mac sheet's frame: its title at the leading edge, the content, then its buttons at the bottom trailing edge, the
/// way AppKit lays sheets out. A NavigationStack would hold a back-button slot before the title and draw it as a bar.
struct MacSheet<Content: View, Buttons: View>: View {
    let title: String
    var back: (() -> Void)?
    @ViewBuilder let content: Content
    @ViewBuilder let buttons: Buttons

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                if let back {
                    Button(action: back) {
                        Image(systemName: "chevron.left").font(.ui(size: 13, weight: .semibold))
                    }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("[", modifiers: .command)
                    .help("Back")
                    .accessibilityLabel("Back")
                }
                Text(title).font(.title3.weight(.semibold))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 6)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                buttons
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
    }
}
#endif

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
