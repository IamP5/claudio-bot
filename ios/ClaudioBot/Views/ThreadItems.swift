import SwiftUI

/// One display row of a session thread. Equatable on the row alone: the model it reads through is the same object
/// for the life of the thread, so a row whose item did not change is skipped.
struct ThreadRowView: View, Equatable {
    let row: ThreadRow
    let sessionId: SessionID
    let model: ThreadModel
    var botName: String?
    /// A prompt a stop ended before Claude answered: it offers Edit and resend.
    var unanswered = false
    /// The bridge takes queued messages back.
    var withdraws = false
    let onFullOutput: (ToolStep) -> Void

    @Environment(BridgeClient.self) private var client

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.row == b.row && a.sessionId == b.sessionId && a.botName == b.botName && a.unanswered == b.unanswered && a.withdraws == b.withdraws
    }

    var body: some View {
        switch row {
        case let .fold(id, items, expanded):
            FoldRow(items: items, expanded: expanded) { model.toggle(fold: id) }
        case .item(let item):
            switch item {
            case let .user(id, _, text, from, queued):
                SessionUserBubble(text: text, from: from, queued: queued, botName: botName, actions: actions(id, text, queued: queued))
            case let .assistant(id, _, text):
                RenderedMarkdownView(markdown: model.rendered(id, text))
                    .font(.ui(size: 16))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
            case let .thinking(_, _, text, ms):
                ThinkingRow(text: text, ms: ms)
            case let .work(_, _, steps):
                // Only a live run reads the controls, so a heartbeat redraws the work still running and nothing else.
                WorkRunRow(run: WorkRun(steps: steps, controls: steps.contains { $0.state.isLive } ? model.controls : nil), onFullOutput: onFullOutput)
            case let .todo(_, _, todos):
                TodoCard(todos: todos)
            case let .plan(id, _, text, state, cardId):
                PlanCard(sessionId: sessionId, markdown: model.rendered(id, text), state: state, cardId: cardId)
            case let .permission(_, _, permission):
                SessionPermissionCard(sessionId: sessionId, permission: permission, model: model)
            case let .ask(_, _, questions, answers, cardId):
                AskCard(sessionId: sessionId, questions: questions, answers: answers, cardId: cardId)
            case let .notice(_, _, text, tone, _):
                NoticeLine(text: text, tone: tone)
            case .compaction:
                CompactionDivider()
            case .unknown:
                EmptyView()
            }
        }
    }
}

extension ThreadRowView {
    private func actions(_ id: ItemID, _ text: String, queued: Bool) -> SessionUserBubble.Actions? {
        if queued, withdraws {
            return .queued(
                edit: { client.withdraw(id, text: text, from: model, edit: true) },
                withdraw: { client.withdraw(id, text: text, from: model, edit: false) }
            )
        }
        return unanswered && !queued ? .resend { model.edit(text) } : nil
    }
}

/// The least height of a clickable row: a fingertip on iPhone, a pointer's regular control on a Mac.
enum HitTarget {
    #if os(macOS)
    static let minHeight: CGFloat = 28
    #else
    static let minHeight: CGFloat = 44
    #endif
}

struct SessionUserBubble: View {
    /// What the user can still do with the message: take a queued one back, or edit one a stop cut off and send it again.
    enum Actions {
        case queued(edit: () -> Void, withdraw: () -> Void)
        case resend(() -> Void)
    }

    let text: String
    let from: SessionAuthor
    let queued: Bool
    var botName: String?
    var actions: Actions?

    var body: some View {
        if from == .system {
            NoticeLine(text: text, tone: .info)
        } else {
            let rendered = MarkdownText.inline(text)
            VStack(alignment: .trailing, spacing: 5) {
                if from == .bot {
                    Label(botName.map { "From \($0)" } ?? "From a bot", systemImage: "gearshape")
                        .font(.caption)
                        .foregroundStyle(Theme.tertiary)
                }
                HStack(spacing: 0) {
                    Spacer(minLength: 48)
                    Text(rendered)
                        .font(.ui(size: 16))
                        .bubbleText()
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .padding(Bubble.padding)
                        .background {
                            let shape = Bubble.shape
                            if queued {
                                shape.strokeBorder(Color.white.opacity(0.28), style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                            } else {
                                shape.fill(Theme.raised)
                            }
                        }
                        .opacity(queued ? 0.75 : 1)
                }
                caption
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Self.spoken(rendered, from: from, botName: botName, queued: queued))
            .accessibilityActions {
                switch actions {
                case let .queued(edit, withdraw)?:
                    Button("Edit", action: edit)
                    Button("Withdraw", action: withdraw)
                case .resend(let resend)?:
                    Button("Edit and resend", action: resend)
                case nil:
                    EmptyView()
                }
            }
        }
    }

    @ViewBuilder
    private var caption: some View {
        switch actions {
        case let .queued(edit, withdraw)?:
            Menu {
                Button(action: edit) { Label("Edit", systemImage: "pencil") }
                Button(role: .destructive, action: withdraw) { Label("Withdraw", systemImage: "arrow.uturn.backward") }
            } label: {
                captionLabel("Queued · Edit or withdraw", symbol: "clock")
            }
        case .resend(let resend)?:
            Button(action: resend) { captionLabel("Edit and resend", symbol: "arrow.uturn.up") }
                .buttonStyle(.plain)
        case nil:
            if queued {
                Label("Queued", systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(Theme.tertiary)
            }
        }
    }

    private func captionLabel(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(Theme.secondary)
            .frame(minHeight: HitTarget.minHeight)
            .contentShape(Rectangle())
    }

    /// The message as it reads on screen: link labels, not their addresses, and no markup characters (F-SES-168).
    static func spoken(_ rendered: AttributedString, from: SessionAuthor, botName: String?, queued: Bool) -> String {
        (from == .bot ? "From \(botName ?? "a bot"): " : "You: ") + String(rendered.characters) + (queued ? ". Queued" : "")
    }
}

struct FoldRow: View {
    let items: [SessionItem]
    let expanded: Bool
    let toggle: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private var steps: [ToolStep] {
        items.flatMap { item -> [ToolStep] in if case .work(_, _, let steps) = item { steps } else { [] } }
    }

    private var failed: Int { WorkSummary.errors(steps) }

    var body: some View {
        // The folded rows are rows of the list, so the list's rows move and fade with this transaction.
        Button {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { toggle() }
        } label: {
            let stacked = typeSize.isAccessibilitySize
            let diff = WorkSummary.diff(steps)
            HStack(spacing: 8) {
                if !stacked {
                    Image(systemName: "square.stack.3d.up")
                        .font(.footnote)
                        .foregroundStyle(Theme.tertiary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(WorkSummary.fold(items))
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondary)
                    if failed > 0 {
                        Label("\(failed) failed", systemImage: "xmark.circle.fill")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Theme.danger)
                    }
                    if stacked, let diff { DiffStat(added: diff.added, removed: diff.removed) }
                }
                .multilineTextAlignment(.leading)
                if !stacked, let diff { DiffStat(added: diff.added, removed: diff.removed) }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.tertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
            }
            .padding(.vertical, 8)
            .frame(minHeight: HitTarget.minHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(WorkSummary.fold(items) + (failed > 0 ? ", \(failed) failed" : ""))
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Hides these steps" : "Shows these steps")
    }
}

struct ThinkingRow: View {
    let text: String
    let ms: Int?
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var title: String {
        guard let ms else { return "Thought" }
        let seconds = max(1, Int((Double(ms) / 1000).rounded()))
        return "Thought for \(seconds)s"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.footnote)
                    Text(title).font(.subheadline)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(Theme.tertiary)
                .frame(minHeight: HitTarget.minHeight)
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

extension EnvironmentValues {
    /// Set while the run state may be out of date, to when it was last known true. Timers stop there and live marks
    /// dim, so a silent or unreachable Mac never shows a clock still ticking.
    @Entry var runStateStale: Date? = nil
}

/// A work item: a header that says what runs, what failed and for how long, then its steps. While the run is live its
/// running and waiting steps stay in view; the rest open on tap. One clock ticks per run, never one per step.
struct WorkRunRow: View {
    let run: WorkRun
    let onFullOutput: (ToolStep) -> Void
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.runStateStale) private var staleAt
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var onScreen = true
    @ScaledMetric(relativeTo: .subheadline) private var slot: CGFloat = 20
    @Environment(\.revealedStep) private var revealedStep

    var body: some View {
        Group {
            if onScreen, staleAt == nil, run.ticks {
                TimelineView(.periodic(from: run.since ?? .now, by: 1)) { context in
                    content(now: context.date)
                }
            } else {
                content(now: staleAt ?? .now)
            }
        }
        // Any part on screen counts. At the default half, a run taller than twice the screen never counts as visible.
        .onScrollVisibilityChange(threshold: 0.01) { onScreen = $0 }
        .onChange(of: revealedStep, initial: true) { _, id in
            if let id, run.steps.contains(where: { $0.id == id }) { open = true }
        }
    }

    private func content(now: Date) -> some View {
        let shown = open ? run.steps : run.live
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { open.toggle() }
            } label: {
                header(now: now)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(run.spoken(now: now))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityHint(open ? "Hides the finished steps" : "Shows every step")
            if !shown.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(shown) { step in
                        ToolStepRow(step: step, run: run, now: now, onFullOutput: onFullOutput)
                            .background { if step.id == revealedStep { Theme.attention.opacity(0.14) } }
                            .id(step.id)
                        if step.id != shown.last?.id { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 34) }
                    }
                }
                .padding(.vertical, 4)
                .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.top, 4)
            }
        }
    }

    private func header(now: Date) -> some View {
        let busy = run.isRunning && staleAt == nil
        let line = Text(run.headline() + (run.since.map { " · " + RunClock.short(now.timeIntervalSince($0)) } ?? ""))
            .font(.subheadline)
            .monospacedDigit()
            .foregroundStyle(Theme.secondary)
        let diff = run.isLive ? nil : WorkSummary.diff(run.steps)
        // At accessibility sizes the words get the row's width: beside the glyph and the diff they wrapped a word a line.
        // The headline's state word and its clock still say whether it runs.
        let stacked = typeSize.isAccessibilitySize
        return HStack(alignment: .top, spacing: 8) {
            if !stacked {
                Group {
                    if busy {
                        WorkingRing(size: slot * 0.6)
                    } else if run.isRunning {
                        Image(systemName: "circle.dotted").font(.footnote).foregroundStyle(Theme.tertiary)
                    } else if run.isLive {
                        Image(systemName: "hand.raised").font(.footnote).foregroundStyle(Theme.attention)
                    } else {
                        Image(systemName: "wrench.and.screwdriver").font(.footnote).foregroundStyle(Theme.tertiary)
                    }
                }
                .frame(width: slot, height: slot)
            }
            VStack(alignment: .leading, spacing: 3) {
                if busy { line.shimmering() } else { line }
                if let failure = run.failure {
                    Label(failure, systemImage: "xmark.circle.fill")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.danger)
                }
                if stacked, let diff { DiffStat(added: diff.added, removed: diff.removed) }
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            if !stacked, let diff { DiffStat(added: diff.added, removed: diff.removed) }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.tertiary)
                .rotationEffect(.degrees(open ? 90 : 0))
                .frame(height: slot)
        }
        .padding(.vertical, 8)
        .frame(minHeight: HitTarget.minHeight)
        .contentShape(Rectangle())
    }
}

struct ToolStepRow: View {
    let step: ToolStep
    let run: WorkRun
    let now: Date
    let onFullOutput: (ToolStep) -> Void
    @Environment(\.runStateStale) private var staleAt
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .footnote) private var slot: CGFloat = 16

    /// At accessibility sizes the tool glyph goes, so the step's words get the whole width.
    private var indent: CGFloat { typeSize.isAccessibilitySize ? 0 : slot + 10 }

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
            summary
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spoken)
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
                        .frame(minHeight: HitTarget.minHeight)
                }
                .padding(.leading, indent)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if !typeSize.isAccessibilitySize {
                    Image(systemName: Self.symbol(step.tool))
                        .font(.footnote)
                        .foregroundStyle(Theme.tertiary)
                        .frame(width: slot)
                }
                Text(step.label)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(step.state == .denied || step.state == .stopped ? Theme.tertiary : .white)
                    .lineLimit(step.state.isLive ? nil : 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let diff = step.diff { DiffStat(added: diff.added, removed: diff.removed) }
                StepState(state: step.state, stale: staleAt != nil)
            }
            VStack(alignment: .leading, spacing: 3) {
                if let detail = step.detail, !detail.isEmpty, detail != step.label {
                    Text(detail)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Theme.secondary)
                        .lineLimit(3)
                }
                Text(run.status(step, now: now).joined(separator: " · "))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(step.state == .waiting || run.task(for: step)?.waiting != nil ? Theme.attention : Theme.tertiary)
                if step.state == .error || step.state == .denied, let cause = step.cause {
                    Text(cause)
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, indent)
        }
    }

    private var spoken: String {
        var parts = [step.label] + run.status(step, now: now, spoken: true)
        if let detail = step.detail, !detail.isEmpty, detail != step.label {
            switch step.tool {
            case "Bash": parts.append("command: " + detail)
            case "Task", "Agent": parts.append("subagent type: " + detail)
            default: parts.append(detail)
            }
        }
        if step.state == .error || step.state == .denied, let cause = step.cause { parts.append(cause) }
        if let diff = step.diff { parts.append("\(diff.added) lines added, \(diff.removed) removed") }
        return parts.joined(separator: ", ")
    }

    /// The last 6 lines: where a test run or a build says how it went.
    static func tail(_ output: String) -> String {
        output.split(separator: "\n", omittingEmptySubsequences: false).suffix(6).joined(separator: "\n")
            .trimmingCharacters(in: .newlines)
    }
}

/// A step's state as a glyph. The word goes in the step's status line, which VoiceOver reads.
private struct StepState: View {
    let state: ToolStepState
    let stale: Bool

    var body: some View {
        switch state {
        case .running:
            if stale {
                Image(systemName: "circle.dotted").font(.footnote).foregroundStyle(Theme.tertiary)
            } else {
                WorkingRing(size: 11)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
            }
        case .waiting:
            Image(systemName: "hand.raised").font(.footnote).foregroundStyle(Theme.attention)
        case .ok:
            Image(systemName: "checkmark.circle").font(.footnote).foregroundStyle(Theme.tertiary)
        case .error:
            Image(systemName: "xmark.circle.fill").font(.footnote).foregroundStyle(Theme.danger)
        case .denied:
            Image(systemName: "nosign").font(.footnote).foregroundStyle(Theme.attention)
        case .stopped:
            Image(systemName: "stop.circle").font(.footnote).foregroundStyle(Theme.secondary)
        case .unknown:
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
                .font(.ui(size: 15))
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
                if sent == choice { SendingSpinner() }
                Text(title)
            }
            .font(.ui(size: 15, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .foregroundStyle(primary ? Color.black : .white)
            .background(primary ? Color.white : Theme.inset, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.pressable)
        .sending(sent == choice)
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
                            .font(.ui(size: 15, weight: .medium))
                            .foregroundStyle(Theme.tertiary)
                            .frame(width: HitTarget.minHeight, height: HitTarget.minHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sent)
                    .help("Dismiss Question")
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
                #if os(macOS)
                Text(q.header)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.tertiary)
                #else
                Text(q.header.uppercased())
                    .font(.caption2.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(Theme.tertiary)
                #endif
            }
            Text(q.question)
                .font(.ui(size: 17, weight: .semibold))
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
                            if sent { SendingSpinner() }
                            Text(questions.count == 1 ? "Send answer" : "Send answers")
                        }
                        .font(.ui(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .foregroundStyle(.black)
                        .background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .opacity(draft.count == questions.count ? 1 : 0.4)
                    }
                    .buttonStyle(.pressable)
                    .sending(sent)
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
                    .font(.ui(size: 19))
                    .foregroundStyle(picked ? .white : Theme.tertiary)
                    .frame(width: 22, height: 22)
            } else {
                LetterBadge(index: index, fill: picked ? .white : .white.opacity(0.08), ink: picked ? .black : Theme.tertiary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.ui(size: 16))
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
        .frame(minHeight: HitTarget.minHeight)
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
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(tone == .error ? "Error: " + text : text)
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

/// The only view that reads the live text, so a delta redraws this and nothing else. What runs is the status line's.
struct StreamingTail: View {
    let live: LiveText

    var body: some View {
        if live.itemId != nil, !live.text.isEmpty {
            Text(live.text)
                .font(.ui(size: 16))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 14)
                // A label of the growing text would be read again on every delta. The reply reads in full once it lands.
                .accessibilityLabel("Claude is replying")
        }
    }
}
