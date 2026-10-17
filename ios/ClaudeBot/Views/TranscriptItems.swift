import SwiftUI

struct TranscriptItemView: View {
    let taskId: TaskID
    let item: Item

    var body: some View {
        switch item {
        case .user(let i): UserBubble(text: i.text)
        case .assistant(let i): MarkdownText(text: i.text)
        case .tool(let i): ToolRow(item: i)
        case .approval(let i): ApprovalCard(taskId: taskId, item: i)
        case .question(let i): QuestionCard(taskId: taskId, item: i)
        case .result(let i): ResultFooter(item: i)
        case .notice(let i): NoticeRow(item: i)
        case .unknown: EmptyView()
        }
    }
}

private let cardShape = RoundedRectangle(cornerRadius: 16, style: .continuous)

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.claude, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .textSelection(.enabled)
        }
    }
}

struct ToolRow: View {
    let item: ToolItem
    @State private var expanded = false

    private var hasOutput: Bool { !(item.output ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: ToolSymbol.name(for: item.name))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    (Text(item.name).fontWeight(.semibold) + Text("  ") + Text(item.summary).foregroundStyle(.secondary))
                        .font(.footnote)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    stateIcon
                    if hasOutput {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasOutput)

            if expanded, let output = item.output {
                Divider()
                ScrollView([.horizontal, .vertical]) {
                    Text(output)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
            }
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch item.state {
        case .running: ProgressView().controlSize(.small)
        case .ok: Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.green)
        case .error: Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.red)
        }
    }
}

struct DiffView: View {
    let text: String

    var body: some View {
        ScrollView([.horizontal, .vertical], showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                    Text(line.isEmpty ? " " : String(line))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Self.color(line))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Self.color(line).opacity(line.hasPrefix("-") || line.hasPrefix("+") ? 0.12 : 0))
                }
            }
            .padding(.vertical, 8)
        }
        .frame(maxHeight: 260)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(.systemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private static func color(_ line: Substring) -> Color {
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        return .primary
    }
}

struct ApprovalCard: View {
    @Environment(BridgeClient.self) private var client
    let taskId: TaskID
    let item: ApprovalItem
    @State private var sent: Decision?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: ToolSymbol.name(for: item.tool))
                    .foregroundStyle(Color.claude)
                Text(item.tool).font(.headline)
                Spacer()
                if item.state == .pending {
                    Text("Approval needed")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.claude)
                }
            }
            Text(item.summary)
                .font(.system(.subheadline, design: .monospaced))
                .lineLimit(3)
            if !item.detail.isEmpty {
                DiffView(text: item.detail)
            }
            footer
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: cardShape)
        .overlay(cardShape.strokeBorder(item.state == .pending ? Color.claude.opacity(0.6) : .clear, lineWidth: 1.5))
        .opacity(item.state == .pending ? 1 : 0.75)
        .sensoryFeedback(.impact(weight: .medium), trigger: sent)
    }

    @ViewBuilder
    private var footer: some View {
        switch item.state {
        case .pending:
            if sent != nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Sending…").font(.subheadline).foregroundStyle(.secondary)
                }
            } else {
                HStack(spacing: 8) {
                    decisionButton("Deny", .deny, role: .destructive)
                        .buttonStyle(.bordered)
                    decisionButton("Always allow", .allowAlways)
                        .buttonStyle(.bordered)
                    decisionButton("Allow", .allow)
                        .buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
            }
        case .allowed:
            Label("Allowed", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        case .denied:
            Label("Denied", systemImage: "xmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }

    private func decisionButton(_ title: String, _ decision: Decision, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            sent = decision
            client.send(.decide(taskId: taskId, itemId: item.id, decision: decision))
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
        }
    }
}

struct QuestionCard: View {
    @Environment(BridgeClient.self) private var client
    let taskId: TaskID
    let item: QuestionItem
    @State private var picks: [String: Set<String>] = [:]
    @State private var submitted = false

    /// One single-select question answers on tap; anything else needs an explicit Submit.
    private var answersOnTap: Bool {
        item.questions.count == 1 && item.questions.first?.multiSelect == false
    }

    private var complete: Bool {
        item.questions.allSatisfy { !(picks[$0.question] ?? []).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let answers = item.answers {
                answered(answers)
            } else {
                ForEach(item.questions, id: \.question) { question in
                    questionView(question)
                }
                if !answersOnTap {
                    Button {
                        submit()
                    } label: {
                        Text("Submit").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!complete || submitted)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: cardShape)
        .overlay(cardShape.strokeBorder(item.answers == nil ? Color.claude.opacity(0.6) : .clear, lineWidth: 1.5))
        .sensoryFeedback(.selection, trigger: picks)
    }

    private func questionView(_ question: Question) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(Color.claude)
                Text(question.header.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                if question.multiSelect {
                    Text("Pick any").font(.caption).foregroundStyle(.tertiary)
                }
            }
            Text(question.question).font(.headline)
            ForEach(question.options, id: \.label) { option in
                optionButton(option, in: question)
            }
        }
    }

    private func optionButton(_ option: QuestionOption, in question: Question) -> some View {
        let selected = picks[question.question, default: []].contains(option.label)
        return Button {
            toggle(option.label, in: question)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                    if !option.description.isEmpty {
                        Text(option.description).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if question.multiSelect {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.claude : Color.secondary)
                } else if selected {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                selected ? Color.claude.opacity(0.14) : Color(.systemBackground),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(selected ? Color.claude : Color(.separator), lineWidth: selected ? 1.5 : 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(submitted)
    }

    private func toggle(_ label: String, in question: Question) {
        if question.multiSelect {
            picks[question.question, default: []].formSymmetricDifference([label])
        } else {
            picks[question.question] = [label]
            if answersOnTap { submit() }
        }
    }

    private func submit() {
        guard complete, !submitted else { return }
        submitted = true
        let answers = Dictionary(uniqueKeysWithValues: item.questions.map { question in
            let chosen = question.options.map(\.label).filter { picks[question.question, default: []].contains($0) }
            return (question.question, chosen.joined(separator: ", "))
        })
        client.send(.answer(taskId: taskId, itemId: item.id, answers: answers))
    }

    private func answered(_ answers: [String: String]) -> some View {
        let order = item.questions.map(\.question)
        let keys = answers.keys.sorted { (order.firstIndex(of: $0) ?? .max, $0) < (order.firstIndex(of: $1) ?? .max, $1) }
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(keys, id: \.self) { key in
                VStack(alignment: .leading, spacing: 3) {
                    Text(key).font(.subheadline).foregroundStyle(.secondary)
                    Label(answers[key] ?? "", systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ResultFooter: View {
    let item: ResultItem

    var body: some View {
        VStack(spacing: 4) {
            if item.ok {
                Label("Done · \(Format.cost(item.costUsd)) · \(Format.duration(ms: item.durationMs))", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            } else {
                Label(item.text.isEmpty ? "Failed" : item.text, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                Text("\(Format.cost(item.costUsd)) · \(Format.duration(ms: item.durationMs))")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}

struct NoticeRow: View {
    @Environment(\.openURL) private var openURL
    let item: NoticeItem

    var body: some View {
        VStack(spacing: 8) {
            Text(item.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let url = item.url {
                Button("Open in Claude", systemImage: "arrow.up.forward.app") { openURL(url) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}
