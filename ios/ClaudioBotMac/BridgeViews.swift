import AppKit
import SwiftUI

/// The first screen while unpaired: choose where the bots run. This Mac sets up its own bridge, step by step, on
/// a click; another computer opens the pairing form. Nothing starts before the user chooses.
struct WelcomeView: View {
    let anotherMac: () -> Void
    /// The setup under way, and which run of it: Try Again starts a fresh one.
    @State private var setUpRun: Int?
    @State private var setUpFailed = false
    @Environment(LocalBridge.self) private var local
    @Environment(BridgeClient.self) private var client
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 14) {
                    AvatarView(avatar: .standard, size: 84, motion: setUpRun == nil ? .idle : .working)
                    Text(setUpRun == nil ? "Welcome to ClaudioBot" : "Setting Up This Mac")
                        .font(.largeTitle.bold())
                    Text(setUpRun == nil
                        ? "Your bots live in the bridge, on a computer that runs Claude Code. Where should they run?"
                        : "ClaudioBot installs the bridge, starts it and pairs itself. Your bots keep running after you quit the app.")
                        .foregroundStyle(.secondary)
                    if let reason = client.unpairedReason, setUpRun == nil {
                        Label(reason, systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(Theme.attention)
                    }
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)

                if setUpRun == nil {
                    choices
                } else {
                    progress
                }
            }
            .padding(32)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.background)
        .task { await local.onDemand() }
        .task { await local.checkClaudeCode() }
        .task(id: setUpRun) {
            guard setUpRun != nil else { return }
            setUpFailed = false
            if await local.setUp(client) {
                app.cancelPairing()
                await app.notifier.requestAuthorization()
            } else if !Task.isCancelled {
                setUpFailed = true
            }
        }
    }

    // MARK: Choose

    private var choices: some View {
        HStack(alignment: .top, spacing: 16) {
            card(title: "This Mac", systemImage: "laptopcomputer") {
                Text("Run your bots here, with this Mac's Claude Code and its projects.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                claudeCodeLine
                if case .running = local.state {
                    Label("A bridge is already running here.", systemImage: "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                choiceButton(thisMacTitle) { setUpRun = 0 }
                    .disabled(!canUseThisMac)
            }
            card(title: "Another Computer", systemImage: "network") {
                Text("Connect to a bridge on another Mac, a server or a devbox, over your network or Tailscale.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Paste its pairing link, or enter its address and a pairing code.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                choiceButton("Connect to a Bridge…", action: anotherMac)
            }
        }
        .frame(maxWidth: 720)
    }

    @ViewBuilder private var claudeCodeLine: some View {
        switch local.claudeCode {
        case .checking:
            Label("Looking for Claude Code…", systemImage: "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .found(let path):
            Label("Claude Code found at \(path)", systemImage: "checkmark.seal.fill")
                .font(.footnote)
                .foregroundStyle(.green)
                .lineLimit(1)
                .truncationMode(.middle)
        case .missing:
            VStack(alignment: .leading, spacing: 6) {
                Label("Claude Code is not installed on this Mac. Install it and log in, then check again.", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.attention)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Link("Get Claude Code", destination: URL(string: "https://claude.com/claude-code")!)
                    Button("Check Again") { Task { await local.checkClaudeCode() } }
                }
                .font(.footnote)
            }
        }
        if case .notInstalled(nil) = local.state {
            Text("This copy of ClaudioBot was not built from a claudio-bot checkout, so it cannot install the bridge. Run bun run claudiobot install in the checkout's bridge folder.")
                .font(.footnote)
                .foregroundStyle(Theme.attention)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var thisMacTitle: String {
        switch local.state {
        case .running: "Use This Mac"
        case .notInstalled: "Set Up This Mac"
        default: "Start and Use This Mac"
        }
    }

    /// A running bridge already found its claude. Otherwise the bridge needs one, and a checkout to install from.
    private var canUseThisMac: Bool {
        switch local.state {
        case .running(managed: false, selfPairing: false), .checking: false
        case .running: true
        case .notInstalled(nil): false
        default: if case .found = local.claudeCode { true } else { false }
        }
    }

    // MARK: Set up

    private var progress: some View {
        VStack(alignment: .leading, spacing: 16) {
            let current = local.state.setUpPhase(action: local.action)
            ForEach(SetUpPhase.allCases, id: \.self) { phase in
                HStack(spacing: 12) {
                    mark(phase, current: current).frame(width: 22, height: 22)
                    Text(phase.title)
                        .foregroundStyle(phase > current ? .secondary : .primary)
                }
            }
            if setUpFailed {
                Divider()
                Label(local.problem ?? local.state.summary, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let output = local.installOutput ?? failedTail {
                    Text(output.split(separator: "\n").suffix(10).joined(separator: "\n"))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                HStack {
                    Button("Try Again") { setUpRun = (setUpRun ?? 0) + 1 }
                        .buttonStyle(.borderedProminent)
                    Button("Show Log") { local.showLog() }
                    Spacer()
                    Button("Back") { setUpRun = nil }
                }
            } else {
                Button("Cancel") { setUpRun = nil }
                    .disabled(local.action == .installing)
            }
        }
        .padding(24)
        .frame(maxWidth: 480, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var failedTail: String? {
        if case .failed(_, let tail) = local.state, !tail.isEmpty { tail.joined(separator: "\n") } else { nil }
    }

    @ViewBuilder private func mark(_ phase: SetUpPhase, current: SetUpPhase) -> some View {
        if phase < current {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        } else if phase > current {
            Image(systemName: "circle").foregroundStyle(.tertiary)
        } else if setUpFailed {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func choiceButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
            .controlSize(.large)
    }

    private func card(title: String, systemImage: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage).font(.title3.weight(.semibold))
            content()
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: 240, alignment: .topLeading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// The one button the state calls for, then the last action's problem and the log tail of a failed start.
struct LocalBridgeControls: View {
    var prominent = false
    @Environment(LocalBridge.self) private var local
    @Environment(AppModel.self) private var app
    @Environment(BridgeClient.self) private var client

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let action = local.action {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(Self.progress(action)).foregroundStyle(.secondary)
                }
            } else {
                primary
            }
            if let problem = local.problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if case .failed(_, let tail) = local.state, !tail.isEmpty {
                Text(tail.suffix(8).joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(8)
                    .textSelection(.enabled)
            }
            if let output = local.installOutput {
                Text(output.split(separator: "\n").suffix(12).joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private var primary: some View {
        switch local.state {
        case .checking, .starting:
            ProgressView().controlSize(.small)
        case .notInstalled(let checkout):
            if let checkout {
                button("Install the Bridge") { await local.install(from: checkout) }
                Text("Runs bun install and claudiobot install in \(checkout.appending(path: "bridge").path(percentEncoded: false)).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text("Install it from your claudio-bot checkout: bun run claudiobot install in its bridge folder.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .stopped:
            button("Start the Bridge") { await local.start() }
        case .running(_, selfPairing: true):
            if BridgePlace(client.pairing) == .thisMac {
                Label("This app is paired with it.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                button("Use This Mac") {
                    if await local.useThisMac(client) {
                        app.cancelPairing()
                        await app.notifier.requestAuthorization()
                    }
                }
            }
        case .running(managed: true, selfPairing: false):
            button("Restart the Bridge to Pair This Mac") { await local.restart() }
        case .running(managed: false, selfPairing: false):
            Text("Restart the bridge in its terminal so this Mac can pair itself.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failed:
            HStack {
                button("Restart the Bridge") { await local.restart() }
                Button("Show Log") { local.showLog() }
            }
        }
    }

    private func button(_ title: String, _ run: @escaping @MainActor () async -> Void) -> some View {
        Button(title) { Task { await run() } }
            .buttonStyle(.borderedProminent)
            .tint(prominent ? .white : .accentColor)
            .foregroundStyle(prominent ? .black : .white)
            .controlSize(.large)
    }

    private static func progress(_ action: LocalBridge.Action) -> String {
        switch action {
        case .pairing: "Pairing this Mac…"
        case .installing: "Installing the bridge…"
        case .starting: "Starting…"
        case .stopping: "Stopping…"
        case .restarting: "Restarting…"
        }
    }
}

/// Settings › Bridge: where the bridge runs, this Mac's service and its controls, switching, and the editor.
struct BridgeSettings: View {
    @AppStorage(Editor.preferenceKey) private var editor = ""
    @State private var confirmingStop = false
    @Environment(LocalBridge.self) private var local
    @Environment(AppModel.self) private var app
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Form {
            if local.isDemo {
                Section {
                    LabeledContent("Place", value: "Sample bots")
                } header: {
                    Text("Your bots run on")
                } footer: {
                    Text("Demo mode shows sample bots and leaves the bridge on this Mac alone.")
                }
            } else {
                Section("Your bots run on") {
                    LabeledContent("Place", value: place)
                    if BridgePlace(client.pairing) == .otherMac {
                        Button("Use This Mac Instead") { Task { _ = await local.useThisMac(client) } }
                            .disabled(!local.state.selfPairs || local.action != nil)
                    }
                    Button("Connect to Another Mac…") {
                        app.beginPairing()
                        openWindow(id: "main")
                    }
                    .disabled(store.connection == .unpaired)
                }

                Section {
                    LabeledContent("Status", value: local.state.summary)
                    LocalBridgeControls()
                    HStack {
                        Button("Start") { Task { await local.start() } }
                            .disabled(!local.state.canStart || local.action != nil)
                        Button("Stop…") { confirmingStop = true }
                            .disabled(!local.state.canStop || local.action != nil)
                        Button("Restart") { Task { await local.restart() } }
                            .disabled(!local.state.canRestart || local.action != nil)
                        Spacer()
                        Button("Show Log") { local.showLog() }
                    }
                    LabeledContent("Service", value: local.config.label)
                    LabeledContent("Address", value: local.config.socketURL.absoluteString)
                    LabeledContent("Home", value: local.config.home.path(percentEncoded: false))
                    if let checkout = local.checkout {
                        LabeledContent("Checkout", value: checkout.path(percentEncoded: false))
                    }
                } header: {
                    Text("Bridge on this Mac")
                } footer: {
                    Text("launchd runs the bridge, so your bots keep working after you quit ClaudioBot.")
                }
            }

            Section {
                if Editor.installed.isEmpty {
                    Text("No code editor found. Folders open in their default app.").foregroundStyle(.secondary)
                } else {
                    Picker("Open folders in", selection: Binding(
                        get: { Editor.preferred(editor)?.rawValue ?? "" },
                        set: { editor = $0 }
                    )) {
                        ForEach(Editor.installed) { Text($0.name).tag($0.rawValue) }
                    }
                }
            } header: {
                Text("Editor")
            } footer: {
                Text("Projects and worktrees of a bridge on this Mac open in this editor, Finder or Terminal.")
            }
        }
        .confirmationDialog("Stop the bridge?", isPresented: $confirmingStop) {
            Button("Stop", role: .destructive) { Task { await local.stop() } }
        } message: {
            Text("Your bots and routines stop until you start it again, and your phone cannot reach them.")
        }
        .task { await local.onDemand() }
    }

    private var place: String {
        switch BridgePlace(client.pairing) {
        case .thisMac: "This Mac"
        case .otherMac: client.pairing.map { "Another Mac (\($0.url.bridgeAddress))" } ?? "Another Mac"
        case nil: "Not paired"
        }
    }
}

extension ServiceState {
    var selfPairs: Bool {
        if case .running(_, selfPairing: true) = self { true } else { false }
    }
}

/// The code editors a folder can open in, by bundle id.
enum Editor: String, CaseIterable, Identifiable {
    case cursor, vscode, zed, xcode

    static let preferenceKey = "preferredEditor"

    var id: Self { self }

    var name: String {
        switch self {
        case .cursor: "Cursor"
        case .vscode: "Visual Studio Code"
        case .zed: "Zed"
        case .xcode: "Xcode"
        }
    }

    var bundleID: String {
        switch self {
        case .cursor: "com.todesktop.230313mzl4w4u92"
        case .vscode: "com.microsoft.VSCode"
        case .zed: "dev.zed.Zed"
        case .xcode: "com.apple.dt.Xcode"
        }
    }

    var appURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) }

    static var installed: [Editor] { allCases.filter { $0.appURL != nil } }

    /// The user's pick while it is installed, else the first installed editor.
    static func preferred(_ raw: String) -> Editor? {
        Editor(rawValue: raw).flatMap { $0.appURL == nil ? nil : $0 } ?? installed.first
    }
}

extension LocalOpener {
    /// Opens paths on this Mac. Without an editor, a folder opens in its default app.
    @MainActor static func installed(editor: Editor?) -> LocalOpener {
        let editorApp = editor?.appURL
        return LocalOpener(
            editorName: editor?.name ?? "Default App",
            openInEditor: { path in
                let url = URL(filePath: path)
                if let editorApp {
                    NSWorkspace.shared.open([url], withApplicationAt: editorApp, configuration: NSWorkspace.OpenConfiguration())
                } else {
                    NSWorkspace.shared.open(url)
                }
            },
            revealInFinder: { path in NSWorkspace.shared.activateFileViewerSelecting([URL(filePath: path)]) },
            openInTerminal: { path in
                var url = URL(filePath: path)
                var folder: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &folder), !folder.boolValue { url.deleteLastPathComponent() }
                guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { return }
                NSWorkspace.shared.open([url], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
            },
            exists: { FileManager.default.fileExists(atPath: $0) }
        )
    }
}
