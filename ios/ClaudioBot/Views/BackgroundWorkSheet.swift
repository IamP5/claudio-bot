import SwiftUI

/// The session's live tasks (P-BG-3): each subagent and background command with what it is, how long it has run, who
/// started it and a Stop of its own (P-STOP-2), and Stop all under them.
struct BackgroundWorkSheet: View {
    let sessionId: SessionID
    /// Set while the thread's state may be out of date: clocks stop there and Stop waits for the Mac.
    let staleAt: Date?

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var openCommands: Set<TaskID> = []

    private var model: ThreadModel? { store.threads[sessionId] }
    private var tasks: [SessionTask] { model?.controls?.tasks ?? [] }

    var body: some View {
        NavigationStack {
            Group {
                if tasks.isEmpty {
                    ContentUnavailableView("Nothing running", systemImage: "checkmark.circle", description: Text("Nothing runs in the background now."))
                        .foregroundStyle(Theme.secondary)
                } else {
                    list
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .navigationTitle("Running now")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, idealWidth: 560, minHeight: 360, idealHeight: 480)
        #endif
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let now = staleAt ?? context.date
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(tasks) { task in
                                row(task, now: now, clock: context.date)
                                if task.id != tasks.last?.id { Rectangle().fill(Theme.hairline).frame(height: 1) }
                            }
                        }
                        .padding(.horizontal, 14)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        if store.has(.sessionTasks) {
                            stopAll(clock: context.date)
                            if case .refused(let why) = phase(.all, context.date) {
                                Text("Couldn't stop. " + why)
                                    .font(.footnote)
                                    .foregroundStyle(Theme.danger)
                                    .padding(.top, 8)
                                    .accessibilityLabel("Error: couldn't stop. " + why)
                            }
                        }
                    }
                }
                if staleAt != nil {
                    Text("Your Mac has not confirmed this for a while, so it may have changed.")
                        .font(.footnote)
                        .foregroundStyle(Theme.tertiary)
                        .padding(.top, 12)
                }
            }
            .padding(16)
            .frame(maxWidth: SessionThreadView.column)
            .frame(maxWidth: .infinity)
        }
    }

    private func row(_ task: SessionTask, now: Date, clock: Date) -> some View {
        let line = Self.status(task, now: now, owner: owner(of: task))
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
        return layout {
            words(task, line)
            stop(task, clock: clock)
        }
        .padding(.vertical, 12)
    }

    private func words(_ task: SessionTask, _ line: String) -> some View {
        let refusal = refusal(of: task)
        let command = command(of: task)
        return VStack(alignment: .leading, spacing: 4) {
            Text(title(of: task))
                .font(task.kind == .command && command == nil ? .system(.subheadline, design: .monospaced) : .subheadline)
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
            if let command {
                StepDetail(
                    text: command, title: title(of: task),
                    open: Binding(
                        get: { openCommands.contains(task.id) },
                        set: { if $0 { openCommands.insert(task.id) } else { openCommands.remove(task.id) } }
                    )
                )
            }
            Text(line)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(task.waiting != nil ? Theme.attention : Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            if let refusal {
                Text("Couldn't stop. " + refusal)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            title(of: task) + ", " + Self.status(task, now: staleAt ?? .now, owner: owner(of: task), spoken: true) + (command.map { ", command: " + $0 } ?? "")
                + (refusal.map { ". Error: couldn't stop. " + $0 } ?? "")
        )
    }

    private func step(of task: SessionTask) -> ToolStep? {
        guard let id = task.stepId else { return nil }
        for case let .work(_, _, steps) in model?.items ?? [] {
            if let step = steps.first(where: { $0.id == id }) { return step }
        }
        return nil
    }

    /// A command's task is named by its step's title, "Sleep 75 seconds", and its command goes under it in full; the
    /// task's own label is that command cut to one line (F-SES-203). Other tasks keep their label.
    private func title(of task: SessionTask) -> String {
        command(of: task).flatMap { _ in step(of: task)?.label } ?? task.label
    }

    private func command(of task: SessionTask) -> String? {
        guard task.kind == .command, let step = step(of: task), let detail = step.detail, !detail.isEmpty, detail != step.label else { return nil }
        return detail
    }

    private func refusal(of task: SessionTask) -> String? {
        if case .refused(let why)? = store.stops[sessionId]?[.task(task.id)]?.state { why } else { nil }
    }

    private func phase(_ target: StopTarget, _ clock: Date) -> StopPhase {
        StopPhase(store.stops[sessionId]?[target], at: clock)
    }

    @ViewBuilder
    private func stop(_ task: SessionTask, clock: Date) -> some View {
        if store.has(.sessionTasks) {
            let phase = phase(.task(task.id), clock)
            let name = title(of: task)
            Button {
                client.send(.sessionStop(sessionId: sessionId, target: .task(task.id)))
            } label: {
                Text(phase == .stopping ? "Stopping…" : phase.retries ? "Try again" : "Stop")
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .tint(phase == .stopping ? Theme.secondary : Theme.danger)
            .disabled(phase == .stopping)
            .accessibilityLabel(phase == .stopping ? "Stopping \(name)" : phase.retries ? "Not stopped yet. Try stopping \(name) again" : "Stop \(name)")
        }
    }

    private func stopAll(clock: Date) -> some View {
        let phase = phase(.all, clock)
        let what = model?.controls?.turn == nil ? "all background work" : "the turn and all background work"
        return Button(role: .destructive) {
            client.send(.sessionStop(sessionId: sessionId, target: .all, turnStartedAt: model?.controls?.turn?.startedAt))
        } label: {
            Text(phase == .stopping ? "Stopping all…" : phase.retries ? "Not stopped yet. Stop all again" : "Stop all")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(Theme.danger)
        .disabled(phase == .stopping)
        .padding(.top, 16)
        .accessibilityLabel(phase == .stopping ? "Stopping \(what)" : "Stop \(what)")
    }

    /// The subagent that started the task: another live task, else the step it ran as.
    private func owner(of task: SessionTask) -> String? {
        guard let owner = task.owner else { return nil }
        if let parent = tasks.first(where: { $0.stepId == owner }) { return parent.label }
        for case let .work(_, _, steps) in model?.items ?? [] {
            if let step = steps.first(where: { $0.id == owner }) { return step.label }
        }
        return nil
    }

    /// "Background command · 1m 12s · started by sleeper one", "Subagent · 43s · 7 tools, last Read · waiting for your approval".
    static func status(_ task: SessionTask, now: Date, owner: String?, spoken: Bool = false) -> String {
        let kind = switch task.kind {
        case .agent: task.background ? "Background subagent" : "Subagent"
        case .command: task.background ? "Background command" : "Command"
        case .other, .unknown: task.background ? "Background task" : "Task"
        }
        var parts = [kind, (spoken ? RunClock.spoken : RunClock.short)(now.timeIntervalSince(task.startedAt))]
        if let progress = task.progress {
            parts.append(WorkSummary.plural(progress.tools, "tool") + (progress.last.map { ", last \($0)" } ?? ""))
        }
        if let owner { parts.append("started by \(owner)") }
        if task.waiting != nil { parts.append("waiting for your approval") }
        return parts.joined(separator: spoken ? ", " : " · ")
    }
}
