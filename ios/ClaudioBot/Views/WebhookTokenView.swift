import SwiftUI
import UIKit

/// A webhook routine's token: make or rotate it, then show it once. Shown when the bridge lists .webhooks.
struct WebhookTokenSection: View {
    let botId: BotID
    let routine: Routine

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @State private var copied: String?

    static func shows(_ routine: Routine, features: Set<Feature>) -> Bool {
        features.contains(.webhooks) && routine.trigger == .webhook
    }

    var body: some View {
        if Self.shows(routine, features: store.features) {
            CardSection(
                title: "Webhook",
                footer: "Programs on your Mac POST to this address with the token; it does not answer from the phone or the network. The Mac keeps only a hash of the token, so it is shown once, and a new one replaces the old."
            ) {
                if let fresh = store.webhookToken, fresh.routineId == routine.id {
                    reveal(fresh)
                } else {
                    makeButton
                }
            }
            .onDisappear {
                if store.webhookToken?.routineId == routine.id { store.dismissWebhookToken() }
            }
        }
    }

    /// A command that fires the routine once, with the token, for pasting into Terminal on the Mac.
    static func curl(_ token: WebhookToken) -> String {
        "curl -X POST -H 'Authorization: Bearer \(token.token)' -d 'test from my phone' \(token.url.absoluteString)"
    }

    private var makeButton: some View {
        Button {
            client.send(.webhookToken(botId: botId, routineId: routine.id))
        } label: {
            HStack {
                Label("Make a new token", systemImage: "key.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(.white)
                Spacer()
            }
            .padding(16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func reveal(_ fresh: WebhookToken) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            field("Address", fresh.url.absoluteString)
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16)
            field("Token", fresh.token)
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16)
            field("Test it in Terminal on your Mac", Self.curl(fresh))
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16)
            Button("Done") { store.dismissWebhookToken() }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(AvatarColor.teal.color)
                .frame(maxWidth: .infinity)
                .padding(16)
        }
    }

    private func field(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 13)).foregroundStyle(Theme.tertiary)
                Text(value)
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button {
                UIPasteboard.general.string = value
                copied = title
            } label: {
                Label(copied == title ? "Copied" : "Copy", systemImage: copied == title ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 14, weight: .medium))
            }
            .buttonStyle(.bordered)
            .tint(.white)
        }
        .padding(16)
    }
}
