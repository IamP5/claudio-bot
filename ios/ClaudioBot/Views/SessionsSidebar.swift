import SwiftUI

struct SidebarRoot: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router

    /// Kept up while Sessions is picked, so a bridge without the feature can say to update it and the user can go back.
    private var showsSwitch: Bool {
        store.has(.sessions) || router.sidebar == .sessions
    }

    var body: some View {
        @Bindable var router = router
        Group {
            if showsSwitch && router.sidebar == .sessions {
                SessionsSidebar()
            } else {
                HomeView()
            }
        }
        .topBar {
            if showsSwitch {
                VStack(alignment: .leading, spacing: 6) {
                    Picker("Show", selection: $router.sidebar) {
                        Text("Bots").tag(SidebarMode.bots)
                        Text("Sessions").tag(SidebarMode.sessions)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    #if os(macOS)
                    .controlSize(.small)
                    #endif
                    if router.sidebar == .bots { SessionsElsewhere() }
                }
                #if os(macOS)
                .padding(.horizontal, 12)
                #else
                .padding(.horizontal, 16)
                #endif
                .padding(.bottom, 8)
            }
        }
        .onChange(of: Reach(store.connection, failures: client.failures, greeted: store.bridgeProtocol != nil)) { old, new in
            if let text = Reach.announcement(from: old, to: new) { AccessibilityNotification.Announcement(text).post() }
        }
    }
}

/// The Bots side still says what runs and what needs the user in Sessions, from the list the window keeps watching.
/// A view of its own, so a list change redraws this line and never the bot list.
struct SessionsElsewhere: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let counts = store.sessions.freshness(online: store.machine != nil).visibleCounts(store.sessions.counts)
        let parts = SessionText.elsewhere(counts)
        if !parts.isEmpty {
            Button { router.sidebar = .sessions } label: {
                Text((["Sessions"] + parts).joined(separator: " · "))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(counts[.needsYou, default: 0] > 0 ? Theme.attention : Theme.secondary)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // A summary above the bot list: past AX2 it would push the bots off screen.
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            .accessibilityLabel((["Sessions"] + parts).joined(separator: ", "))
            .accessibilityHint("Shows the Sessions list")
        }
    }
}

struct SessionsSidebar: View {
    static let pageSize = 5
    static let moreStep = 10

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @State private var query = SessionQuery()
    @State private var searching = false
    @FocusState private var searchFocused: Bool
    @State private var limits: [ProjectID: Int] = [:]
    @AppStorage("collapsedProjects") private var collapsed = CollapsedProjects()
    @State private var renaming: SessionRow?
    @State private var newTitle = ""
    /// One clock for every row's time. Rows compare their time text, so only those that changed redraw.
    @State private var now = Date.now
    @State private var lastRetryFailed = false
    /// The rows that needed the user when the list last looked, so only a new ask opens a folded project.
    @State private var seenNeedingYou: Set<SessionID> = []
    @State private var announcing: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var index: SessionIndex { store.sessions }
    private var freshness: ListFreshness { index.freshness(online: store.machine != nil) }

    var body: some View {
        @Bindable var router = router
        let sections = index.loaded ? index.sections(query) : []
        List(selection: $router.selection) {
            banners
            #if os(iOS)
            if searching {
                searchField.plainRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            #endif
            if store.lacks(.sessions) {
                UpdateBridgeNote()
                    .plainRow()
            } else if !index.loaded {
                if store.machine == nil {
                    Text("Your sessions show here once your Mac answers.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                        .plainRow()
                } else {
                    SessionsSkeleton()
                }
            } else {
                FilterChips(query: $query.animation(reduceMotion ? nil : .snappy(duration: 0.25)), counts: freshness.visibleCounts(counts(for: query)), hidden: index.hiddenCount)
                    .plainRow(insets: EdgeInsets(top: 0, leading: 0, bottom: 2, trailing: 0))
                if sections.isEmpty {
                    emptyState
                }
                ForEach(sections) { section in
                    projectSection(section)
                }
            }
        }
        #if os(macOS)
        // The sidebar style draws the only selection, sizes rows to the system's sidebar, and leaves the glass uncovered.
        .listStyle(.sidebar)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: sections.map(\.id))
        .searchable(text: $query.text, placement: .sidebar, prompt: "Search Sessions")
        .searchFocused($searchFocused)
        .focusedSceneValue(\.sidebarSearch, SidebarSearch { searchFocused = true })
        #else
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 44)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: sections.map(\.id))
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        #endif
        .environment(\.defaultMinListHeaderHeight, 0)
        .listSectionSpacing(6)
        .refreshable { await refresh() }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .onChange(of: store.machine) { lastRetryFailed = false }
        .onScrollPhaseChange { _, phase in index.holdOrder(phase != .idle) }
        .onAppear {
            now = .now
            index.resort()
        }
        // A list that leaves mid-fling never sees its scroll come to rest.
        .onDisappear { index.holdOrder(false) }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            now = .now
            index.resort()
        }
        .onChange(of: index.needingYou, initial: true) { _, needing in
            let opening = Set(needing.subtracting(seenNeedingYou).compactMap { index.rows[$0]?.projectId }).intersection(collapsed.ids)
            if !opening.isEmpty { collapsed.ids.subtract(opening) }
            seenNeedingYou = needing
        }
        .onChange(of: query) { _, query in announce(query) }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                now = .now
            }
        }
        .alert("Rename Session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if let row = renaming, !title.isEmpty { client.send(.sessionSet(sessionId: row.id, patch: SessionPatch(title: title))) }
            }
        } message: {
            Text("The new title is saved in the session, so the Claude app shows it too.")
        }
    }

    @ViewBuilder
    private var banners: some View {
        if store.connection == .unrecognized {
            UnrecognizedBanner().plainRow()
        } else if store.machine == nil {
            ConnectionBanner(state: store.connection, staleSince: index.updatedAt, lastRetryFailed: $lastRetryFailed).plainRow()
        }
        if let mismatch = store.protocolMismatch {
            UpdateBanner(mismatch: mismatch).plainRow()
        }
        #if os(iOS)
        if store.has(.pushState), let note = store.pushState?.listNote {
            Button { router.showingSettings = true } label: {
                Label(note, systemImage: "bell.slash")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.attention)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // A line above the list: past AX2 it would push the sessions off screen.
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
            .accessibilityHint("Opens Settings")
            .plainRow()
        }
        #endif
    }

    @ViewBuilder
    private var emptyState: some View {
        if query.isNarrowed {
            Text(query.filter == .all ? "No sessions match." : "No \(query.filter.title.lowercased()) sessions.")
                .font(.subheadline)
                .foregroundStyle(Theme.secondary)
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
                .plainRow()
        } else {
            VStack(spacing: 14) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.ui(size: 30, weight: .light))
                    .foregroundStyle(Theme.tertiary)
                Text("No Claude Code sessions on this Mac yet")
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text("Sessions from the Claude app, a terminal or your bots' agents show up here, grouped by project.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
                ForEach(index.orderedProjects.prefix(4)) { project in
                    Button {
                        router.newSession = NewSessionRequest(projectId: project.id)
                    } label: {
                        Label("New session in \(project.name)", systemImage: "plus")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.pressable)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
            .padding(.horizontal, 8)
            .plainRow()
        }
    }

    /// A search or filter shows every match, so a narrowed list drops the fold.
    @ViewBuilder
    private func projectSection(_ section: ProjectSection) -> some View {
        let header = ProjectHeader(
            project: section.project, tally: SectionTally(section.rows), freshness: freshness, expanded: query.isNarrowed ? nil : expanded(section.id)
        ) {
            router.newSession = NewSessionRequest(projectId: section.project.id)
        }
        Group {
            if query.isNarrowed {
                Section { sectionRows(section) } header: { header }
            } else {
                Section(isExpanded: expanded(section.id)) { sectionRows(section) } header: { header }
            }
        }
        .listSectionSeparator(.hidden)
    }

    private func expanded(_ id: ProjectID) -> Binding<Bool> {
        Binding {
            !collapsed.ids.contains(id)
        } set: { open in
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
                if open { collapsed.ids.remove(id) } else { collapsed.ids.insert(id) }
            }
        }
    }

    @ViewBuilder
    private func sectionRows(_ section: ProjectSection) -> some View {
        let limit = query.isNarrowed ? section.trees.count : limits[section.id, default: Self.pageSize]
        let shown = section.trees.enumerated().filter { $0.offset < limit || $0.element.isActive }.map(\.element)
        ForEach(shown) { tree in
            sessionRow(tree.row)
            ForEach(tree.descendants, id: \.row.id) { child in
                sessionRow(child.row, depth: child.depth, isLast: child.isLast, parent: child.row.parentId.flatMap { index.rows[$0]?.title })
            }
        }
        let folded = section.trees.count - shown.count
        if folded > 0 {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
                    limits[section.id] = max(limit, shown.count) + Self.moreStep
                }
            } label: {
                Text("Show more")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show \(min(Self.moreStep, folded)) more in \(section.project.name)")
            .plainRow(insets: EdgeInsets(top: 0, leading: 20, bottom: 4, trailing: 16))
        }
    }

    private func sessionRow(_ row: SessionRow, depth: Int = 0, isLast: Bool = false, parent: String? = nil) -> some View {
        let bot = row.agent.flatMap { store.bots[$0.botId] }
        return SessionRowView(row: row, avatar: bot?.avatar, depth: depth, isLast: isLast, now: now, freshness: freshness)
            .equatable()
            .tag(Selection.session(row.id))
        .listRowSeparator(.hidden)
        #if os(macOS)
        .sidebarHover(selected: router.selection == .session(row.id))
        #else
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
        .listRowBackground(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(router.selection == .session(row.id) ? Theme.card : .clear)
                .padding(.horizontal, 8)
        )
        #endif
        .swipeActions(edge: .trailing) {
            Button {
                client.send(.sessionSet(sessionId: row.id, patch: SessionPatch(hidden: !row.hidden)))
            } label: {
                Label(row.hidden ? "Show" : "Hide", systemImage: row.hidden ? "eye" : "eye.slash")
            }
            .tint(Theme.letter)
        }
        .swipeActions(edge: .leading) {
            if row.origin != .cloud {
                Button {
                    client.send(.sessionOpenDesktop(sessionId: row.id))
                } label: {
                    Label("Open in Claude app", systemImage: "macwindow")
                }
                .tint(AvatarColor.blue.color)
            }
        }
        .contextMenu { menu(for: row) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SessionText.spoken(row, project: index.project(of: row)?.name, botName: bot?.name, parent: parent, now: now, freshness: freshness))
        .accessibilityAddTraits(.isButton)
        // Ignoring the children drops the list's own press, so pressing the row selects it here.
        .accessibilityAction { router.selection = .session(row.id) }
        .accessibilityActions { actions(for: row) }
    }

    @ViewBuilder
    private func menu(for row: SessionRow) -> some View {
        OpenInNewWindowButton(selection: .session(row.id))
        Button {
            newTitle = row.title
            renaming = row
        } label: {
            Label("Rename", systemImage: "pencil")
        }
        if row.unread {
            Button {
                client.send(.unwatchSession(sessionId: row.id))
            } label: {
                Label("Mark as Read", systemImage: "checkmark.message")
            }
        }
        if row.origin != .cloud {
            Button {
                client.send(.sessionOpenDesktop(sessionId: row.id))
            } label: {
                Label("Open in Claude App", systemImage: "macwindow")
            }
        }
        if let pr = row.pr {
            Link(destination: pr.url) { Label("Open PR #\(pr.number)", systemImage: "arrow.triangle.pull") }
        }
        Button {
            Clipboard.copy(row.id.rawValue)
        } label: {
            Label("Copy Session ID", systemImage: "doc.on.doc")
        }
        if let project = index.project(of: row) { LocalPathMenu(path: project.path) }
        Divider()
        Button {
            client.send(.sessionSet(sessionId: row.id, patch: SessionPatch(hidden: !row.hidden)))
        } label: {
            Label(row.hidden ? "Show in Sidebar" : "Hide from Sidebar", systemImage: row.hidden ? "eye" : "eye.slash")
        }
    }

    @ViewBuilder
    private func actions(for row: SessionRow) -> some View {
        Button(row.hidden ? "Show" : "Hide") {
            client.send(.sessionSet(sessionId: row.id, patch: SessionPatch(hidden: !row.hidden)))
        }
        if row.origin != .cloud {
            Button("Open in Claude app") { client.send(.sessionOpenDesktop(sessionId: row.id)) }
        }
        if row.unread {
            Button("Mark as read") { client.send(.unwatchSession(sessionId: row.id)) }
        }
        Button("Rename") {
            newTitle = row.title
            renaming = row
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        SidebarAccountItems(name: store.userName, proposals: store.proposedFacts.count, usage: store.usage, hasUsage: store.has(.usage)) {
            router.showingSettings = true
        } showUsage: {
            router.showingUsage = true
        }
        #if os(iOS)
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                withAnimation { searching.toggle() }
                query.text = ""
                searchFocused = searching
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .accessibilityLabel("Search sessions")
        }
        #endif
        ToolbarSpacerIfAvailable()
        ToolbarItem(placement: .topBarTrailing) {
            Button { router.newSession = NewSessionRequest(projectId: nil) } label: {
                Image(systemName: "plus")
            }
            .disabled(!store.has(.sessions) || index.projects.isEmpty)
            .accessibilityLabel("New session")
            .help("New Session")
        }
    }

    /// Once the list has settled on the new filter or search, VoiceOver hears how many sessions it shows.
    private func announce(_ query: SessionQuery) {
        announcing?.cancel()
        announcing = Task {
            guard (try? await Task.sleep(for: .milliseconds(500))) != nil else { return }
            let count = index.sections(query).reduce(0) { $0 + $1.rows.count }
            AccessibilityNotification.Announcement(SessionText.matches(count, query: query)).post()
        }
    }

    /// What each filter would show for the current search, so the counts drop as the search narrows the list.
    private func counts(for query: SessionQuery) -> [SessionFilter: Int] {
        guard !query.needle.isEmpty else { return index.counts }
        return Dictionary(uniqueKeysWithValues: SessionFilter.allCases.map { filter in
            var narrowed = query
            narrowed.filter = filter
            narrowed.showHidden = false
            let shown = SessionIndex.sections(rows: index.rows, projects: index.projects, query: narrowed)
            return (filter, shown.reduce(0) { $0 + $1.trees.count })
        })
    }

    #if os(iOS)
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.tertiary)
            TextField("Title, project or branch", text: $query.text)
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            Button("Cancel") {
                withAnimation { searching = false }
                query.text = ""
            }
            .foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.card, in: Capsule())
    }
    #endif

    private func refresh() async {
        let before = index.updatedAt
        if store.machine == nil {
            lastRetryFailed = !(await ConnectionBanner.retry(client))
            if lastRetryFailed { return }
        } else {
            client.refreshSessions()
        }
        for _ in 0..<25 {
            if index.updatedAt != before || Task.isCancelled { return }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }
}

struct ProjectHeader: View {
    let project: SessionProject
    let tally: SectionTally
    var freshness = ListFreshness.live
    /// Nil while the list is narrowed, when the section can't fold.
    var expanded: Binding<Bool>?
    let onNew: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize
    #if os(macOS)
    @State private var hovering = false
    #endif

    var body: some View {
        HStack(spacing: 6) {
            Button {
                expanded?.wrappedValue.toggle()
            } label: {
                HStack(spacing: 6) {
                    #if os(iOS)
                    // The plain list draws no disclosure of its own, so the header carries the chevron.
                    if let expanded {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.tertiary)
                            .rotationEffect(.degrees(expanded.wrappedValue ? 90 : 0))
                    }
                    #endif
                    // At accessibility sizes the name wraps whole and the counts go under it, so projects that share a
                    // prefix stay apart.
                    let accessible = typeSize.isAccessibilitySize
                    let line = accessible ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 6))
                    line {
                        Text(project.name)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Theme.secondary)
                            .lineLimit(accessible ? nil : 1)
                        Text(tally.shown(freshness))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(tally.needsYou > 0 ? Theme.attention : Theme.secondary)
                            .lineLimit(accessible ? nil : 1)
                            .layoutPriority(1)
                    }
                    Spacer(minLength: 8)
                }
                #if os(iOS)
                .frame(minHeight: 44)
                #endif
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(expanded == nil)
            .accessibilityLabel("\(project.name), \(tally.spoken(freshness))")
            .accessibilityValue(expanded.map { $0.wrappedValue ? "Expanded" : "Collapsed" } ?? "")
            #if os(macOS)
            // Shown under the pointer, as the Finder sidebar shows its section controls.
            Button(action: onNew) {
                Image(systemName: "plus")
            }
            .buttonStyle(.borderless)
            .help("New Session in \(project.name)")
            .accessibilityLabel("New session in \(project.name)")
            .opacity(hovering ? 1 : 0)
            #else
            Button(action: onNew) {
                Image(systemName: "plus")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New session in \(project.name)")
            #endif
        }
        #if os(macOS)
        .contentShape(Rectangle())
        .onHover { inside in
            withAnimation(.easeOut(duration: 0.14)) { hovering = inside }
        }
        #else
        .padding(.leading, 4)
        #endif
        .textCase(nil)
        .accessibilityElement(children: .contain)
    }
}

struct FilterChips: View {
    @Binding var query: SessionQuery
    let counts: [SessionFilter: Int]
    let hidden: Int

    var body: some View {
        #if os(macOS)
        menu
        #else
        chips
        #endif
    }

    #if os(macOS)
    /// A strip of chips scrolls out of a narrow sidebar, so the Mac picks the filter from a menu and keeps a
    /// shortcut to what needs the user in view.
    private var menu: some View {
        let needsYou = counts[.needsYou, default: 0]
        return HStack(spacing: 8) {
            Menu {
                Picker("Show", selection: $query.filter) {
                    ForEach(SessionFilter.allCases, id: \.self) { filter in
                        let count = counts[filter, default: 0]
                        Text(filter == .all || count == 0 ? Self.title(filter) : "\(Self.title(filter)) (\(count))").tag(filter)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                if hidden > 0 {
                    Divider()
                    Toggle("Show Hidden (\(hidden))", isOn: $query.showHidden)
                }
            } label: {
                Label(query.filter == .all ? "All Sessions" : Self.title(query.filter), systemImage: "line.3.horizontal.decrease")
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .fixedSize()
            .help("Filter Sessions")
            Spacer(minLength: 0)
            if needsYou > 0 && query.filter != .needsYou {
                Button("\(needsYou) \(needsYou == 1 ? "needs" : "need") you") { query.filter = .needsYou }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.attention)
                    .help("Show Sessions That Need You")
            }
        }
        .font(.subheadline)
        .controlSize(.small)
    }

    private static func title(_ filter: SessionFilter) -> String {
        filter == .needsYou ? "Needs You" : filter.title
    }
    #endif

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(SessionFilter.allCases, id: \.self) { filter in
                    let count = counts[filter, default: 0]
                    chip(filter.title, count: filter == .all ? nil : count, on: query.filter == filter, tint: filter == .needsYou && count > 0 ? Theme.attention : nil) {
                        query.filter = filter
                    }
                }
                if hidden > 0 {
                    chip("Hidden", count: hidden, on: query.showHidden, tint: nil) { query.showHidden.toggle() }
                }
            }
            .padding(.horizontal, 16)
        }
        .sensoryFeedback(.selection, trigger: query)
    }

    private func chip(_ title: String, count: Int?, on: Bool, tint: Color?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                if let count, count > 0 {
                    Text("\(count)").monospacedDigit().foregroundStyle(on ? Color.black.opacity(0.6) : tint ?? Theme.secondary)
                }
            }
            .font(.subheadline.weight(on ? .semibold : .regular))
            .foregroundStyle(on ? Color.black : Color.white.opacity(0.86))
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            .background(on ? Color.white : Theme.card, in: Capsule())
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityLabel(count.map { "\(title), \($0)" } ?? title)
    }
}

struct UpdateBridgeNote: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Update the bridge", systemImage: "arrow.triangle.2.circlepath")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.attention)
            Text("The bridge on your Mac doesn't serve Claude Code sessions yet. Update it to see your sessions here, grouped by project.")
                .font(.subheadline)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.top, 8)
    }
}

struct SessionsSkeleton: View {
    private static let widths: [[CGFloat]] = [[0.72, 0.55, 0.8, 0.46], [0.6, 0.78, 0.5]]

    var body: some View {
        ForEach(Array(Self.widths.enumerated()), id: \.offset) { _, rows in
            VStack(alignment: .leading, spacing: 0) {
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 90, height: 10).padding(.vertical, 14)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, width in
                    HStack(spacing: 10) {
                        Circle().fill(Theme.card).frame(width: 18, height: 18)
                        GeometryReader { proxy in
                            RoundedRectangle(cornerRadius: 5).fill(Theme.card).frame(width: proxy.size.width * width, height: 14)
                        }
                        .frame(height: 14)
                    }
                    .frame(height: 44)
                }
            }
            .padding(.horizontal, 20)
            .plainRow()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading sessions")
    }
}

extension View {
    /// On the Mac the sidebar's own insets stay, so banners, the filter and rows share one leading edge.
    func plainRow(insets: EdgeInsets = EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)) -> some View {
        #if os(macOS)
        let rowInsets: EdgeInsets? = nil
        #else
        let rowInsets: EdgeInsets? = insets
        #endif
        return listRowInsets(rowInsets)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .selectionDisabled()
    }
}

/// The projects folded shut in the sessions sidebar, kept across launches as Claude Code keeps its sidebar.
struct CollapsedProjects: RawRepresentable, Equatable {
    var ids: Set<ProjectID> = []

    init() {}

    init(rawValue: String) {
        ids = Set(rawValue.split(separator: "\n").map { ProjectID(String($0)) })
    }

    var rawValue: String { ids.map(\.rawValue).sorted().joined(separator: "\n") }
}
