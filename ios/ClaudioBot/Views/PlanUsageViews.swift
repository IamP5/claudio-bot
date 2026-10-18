import SwiftUI

extension UsageSeverity {
    var tint: Color {
        switch self {
        case .warning: Theme.attention
        case .critical: Theme.danger
        case .normal, .unknown: AvatarColor.teal.color
        }
    }
}

struct PlanUsageSection: View {
    /// The sheet is titled Plan usage already, so its section says only what the rows are.
    var title = "Plan usage"
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @State private var refreshing = false

    /// Asks the bridge to read again and waits for the answer, at most as long as the bridge's own read may take.
    static func refresh(_ store: AppStore, _ client: BridgeClient) async {
        let before = store.usage
        client.send(.refreshUsage)
        for _ in 0..<80 {
            if store.usage != before || Task.isCancelled { return }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    var body: some View {
        if store.has(.usage) {
            Section {
                rows
            } header: {
                header
            } footer: {
                if let usage = store.usage {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text([UsageText.plan(plan(of: usage)), UsageText.status(usage, now: context.date)].compactMap(\.self).joined(separator: " · "))
                    }
                }
            }
        } else if store.lacks(.usage) {
            Section("Plan usage") {
                Text("Update the bridge on your Mac to see your plan's usage limits.")
                    .foregroundStyle(Theme.secondary)
            }
        }
    }

    @ViewBuilder
    private var rows: some View {
        switch store.usage {
        case nil:
            HStack(spacing: 10) {
                ProgressView()
                Text("Reading usage from your Mac…").foregroundStyle(Theme.secondary)
            }
        case .ok(_, _, _, let windows) where windows.isEmpty:
            Text("Claude Code reported no limits for this plan.").foregroundStyle(Theme.secondary)
        case .ok(_, _, let stale, let windows):
            ForEach(windows) { UsageRow(window: $0, stale: stale) }
        case .unavailable(let reason, _):
            Label {
                Text(UsageText.unavailable(reason)).foregroundStyle(Theme.secondary)
            } icon: {
                Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.tertiary)
            }
        }
    }

    private var header: some View {
        HStack {
            Text(title)
            Spacer()
            Button {
                refreshing = true
                Task {
                    await Self.refresh(store, client)
                    refreshing = false
                }
            } label: {
                if refreshing {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .disabled(refreshing || store.machine == nil)
            .accessibilityLabel("Refresh plan usage")
        }
    }

    private func plan(of usage: PlanUsage) -> String? {
        if case .ok(let plan, _, _, _) = usage { plan } else { nil }
    }
}

struct UsageRow: View {
    let window: UsageWindow
    var stale = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let tint = window.severity.tint
            VStack(alignment: .leading, spacing: 8) {
                let line = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
                line {
                    Text(window.label).foregroundStyle(.white)
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    Text(UsageText.used(window.utilization))
                        .font(.subheadline.monospacedDigit().weight(window.severity == .normal ? .regular : .semibold))
                        .foregroundStyle(window.severity == .normal ? Theme.secondary : tint)
                }
                ProgressView(value: min(max(window.utilization, 0), 1))
                    .tint(tint)
                if let reset = UsageText.resets(window.resetsAt, now: context.date) {
                    Text(reset).font(.footnote).foregroundStyle(Theme.secondary)
                }
            }
            .padding(.vertical, 4)
            .opacity(stale ? 0.6 : 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(UsageText.spoken(window, now: context.date))
        }
    }
}

struct SessionUsageButton: View {
    let usage: PlanUsage?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if let window = usage?.session {
                HStack(spacing: 6) {
                    ring(window)
                    Text("\(UsageText.percent(window.utilization))%")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background {
                    if #unavailable(iOS 26.0) { Capsule().fill(Theme.card) }
                }
                .opacity(isStale ? 0.6 : 1)
            } else {
                Image(systemName: "gauge.with.dots.needle.33percent")
                    .foregroundStyle(Theme.secondary)
                    .frame(width: 36, height: 36)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(usage?.session.map { UsageText.spoken($0, now: .now) } ?? "Plan usage")
        .accessibilityHint("Shows your plan's usage limits")
    }

    private var isStale: Bool {
        if case .ok(_, _, true, _) = usage { true } else { false }
    }

    private func ring(_ window: UsageWindow) -> some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.14), lineWidth: 3)
            Circle()
                .trim(from: 0, to: min(max(window.utilization, 0), 1))
                .stroke(window.severity.tint, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 16, height: 16)
    }
}

struct PlanUsageView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                PlanUsageSection(title: "Limits")
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .refreshable { await PlanUsageSection.refresh(store, client) }
            .navigationTitle("Plan usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
