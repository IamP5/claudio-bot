import SwiftUI

/// One display row of a session thread. Equatable on the row alone: the model it reads through is the same object
/// for the life of the thread, so a row whose item did not change is skipped.
struct ThreadRowView: View, Equatable {
    let row: ThreadRow
    let sessionId: SessionID
    let model: ThreadModel
    var botName: String?
    let onFullOutput: (ToolStep) -> Void

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.row == b.row && a.sessionId == b.sessionId && a.botName == b.botName
    }

    var body: some View {
        switch row {
        case let .fold(id, items, expanded):
            FoldRow(items: items, expanded: expanded) { model.toggle(fold: id) }
        case .item(let item):
            switch item {
            case let .user(_, _, text, from, queued):
                SessionUserBubble(text: text, from: from, queued: queued, botName: botName)
            case let .assistant(id, _, text):
                RenderedMarkdownView(markdown: model.rendered(id, text))
                    .font(.system(size: 16))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            case let .thinking(_, _, text, ms):
                ThinkingRow(text: text, ms: ms)
            case let .work(_, _, steps):
                WorkRunRow(steps: steps, onFullOutput: onFullOutput)
            case let .todo(_, _, todos):
                TodoCard(todos: todos)
            case let .plan(id, _, text, state, cardId):
                PlanCard(sessionId: sessionId, markdown: model.rendered(id, text), state: state, cardId: cardId)
            case let .permission(_, _, permission):
                PermissionCardView(messageId: permission.cardId, card: permission.card) {
                    .sessionDecide(sessionId: sessionId, cardId: permission.cardId, choice: $0)
                }
            case let .ask(_, _, questions, answers, cardId):
                AskCard(sessionId: sessionId, questions: questions, answers: answers, cardId: cardId)
            case let .notice(_, _, text, tone):
                NoticeLine(text: text, tone: tone)
            case .compaction:
                CompactionDivider()
            case .unknown:
                EmptyView()
            }
        }
    }
}

struct SessionUserBubble: View {
    let text: String
    let from: SessionAuthor
    let queued: Bool
    var botName: String?

    var body: some View {
        if from == .system {
            NoticeLine(text: text, tone: .info)
        } else {
            VStack(alignment: .trailing, spacing: 5) {
                if from == .bot {
                    Label(botName.map { "From \($0)" } ?? "From a bot", systemImage: "gearshape")
                        .font(.caption)
                        .foregroundStyle(Theme.tertiary)
                }
                HStack(spacing: 0) {
                    Spacer(minLength: 48)
                    Text(MarkdownText.inline(text))
                        .font(.system(size: 16))
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background {
                            let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
                            if queued {
                                shape.strokeBorder(Color.white.opacity(0.28), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                            } else {
                                shape.fill(Theme.raised)
                            }
                        }
                        .opacity(queued ? 0.75 : 1)
                }
                if queued {
                    Label("Queued", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(Theme.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityElement(children: .combine)
            .accessibilityLabel((from == .bot ? "From \(botName ?? "a bot"): " : "You: ") + text + (queued ? ". Queued" : ""))
        }
    }
}

struct FoldRow: View {
    let items: [SessionItem]
    let expanded: Bool
    let toggle: () -> Void

    private var steps: [ToolStep] {
        items.flatMap { item -> [ToolStep] in if case .work(_, _, let steps) = item { steps } else { [] } }
    }

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                Image(systemName: "square.stack.3d.up")
                    .font(.footnote)
                    .foregroundStyle(Theme.tertiary)
                Text(WorkSummary.fold(items))
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.leading)
                if let diff = WorkSummary.diff(steps) { DiffStat(added: diff.added, removed: diff.removed) }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(WorkSummary.fold(items))
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Hides these steps" : "Shows these steps")
    }
}

struct ThinkingRow: View {
    let text: String
    let ms: Int?
    @State private var open = false

    private var title: String {
        guard let ms else { return "Thought" }
        let seconds = max(1, Int((Double(ms) / 1000).rounded()))
        return "Thought for \(seconds)s"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.footnote)
                    Text(title).font(.subheadline)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(Theme.tertiary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                Text(text)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 2) }
            }
        }
    }
}

struct WorkRunRow: View {
    let steps: [ToolStep]
    let onFullOutput: (ToolStep) -> Void
    @State private var open = false

    private var running: ToolStep? { steps.last { $0.state == .running } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps) { step in
                        ToolStepRow(step: step, onFullOutput: onFullOutput)
                        if step.id != steps.last?.id { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 34) }
                    }
                }
                .padding(.vertical, 4)
                .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.top, 4)
            }
        }
    }

    private var summary: String {
        if let running { return running.label }
        let errors = WorkSummary.errors(steps)
        return WorkSummary.text(steps) + (errors > 0 ? ", \(errors) failed" : "")
    }

    private var header: some View {
        HStack(spacing: 8) {
            if running != nil {
                WorkingRing(size: 12)
                    .frame(width: 16)
            } else {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.footnote)
                    .foregroundStyle(Theme.tertiary)
                    .frame(width: 16)
            }
            Group {
                if let running {
                    Text(running.label).shimmering()
                } else {
                    Text(WorkSummary.text(steps))
                }
            }
            .font(.subheadline)
            .foregroundStyle(Theme.secondary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            if let diff = WorkSummary.diff(steps) { DiffStat(added: diff.added, removed: diff.removed) }
            let errors = WorkSummary.errors(steps)
            if errors > 0 {
                Label("\(errors) failed", systemImage: "xmark.circle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.danger)
                    .labelStyle(.titleAndIcon)
                    .fixedSize()
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.tertiary)
                .rotationEffect(.degrees(open ? 90 : 0))
        }
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

struct ToolStepRow: View {
    let step: ToolStep
    let onFullOutput: (ToolStep) -> Void

    static func symbol(_ tool: String) -> String {
        switch tool {
        case "Edit", "MultiEdit", "NotebookEdit": "pencil"
        case "Write": "doc.badge.plus"
        case "Bash", "BashOutput": "terminal"
        case "Read": "doc.text"
        case "Grep", "Glob", "ToolSearch": "magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "Task", "Agent": "person.2"
        default: "wrench"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: Self.symbol(step.tool))
                    .font(.footnote)
                    .foregroundStyle(Theme.tertiary)
                    .frame(width: 16)
                Text(step.label)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(step.state == .denied ? Theme.tertiary : .white)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let diff = step.diff { DiffStat(added: diff.added, removed: diff.removed) }
                StepState(state: step.state)
            }
            if let output = step.output, !output.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(Self.tail(output))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(step.state == .error ? Theme.danger.opacity(0.9) : Theme.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Full output") { onFullOutput(step) }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.link)
                        .frame(minHeight: 44)
                }
                .padding(.leading, 26)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    /// The last 6 lines: where a test run or a build says how it went.
    static func tail(_ output: String) -> String {
        output.split(separator: "\n", omittingEmptySubsequences: false).suffix(6).joined(separator: "\n")
            .trimmingCharacters(in: .newlines)
    }
}

private struct StepState: View {
    let state: ToolStepState

    var body: some View {
        switch state {
        case .running:
            ProgressView().controlSize(.mini).accessibilityLabel("Running")
        case .error:
            Image(systemName: "xmark.circle.fill").font(.footnote).foregroundStyle(Theme.danger).accessibilityLabel("Failed")
        case .denied:
            Image(systemName: "nosign").font(.footnote).foregroundStyle(Theme.attention).accessibilityLabel("Denied")
        case .ok, .unknown:
            EmptyView()
        }
    }
}

struct DiffStat: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(added)").foregroundStyle(Color(hex: 0x3FB950))
            Text("−\(removed)").foregroundStyle(Color(hex: 0xF85149))
        }
        .font(.caption.monospacedDigit().weight(.medium))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(added) lines added, \(removed) removed")
    }
}

struct TodoCard: View {
    let todos: [SessionTodo]

    var body: some View {
        let done = todos.count { $0.state == .done }
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("To-dos", systemImage: "checklist")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                Spacer()
                Text("\(done) of \(todos.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.tertiary)
            }
            ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: Self.symbol(todo.state))
                        .font(.subheadline)
                        .foregroundStyle(todo.state == .done ? Color(hex: 0x3FB950) : todo.state == .inProgress ? AvatarColor.orange.color : Theme.tertiary)
                    Text(todo.text)
                        .font(.subheadline.weight(todo.state == .inProgress ? .semibold : .regular))
                        .foregroundStyle(todo.state == .done ? Theme.tertiary : .white)
                        .strikethrough(todo.state == .done, color: Theme.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(Self.spoken(todo.state))
            }
        }
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    static func symbol(_ state: TodoState) -> String {
        switch state {
        case .done: "checkmark.circle.fill"
        case .inProgress: "circle.lefthalf.filled"
        case .pending, .unknown: "circle"
        }
    }

    static func spoken(_ state: TodoState) -> String {
        switch state {
        case .done: "done"
        case .inProgress: "in progress"
        case .pending, .unknown: "to do"
        }
    }
}

struct PlanCard: View {
    let sessionId: SessionID
    let markdown: RenderedMarkdown
    let state: PlanState
    let cardId: MessageID?

    @Environment(BridgeClient.self) private var client
    @State private var sent: PermissionChoice?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Plan", systemImage: "list.bullet.clipboard")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(state == .proposed ? Theme.attention : Theme.secondary)
            RenderedMarkdownView(markdown: markdown)
                .font(.system(size: 15))
                .foregroundStyle(state == .proposed ? .white : Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            switch state {
            case .proposed:
                if let cardId {
                    HStack(spacing: 8) {
                        decide("Approve", .once, cardId, primary: true)
                        decide("Keep planning", .deny, cardId, primary: false)
                    }
                    .disabled(sent != nil)
                    Text("Approving lets Claude leave plan mode and start on it.")
                        .font(.footnote)
                        .foregroundStyle(Theme.tertiary)
                } else {
                    Text("Waiting for an answer where it was asked.")
                        .font(.footnote)
                        .foregroundStyle(Theme.tertiary)
                }
            case .approved:
                Label("Approved", systemImage: "checkmark.circle.fill").font(.subheadline.weight(.semibold)).foregroundStyle(Color(hex: 0x3FB950))
            case .rejected:
                Label("Kept planning", systemImage: "arrow.uturn.backward.circle").font(.subheadline).foregroundStyle(Theme.secondary)
            case .expired, .unknown:
                Text("Expired. Nobody answered in time.").font(.subheadline).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            if state == .proposed {
                RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.attention.opacity(0.35), lineWidth: 1)
            }
        }
        .sensoryFeedback(trigger: sent) { _, choice in choice.map { $0.allows ? .success : .warning } }
        .onChange(of: state) { sent = nil }
    }

    private func decide(_ title: String, _ choice: PermissionChoice, _ cardId: MessageID, primary: Bool) -> some View {
        Button {
            sent = choice
            client.send(.sessionDecide(sessionId: sessionId, cardId: cardId, choice: choice))
        } label: {
            HStack(spacing: 6) {
                if sent == choice { ProgressView().controlSize(.mini) }
                Text(title)
            }
            .font(.system(size: 15, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .foregroundStyle(primary ? Color.black : .white)
            .background(primary ? Color.white : Theme.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.pressable)
    }
}

struct AskCard: View {
    let sessionId: SessionID
    let questions: [AskQuestion]
    let answers: AskAnswers?
    let cardId: MessageID?

    @Environment(BridgeClient.self) private var client
    @State private var picks: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var sent = false

    private var open: Bool { answers == nil && cardId != nil }

    /// The answer each question would send: what was typed, else the picked labels in option order.
    private var draft: [String: String] {
        var out: [String: String] = [:]
        for q in questions {
            let free = typed[q.question, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = q.options.map(\.label).filter { picks[q.question]?.contains($0) == true }
            if !free.isEmpty { out[q.question] = free } else if !chosen.isEmpty { out[q.question] = chosen.joined(separator: ", ") }
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Label(questions.count == 1 ? "Question" : "\(questions.count) questions", systemImage: "questionmark.bubble")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(open ? Theme.attention : Theme.secondary)
                Spacer()
                if open, let cardId {
                    Button {
                        sent = true
                        client.send(.sessionAnswer(sessionId: sessionId, cardId: cardId, answers: nil))
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.tertiary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sent)
                    .accessibilityLabel("Dismiss question")
                }
            }
            ForEach(Array(questions.enumerated()), id: \.offset) { _, q in
                question(q)
            }
            footer
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            if open { RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Theme.attention.opacity(0.35), lineWidth: 1) }
        }
        .sensoryFeedback(.success, trigger: sent) { _, now in now }
        .onChange(of: answers) { sent = false }
    }

    @ViewBuilder
    private func question(_ q: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !q.header.isEmpty {
                Text(q.header.uppercased())
                    .font(.caption2.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(Theme.tertiary)
            }
            Text(q.question)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(open ? .white : Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if open {
                VStack(spacing: 0) {
                    ForEach(Array(q.options.enumerated()), id: \.offset) { index, option in
                        if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 48) }
                        Button { pick(option.label, in: q) } label: {
                            AskOptionRow(index: index, option: option, multi: q.multiSelect, picked: picks[q.question]?.contains(option.label) == true)
                        }
                        .buttonStyle(.pressable)
                        .disabled(sent)
                    }
                }
                .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                TextField("Or type your own answer", text: Binding(get: { typed[q.question, default: ""] }, set: { typed[q.question] = $0 }), axis: .vertical)
                    .font(.subheadline)
                    .lineLimit(1...4)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Theme.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .disabled(sent)
            } else if case .answered(let given) = answers, let answer = given[q.question] {
                Label(answer, systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .symbolRenderingMode(.multicolor)
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        switch answers {
        case nil:
            if let cardId {
                if needsSubmit {
                    Button {
                        sent = true
                        client.send(.sessionAnswer(sessionId: sessionId, cardId: cardId, answers: draft))
                    } label: {
                        HStack(spacing: 6) {
                            if sent { ProgressView().controlSize(.mini) }
                            Text(questions.count == 1 ? "Send answer" : "Send answers")
                        }
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .foregroundStyle(.black)
                        .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .opacity(draft.count == questions.count ? 1 : 0.4)
                    }
                    .buttonStyle(.pressable)
                    .disabled(sent || draft.count != questions.count)
                }
            } else {
                Text("Waiting for an answer where it was asked.").font(.footnote).foregroundStyle(Theme.tertiary)
            }
        case .dismissed:
            Text("Dismissed").font(.subheadline).foregroundStyle(Theme.tertiary)
        case .expired:
            Text("Expired. Nobody answered in time.").font(.subheadline).foregroundStyle(Theme.tertiary)
        case .closed:
            Text("Closed").font(.subheadline).foregroundStyle(Theme.tertiary)
        case .answered:
            EmptyView()
        }
    }

    private var needsSubmit: Bool {
        !(questions.count == 1 && !questions[0].multiSelect && typed[questions[0].question, default: ""].isEmpty)
    }

    private func pick(_ label: String, in q: AskQuestion) {
        var set = picks[q.question, default: []]
        if q.multiSelect {
            if set.remove(label) == nil { set.insert(label) }
        } else {
            set = [label]
        }
        picks[q.question] = set
        typed[q.question] = ""
        if !needsSubmit, let cardId {
            sent = true
            client.send(.sessionAnswer(sessionId: sessionId, cardId: cardId, answers: [q.question: label]))
        }
    }
}

private struct AskOptionRow: View {
    let index: Int
    let option: AskOption
    let multi: Bool
    let picked: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if multi {
                Image(systemName: picked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 19))
                    .foregroundStyle(picked ? .white : Theme.tertiary)
                    .frame(width: 22, height: 22)
            } else {
                LetterBadge(index: index, fill: picked ? .white : .white.opacity(0.08), ink: picked ? .black : Theme.tertiary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.system(size: 16))
                    .foregroundStyle(.white)
                if !option.description.isEmpty {
                    Text(option.description)
                        .font(.footnote)
                        .foregroundStyle(Theme.secondary)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }
}

struct NoticeLine: View {
    let text: String
    let tone: NoticeTone

    var body: some View {
        Label(text, systemImage: tone == .error ? "exclamationmark.triangle" : "info.circle")
            .font(.footnote)
            .foregroundStyle(tone == .error ? Theme.danger : Theme.tertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
    }
}

struct CompactionDivider: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
            Text("Conversation compacted")
                .font(.caption)
                .foregroundStyle(Theme.tertiary)
                .fixedSize()
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The only view that reads the live text, so a delta redraws this and nothing else.
struct StreamingTail: View {
    let live: LiveText
    let working: Bool

    var body: some View {
        if live.itemId != nil, !live.text.isEmpty {
            Text(live.text)
                .font(.system(size: 16))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 14)
                .accessibilityLabel("Writing: \(live.text)")
        } else if working {
            HStack(spacing: 8) {
                WorkingRing(size: 12)
                Text("Working…")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
                    .shimmering()
            }
            .padding(.top, 14)
            .accessibilityElement(children: .combine)
        }
    }
}
