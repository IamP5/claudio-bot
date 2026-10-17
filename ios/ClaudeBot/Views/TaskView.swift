import SwiftUI

struct TaskView: View {
    let taskId: TaskID

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(AppModel.self) private var app
    @State private var draft = ""
    @State private var pinnedToBottom = true

    private var task: TaskSummary? { store.tasks[taskId] }
    private var items: [Item] { store.transcripts[taskId]?.items ?? [] }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(items) { item in
                        TranscriptItemView(taskId: taskId, item: item)
                            .id(item.id)
                    }
                    if items.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 80
            } action: { _, atBottom in
                pinnedToBottom = atBottom
            }
            .task {
                // LazyVStack only knows its real height after the first layout pass.
                try? await Task.sleep(for: .milliseconds(150))
                proxy.scrollTo(Self.bottom, anchor: .bottom)
            }
            .onChange(of: items) {
                guard pinnedToBottom else { return }
                withAnimation(.snappy) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if let task, task.target.isCloud { CloudBanner(url: task.cloudUrl) }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let task { composer(task) }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let task { TaskHeader(task: task) }
            }
        }
        .onAppear {
            client.openTask = taskId
            app.notifier.clear(task: taskId)
        }
        .onDisappear {
            if client.openTask == taskId { client.openTask = nil }
        }
    }

    private static let bottom = "bottom"

    @ViewBuilder
    private func composer(_ task: TaskSummary) -> some View {
        if task.status == .failed || task.status == .stopped {
            Text(task.status == .failed ? "This task failed. Start a new one to try again." : "This task was stopped.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(.bar)
        } else {
            HStack(alignment: .bottom, spacing: 8) {
                PromptTextView(text: $draft, placeholder: task.status.isActive ? "Queue a follow-up" : "Reply to Claude", maxLines: 6)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                if task.status.isActive {
                    Button {
                        client.send(.stop(taskId: taskId))
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 34))
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(.red)
                    }
                    .accessibilityLabel("Stop")
                }
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(canSend ? Color.claude : Color.secondary.opacity(0.4))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        client.send(.send(taskId: taskId, text: text))
        draft = ""
        pinnedToBottom = true
    }
}

private struct TaskHeader: View {
    let task: TaskSummary

    var body: some View {
        VStack(spacing: 2) {
            Text(task.title)
                .font(.headline)
                .lineLimit(1)
            HStack(spacing: 4) {
                Image(systemName: task.target.isCloud ? "cloud" : "laptopcomputer")
                Text("\(task.projectName) · \(task.target.isCloud ? "Cloud" : "Mac") ·")
                StatusDot(color: task.status.color, pulsing: task.status == .running)
                Text(task.status.title)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .frame(maxWidth: 240)
    }
}

private struct CloudBanner: View {
    @Environment(\.openURL) private var openURL
    let url: URL?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "cloud.fill")
                .foregroundStyle(Color.claude)
            Text("Runs in a Claude Code cloud session. Live output streams in the Claude app.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let url {
                Button("Open") { openURL(url) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .accessibilityLabel("Open in Claude")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}
