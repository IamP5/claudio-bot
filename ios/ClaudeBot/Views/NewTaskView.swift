import SwiftUI

struct NewTaskView: View {
    enum Place: String, CaseIterable {
        case local, cloud
        var title: String { self == .local ? "Mac" : "Cloud" }
        var symbol: String { self == .local ? "laptopcomputer" : "cloud" }
    }

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss

    @AppStorage("new.place") private var place = Place.local
    @AppStorage("new.project") private var projectRaw = ""
    @AppStorage("new.model") private var model = ModelChoice.opus.rawValue
    @AppStorage("new.permission") private var permission = PermissionMode.default

    @State private var prompt = ""

    private var eligibleProjects: [Project] {
        place == .cloud ? store.projects.filter { $0.githubRepo != nil } : store.projects
    }

    /// The remembered project when it fits the chosen place, else the first that does.
    private var project: Project? {
        eligibleProjects.first { $0.id.rawValue == projectRaw } ?? eligibleProjects.first
    }

    private var canSend: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && project != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    PromptTextView(text: $prompt, placeholder: "What should Claude do?", minLines: 7, autofocus: true)
                        .padding(.vertical, 4)
                }

                Section {
                    Picker("Where", selection: $place) {
                        ForEach(Place.allCases, id: \.self) { place in
                            Label(place.title, systemImage: place.symbol).tag(place)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    Text(place == .local
                        ? "Runs Claude Code on your Mac, in the project folder."
                        : "Starts a Claude Code cloud session on the project's GitHub repo.")
                }

                Section {
                    projectPicker
                    Picker("Model", selection: $model) {
                        ForEach(ModelChoice.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                    .pickerStyle(.menu)
                    Picker("Permissions", selection: $permission) {
                        ForEach(PermissionMode.choices, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.menu)
                } footer: {
                    Text(permission.explanation)
                }
            }
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send", systemImage: "arrow.up", action: send)
                        .buttonStyle(.borderedProminent)
                        .disabled(!canSend)
                }
            }
        }
    }

    @ViewBuilder
    private var projectPicker: some View {
        if eligibleProjects.isEmpty {
            LabeledContent("Project") {
                Text(place == .cloud ? "No project has a GitHub remote" : "No projects on your Mac")
                    .foregroundStyle(.secondary)
            }
        } else {
            Picker("Project", selection: Binding(
                get: { project?.id.rawValue ?? "" },
                set: { projectRaw = $0 }
            )) {
                ForEach(eligibleProjects) { project in
                    VStack(alignment: .leading) {
                        Text(project.name)
                        if let repo = project.githubRepo, place == .cloud {
                            Text(repo)
                        } else if let branch = project.branch {
                            Text(branch)
                        }
                    }
                    .tag(project.id.rawValue)
                }
            }
            .pickerStyle(.menu)
        }
    }

    private func send() {
        guard let project, canSend else { return }
        let target: Target = place == .cloud ? .cloud(project.id) : .local(project.id)
        projectRaw = project.id.rawValue
        client.send(.create(
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            target: target,
            model: model,
            permissionMode: permission
        ))
        router.awaitingNewTask = true
        dismiss()
    }
}
