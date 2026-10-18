import SwiftUI
import UIKit

@main
struct ClaudioBotApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.store)
                .environment(app.client)
                .environment(app.router)
                .onOpenURL { app.open($0) }
                .preferredColorScheme(.dark)
                .overlay { SplashView() }
        }
        .onChange(of: scenePhase) { _, phase in app.scenePhaseChanged(phase) }
    }
}

enum Route: Hashable {
    case profile(BotID, tab: ProfileView.Tab = .info)
    case exchange(AgentID)
    /// What the chat's bot and another bot said to each other.
    case botExchange(BotID, peer: BotID)
    case file(BotID, path: String)
    case routine(BotID, RoutineID)
}

enum Selection: Hashable, Sendable {
    case bot(BotID)
    case session(SessionID)

    var bot: BotID? {
        if case .bot(let id) = self { id } else { nil }
    }

    var session: SessionID? {
        if case .session(let id) = self { id } else { nil }
    }
}

enum SidebarMode: String, Hashable, Sendable {
    case bots, sessions
}

@Observable
@MainActor
final class Router {
    static let sidebarKey = "sidebarMode"

    var selection: Selection?
    var sidebar: SidebarMode = SidebarMode(rawValue: UserDefaults.standard.string(forKey: Router.sidebarKey) ?? "") ?? .bots {
        didSet { UserDefaults.standard.set(sidebar.rawValue, forKey: Self.sidebarKey) }
    }
    /// Screens pushed on top of the chat.
    var path: [Route] = []
    var showingNewChat = false
    var showingSettings = false
    var showingUsage = false
    var newSession: NewSessionRequest?
    /// The profile beside the chat, on iPad.
    var showingInspector = false
    /// The ref of a create_bot in flight; the bot it becomes is opened.
    var pendingCreate: String?
    var pendingSessionCreate: String?

    /// The list is watched while it shows, and while a thread is open: its header reads the row.
    var watchesSessions: Bool {
        sidebar == .sessions || selection?.session != nil
    }

    func open(_ bot: BotID) {
        open(.bot(bot))
    }

    func open(_ target: Selection) {
        showingNewChat = false
        showingSettings = false
        showingUsage = false
        newSession = nil
        path = []
        if case .session = target { sidebar = .sessions }
        selection = target
    }
}

struct NewSessionRequest: Identifiable, Hashable, Sendable {
    let id = UUID()
    var projectId: ProjectID?
}

@Observable
@MainActor
final class AppModel {
    let store = AppStore()
    let client: BridgeClient
    let router = Router()
    /// The pairing in progress. While paired, a flow shows the pairing sheet; while unpaired the pairing screen is always up.
    private(set) var pairingFlow: PairingFlow?
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init() {
        let client = BridgeClient(store: store, deviceName: UIDevice.current.name)
        self.client = client
        let notifier = notifier
        let router = router
        client.onAlerts = { notifier.post($0, viewing: client.openBot) }
        client.onForget = { notifier.clearAll() }
        notifier.onOpenBot = { router.open($0) }
        notifier.onAnswer = { bot, message, option in
            client.send(.answer(botId: bot, messageId: message, option: option))
            await client.waitUntilSent()
        }
        #if DEBUG
        if Demo.isEnabled {
            Demo.load(into: self)
            return
        }
        #endif
        if let pairing = PairingVault.app.load() {
            client.start(pairing)
        }
    }

    /// Opens the pairing form, for a Mac that no longer recognizes this iPhone.
    func beginPairing() {
        if pairingFlow == nil { pairingFlow = PairingFlow() }
    }

    /// Asks the user to confirm the bridge's address. Nothing is sent until they do.
    func propose(_ invite: PairInvite) {
        var flow = pairingFlow ?? PairingFlow()
        flow.propose(invite)
        pairingFlow = flow
    }

    func cancelConfirmation() {
        pairingFlow?.cancelConfirmation()
    }

    /// Closes the pairing sheet, except while a code is being redeemed.
    func cancelPairing() {
        if pairingFlow?.isPairing != true { pairingFlow = nil }
    }

    func showPairingFailure(_ message: String) {
        var flow = pairingFlow ?? PairingFlow()
        flow.fail(message)
        pairingFlow = flow
    }

    /// Redeems the confirmed code. The current pairing stays until the new bridge says hello.
    func confirmPairing() {
        guard let invite = pairingFlow?.confirm() else { return }
        let current = client.pairing
        Task {
            do {
                try await client.pair(invite)
                pairingFlow = nil
                await notifier.requestAuthorization()
            } catch {
                let unchanged = current.map { " You are still paired with \($0.url.bridgeAddress)." } ?? ""
                showPairingFailure(error.localizedDescription + unchanged)
            }
        }
    }

    func open(_ url: URL) {
        switch DeepLink(url: url) {
        case .pair(let invite): propose(invite)
        case .outdatedBridge: showPairingFailure(DeepLink.outdatedBridgeMessage)
        case .bot(let bot, _): router.open(bot)
        case .session(let session): router.open(.session(session))
        case nil: break
        }
    }

    func createBot() {
        let ref = UUID().uuidString
        router.pendingCreate = ref
        client.send(.createBot(ref: ref))
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            // Keeps the socket alive for the short grace period iOS allows, so an answer
            // tapped on a notification still reaches the Mac.
            guard backgroundTask == .invalid else { return }
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "bridge") { [weak self] in
                MainActor.assumeIsolated { self?.endBackgroundTask() }
            }
        case .active:
            endBackgroundTask()
            client.reconnectNow()
            if let open = client.openBot { notifier.clear(bot: open) }
        default:
            break
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router

    var body: some View {
        Group {
            if store.connection == .unpaired {
                PairingView()
            } else {
                MainView()
                    .sheet(isPresented: Binding(get: { app.pairingFlow != nil }, set: { if !$0 { app.cancelPairing() } })) {
                        NavigationStack { PairingView() }
                            .interactiveDismissDisabled(app.pairingFlow?.isPairing == true)
                    }
            }
        }
        .overlay(alignment: .top) { ErrorToast() }
        .tint(.white)
        .onChange(of: router.selection, initial: true) { _, selection in
            client.openBot = selection?.bot
            client.openSession = selection?.session
        }
        .onChange(of: router.watchesSessions, initial: true) { _, watches in client.watchingSessions = watches }
        .onChange(of: store.created) { _, created in
            if let ref = router.pendingCreate, let bot = created[ref] {
                router.pendingCreate = nil
                router.open(bot)
            }
        }
        .onChange(of: store.sessions.created) { _, created in
            if let ref = router.pendingSessionCreate, let session = created[ref] {
                router.pendingSessionCreate = nil
                router.open(.session(session))
            }
        }
    }
}
