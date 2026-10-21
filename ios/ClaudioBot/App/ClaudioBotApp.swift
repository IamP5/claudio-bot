import Network
import SwiftUI
#if os(iOS)
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
#endif

enum Route: Hashable {
    case profile(BotID, tab: ProfileView.Tab = .info)
    case exchange(AgentID)
    /// What the chat's bot and another bot said to each other.
    case botExchange(BotID, peer: BotID)
    case file(BotID, path: String)
    case routine(BotID, RoutineID)
}

enum Selection: Hashable, Codable, Sendable {
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

    /// A new pick shows its own chat or thread, never a screen pushed over the last one, however it was picked.
    var selection: Selection? {
        didSet { if selection != oldValue { path = [] } }
    }
    /// Whether this window has the sidebar. A Mac window opened for one chat or session has none.
    let hasSidebar: Bool
    var sidebar: SidebarMode {
        didSet { if hasSidebar { UserDefaults.standard.set(sidebar.rawValue, forKey: Self.sidebarKey) } }
    }
    /// Whether the sidebar shows beside the chat. Find opens it, so it lives here rather than in the view.
    var columns: NavigationSplitViewVisibility = .automatic
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

    /// The main window's router, with the sidebar it had last time.
    init() {
        hasSidebar = true
        sidebar = SidebarMode(rawValue: UserDefaults.standard.string(forKey: Router.sidebarKey) ?? "") ?? .bots
    }

    /// A window for one chat or session, without a sidebar.
    init(showing selection: Selection) {
        hasSidebar = false
        sidebar = selection.session == nil ? .bots : .sessions
        self.selection = selection
    }

    /// A window with the sidebar watches the list on either side: the Bots side says what runs and what needs the
    /// user. A window for one thread watches it for the thread's header, which reads the row.
    var watchesSessions: Bool {
        hasSidebar || selection?.session != nil
    }

    var viewing: Viewing {
        Viewing(bot: selection?.bot, session: selection?.session, sessionsList: watchesSessions)
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
    @ObservationIgnored private let network = NWPathMonitor()
    #if os(iOS)
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    #endif

    init() {
        let client = BridgeClient(store: store, deviceName: ThisDevice.pairingName)
        self.client = client
        let notifier = notifier
        let router = router
        client.onAlerts = { notifier.post($0, viewing: client.onScreen.bots) }
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
        network.pathUpdateHandler = { path in
            let seen = NetworkPath(satisfied: path.status == .satisfied, interfaces: path.availableInterfaces.map(\.name))
            MainActor.assumeIsolated { client.networkChanged(seen) }
        }
        network.start(queue: .main)
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
        #if DEBUG
        // `-pairingAutoConfirm YES` taps Pair for the scenario runner, which cannot tap a simulator.
        if UserDefaults.standard.bool(forKey: "pairingAutoConfirm") { confirmPairing() }
        #endif
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
        #if os(iOS)
        case .background:
            client.leave()
            // Keeps the socket alive for the short grace period iOS allows, so an answer
            // tapped on a notification still reaches the Mac.
            guard backgroundTask == .invalid else { return }
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "bridge") { [weak self] in
                MainActor.assumeIsolated { self?.endBackgroundTask() }
            }
        #endif
        case .active:
            #if os(iOS)
            endBackgroundTask()
            #endif
            client.comeBack()
            client.onScreen.bots.forEach { notifier.clear(bot: $0) }
        default:
            break
        }
    }

    #if os(iOS)
    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
    #endif
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
        #if os(iOS)
        // The Mac keeps the system accent, which draws the sidebar's selection.
        .tint(.white)
        #endif
        .viewing(router)
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

extension View {
    /// Holds a viewing lease for this window while it is open, kept to what `router` shows.
    func viewing(_ router: Router) -> some View {
        modifier(ViewingLeaseHolder(router: router))
    }
}

private struct ViewingLeaseHolder: ViewModifier {
    let router: Router
    @State private var lease = ViewingLease()
    @Environment(BridgeClient.self) private var client

    func body(content: Content) -> some View {
        content
            .onAppear { client.view(router.viewing, as: lease) }
            .onChange(of: router.viewing) { _, viewing in client.view(viewing, as: lease) }
            .onDisappear { client.view(nil, as: lease) }
    }
}
