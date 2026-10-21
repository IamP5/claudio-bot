import SwiftUI

enum ThreadBanner: Equatable {
    case cloud(URL?)
    case busyElsewhere(String)
    case alsoInDesktop
    case waiting(String)

    static func of(row: SessionRow?, controls: SessionControls?) -> ThreadBanner? {
        guard let row else { return nil }
        if row.origin == .cloud { return .cloud(row.url) }
        if row.status == .parked { return .waiting(SessionText.parked(row.holder) + ". Your message runs next.") }
        let readOnly = controls.map { !$0.canSend } ?? false
        switch row.holder {
        case .desktop: return readOnly ? .busyElsewhere("Working in the Claude app. Read only.") : .alsoInDesktop
        case .terminal where readOnly: return .busyElsewhere("Working in a terminal. Read only.")
        case .other where readOnly: return .busyElsewhere("Another program is working in it. Read only.")
        default: return nil
        }
    }
}

struct SessionThreadView: View {
    let sessionId: SessionID

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var followsBottom = true
    @State private var showsJump = false
    @State private var fullOutput: ToolStep?
    /// The row on top when an earlier page was asked for. Once the page lands above it, the list scrolls back to it,
    /// so reading continues where it was.
    @State private var pageAnchor: ItemID?
    /// The step a card's "Show the step" scrolled to, tinted for a moment so the eye lands on it.
    @State private var revealed: HeldStep?
    @State private var renaming = false
    @State private var newTitle = ""

    private var row: SessionRow? { store.sessions.rows[sessionId] }

    /// The transcript, banners and composer share one centered column.
    #if os(macOS)
    static let column: CGFloat = 960
    #else
    static let column: CGFloat = 760
    #endif

    var body: some View {
        Group {
            if let model = store.threads[sessionId] {
                switch model.phase {
                case .loading:
                    ThreadSkeleton()
                case .ready:
                    thread(model)
                case .removed(let movedTo):
                    ContentUnavailableView(
                        movedTo == nil ? "This session is gone" : "This session moved",
                        systemImage: "tray",
                        description: Text(movedTo == nil ? "Its transcript is no longer on your Mac." : "Opening it where it continues…")
                    )
                    .foregroundStyle(Theme.secondary)
                    .task(id: movedTo) {
                        if let movedTo { router.open(.session(movedTo)) }
                    }
                }
            } else {
                ThreadSkeleton()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .sheet(item: $fullOutput) { step in
            ToolOutputSheet(sessionId: sessionId, step: step)
        }
        .alert("Rename Session", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty { client.send(.sessionSet(sessionId: sessionId, patch: SessionPatch(title: title))) }
            }
        }
    }

    private func thread(_ model: ThreadModel) -> some View {
        let botName = row?.agent.flatMap { store.bots[$0.botId]?.name }
        let rows = model.rows
        let openCard = Self.openCard(model.items)
        return ScrollView {
            // Not lazy: a lazy stack estimates the height of rows it has not drawn, and at the largest text sizes one
            // row can be several screens tall. Pinned to the bottom, a swipe moved the rows by those estimates and they
            // never settled, so the app stopped responding.
            VStack(alignment: .leading, spacing: 0) {
                // Lazy, so the earlier page loads only once the thread is scrolled up to it.
                LazyVStack {
                    if model.before != nil {
                        LoadEarlierRow(loading: model.loadingEarlier)
                            .onAppear { loadEarlier(model) }
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    ThreadRowView(row: row, sessionId: sessionId, model: model, botName: botName) { fullOutput = $0 }
                        .equatable()
                        .padding(.top, index == 0 ? 12 : Self.gap(between: rows[index - 1], and: row))
                }
                // Under a card that waits on the user, "Working" would say the opposite of what is happening.
                StreamingTail(live: model.live, working: (model.controls?.working ?? false) && openCard == nil)
            }
            // An answered card collapses with its own animation. Moving the rows and the Working line in the same
            // transaction keeps them from snapping over the card while it shrinks.
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: openCard?.id)
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
            .frame(maxWidth: Self.column)
            .frame(maxWidth: .infinity)
        }
        .environment(\.revealStep) { reveal($0, in: model) }
        .environment(\.revealedStep, revealed?.step.id)
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        #if os(macOS)
        // The chips and the field float apart. A hard edge keeps the transcript from showing between them.
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        #endif
        .onScrollPhaseChange { _, phase, context in
            switch phase {
            case .interacting: followsBottom = false
            case .idle: if !followsBottom { followsBottom = Self.bottomGap(context.geometry) < 60 }
            default: break
            }
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height + $0.contentInsets.bottom } action: { _, _ in
            if followsBottom { position.scrollTo(edge: .bottom) }
        }
        .onScrollGeometryChange(for: Bool.self) { Self.bottomGap($0) > 200 } action: { _, far in
            withAnimation(.easeOut(duration: 0.2)) { showsJump = far }
        }
        .overlay(alignment: .bottomTrailing) {
            if showsJump {
                JumpToLatestButton {
                    followsBottom = true
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.35)) { position.scrollTo(edge: .bottom) }
                }
                .padding(.trailing, 16)
                .padding(.bottom, 12)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.8)))
            }
        }
        // Following the bottom would push an opened group's steps up and off screen. It opens in place instead.
        .onChange(of: model.expanded) { old, new in
            if !new.subtracting(old).isEmpty { followsBottom = false }
        }
        .onChange(of: model.loadingEarlier) { _, loading in
            guard !loading, let anchor = pageAnchor else { return }
            pageAnchor = nil
            position.scrollTo(id: anchor, anchor: .top)
        }
        .scrollDismissesKeyboard(.interactively)
        .topBar { banner(model) }
        .composerBar {
            SessionComposer(sessionId: sessionId, controls: model.controls) {
                followsBottom = true
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.3)) { position.scrollTo(edge: .bottom) }
            }
            .frame(maxWidth: Self.column)
        }
        .onChange(of: openCard) { old, new in
            if let new, new.id != old?.id { AccessibilityNotification.Announcement(new.announcement).post() }
        }
    }

    @ViewBuilder
    private func banner(_ model: ThreadModel) -> some View {
        if OfflineBar.shows(store.connection) {
            OfflineBar(state: store.connection).frame(maxWidth: Self.column)
        } else if let banner = ThreadBanner.of(row: row, controls: model.controls) {
            HolderBanner(banner: banner).frame(maxWidth: Self.column)
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            ThreadHeader(row: row, project: row.flatMap { store.sessions.project(of: $0) }, avatar: row?.agent.flatMap { store.bots[$0.botId]?.avatar })
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let row {
                    if row.origin == .cloud, let url = row.url {
                        Button { openURL(url) } label: { Label("Open on claude.ai", systemImage: "safari") }
                    } else {
                        Button { client.send(.sessionOpenDesktop(sessionId: sessionId)) } label: {
                            Label("Open in Claude App", systemImage: "macwindow")
                        }
                    }
                    if let pr = row.pr {
                        Button { openURL(pr.url) } label: { Label("Open PR #\(pr.number)", systemImage: "arrow.triangle.pull") }
                    }
                    Button {
                        newTitle = row.title
                        renaming = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button {
                        client.send(.sessionSet(sessionId: sessionId, patch: SessionPatch(hidden: !row.hidden)))
                    } label: {
                        Label(row.hidden ? "Show in Sidebar" : "Hide from Sidebar", systemImage: row.hidden ? "eye" : "eye.slash")
                    }
                }
                Button { Clipboard.copy(sessionId.rawValue) } label: {
                    Label("Copy Session ID", systemImage: "doc.on.doc")
                }
                if let project = row.flatMap({ store.sessions.project(of: $0) }) { LocalPathMenu(path: project.path) }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel("More")
            .help("More")
        }
    }

    private func loadEarlier(_ model: ThreadModel) {
        guard let cursor = model.requestEarlier() else { return }
        pageAnchor = model.rows.first?.id
        client.send(.sessionPage(sessionId: sessionId, before: cursor))
    }

    /// Opens the fold that hides the step's work run and marks the step, which opens the run. On the next pass, once the
    /// run has laid out its steps, it scrolls to the step and the mark fades after two seconds.
    private func reveal(_ held: HeldStep, in model: ThreadModel) {
        let fold = model.rows.first { row in
            if case let .fold(_, items, false) = row { items.contains { $0.id == held.row } } else { false }
        }
        if let fold { model.toggle(fold: fold.id) }
        followsBottom = false
        revealed = held
        DispatchQueue.main.async {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.35)) { position.scrollTo(id: held.step.id, anchor: .center) }
        }
        Task {
            try? await Task.sleep(for: .seconds(2))
            if revealed == held { withAnimation(.easeOut(duration: 0.4)) { revealed = nil } }
        }
    }

    private static func bottomGap(_ geometry: ScrollGeometry) -> CGFloat {
        geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY
    }

    private static func gap(between previous: ThreadRow, and row: ThreadRow) -> CGFloat {
        switch (previous.kind, row.kind) {
        case (_, .prompt): 24
        case (.step, .step): 2
        case (.prompt, _): 16
        default: 12
        }
    }

    /// The newest card waiting on the user, so VoiceOver can announce one when it arrives.
    struct OpenCard: Equatable {
        let id: ItemID
        let announcement: String
    }

    static func openCard(_ items: [SessionItem]) -> OpenCard? {
        for item in items.reversed() {
            switch item {
            case let .permission(id, _, permission) where permission.card.answer == nil:
                return OpenCard(id: id, announcement: "Approval needed: \(permission.card.label)")
            case let .ask(id, _, questions, nil, _?):
                return OpenCard(id: id, announcement: "Question: \(questions.first?.question ?? "")")
            case let .plan(id, _, _, .proposed, _?):
                return OpenCard(id: id, announcement: "A plan is ready for your approval")
            default:
                continue
            }
        }
        return nil
    }
}

extension ThreadRow {
    enum Kind { case prompt, step, other }

    var kind: Kind {
        switch self {
        case .fold: .step
        case .item(.user): .prompt
        case .item(.thinking), .item(.work): .step
        case .item: .other
        }
    }
}

struct ThreadHeader: View {
    let row: SessionRow?
    let project: SessionProject?
    let avatar: Avatar?

    var body: some View {
        VStack(spacing: 1) {
            Text(row?.title ?? "Session")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            HStack(spacing: 4) {
                if let row { OriginBadge(origin: row.origin, avatar: avatar, size: 12) }
                Text([project?.name, row?.branch].compactMap { $0 }.joined(separator: " · "))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(.caption)
            .foregroundStyle(Theme.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        #if os(macOS)
        // The toolbar item already sits on the toolbar's glass.
        .frame(maxWidth: 360)
        #else
        .frame(maxWidth: 260)
        .glass(in: Capsule())
        #endif
        .accessibilityElement(children: .combine)
    }
}

struct HolderBanner: View {
    let banner: ThreadBanner
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 10) {
            switch banner {
            case .cloud(let url):
                Image(systemName: "cloud").foregroundStyle(Theme.secondary)
                Text("Cloud session. Continue it on claude.ai.").foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
                if let url {
                    Button("Open") { openURL(url) }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            case .waiting(let text):
                Image(systemName: "pause.circle").foregroundStyle(Theme.secondary)
                Text(text).foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
            case .busyElsewhere(let text):
                WorkingRing(size: 12)
                Text(text).foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
            case .alsoInDesktop:
                Image(systemName: "macwindow").foregroundStyle(Theme.secondary)
                Text("Also open in the Claude app.").foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
            }
        }
        .font(.footnote)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }
}

struct LoadEarlierRow: View {
    let loading: Bool

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Loading earlier messages…").font(.footnote).foregroundStyle(Theme.tertiary)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .opacity(loading ? 1 : 0.6)
        .accessibilityElement(children: .combine)
    }
}

struct ToolOutputSheet: View {
    let sessionId: SessionID
    let step: ToolStep

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let output = store.threads[sessionId]?.toolOutputs[step.id] {
                    ScrollView([.vertical, .horizontal]) {
                        Text(output)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.white)
                            .textSelection(.enabled)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .defaultScrollAnchor(.bottom)
                } else {
                    ProgressView("Reading the output from your Mac…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.background)
            .navigationTitle(step.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let output = store.threads[sessionId]?.toolOutputs[step.id] {
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: output) { Image(systemName: "square.and.arrow.up") }
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 640, idealWidth: 760, minHeight: 420, idealHeight: 560)
        #endif
        .task { client.send(.sessionTool(sessionId: sessionId, toolUseId: step.id)) }
    }
}

struct ThreadSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            HStack { Spacer(); RoundedRectangle(cornerRadius: 18).fill(Theme.card).frame(width: 220, height: 44) }
            RoundedRectangle(cornerRadius: 6).fill(Theme.card).frame(height: 14)
            RoundedRectangle(cornerRadius: 6).fill(Theme.card).frame(width: 260, height: 14)
            RoundedRectangle(cornerRadius: 10).fill(Theme.card).frame(width: 200, height: 32)
            RoundedRectangle(cornerRadius: 6).fill(Theme.card).frame(height: 14)
            RoundedRectangle(cornerRadius: 6).fill(Theme.card).frame(width: 180, height: 14)
        }
        .padding(16)
        .frame(maxWidth: SessionThreadView.column, maxHeight: .infinity)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading the session")
    }
}
