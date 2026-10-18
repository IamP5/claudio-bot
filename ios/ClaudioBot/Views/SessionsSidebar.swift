import SwiftUI

struct SidebarRoot: View {
    @Environment(AppStore.self) private var store
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
                Picker("Show", selection: $router.sidebar) {
                    Text("Bots").tag(SidebarMode.bots)
                    Text("Sessions").tag(SidebarMode.sessions)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
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
    @State private var renaming: SessionRow?
    @State private var newTitle = ""
    /// One clock for every row's age. Rows compare their age text, so only those that changed redraw.
    @State private var now = Date.now
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var index: SessionIndex { store.sessions }

    var body: some View {
        @Bindable var router = router
        let sections = index.loaded ? index.sections(query) : []
        List(selection: $router.selection) {
            banners
            if searching {
                searchField.plainRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if store.lacks(.sessions) {
                UpdateBridgeNote()
                    .plainRow()
            } else if !index.loaded {
                if store.machine == nil {
                    Text("Connect to your Mac to see its Claude Code sessions.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.tertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                        .plainRow()
                } else {
                    SessionsSkeleton()
                }
            } else {
                FilterChips(query: $query, counts: index.counts, hidden: index.hiddenCount)
                    .plainRow(insets: EdgeInsets(top: 0, leading: 0, bottom: 2, trailing: 0))
                if sections.isEmpty {
                    emptyState
                }
                ForEach(sections) { section in
                    projectSection(section)
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 44)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: sections.map(\.id))
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .environment(\.defaultMinListHeaderHeight, 0)
        .listSectionSpacing(6)
        .refreshable { await refresh() }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
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
            if let updatedAt = index.updatedAt {
                StaleListBanner(state: store.connection, updatedAt: updatedAt).plainRow()
            } else {
                ConnectionBanner(state: store.connection).plainRow()
            }
        }
        if let mismatch = store.protocolMismatch {
            UpdateBanner(mismatch: mismatch).plainRow()
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if query.isNarrowed {
            Text(query.filter == .all ? "No sessions match." : "No \(query.filter.title.lowercased()) sessions.")
                .font(.subheadline)
                .foregroundStyle(Theme.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
                .plainRow()
        } else {
            VStack(spacing: 14) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 30, weight: .light))
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

    @ViewBuilder
    private func projectSection(_ section: ProjectSection) -> some View {
        let limit = query.isNarrowed ? section.trees.count : limits[section.id, default: Self.pageSize]
        let shown = section.trees.prefix(limit)
        Section {
            ForEach(shown) { tree in
                sessionRow(tree.row)
                ForEach(tree.descendants, id: \.row.id) { child in
                    sessionRow(child.row, depth: child.depth, isLast: child.isLast)
                }
            }
            if section.trees.count > limit {
                Button {
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
                        limits[section.id] = limit + Self.moreStep
                    }
                } label: {
                    Text("Show more")
                        .font(.subheadline)
                        .foregroundStyle(Theme.tertiary)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show \(min(Self.moreStep, section.trees.count - limit)) more in \(section.project.name)")
                .plainRow(insets: EdgeInsets(top: 0, leading: 20, bottom: 4, trailing: 16))
            }
        } header: {
            ProjectHeader(project: section.project, count: section.trees.count) {
                router.newSession = NewSessionRequest(projectId: section.project.id)
            }
        }
        .listSectionSeparator(.hidden)
    }

    private func sessionRow(_ row: SessionRow, depth: Int = 0, isLast: Bool = false) -> some View {
        let bot = row.agent.flatMap { store.bots[$0.botId] }
        return SessionRowView(row: row, avatar: bot?.avatar, depth: depth, isLast: isLast, now: now)
            .equatable()
            .tag(Selection.session(row.id))
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
        .listRowBackground(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(router.selection == .session(row.id) ? Theme.card : .clear)
                .padding(.horizontal, 8)
        )
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
        .accessibilityLabel(SessionText.spoken(row, project: index.project(of: row)?.name, botName: bot?.name))
        .accessibilityAddTraits(.isButton)
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
        InitialsItem(name: store.userName, proposals: store.proposedFacts.count) { router.showingSettings = true }
        if store.has(.usage) {
            ToolbarItem(placement: .principal) {
                SessionUsageButton(usage: store.usage) { router.showingUsage = true }
            }
        }
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
        ToolbarSpacerIfAvailable()
        ToolbarItem(placement: .topBarTrailing) {
            Button { router.newSession = NewSessionRequest(projectId: nil) } label: {
                Image(systemName: "plus")
            }
            .disabled(!store.has(.sessions) || index.projects.isEmpty)
            .accessibilityLabel("New session")
        }
    }

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

    private func refresh() async {
        let before = index.updatedAt
        client.refreshSessions()
        for _ in 0..<25 {
            if index.updatedAt != before || Task.isCancelled { return }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }
}

struct ProjectHeader: View {
    let project: SessionProject
    let count: Int
    let onNew: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(project.name)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.secondary)
                .lineLimit(1)
            Text("\(count)")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(Theme.tertiary)
            Spacer(minLength: 8)
            Button(action: onNew) {
                Image(systemName: "plus")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New session in \(project.name)")
        }
        .padding(.leading, 4)
        .textCase(nil)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(project.name), \(count) \(count == 1 ? "session" : "sessions")")
    }
}

struct FilterChips: View {
    @Binding var query: SessionQuery
    let counts: [SessionFilter: Int]
    let hidden: Int

    var body: some View {
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
                    Text("\(count)").monospacedDigit().foregroundStyle(on ? Color.black.opacity(0.6) : tint ?? Theme.tertiary)
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

struct StaleListBanner: View {
    let state: ConnectionState
    let updatedAt: Date

    var body: some View {
        HStack(spacing: 10) {
            ConnectionBadge(state: state)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(SessionText.updated(updatedAt, now: context.date))
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
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
    func plainRow(insets: EdgeInsets = EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16)) -> some View {
        listRowInsets(insets)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .selectionDisabled()
    }
}
