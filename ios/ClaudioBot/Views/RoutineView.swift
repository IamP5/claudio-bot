import SwiftUI

/// One routine: when it runs next, how its last runs went, and Run now.
struct RoutineView: View {
    let botId: BotID
    let routineId: RoutineID

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client

    var body: some View {
        Group {
            if let routine = store.bots[botId]?.routines.first(where: { $0.id == routineId }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        header(routine)
                        CardSection(title: "Prompt") {
                            Text(routine.prompt)
                                .font(.ui(size: 15))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                        }
                        runs
                        WebhookTokenSection(botId: botId, routine: routine)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
                }
                .safeAreaInset(edge: .bottom) { runNow(routine) }
            } else {
                ContentUnavailableView("Routine removed", systemImage: "timer", description: Text("This routine no longer exists."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .navigationTitle(store.bots[botId]?.routines.first(where: { $0.id == routineId })?.name ?? "Routine")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { client.send(.details(botId: botId)) }
    }

    private func header(_ routine: Routine) -> some View {
        VStack(spacing: 0) {
            Toggle(isOn: Binding(
                get: { routine.enabled },
                set: { client.send(.setRoutine(botId: botId, routineId: routineId, enabled: $0)) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(routine.describe).font(.ui(size: 16)).foregroundStyle(.white)
                    if !routine.schedule.isEmpty {
                        Text(routine.schedule).font(.ui(size: 13, design: .monospaced)).foregroundStyle(Theme.tertiary)
                    }
                }
            }
            .tint(AvatarColor.teal.color)
            .padding(16)
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16)
            HStack {
                Text("Next run").font(.ui(size: 16)).foregroundStyle(.white)
                Spacer()
                Text(Self.nextRun(routine)).font(.ui(size: 15)).foregroundStyle(Theme.secondary)
            }
            .padding(16)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    static func nextRun(_ routine: Routine) -> String {
        guard routine.enabled else { return "Paused" }
        if routine.trigger == .webhook { return "When called" }
        guard let next = routine.nextRunAt else { return "Not scheduled" }
        return TimeLabel.separator(next)
    }

    private var runs: some View {
        let history = store.runs(of: routineId, in: botId)
        return CardSection(title: "Last runs") {
            if history.isEmpty {
                Placeholder(text: "No runs yet.")
            } else {
                ForEach(Array(history.enumerated()), id: \.element.id) { index, run in
                    if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 16) }
                    RunRow(run: run)
                }
            }
        }
    }

    private func runNow(_ routine: Routine) -> some View {
        let running = routine.runs.first?.status == .running
        return Button {
            client.send(.runRoutine(botId: botId, routineId: routineId))
        } label: {
            Label(running ? "Running…" : "Run now", systemImage: "play.fill")
                .font(.ui(size: 16, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.white, in: Capsule())
                .foregroundStyle(.black)
        }
        .buttonStyle(.plain)
        .disabled(running)
        .opacity(running ? 0.6 : 1)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: 560)
    }
}

private struct RunRow: View {
    let run: RoutineRun

    private var color: Color {
        switch run.status {
        case .running: AvatarColor.orange.color
        case .ok: AvatarColor.green.color
        case .failed: Theme.danger
        case .quiet, .skipped, .unknown: Theme.secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                StatusPill(text: run.status.title, color: color, pulsing: run.status == .running)
                ForEach(run.tags, id: \.self) { tag in
                    Text(tag)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Theme.raised, in: Capsule())
                }
                Spacer(minLength: 0)
                Text(TimeLabel.separator(run.at))
                    .font(.ui(size: 13))
                    .foregroundStyle(Theme.tertiary)
                    .lineLimit(1)
            }
            if let note = run.note {
                Text(note)
                    .font(.ui(size: 14))
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}
