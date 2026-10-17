import SwiftUI
import UIKit

@main
struct ClaudeBotApp: App {
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
        }
        .onChange(of: scenePhase) { _, phase in app.scenePhaseChanged(phase) }
    }
}

enum Route: Hashable {
    case profile(BotID, tab: ProfileView.Tab = .info)
    case exchange(AgentID)
    case file(BotID, path: String)
}

@Observable
@MainActor
final class Router {
    /// The bot whose chat is on screen.
    var selection: BotID?
    /// Screens pushed on top of the chat.
    var path: [Route] = []
    var showingNewChat = false
    var showingSettings = false
    /// The profile beside the chat, on iPad.
    var showingInspector = false
    /// The ref of a create_bot in flight; the bot it becomes is opened.
    var pendingCreate: String?
    /// A pairing that arrived through a claudebot://pair link, waiting to be confirmed.
    var pairingLink: Pairing?

    func open(_ bot: BotID) {
        showingNewChat = false
        showingSettings = false
        path = []
        selection = bot
    }
}

@Observable
@MainActor
final class AppModel {
    let store = AppStore()
    let client: BridgeClient
    let router = Router()
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init() {
        let client = BridgeClient(store: store)
        self.client = client
        let notifier = notifier
        let router = router
        client.onAlerts = { notifier.post($0, viewing: client.openBot) }
        notifier.onOpenBot = { router.open($0) }
        notifier.onAnswer = { bot, message, option in
            client.send(.answer(botId: bot, messageId: message, option: option))
            await client.waitUntilSent()
        }
        #if DEBUG
        if Demo.isEnabled {
            Demo.load(into: store, router: router)
            return
        }
        #endif
        if let pairing = PairingVault.load() {
            client.start(pairing)
        }
    }

    /// Validates by connecting first, so only a pairing that reached the bridge is saved.
    func pair(_ pairing: Pairing) async throws {
        _ = try await BridgeClient.probe(pairing)
        PairingVault.save(pairing)
        client.start(pairing)
        router.pairingLink = nil
        await notifier.requestAuthorization()
    }

    func open(_ url: URL) {
        if let pairing = Pairing(link: url) {
            router.pairingLink = pairing
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
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        Group {
            if store.connection == .unpaired {
                PairingView()
            } else {
                MainView()
                    .sheet(item: $router.pairingLink) { link in
                        NavigationStack { PairingView(link: link) }
                    }
            }
        }
        .tint(.white)
        .onChange(of: router.selection, initial: true) { _, bot in client.openBot = bot }
        .onChange(of: store.created) { _, created in
            if let ref = router.pendingCreate, let bot = created[ref] {
                router.pendingCreate = nil
                router.open(bot)
            }
        }
    }
}

extension Pairing: Identifiable {
    var id: String { url.absoluteString + token }
}
