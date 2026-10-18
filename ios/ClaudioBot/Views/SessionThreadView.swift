import SwiftUI

/// What the bar over a thread says about who else holds the session.
enum ThreadBanner: Equatable {
    /// A claude.ai session: read here, continued there.
    case cloud(URL?)
    /// Another process is working in it, so the phone only watches.
    case busyElsewhere(String)
    /// Open but idle in the Claude app: the phone may send.
    case alsoInDesktop
    /// The phone's message waits for another Claude Code to let go of the session.
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

/// A Claude Code session's thread: the transcript, cards that wait on the user, and the composer.
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
    @State private var renaming = false
    @State private var newTitle = ""

    private var row: SessionRow? { store.sessions.rows[sessionId] }

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
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if model.before != nil {
                    LoadEarlierRow(loading: model.loadingEarlier)
                        .onAppear { loadEarlier(model) }
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    ThreadRowView(row: row, sessionId: sessionId, model: model, botName: botName) { fullOutput = $0 }
                        .equatable()
                        .padding(.top, index == 0 ? 12 : Self.gap(between: rows[index - 1], and: row))
                }
                // Under a card that waits on the user, "Working" would say the opposite of what is happening.
                StreamingTail(live: model.live, working: (model.controls?.working ?? false) && Self.openCard(model.items) == nil)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
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
            .frame(maxWidth: 760)
        }
        .onChange(of: Self.openCard(model.items)) { old, new in
            if let new, new.id != old?.id { AccessibilityNotification.Announcement(new.announcement).post() }
        }
    }

    @ViewBuilder
    private func banner(_ model: ThreadModel) -> some View {
        if OfflineBar.shows(store.connection) {
            OfflineBar(state: store.connection).frame(maxWidth: 760)
        } else if let banner = ThreadBanner.of(row: row, controls: model.controls) {
            HolderBanner(banner: banner).frame(maxWidth: 760)
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
                Button { UIPasteboard.general.string = sessionId.rawValue } label: {
                    Label("Copy Session ID", systemImage: "doc.on.doc")
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel("More")
        }
    }

    private func loadEarlier(_ model: ThreadModel) {
        guard let cursor = model.requestEarlier() else { return }
        pageAnchor = model.rows.first?.id
        client.send(.sessionPage(sessionId: sessionId, before: cursor))
    }

    private static func bottomGap(_ geometry: ScrollGeometry) -> CGFloat {
        geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY
    }

    /// Steps of one turn sit close; a new prompt and cards get air.
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

    /// For spacing: a prompt opens a turn; thinking, tool runs and folds are steps.
    var kind: Kind {
        switch self {
        case .fold: .step
        case .item(.user): .prompt
        case .item(.thinking), .item(.work): .step
        case .item: .other
        }
    }
}

/// The title and where the session lives, centered in the navigation bar.
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
        .frame(maxWidth: 260)
        .glass(in: Capsule())
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

/// At the top of a thread with older items: asks for the page above when it scrolls into view.
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

/// A tool call's full result, asked for when the sheet opens.
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
        .task { client.send(.sessionTool(sessionId: sessionId, toolUseId: step.id)) }
    }
}

/// Gray bars where a thread's first messages will be.
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
        .frame(maxWidth: 760, maxHeight: .infinity)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading the session")
    }
}
