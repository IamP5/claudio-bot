import SwiftUI
import VisionKit

struct PairingView: View {
    /// A pairing from a claudebot://pair link; it fills the form and connects right away.
    var link: Pairing?

    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var urlText = ""
    @State private var token = ""
    @State private var connecting = false
    @State private var failure: String?
    @State private var scanning = false

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
                .controlSize(.large)

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
        .sheet(isPresented: $scanning) {
            QRScannerSheet { payload in
                scanning = false
                guard let url = URL(string: payload), let pairing = Pairing(link: url) else {
                    failure = "That QR code is not a ClaudeBot pairing code."
                    return
                }
                connect(pairing)
            }
        }
        .onAppear { if let pending = link ?? router.pairingLink { connect(pending) } }
        .onChange(of: router.pairingLink) { _, pending in if let pending { connect(pending) } }
    }

    private var header: some View {
        VStack(spacing: 14) {
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 54, weight: .light))
                .foregroundStyle(Color.claude)
                .padding(.top, 24)
            Text("Pair with your Mac")
                .font(.largeTitle.bold())
            Text("Run `bun run start` in the bridge folder on your Mac. It prints a QR code and a pairing token.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var manualForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Bridge address").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                TextField("ws://192.168.1.20:7878/ws", text: $urlText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fieldStyle()
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Token").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                TextField("Paste the token", text: $token)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fieldStyle()
            }
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button {
                do {
                    connect(try Pairing(urlString: urlText, token: token))
                } catch {
                    failure = error.localizedDescription
                }
            } label: {
                HStack {
                    if connecting { ProgressView() }
                    Text(connecting ? "Connecting…" : "Connect")
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(connecting || urlText.isEmpty || token.isEmpty)
            .padding(.top, 4)
        }
    }

    private func connect(_ pairing: Pairing) {
        urlText = pairing.url.absoluteString
        token = pairing.token
        failure = nil
        connecting = true
        Task {
            do {
                try await app.pair(pairing)
                dismiss()
            } catch {
                failure = error.localizedDescription
            }
            connecting = false
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
                        description: Text("This device cannot scan codes. Open the pairing link from the bridge on this phone, or enter the address and token by hand.")
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
