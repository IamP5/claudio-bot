import SwiftUI

/// The bar under a session's thread: model and mode, what is queued, the plan's usage, and the field with Send or
/// Stop. While Claude works, Send queues the message; holding it offers Stop and send. When the session cannot take
/// a message, the field gives way to the reason.
struct SessionComposer: View {
    let sessionId: SessionID
    let controls: SessionControls?
    var onSend: () -> Void = {}

    @Environment(BridgeClient.self) private var client
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ComposerDraft()
    @State private var caret = 0
    @State private var sends = 0
    @State private var stops = 0

    private var working: Bool { controls?.working ?? false }
    private var canSend: Bool { controls?.canSend ?? false }
    private var hasText: Bool { !draft.isBlank }
    /// A cloud session runs on claude.ai: the bridge can follow up on it but not stop it.
    private var canStop: Bool { store.sessions.rows[sessionId]?.origin != .cloud }
    private var showsStop: Bool { working && !hasText && canStop }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let controls { controlsRow(controls) }
            if canSend || controls == nil {
                field
            } else {
                Label(controls?.reason ?? "This session can't take a message now.", systemImage: "lock")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity, minHeight: Composer.field, alignment: .leading)
                    .padding(.horizontal, 16)
                    .glass(
                        in: RoundedRectangle(
                            cornerRadius: Composer.control / 2 + Composer.inset, style: .continuous)
                    )
                    .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.impact(weight: .medium), trigger: stops)
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 6) {
            PromptTextView(
                draft: $draft, caret: $caret, placeholder: working ? "Queue a message" : "Message Claude",
                maxLines: 6
            )
            .padding(.vertical, 8)
            .frame(minHeight: Composer.field)
            .padding(.leading, 16)
            .disabled(controls == nil)
            if hasText || showsStop {
                sendButton
                    .padding(.bottom, Composer.inset)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
            }
        }
        .padding(.trailing, Composer.inset)
        .animation(
            reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25, extraBounce: 0.12),
            value: hasText || showsStop
        )
        .glass(
            in: RoundedRectangle(cornerRadius: Composer.control / 2 + Composer.inset, style: .continuous))
    }

    @ViewBuilder
    private var sendButton: some View {
        let label = Image(systemName: showsStop ? "stop.fill" : "arrow.up")
            .font(.system(size: showsStop ? 14 : 16, weight: .bold))
            .contentTransition(.symbolEffect(.replace))
            .foregroundStyle(.black)
            .frame(width: Composer.control + 10, height: Composer.control)
            .background(Color.white, in: Capsule())
        if working && hasText && canStop {
            Menu {
                Button {
                    send(interrupt: true)
                } label: {
                    Label("Stop and send", systemImage: "stop.circle")
                }
                Button {
                    send(interrupt: false)
                } label: {
                    Label("Send after this turn", systemImage: "clock")
                }
            } label: {
                label
            } primaryAction: {
                send(interrupt: false)
            }
            .accessibilityLabel("Queue message")
            .accessibilityHint("Sends when the current turn ends. Hold for Stop and send.")
            .accessibilityAction(named: "Stop and send") { send(interrupt: true) }
        } else {
            Button {
                if showsStop { stop() } else { send(interrupt: false) }
            } label: {
                label
            }
            .buttonStyle(.pressable)
            .accessibilityLabel(showsStop ? "Stop" : "Send")
        }
    }

    private func controlsRow(_ controls: SessionControls) -> some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if !controls.models.isEmpty {
                        Menu {
                            Picker(
                                "Model",
                                selection: Binding(
                                    get: { controls.model ?? controls.models.first?.id ?? "" },
                                    set: {
                                        client.send(
                                            .sessionSet(sessionId: sessionId, patch: SessionPatch(model: .some($0))))
                                    }
                                )
                            ) {
                                ForEach(controls.models) { Text($0.label).tag($0.id) }
                            }
                        } label: {
                            chip(Self.modelLabel(controls), symbol: "cpu")
                        }
                        .accessibilityLabel("Model, \(Self.modelLabel(controls))")
                    }
                    if !controls.modes.isEmpty {
                        Menu {
                            Picker(
                                "Mode",
                                selection: Binding(
                                    get: { controls.mode },
                                    set: {
                                        client.send(.sessionSet(sessionId: sessionId, patch: SessionPatch(mode: $0)))
                                    }
                                )
                            ) {
                                ForEach(controls.modes.filter { $0 != .bypassPermissions }, id: \.self) { mode in
                                    Label(SessionText.mode(mode), systemImage: SessionText.modeSymbol(mode)).tag(mode)
                                }
                            }
                        } label: {
                            chip(SessionText.mode(controls.mode), symbol: SessionText.modeSymbol(controls.mode))
                        }
                        .accessibilityLabel("Mode, \(SessionText.mode(controls.mode))")
                    }
                    if controls.queued > 0 {
                        chip("\(controls.queued) queued", symbol: "clock", tint: Theme.secondary)
                            .accessibilityLabel("\(controls.queued) messages queued")
                    }
                }
                .padding(.horizontal, 4)
            }
            if store.has(.usage) {
                SessionUsageButton(usage: store.usage) { router.showingUsage = true }
            }
        }
    }

    private func chip(_ title: String, symbol: String, tint: Color = .white) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.caption)
            Text(title).font(.footnote.weight(.medium)).lineLimit(1)
            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(
                Theme.tertiary)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 11)
        .frame(minHeight: 32)
        .glass(in: Capsule(), interactive: true)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    /// The chip's short name: "Default (Opus 5.5)" reads "Default"; the menu keeps the whole label.
    static func modelLabel(_ controls: SessionControls) -> String {
        let id = controls.model ?? controls.models.first?.id
        let label = controls.models.first { $0.id == id }?.label ?? controls.model ?? "Model"
        return label.replacing(/\s*\(.*\)$/, with: "")
    }

    private func send(interrupt: Bool) {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, canSend else { return }
        let clientId = UUID().uuidString
        store.threads[sessionId]?.echo(clientId: clientId, text: text)
        client.send(
            .sessionSend(sessionId: sessionId, text: text, clientId: clientId, interrupt: interrupt))
        draft = ComposerDraft()
        caret = 0
        sends += 1
        onSend()
    }

    private func stop() {
        client.send(.sessionStop(sessionId: sessionId))
        stops += 1
    }
}

/// A new Claude Code session in one of the Mac's projects. The bridge answers with the session's id before Claude
/// Code starts, and the app opens it.
struct NewSessionSheet: View {
    let projectId: ProjectID?

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var project: ProjectID?
    @State private var draft = ComposerDraft()
    @State private var caret = 0
    @State private var model: String?
    @State private var mode: PermissionMode?
    @State private var worktree = false
    @State private var starting = false

    private var models: [SessionModelOption] {
        store.threads.lastModels
    }

    private var canStart: Bool {
        project != nil && !draft.isBlank && !starting && store.machine != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    Picker("Project", selection: $project) {
                        ForEach(store.sessions.orderedProjects) { project in
                            Text(project.name).tag(Optional(project.id))
                        }
                    }
                    .pickerStyle(.navigationLink)
                }
                Section {
                    PromptTextView(
                        draft: $draft, caret: $caret, placeholder: "What should Claude do?", minLines: 4,
                        maxLines: 10, autofocus: true
                    )
                    .padding(.vertical, 4)
                }
                Section {
                    if !models.isEmpty {
                        Picker("Model", selection: $model) {
                            Text("Your default").tag(String?.none)
                            ForEach(models) { Text($0.label).tag(Optional($0.id)) }
                        }
                    }
                    Picker("Mode", selection: $mode) {
                        Text("Your Claude Code default").tag(PermissionMode?.none)
                        ForEach(SessionText.phoneModes, id: \.self) { mode in
                            Label(SessionText.mode(mode), systemImage: SessionText.modeSymbol(mode)).tag(
                                Optional(mode))
                        }
                    }
                    Toggle("Work in a new worktree", isOn: $worktree)
                        .tint(AvatarColor.green.color)
                } footer: {
                    Text(
                        worktree
                            ? "Claude works on its own branch in a new worktree, so the project's checkout stays as it is."
                            : "Claude works in the project's folder, on the branch checked out there.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if starting {
                        ProgressView()
                    } else {
                        Button("Start", action: start).disabled(!canStart)
                    }
                }
            }
        }
        .onAppear { project = projectId ?? store.sessions.orderedProjects.first?.id }
        // A refused create comes back as an error frame, so the sheet lets the user try again.
        .onChange(of: store.lastError) {
            if starting {
                starting = false
                router.pendingSessionCreate = nil
            }
        }
        .interactiveDismissDisabled(starting)
    }

    private func start() {
        guard let project, canStart else { return }
        let ref = UUID().uuidString
        starting = true
        router.pendingSessionCreate = ref
        client.send(
            .sessionCreate(
                ref: ref, projectId: project,
                text: draft.text.trimmingCharacters(in: .whitespacesAndNewlines),
                model: model, mode: mode, isolate: worktree ? .worktree : .inPlace
            ))
    }
}
