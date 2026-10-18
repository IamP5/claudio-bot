import SwiftUI
import VisionKit

struct PairingView: View {
    @Environment(AppModel.self) private var app
    @Environment(BridgeClient.self) private var client
    @State private var urlText = ""
    @State private var code = ""
    @State private var scanning = false

    private var flow: PairingFlow { app.pairingFlow ?? PairingFlow() }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header
                Button {
                    scanning = true
                } label: {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
                .controlSize(.large)
                .disabled(flow.isPairing)

                HStack {
                    VStack { Divider() }
                    Text("or enter it yourself").font(.footnote).foregroundStyle(.secondary).fixedSize()
                    VStack { Divider() }
                }

                manualForm
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { app.cancelPairing() }
                    .disabled(flow.isPairing)
            }
        }
        .sheet(isPresented: $scanning) {
            QRScannerSheet { payload in
                scanning = false
                switch URL(string: payload).flatMap(DeepLink.init(url:)) {
                case .pair(let invite): app.propose(invite)
                case .outdatedBridge: app.showPairingFailure(DeepLink.outdatedBridgeMessage)
                default: app.showPairingFailure("That QR code is not a ClaudioBot pairing code.")
                }
            }
        }
        // Dismissal goes through the buttons only, so a dismissal can never race the Pair action.
        .alert(
            flow.confirming?.confirmation(replacing: client.pairing).title ?? "",
            isPresented: Binding(get: { flow.confirming != nil }, set: { _ in }),
            presenting: flow.confirming
        ) { _ in
            Button("Pair") { app.confirmPairing() }
            Button("Cancel", role: .cancel) { app.cancelConfirmation() }
        } message: { invite in
            if let detail = invite.confirmation(replacing: client.pairing).detail { Text(detail) }
        }
        .onChange(of: flow.confirming, initial: true) { _, invite in
            guard let invite else { return }
            urlText = invite.url.absoluteString
            code = invite.code
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            AvatarView(avatar: .standard, size: 84, motion: .idle)
                .padding(.top, 24)
            Text("Pair with your Mac")
                .font(.largeTitle.bold())
            Text("Your bots live on your Mac. Run `bun run start` in the bridge folder there. It prints a QR code and a pairing code. A phone that is already paired can show one too, under Settings.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let reason = client.unpairedReason {
                Label(reason, systemImage: "iphone.slash")
                    .font(.footnote)
                    .foregroundStyle(Theme.attention)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Bridge address").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                TextField("ws://10.0.0.20:7878/ws", text: $urlText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fieldStyle()
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Pairing code").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                TextField("XXXX-XXXX", text: $code)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .fieldStyle()
            }
            if let failure = flow.failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button {
                do {
                    app.propose(try PairInvite(urlString: urlText, code: code))
                } catch {
                    app.showPairingFailure(error.localizedDescription)
                }
            } label: {
                HStack {
                    if flow.isPairing { ProgressView() }
                    Text(flow.isPairing ? "Pairing…" : "Pair")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(flow.isPairing || urlText.isEmpty || code.isEmpty)
            .padding(.top, 4)
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct QRScannerSheet: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    private var available: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            Group {
                if available {
                    QRScanner(onScan: onScan)
                        .ignoresSafeArea()
                } else {
                    ContentUnavailableView(
                        "Scanning unavailable",
                        systemImage: "qrcode.viewfinder",
                        description: Text("This device cannot scan codes. Open the pairing link from the bridge on this phone, or enter the address and pairing code by hand.")
                    )
                }
            }
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        private var done = false

        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for case .barcode(let code) in added {
                if let payload = code.payloadStringValue {
                    done = true
                    scanner.stopScanning()
                    onScan(payload)
                    return
                }
            }
        }
    }
}
