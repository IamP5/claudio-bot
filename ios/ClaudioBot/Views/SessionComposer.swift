import SwiftUI

struct SessionComposer: View {
    let sessionId: SessionID
    @Bindable var model: ThreadModel
    /// The thread's announcer, so what the composer says keeps the thread's spacing and never talks over the status line.
    let announce: (String) -> Void
    var onSend: () -> Void = {}

    @Environment(BridgeClient.self) private var client
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var scaled = Composer.control
    /// Send and Stop grow with the text, up to a size that leaves the field its room (F-SES-134).
    private var control: CGFloat { min(scaled, Composer.control * 1.5) }
    @AccessibilityFocusState private var lockFocused: Bool
    @State private var caret = 0
    @State private var sends = 0
    @State private var stops = 0
    @State private var sentAt: Date?
    @State private var sentQueued = false
    /// Redraws the composer when Sent or a pending stop runs out of time.
    @State private var clock = Date.now
    @State private var confirming: StopScope?

    private var controls: SessionControls? { model.controls }
    private var canSend: Bool { controls?.canSend ?? false }
    /// A cloud session runs on claude.ai: the bridge can follow up on it but not stop it.
    private var canStop: Bool { store.sessions.rows[sessionId]?.origin != .cloud }
    private var stopRequest: StopRequest? { store.latestStop(in: sessionId, [.all, .turn]) }

    private func state(at now: Date) -> ComposerState {
        ComposerState(
            controls: controls, hasText: !model.draft.isBlank, canStop: canStop,
            lastSend: sentAt.map { ($0, sentQueued) }, stop: stopRequest, now: now
        )
    }

    var body: some View {
        let now = max(clock, .now)
        let state = state(at: now)
        let note = ComposerNote.of(error: store.sessionErrors[sessionId], stop: state.stop, set: store.sets[sessionId], now: now)
        glassGroup {
            VStack(alignment: .leading, spacing: 8) {
                if let controls { controlsRow(controls) }
                if canSend || controls == nil {
                    field(state)
                } else {
                    lockLine
                }
                if let note { noteLine(note) }
            }
        }
        #if os(macOS)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 16)
        #else
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        #endif
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.impact(weight: .medium), trigger: stops)
        .confirmationDialog(
            confirming?.confirmTitle ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible, presenting: confirming
        ) { scope in
            Button(scope.confirmAll, role: .destructive) { stop(.all) }
            if scope.turn { Button("Stop the turn only") { stop(.turn) } }
            Button("Cancel", role: .cancel) {}
        } message: { scope in
            Text(scope.confirmMessage(queued: controls?.queued ?? 0))
        }
        .task(id: sentAt) {
            guard let sentAt else { return }
            try? await Task.sleep(for: .seconds(max(0, ComposerState.sentShown - Date.now.timeIntervalSince(sentAt))))
            if !Task.isCancelled { clock = .now }
        }
        .task(id: stopRequest) {
            guard let request = stopRequest, request.state == .pending else { return }
            try? await Task.sleep(for: .seconds(max(0, StopRequest.patience - Date.now.timeIntervalSince(request.at))))
            if !Task.isCancelled { clock = .now }
        }
        .onChange(of: state.stop?.phase) { _, phase in
            guard let phase, let scope = state.stop?.scope, let text = ComposerState.announcement(phase, scope) else { return }
            announce(text)
        }
        .onChange(of: store.sessionErrors[sessionId]) { _, error in
            // A refused stop is spoken with the stop's own progress.
            if let error, error.kind != .stop { announce("Error: " + error.text) }
        }
        .onChange(of: canSend) { was, now in
            guard was, !now, let controls else { return }
            announce(controls.reason ?? "This session can't take a message now.")
            lockFocused = true
        }
    }

    /// On the Mac the chips and the field sample the backdrop together, so they read as one control group.
    @ViewBuilder
    private func glassGroup(@ViewBuilder _ content: () -> some View) -> some View {
        #if os(macOS)
        GlassEffectContainer(spacing: 8, content: content)
        #else
        content()
        #endif
    }

    private var lockLine: some View {
        Label(controls?.reason ?? "This session can't take a message now.", systemImage: "lock")
            .font(.subheadline)
            .foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, minHeight: Composer.field, alignment: .leading)
            .padding(.horizontal, 16)
            .glass(in: RoundedRectangle(cornerRadius: Composer.control / 2 + Composer.inset, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityFocused($lockFocused)
    }

    /// At accessibility sizes the controls go under the text, so the field keeps the row's width.
    @ViewBuilder
    private func field(_ state: ComposerState) -> some View {
        let text = PromptTextView(
            draft: $model.draft, caret: $caret, placeholder: ComposerState.placeholder(controls), label: ComposerState.fieldLabel(controls),
            maxLines: 6, onSubmit: { send(interrupt: false) }
        )
        .padding(.vertical, 8)
        .frame(minHeight: Composer.field)
        .padding(.leading, 16)
        .disabled(controls == nil)
        let buttons = HStack(spacing: 6) {
            if let beside = state.stopBeside {
                stopButton(beside.scope, beside.phase)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
            }
            slot(state.slot)
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25, extraBounce: 0.12), value: state.stopBeside != nil)
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .trailing, spacing: 0) {
                    text
                    buttons.padding(.bottom, Composer.inset)
                }
            } else {
                HStack(alignment: .bottom, spacing: 6) {
                    text
                    buttons.padding(.bottom, Composer.inset)
                }
            }
        }
        .padding(.trailing, Composer.inset)
        .glass(in: RoundedRectangle(cornerRadius: Composer.control / 2 + Composer.inset, style: .continuous))
    }

    /// Always drawn, so the control under VoiceOver's focus stays put as it turns from Send to Sent to Stop.
    private func slot(_ slot: ComposerState.Slot) -> some View {
        Button {
            switch slot {
            case .send: send(interrupt: false)
            case let .stop(scope, phase): tapStop(scope, phase)
            }
        } label: {
            capsule(slot.symbol, spinning: slot.spins, dimmed: !slot.acts)
        }
        .buttonStyle(.pressable)
        .disabled(!slot.acts)
        .contextMenu {
            if case .send(.queue) = slot {
                Button { send(interrupt: true) } label: { Label("Stop turn and send", systemImage: "stop.circle") }
                Button { send(interrupt: false) } label: { Label("Send after this turn", systemImage: "clock") }
            }
        }
        .accessibilityLabel(slot.label)
        .accessibilityHint(slot.hint ?? "")
        .accessibilityActions {
            if case .send(.queue) = slot { Button("Stop turn and send") { send(interrupt: true) } }
        }
        .help(slot == .send(.queue) ? "Send After This Turn. Right-click for Stop Turn and Send." : slot.label)
    }

    private func stopButton(_ scope: StopScope, _ phase: StopPhase) -> some View {
        let slot = ComposerState.Slot.stop(scope, phase)
        return Button { tapStop(scope, phase) } label: {
            capsule(slot.symbol, spinning: slot.spins, dimmed: false, filled: false)
        }
        .buttonStyle(.pressable)
        .disabled(!slot.acts)
        .accessibilityLabel(slot.label)
        .accessibilityHint(slot.hint ?? "")
        .help(slot.label)
    }

    private func capsule(_ symbol: String, spinning: Bool, dimmed: Bool, filled: Bool = true) -> some View {
        Group {
            if spinning {
                ProgressView().controlSize(.small).tint(filled ? .black : .white)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: control * (symbol == "stop.fill" ? 0.4 : 0.45), weight: .bold))
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .foregroundStyle(filled ? .black : .white)
        .frame(width: control + (Composer.sendWidth - Composer.control), height: control)
        .background(filled ? Color.white.opacity(dimmed ? 0.35 : 1) : Theme.raised, in: Capsule())
    }

    private func noteLine(_ note: ComposerNote) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch note {
            case .error:
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.danger)
            case .stopping, .changing:
                ProgressView().controlSize(.mini)
            case .unconfirmed:
                Image(systemName: "questionmark.circle").foregroundStyle(Theme.attention)
            }
            Text(note.text)
                .foregroundStyle(note.isError ? Theme.danger : Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if case .error(let error) = note {
                Button("Dismiss") { store.dismissSessionError(error, in: sessionId) }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
            }
        }
        .font(.footnote)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
        .accessibilityRepresentation {
            Text(note.spoken)
            if case .error(let error) = note {
                Button("Dismiss") { store.dismissSessionError(error, in: sessionId) }
            }
        }
    }

    private func controlsRow(_ controls: SessionControls) -> some View {
        let changing = store.sets[sessionId].flatMap { Date.now.timeIntervalSince($0.at) < SetRequest.patience ? $0.change : nil }
        // At accessibility sizes the usage ring joins the chips, so they get the row's width.
        let stacked = typeSize.isAccessibilitySize
        return HStack(spacing: 8) {
            ChipFlow(spacing: 8, lineSpacing: 0) {
                if !controls.models.isEmpty {
                    Menu {
                        Picker(
                            "Model",
                            selection: Binding(
                                get: { controls.model ?? controls.models.first?.id ?? "" },
                                set: { client.send(.sessionSet(sessionId: sessionId, patch: SessionPatch(model: .some($0)))) }
                            )
                        ) {
                            ForEach(controls.models) { Text($0.label).tag($0.id) }
                        }
                    } label: {
                        chip(controls.modelLabel, symbol: "cpu", busy: changing.map { if case .model = $0 { true } else { false } } ?? false)
                    }
                    .chipMenu()
                    .accessibilityLabel("Model, \(controls.modelLabel)" + Self.changingWords(changing, model: true))
                    .help("Model")
                }
                if !controls.modes.isEmpty {
                    Menu {
                        Picker(
                            "Mode",
                            selection: Binding(
                                get: { controls.mode },
                                set: { client.send(.sessionSet(sessionId: sessionId, patch: SessionPatch(mode: $0))) }
                            )
                        ) {
                            ForEach(controls.modes.filter { $0 != .bypassPermissions }, id: \.self) { mode in
                                Label(SessionText.mode(mode), systemImage: SessionText.modeSymbol(mode)).tag(mode)
                            }
                        }
                    } label: {
                        chip(
                            SessionText.mode(controls.mode), symbol: SessionText.modeSymbol(controls.mode),
                            busy: changing.map { if case .mode = $0 { true } else { false } } ?? false
                        )
                    }
                    .chipMenu()
                    .accessibilityLabel("Mode, \(SessionText.mode(controls.mode))" + Self.changingWords(changing, model: false))
                    .help("Permission Mode")
                }
                if controls.queued > 0 { queuedChip(controls.queued) }
                if stacked { usage }
            }
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            if !stacked { usage }
        }
        // The chips are settings, not the conversation. Past this size they would push the field off the screen.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    @ViewBuilder
    private var usage: some View {
        if store.has(.usage) {
            SessionUsageButton(usage: store.usage) { router.showingUsage = true }
        }
    }

    /// ". Changing to Accept edits" while that change is in flight, so the label never claims the new value early.
    private static func changingWords(_ change: SetRequest.Change?, model: Bool) -> String {
        switch change {
        case .model(_, let label)? where model: ". Changing to \(label)"
        case .mode(let mode)? where !model: ". Changing to \(SessionText.mode(mode))"
        default: ""
        }
    }

    /// The messages waiting for the turn, each with Edit and Withdraw on a bridge that takes them back (F-SES-040).
    @ViewBuilder
    private func queuedChip(_ count: Int) -> some View {
        let label = ComposerState.queuedLabel(count)
        let waiting = model.queuedMessages
        if store.has(.sessionUnqueue), !waiting.isEmpty {
            Menu {
                ForEach(waiting, id: \.id) { message in
                    Section(OpenCard.firstLine(message.text, limit: 40) ?? "Message") {
                        Button { client.withdraw(message.id, text: message.text, from: model, edit: true) } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                        Button(role: .destructive) { client.withdraw(message.id, text: message.text, from: model, edit: false) } label: {
                            Label("Withdraw", systemImage: "arrow.uturn.backward")
                        }
                    }
                }
            } label: {
                chip(label, symbol: "clock", tint: Theme.secondary)
            }
            .chipMenu()
            .accessibilityLabel(label)
            .accessibilityHint("Edit or withdraw before it runs")
        } else {
            chip(label, symbol: "clock", tint: Theme.secondary, menu: false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
        }
    }

    private func chip(_ title: String, symbol: String, tint: Color = .white, busy: Bool = false, menu: Bool = true) -> some View {
        HStack(spacing: 5) {
            if busy {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: symbol).font(.caption)
            }
            Text(title).font(.footnote.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            if menu {
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Theme.tertiary)
            }
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 11)
        #if os(macOS)
        .frame(minHeight: 28)
        #else
        .frame(minHeight: 32)
        #endif
        .glass(in: Capsule(), interactive: menu)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private func send(interrupt: Bool) {
        let text = model.draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, canSend else { return }
        let queued = !interrupt && ComposerState.queues(controls)
        let clientId = UUID().uuidString
        model.echo(clientId: clientId, text: text)
        client.send(.sessionSend(sessionId: sessionId, text: text, clientId: clientId, interrupt: interrupt))
        model.draft = ComposerDraft()
        caret = 0
        sends += 1
        sentAt = .now
        sentQueued = queued
        announce(ComposerState.sentAnnouncement(queued: queued, interrupt: interrupt))
        onSend()
    }

    /// Only a stop that would end background work asks first (P-STOP-3). Trying again after a refusal does not ask twice.
    private func tapStop(_ scope: StopScope, _ phase: StopPhase) {
        if phase.retries {
            stop(stopRequest?.target ?? .all)
        } else if scope.asks {
            confirming = scope
        } else {
            stop(.all)
        }
    }

    /// A bridge without tasks stops everything and knows no turn identity, so the frame stays as it always was there.
    private func stop(_ target: StopTarget) {
        let aimed = store.has(.sessionTasks)
        client.send(.sessionStop(sessionId: sessionId, target: aimed ? target : nil, turnStartedAt: aimed ? controls?.turn?.startedAt : nil))
        stops += 1
    }
}

/// Chips in rows: one that does not fit goes to the next row, so none is cut or scrolled out of sight (F-SES-134).
private struct ChipFlow: Layout {
    var spacing: CGFloat
    /// The chips carry their own vertical padding.
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(subviews, width: proposal.width ?? .infinity)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.items {
                let size = size(of: subviews[index], width: bounds.width)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        for (index, subview) in subviews.enumerated() {
            let size = size(of: subview, width: width)
            if let last = rows.indices.last, rows[last].width + spacing + size.width <= width {
                rows[last].items.append(index)
                rows[last].width += spacing + size.width
                rows[last].height = max(rows[last].height, size.height)
            } else {
                rows.append(([index], size.width, size.height))
            }
        }
        return rows
    }

    /// A chip keeps its one-line width, and wraps its words only when even a row of its own is too narrow.
    private func size(of subview: LayoutSubview, width: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        return ideal.width <= width ? ideal : subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }
}

private extension ComposerNote {
    var isError: Bool {
        if case .error = self { true } else { false }
    }
}

extension ThreadModel {
    /// The user's messages that wait for the turn, oldest first.
    var queuedMessages: [(id: ItemID, text: String)] {
        items.compactMap { if case let .user(id, _, text, .user, true) = $0 { (id, text) } else { nil } }
    }
}

extension BridgeClient {
    /// Takes a queued message back before it runs. edit: its text goes back in the composer.
    func withdraw(_ id: ItemID, text: String, from model: ThreadModel, edit: Bool) {
        if edit { model.edit(text) }
        send(.sessionUnqueue(sessionId: model.id, clientId: id.rawValue))
    }
}

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
                Section {
                    Picker("Project", selection: $project) {
                        ForEach(store.sessions.orderedProjects) { project in
                            Text(project.name).tag(Optional(project.id))
                        }
                    }
                    .pickerStyle(.navigationLink)
                } header: {
                    // A Mac form labels the picker in its row, so a header would say "Project" twice.
                    #if os(iOS)
                    Text("Project")
                    #endif
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
                        #if os(iOS)
                        .tint(AvatarColor.green.color)
                        #endif
                } footer: {
                    Text(
                        worktree
                            ? "Claude works on its own branch in a new worktree, so the project's checkout stays as it is."
                            : "Claude works in the project's folder, on the branch checked out there.")
                }
            }
            #if os(macOS)
            .formStyle(.grouped)
            #else
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            #endif
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if starting {
                        ProgressView()
                    } else {
                        Button(Self.startTitle, action: start).disabled(!canStart)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, idealWidth: 520, minHeight: 420, idealHeight: 460)
        #endif
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

    #if os(macOS)
    private static let startTitle = "Create"
    #else
    private static let startTitle = "Start"
    #endif

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

private extension View {
    /// A Mac menu otherwise draws its own bezel and arrow around a chip that already has both.
    @ViewBuilder
    func chipMenu() -> some View {
        #if os(macOS)
        menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        #else
        self
        #endif
    }
}
