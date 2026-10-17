import SwiftUI

struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @State private var query = ""

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            content
                .navigationTitle("ClaudeBot")
                .navigationDestination(for: TaskID.self) { TaskView(taskId: $0) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { router.showingSettings = true } label: {
                            ConnectionBadge(state: store.connection)
                        }
                        .accessibilityLabel("Settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { router.showingSettings = true } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { router.showingNewTask = true } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("New task")
                    }
                }
        }
        .sheet(isPresented: $router.showingNewTask) { NewTaskView() }
        .sheet(isPresented: $router.showingSettings) { SettingsView() }
        .onChange(of: store.lastNewTask) { _, id in
            guard router.awaitingNewTask, let id else { return }
            router.awaitingNewTask = false
            router.path = [id]
        }
        .overlay(alignment: .top) { ErrorToast(notice: store.lastError) }
    }

    @ViewBuilder
    private var content: some View {
        let sections = store.sections(matching: query)
        if store.tasks.isEmpty {
            EmptyHome { router.showingNewTask = true }
        } else {
            List {
                ForEach(sections) { section in
                    Section(section.kind.title) {
                        ForEach(section.tasks) { task in
                            NavigationLink(value: task.id) { TaskRow(task: task) }
                                .swipeActions(edge: .trailing) {
                                    if task.status.isActive {
                                        Button("Stop", systemImage: "stop.fill", role: .destructive) {
                                            client.send(.stop(taskId: task.id))
                                        }
                                    }
                                }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "Search tasks")
            .overlay {
                if sections.isEmpty { ContentUnavailableView.search(text: query) }
            }
        }
    }
}

struct TaskRow: View {
    let task: TaskSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(task.updatedAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !task.preview.isEmpty {
                Text(task.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack(spacing: 6) {
                StatusPill(status: task.status)
                TargetBadge(target: task.target)
                Text(task.projectName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}

private struct EmptyHome: View {
    let newTask: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Hand Claude a task", systemImage: "sparkles")
        } description: {
            Text("Describe a coding task. Claude works on your Mac or in the cloud and pings you when it needs a decision.")
        } actions: {
            Button("New task", systemImage: "plus", action: newTask)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
    }
}

struct ErrorToast: View {
    let notice: ErrorNotice?
    @State private var visible: ErrorNotice?

    var body: some View {
        Group {
            if let visible {
                Label(visible.message, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .shadow(radius: 8, y: 2)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: visible)
        .task(id: notice?.id) {
            guard let notice else { return }
            visible = notice
            try? await Task.sleep(for: .seconds(4))
            visible = nil
        }
    }
}
