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
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
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
    @State private var showsWork = false
    @State private var lastRetryFailed = false
    /// The skeleton waits at most a second for a Mac that is not there.
    @State private var skeletonExpired = false
    /// A connection that drops for less than 400 ms never shows as offline (P-CONN-4).
    @State private var offlineShown = false
    /// Set when the open card's deadline passes, so the status stops counting it.
    @State private var cardClock = Date.now
    @State private var announcer: Announcer
    @State private var statuses: StatusAnnouncer
    /// A tall window: an iPad in portrait, where the split view hides the list.
    @State private var tall = false

    init(sessionId: SessionID) {
        self.sessionId = sessionId
        let announcer = Announcer()
        _announcer = State(initialValue: announcer)
        _statuses = State(initialValue: StatusAnnouncer { announcer.post($0, first: $1) })
    }

    private var row: SessionRow? { store.sessions.rows[sessionId] }

    /// The transcript, banners and composer share one centered column.
    #if os(macOS)
    static let column: CGFloat = 960
    #else
    static let column: CGFloat = 760
    #endif

    private var reach: Reach {
        Reach(store.connection, failures: client.failures, greeted: store.bridgeProtocol != nil)
    }

    var body: some View {
        Group {
            if let model = store.threads[sessionId] {
                switch model.phase {
                case .loading where !offlineShown || !skeletonExpired:
                    ThreadSkeleton()
                case .loading, .ready:
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
        .task {
            try? await Task.sleep(for: .seconds(1))
            skeletonExpired = true
        }
        .task(id: reach.online) {
            guard !reach.online else { return offlineShown = false }
            try? await Task.sleep(for: .milliseconds(400))
            if !Task.isCancelled { offlineShown = true }
        }
        .onChange(of: store.machine) { lastRetryFailed = false }
        .onGeometryChange(for: Bool.self) { $0.size.height > $0.size.width } action: { tall = $0 }
    }

    /// The thread's one status line. A drop shorter than 400 ms keeps the line it had.
    private func status(_ model: ThreadModel, card: OpenCard?) -> ThreadStatus? {
        var quietSince: Date?
        if case .connected(_, let since) = store.connection { quietSince = since }
        return ThreadStatus.of(
            reach: reach.online || offlineShown ? reach : .connected(machine: ""), quietSince: quietSince, lastUpdate: model.phase == .ready ? store.heardAt : nil,
            controls: model.controls, card: card, since: row?.since, outcome: row?.outcome
        )
    }

    private func thread(_ model: ThreadModel) -> some View {
        let botName = row?.agent.flatMap { store.bots[$0.botId]?.name }
        let rows = model.rows
        let openCard = OpenCard.newest(in: model.items, at: max(cardClock, .now))
        let status = status(model, card: openCard)
        let banner = ThreadBanner.of(row: row, controls: model.controls)
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
                    ThreadRowView(
                        row: row, sessionId: sessionId, model: model, botName: botName,
                        unanswered: model.unanswered.contains(row.id), withdraws: store.has(.sessionUnqueue)
                    ) { fullOutput = $0 }
                        .equatable()
                        .padding(.top, index == 0 ? 12 : Self.gap(between: rows[index - 1], and: row))
                }
                StreamingTail(live: model.live)
            }
            // An answered card collapses with its own animation. Moving the rows in the same transaction keeps them from
            // snapping over the card while it shrinks.
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: openCard?.id)
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
            .frame(maxWidth: Self.column)
            .frame(maxWidth: .infinity)
        }
        .environment(\.revealStep) { reveal($0, in: model) }
        .environment(\.revealedStep, revealed?.step.id)
        .environment(\.runStateStale, status?.staleAt)
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        #if os(macOS)
        // The chips and the field float apart. A hard edge keeps the transcript from showing between them.
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        #endif
        .opaqueTopEdge()
        .onScrollPhaseChange { _, phase, context in
            switch phase {
            case .interacting: followsBottom = false
            case .idle: if !followsBottom { followsBottom = Self.bottomGap(context.geometry) < 60 }
            default: break
            }
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height + $0.contentInsets.bottom } action: { _, _ in
            if followsBottom {
                position.scrollTo(edge: .bottom)
            } else if let revealed {
                // The run opens over a pass or two at large text sizes, and the bottom anchor moves the rows each time.
                position.scrollTo(id: revealed.step.id, anchor: .center)
            }
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
        .topBar {
            if let banner { HolderBanner(banner: banner).frame(maxWidth: Self.column) }
        }
        .composerBar {
            VStack(spacing: 6) {
                if let status {
                    // A hanging attempt would hold Retry until its greeting deadline, so Retry starts a new one.
                    ThreadStatusLine(status: status, cause: cause, onTap: tap(status)) {
                        Task { lastRetryFailed = !(await ConnectionBanner.retry(client, restartingAttempt: true)) }
                    }
                    .padding(.horizontal, 16)
                    .transition(.opacity)
                }
                SessionComposer(sessionId: sessionId, model: model, announce: { announcer.post($0) }) {
                    followsBottom = true
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.3)) { position.scrollTo(edge: .bottom) }
                }
            }
            .frame(maxWidth: Self.column)
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: status?.word)
        }
        .sheet(isPresented: $showsWork) {
            BackgroundWorkSheet(sessionId: sessionId, staleAt: status?.staleAt)
        }
        .task(id: openCard?.expiresAt) {
            guard let at = openCard?.expiresAt, at > .now else { return }
            try? await Task.sleep(for: .seconds(at.timeIntervalSinceNow))
            if !Task.isCancelled { cardClock = .now }
        }
        .onChange(of: ThreadAnnouncement.key(status), initial: true) { statuses.update(status) }
        .onChange(of: banner) { _, new in
            if let new { announcer.post(new.spoken) }
        }
    }

    /// What the offline line says is wrong, in the words the Sessions banner uses. At accessibility sizes the address
    /// goes: it would take more lines than the rest.
    private var cause: String {
        if reach == .unrecognized { return "Your Mac doesn't recognize this \(ThisDevice.noun). Pair again from the list." }
        let address = typeSize.isAccessibilitySize ? nil : client.pairing?.url.bridgeAddress
        return ConnectionBanner.cause(reach, address: address, lastRetryFailed: lastRetryFailed, brief: true)
    }

    /// A card scrolls into view; work with tasks opens the list of what runs.
    private func tap(_ status: ThreadStatus) -> (() -> Void)? {
        switch status {
        case .needsYou(let card):
            return {
                followsBottom = false
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.35)) { position.scrollTo(id: card.id, anchor: .center) }
            }
        case .working, .background:
            return status.tasks.isEmpty ? nil : { showsWork = true }
        case .offline, .quiet, .ended:
            return nil
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            let state = store.threads[sessionId].flatMap { status($0, card: OpenCard.newest(in: $0.items, at: max(cardClock, .now))) }
            ThreadHeader(
                row: row, project: row.flatMap { store.sessions.project(of: $0) }, avatar: row?.agent.flatMap { store.bots[$0.botId]?.avatar },
                state: state?.word
            )
        }
        #if os(iOS)
        // iPad with the list out of sight: what else runs, and the way back to it.
        if sizeClass == .regular, router.hasSidebar, router.columns == .detailOnly || (router.columns == .automatic && tall) {
            let elsewhere = SessionsAtWork(store.sessions.rows.values, excluding: sessionId)
            if let summary = elsewhere.summary {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { router.columns = .all } label: {
                        Label(summary, systemImage: elsewhere.needsYou.isEmpty ? "circle.dotted" : "hand.raised")
                            .labelStyle(.titleAndIcon)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(elsewhere.needsYou.isEmpty ? Theme.secondary : Theme.attention)
                    }
                    .accessibilityLabel("Other sessions: \(summary)")
                    .accessibilityHint("Shows the sessions list")
                }
            }
        }
        #endif
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

    /// Opens the fold that hides the step's work run and marks the step, which opens the run. On the next pass it scrolls
    /// to the step, and again whenever the rows grow while the step is marked. The mark fades after two seconds.
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

extension Reach {
    /// The socket is up, or there is no Mac to reach: nothing for the thread to say about the connection.
    var online: Bool {
        switch self {
        case .connected, .unpaired: true
        case .firstConnect, .unreachable, .retrying, .unrecognized: false
        }
    }
}

/// Speaks to VoiceOver at most once every two seconds; what arrives sooner joins the next announcement.
@MainActor
final class Announcer {
    private let gap: TimeInterval
    private let speak: (String) -> Void
    private var last = Date.distantPast
    private var pending: [String] = []
    private var flush: Task<Void, Never>?

    init(gap: TimeInterval = 2, speak: @escaping (String) -> Void = { AccessibilityNotification.Announcement($0).post() }) {
        self.gap = gap
        self.speak = speak
    }

    /// first: the screen just opened, and VoiceOver reads its title first, so the announcement waits a second for that.
    func post(_ text: String, first: Bool = false) {
        pending.append(text)
        guard flush == nil else { return }
        let wait = max(first ? 1 : 0, gap - Date.now.timeIntervalSince(last))
        flush = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            self?.flushPending()
        }
    }

    private func flushPending() {
        flush = nil
        guard !pending.isEmpty else { return }
        speak(pending.joined(separator: " "))
        pending = []
        last = .now
    }
}

/// Above the composer: the one line that says what the thread is doing (ThreadStatus), with the action it offers.
struct ThreadStatusLine: View {
    let status: ThreadStatus
    /// The connection copy the Sessions banner uses.
    let cause: String
    let onTap: (() -> Void)?
    let onRetry: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var slot: CGFloat = 18
    @Environment(\.dynamicTypeSize) private var typeSize

    private var ticks: Bool {
        switch status {
        case .offline(_, let at): at != nil
        case .quiet, .working, .background: true
        case .needsYou, .ended: false
        }
    }

    var body: some View {
        Group {
            if ticks {
                TimelineView(.periodic(from: .now, by: 1)) { context in line(now: context.date) }
            } else {
                line(now: .now)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: HitTarget.minHeight, alignment: .leading)
        .glass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var retries: Bool {
        if case .offline(let reach, _) = status { reach.lost } else { false }
    }

    private func line(now: Date) -> some View {
        // At accessibility sizes the words get the width: the glyph goes, and Retry goes under them. The ticking clock
        // and the state word still say what runs.
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked && retries ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 10))
        return layout {
            if !stacked { glyph.frame(width: slot, height: slot) }
            Text(status.text(now: now, cause: cause))
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(tint == Theme.secondary ? .white : tint)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if retries {
                Button("Retry", action: onRetry)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Retry connecting to your Mac")
            } else if onTap != nil {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.tertiary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
        .accessibilityElement(children: .contain)
        .accessibilityRepresentation {
            if let onTap {
                Button(status.spoken(now: now, cause: cause), action: onTap)
                    .accessibilityHint(status.tasks.isEmpty ? "Shows the card" : "Lists what runs, with a Stop for each")
            } else if retries {
                Text(status.spoken(now: now, cause: cause))
                Button("Retry connecting to your Mac", action: onRetry)
            } else {
                Text(status.spoken(now: now, cause: cause))
            }
        }
    }

    private var tint: Color {
        switch status {
        case .offline, .quiet: Theme.attention
        case .needsYou: Theme.attention
        case .ended(let outcome): outcome.kind == .stopped ? Theme.secondary : Theme.danger
        case .working, .background: Theme.secondary
        }
    }

    @ViewBuilder
    private var glyph: some View {
        switch status {
        case .offline: Image(systemName: "wifi.slash").font(.footnote).foregroundStyle(Theme.attention)
        case .quiet: Image(systemName: "circle.dotted").font(.footnote).foregroundStyle(Theme.attention)
        case .needsYou: Image(systemName: "hand.raised").font(.footnote).foregroundStyle(Theme.attention)
        case .working: WorkingRing(size: slot * 0.7)
        case .background: WorkingRing(size: slot * 0.7, color: Theme.secondary)
        case .ended(let outcome):
            Image(systemName: outcome.kind == .stopped ? "stop.circle" : "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(tint)
        }
    }
}

extension View {
    /// The band under the title is solid, so transcript words never show through beside the title.
    @ViewBuilder
    func opaqueTopEdge() -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
                .toolbarBackground(Theme.background, for: .navigationBar)
                .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        } else {
            toolbarBackground(Theme.background, for: .navigationBar)
                .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        }
        #else
        self
        #endif
    }
}

struct ThreadHeader: View {
    let row: SessionRow?
    let project: SessionProject?
    let avatar: Avatar?
    /// The status line's word, spoken with the title and, on a wide layout, shown under it.
    var state: String?

    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let wide = sizeClass == .regular
        VStack(spacing: 1) {
            Text(row?.title ?? "Session")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            HStack(spacing: 4) {
                if let row { OriginBadge(origin: row.origin, avatar: avatar, size: 12) }
                Text([project?.name, row?.branch, wide ? state : nil].compactMap { $0 }.joined(separator: " · "))
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
        .frame(maxWidth: 520)
        #else
        .frame(maxWidth: wide ? 520 : 260)
        .glass(in: Capsule())
        #endif
        .accessibilityElement(children: .combine)
        // A wide header shows the state in its subtitle, which the combined label already reads.
        .accessibilityValue(wide ? "" : state ?? "")
    }
}

extension ThreadBanner {
    var spoken: String {
        switch self {
        case .cloud: "Cloud session. Continue it on claude.ai."
        case .waiting(let text), .busyElsewhere(let text): text
        case .alsoInDesktop: "Also open in the Claude app."
        }
    }
}

struct HolderBanner: View {
    let banner: ThreadBanner
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 10) {
            Group {
                switch banner {
                case .cloud: Image(systemName: "cloud").foregroundStyle(Theme.secondary)
                case .waiting: Image(systemName: "pause.circle").foregroundStyle(Theme.secondary)
                case .busyElsewhere: WorkingRing(size: 12)
                case .alsoInDesktop: Image(systemName: "macwindow").foregroundStyle(Theme.secondary)
                }
            }
            .accessibilityHidden(true)
            Text(banner.spoken).foregroundStyle(Theme.secondary)
            Spacer(minLength: 0)
            if case .cloud(let url?) = banner {
                Button("Open") { openURL(url) }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Open on claude.ai")
            }
        }
        .font(.footnote)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .accessibilityElement(children: .contain)
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
