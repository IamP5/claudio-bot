import SwiftUI

/// The Memory section in Settings: USER.md's facts. Facts you added or confirmed reach every bot; a bot's proposal reaches
/// only that bot until you confirm it here. Shown when the bridge lists .memory.
struct MemorySection: View {
    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @State private var editing: FactDraft?

    var body: some View {
        if store.has(.memory) {
            Section {
                if let facts = store.facts {
                    if facts.isEmpty {
                        Text("No facts yet. Tell a bot something worth keeping, or add one here.")
                            .foregroundStyle(Theme.secondary)
                    }
                    ForEach(facts) { fact in
                        if fact.confirmed {
                            Button { editing = FactDraft(fact) } label: { FactRow(fact: fact) }
                                .buttonStyle(.plain)
                        } else {
                            ProposedFactRow(
                                fact: fact,
                                onConfirm: { client.send(.confirmFact(factId: fact.id)) },
                                onForget: { client.send(.forgetFact(factId: fact.id)) }
                            )
                        }
                    }
                    .onDelete { offsets in
                        for i in offsets { client.send(.forgetFact(factId: facts[i].id)) }
                    }
                    if facts.count < FactDraft.maxFacts {
                        Button("Add a fact") { editing = FactDraft(nil) }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: {
                Text("Memory")
            } footer: {
                Text("What bots know about you. A fact a bot remembers stays with that bot until you confirm it; then every bot knows it. Tap a fact to edit it, swipe to forget it. They live in USER.md on your Mac.")
            }
            .task(id: store.connection.summary) { client.send(.memory) }
            .sheet(item: $editing) { draft in
                FactEditor(draft: draft) { text in
                    client.send(.setFact(factId: draft.factId, text: text))
                }
            }
        }
    }
}

/// A fact being added (factId nil) or edited in the sheet.
private struct FactDraft: Identifiable {
    static let maxChars = 300
    static let maxFacts = 50

    let id = UUID()
    let factId: FactID?
    let text: String

    init(_ fact: Fact?) {
        factId = fact?.id
        text = fact?.text ?? ""
    }
}

private struct FactRow: View {
    let fact: Fact

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(fact.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(fact.by.map { "From \($0)" } ?? "Added by you") · \(TimeLabel.home(fact.at))")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
        }
        .contentShape(Rectangle())
    }
}

/// A bot's proposed fact: only that bot reads it until the user confirms it, so the row asks for that decision.
private struct ProposedFactRow: View {
    let fact: Fact
    let onConfirm: () -> Void
    let onForget: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(fact.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(fact.by.map { "Proposed by \($0)" } ?? "Proposed by a bot") · \(TimeLabel.home(fact.at)). Only that bot uses it until you confirm.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
            HStack {
                Button("Confirm", action: onConfirm)
                    .buttonStyle(.borderedProminent)
                Button("Forget", role: .destructive, action: onForget)
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
    }
}

private struct FactEditor: View {
    let draft: FactDraft
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmed.isEmpty && trimmed.count <= FactDraft.maxChars && trimmed != draft.text }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Prefers short answers", text: $text, axis: .vertical)
                        .lineLimit(2...6)
                } footer: {
                    Text("\(trimmed.count)/\(FactDraft.maxChars). Every bot reads this. Never put passwords or keys here.")
                        .foregroundStyle(trimmed.count > FactDraft.maxChars ? Theme.danger : Theme.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle(draft.factId == nil ? "New fact" : "Edit fact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(trimmed)
                        dismiss()
                    }
                    .disabled(!canSave)
                }
            }
            .onAppear { text = draft.text }
        }
        .presentationDetents([.medium])
    }
}
