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
        }
        .onChange(of: scenePhase) { _, phase in app.scenePhaseChanged(phase) }
    }
}

@Observable
@MainActor
final class Router {
    var path: [TaskID] = []
    var showingNewTask = false
    var showingSettings = false
    /// Set after a create is sent; the next new task that arrives is opened.
    var awaitingNewTask = false
    /// A pairing that arrived through a claudebot://pair link, waiting to be confirmed.
    var pairingLink: Pairing?

    func open(_ task: TaskID) {
        showingNewTask = false
        showingSettings = false
        path = [task]
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
        client.onAttention = { notifier.post($0, viewing: client.openTask) }
        notifier.onOpenTask = { router.open($0) }
        notifier.onDecide = { task, item, decision in
            client.send(.decide(taskId: task, itemId: item, decision: decision))
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

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            // Keeps the socket alive for the short grace period iOS allows, so a quick
            // approval from a notification still reaches the Mac.
            guard backgroundTask == .invalid else { return }
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "bridge") { [weak self] in
                MainActor.assumeIsolated { self?.endBackgroundTask() }
            }
        case .active:
            endBackgroundTask()
            client.reconnectNow()
            if let open = client.openTask { notifier.clear(task: open) }
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
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        Group {
            if store.connection == .unpaired {
                PairingView()
            } else {
                HomeView()
                    .sheet(item: $router.pairingLink) { link in
                        NavigationStack { PairingView(link: link) }
                    }
            }
        }
        .tint(.accentColor)
    }
}

extension Pairing: Identifiable {
    var id: String { url.absoluteString + token }
}
