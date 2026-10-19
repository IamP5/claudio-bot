import SwiftUI

/// The bot's connectors in its profile: names and statuses, each with a switch. Shown when the bridge lists .connectors.
struct ConnectorsSection: View {
    let bot: Bot
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client

    enum Rows: Equatable {
        case hidden
        case loading
        case shown([Connector])
    }

    static func rows(_ store: AppStore, _ botId: BotID) -> Rows {
        guard store.has(.connectors) else { return .hidden }
        guard let connectors = store.connectors[botId] else { return .loading }
        return .shown(connectors)
    }

    static func toggle(_ botId: BotID, _ connector: Connector, enabled: Bool) -> ClientMessage {
        .setConnector(botId: botId, name: connector.name, enabled: enabled)
    }

    static func detail(_ connector: Connector) -> String {
        guard connector.enabled else { return "Off for this Bot and its agents" }
        switch connector.status {
        case .connected: return "Connected"
        case .pending: return "Connecting"
        case .failed: return "Could not connect"
        case .needsAuth: return "Needs sign-in on your Mac"
        case .unchecked: return "Not checked yet"
        case .unknown(let raw): return raw
        }
    }

    var body: some View {
        let rows = Self.rows(store, bot.id)
        if rows != .hidden {
            CardSection(
                title: "Connectors",
                footer: "The MCP servers this Bot loads on your Mac. Turning one off covers its agents too and saves the tokens it would cost."
            ) {
                switch rows {
                case .hidden:
                    EmptyView()
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 28)
                case .shown(let connectors) where connectors.isEmpty:
                    Placeholder(text: "No connectors yet. They show here once this Bot has run a turn.")
                case .shown(let connectors):
                    ForEach(Array(connectors.enumerated()), id: \.element.id) { index, connector in
                        if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16) }
                        row(connector)
                    }
                }
            }
            .task(id: bot.id) { client.send(.connectors(botId: bot.id)) }
        } else if store.lacks(.connectors) {
            NeedsNewerBridge(title: "Connectors", what: "turn this Bot's connectors on and off")
        }
    }

    private func row(_ connector: Connector) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(connector.name).font(.ui(size: 16)).foregroundStyle(.white)
                Text(Self.detail(connector)).font(.ui(size: 13)).foregroundStyle(Theme.secondary)
            }
            Spacer(minLength: 0)
            Toggle(connector.name, isOn: Binding(
                get: { connector.enabled },
                set: { client.send(Self.toggle(bot.id, connector, enabled: $0)) }
            ))
            .labelsHidden()
            .tint(AvatarColor.teal.color)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
