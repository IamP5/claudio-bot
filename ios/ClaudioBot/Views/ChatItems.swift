import OSLog
import SwiftUI

struct ChatRowView: View {
    let row: ChatRow
    let bot: Bot
    let onPeer: (Peer) -> Void
    /// An exchange line: with a bot, it opens what the two said once the bridge serves exchanges.
    var onExchange: ((Peer) -> Void)?
    /// In a group, this message starts a run from one member, so it shows the member's avatar and name.
    var opensRun = false

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        switch row {
        case .separator(let date):
            TimeSeparator(date: date)
        case .message(let message):
            switch message {
            case let .user(_, _, text, attachments, _, mentions):
                UserBubble(text: text, attachments: attachments, color: bot.avatar.color, mentions: mentions)
            case let .bot(_, _, text, from?):
                MemberBubble(
                    sender: store.bots[from], text: text, members: bot.members.compactMap { store.bots[$0] }, opensRun: opensRun
                ) { router.open($0) }
            case let .bot(_, _, text, nil):
                BotBubble(text: text)
            case let .question(id, _, card):
                QuestionCardView(botId: bot.id, messageId: id, card: card, color: bot.avatar.color)
            case let .permission(id, _, card):
                PermissionCardView(messageId: id, card: card, scope: .chat(card, bot: bot.name)) {
                    .decide(botId: bot.id, messageId: id, choice: $0)
                }
            case let .exchange(_, _, peer, sent, received):
                EventLineView(segments: EventLine.exchange(peer: peer, sent: sent, received: received), onPeer: onExchange ?? onPeer)
            case let .note(_, _, text, refs):
                EventLineView(segments: EventLine.note(text, refs: refs), onPeer: onPeer)
            case .unknown:
                EmptyView()
            }
        }
    }
}

/// "Today 1:15 PM" between runs of messages.
struct TimeSeparator: View {
    let date: Date

    var body: some View {
        Text(TimeLabel.separator(date))
            .font(.ui(size: 13))
            .foregroundStyle(Theme.tertiary)
            .frame(maxWidth: .infinity)
            #if os(macOS)
            // Grok Bot sets a time 28 above and 20 below; the list's own gaps are 22 and 10.
            .padding(.top, 6)
            .padding(.bottom, 10)
            #endif
    }
}

/// Bubble metrics. The Mac ones are Grok Bot's: radius 18, 12 by 7 padding, 22pt lines, at most 560 wide.
enum Bubble {
    #if os(macOS)
    static let radius: CGFloat = 18
    static let padding = EdgeInsets(top: 7, leading: 12, bottom: 7, trailing: 12)
    static let maxWidth: CGFloat = 560
    /// The least room a bot's bubble leaves on its far side.
    static let botInset: CGFloat = 32
    static let userInset: CGFloat = 32
    /// A Mac bubble hugs short text, as Grok Bot's do.
    static let fillsWidth = false
    #else
    static let radius: CGFloat = 20
    static let padding = EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14)
    static let maxWidth: CGFloat = .infinity
    static let botInset: CGFloat = 36
    static let userInset: CGFloat = 56
    static let fillsWidth = true
    #endif

    static var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }
}

extension View {
    /// Message text in a bubble. On a Mac, 22pt lines as in Grok Bot.
    func bubbleText() -> some View {
        #if os(macOS)
        lineHeight(.exact(points: 22))
        #else
        self
        #endif
    }

    /// Caps a bubble's row at the widest a bubble gets and pins it to one side of the column.
    func bubbleRow(_ alignment: Alignment) -> some View {
        frame(maxWidth: Bubble.maxWidth, alignment: alignment)
            .frame(maxWidth: .infinity, alignment: alignment)
    }
}

struct BotBubble: View {
    let text: String
    /// The group's members, whose "@name" in the text reads bold in their color.
    var members: [Bot] = []

    var body: some View {
        HStack(spacing: 0) {
            MarkdownText(text: text, members: members, fillsWidth: Bubble.fillsWidth)
                .font(.ui(size: 17))
                .bubbleText()
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Bubble.padding)
                .background(Theme.bubble, in: Bubble.shape)
            Spacer(minLength: Bubble.botInset)
        }
        .bubbleRow(.leading)
    }
}

struct UserBubble: View {
    let text: String
    let attachments: [Attachment]
    let color: AvatarColor
    var mentions: [Mention] = []

    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    /// Each "@name" bold in its bot's color, read from the bot as it is now. A tap on a bot's opens its chat.
    private var attributed: AttributedString {
        var out = AttributedString()
        for segment in MentionText.segments(text, mentions: mentions) {
            switch segment {
            case .text(let s):
                out += MarkdownText.inline(s)
            case let .mention(mention, label):
                var run = AttributedString(label)
                MentionText.Style.filledBubble.mark(&run, color: color.onAccent, bubbleText: color.onAccent)
                if case .bot(let id, _) = mention {
                    run.link = URL(string: "claudiobot://bot/\(id.rawValue)")
                }
                out += run
            }
        }
        return out
    }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: Bubble.userInset)
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(attachments, id: \.path) { attachment in
                    Label(attachment.name, systemImage: attachment.mime.hasPrefix("image/") ? "photo" : "doc")
                        .font(.subheadline)
                        .lineLimit(1)
                }
                if !text.isEmpty {
                    Text(attributed)
                        .font(.ui(size: 17))
                        .bubbleText()
                        .tint(color.onAccent)
                }
            }
            .foregroundStyle(color.onAccent)
            .padding(Bubble.padding)
            .background(color.accent, in: Bubble.shape)
        }
        .bubbleRow(.trailing)
        .environment(\.openURL, OpenURLAction { url in
            guard case .bot(let id, _)? = DeepLink(url: url) else { return .systemAction }
            if store.bots[id] != nil { router.open(id) }
            return .handled
        })
    }
}

extension MentionText.Style {
    /// Bold, then in the bubble's text color over a faint tint of it, or bare in the mentioned bot's color.
    func mark(_ run: inout AttributedString, color: Color, bubbleText: Color) {
        run.inlinePresentationIntent = .stronglyEmphasized
        run.foregroundColor = usesBubbleTextColor ? bubbleText : color
        if tintOpacity > 0 { run.backgroundColor = bubbleText.opacity(tintOpacity) }
    }
}

/// A question with lettered options. Once answered it dims and keeps only the chosen option.
struct QuestionCardView: View {
    let botId: BotID
    let messageId: MessageID
    let card: QuestionCard
    let color: AvatarColor

    var body: some View {
        AtDeadline(card.expiresAt) { now in
            Settling(card.answer(at: now)) { answer in
                QuestionCardBody(botId: botId, messageId: messageId, card: card, answer: answer, color: color)
            }
        }
    }
}

/// Takes a card's new answer inside an animation, so the transcript around the card resizes with it instead of
/// jumping a frame ahead while the card's own content fades.
private struct Settling<Value: Equatable, Content: View>: View {
    let value: Value
    let content: (Value) -> Content

    @State private var shown: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ value: Value, @ViewBuilder content: @escaping (Value) -> Content) {
        self.value = value
        self.content = content
        _shown = State(initialValue: value)
    }

    var body: some View {
        content(shown)
            .onChange(of: value) { _, new in
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { shown = new }
            }
    }
}

/// A transcript card's shape and width.
enum Card {
    #if os(macOS)
    static let radius: CGFloat = 18
    #else
    static let radius: CGFloat = 22
    #endif

    static var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }

    /// What an answered card swaps: the old part fades out quickly and the new one fades in after it, so the two
    /// never draw over each other.
    static var swap: AnyTransition {
        .asymmetric(
            insertion: .opacity.animation(.easeOut(duration: 0.15).delay(0.1)),
            removal: .opacity.animation(.easeOut(duration: 0.1))
        )
    }
}

extension View {
    /// A card in a transcript. On a Mac it is as wide as the column in a session's thread and at most Grok Bot's
    /// 560 in a bot's chat. Clipped, so what it drops while it shrinks never draws past its edge.
    func transcriptCard(fillsColumn: Bool = false) -> some View {
        background(Theme.card, in: Card.shape)
            .clipShape(Card.shape)
            #if os(macOS)
            .frame(maxWidth: fillsColumn ? .infinity : Bubble.maxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            #else
            .padding(.trailing, 36)
            #endif
    }
}

private struct QuestionCardBody: View {
    let botId: BotID
    let messageId: MessageID
    let card: QuestionCard
    let answer: Answer?
    let color: AvatarColor

    @Environment(BridgeClient.self) private var client
    @State private var taps = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Text(card.question)
                    .font(.ui(size: 17, weight: .semibold))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if answer == nil {
                    Button {
                        client.send(.dismiss(botId: botId, messageId: messageId))
                    } label: {
                        Image(systemName: "xmark")
                            .font(.ui(size: 15, weight: .medium))
                            .foregroundStyle(Theme.tertiary)
                            .frame(width: 28, height: 28)
                            // A plain button takes clicks only on drawn pixels, which left the glyph's 11pt.
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss Question")
                    .accessibilityLabel("Dismiss question")
                    .transition(Card.swap)
                }
            }
            Group {
                switch answer {
                case nil:
                    options
                case .option(let index) where card.options.indices.contains(index):
                    OptionRow(index: index, text: card.options[index], chosen: color)
                        .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                case .expired:
                    ClosedLine(text: "Expired. Nobody answered in time.")
                default:
                    ClosedLine(text: "Dismissed")
                }
            }
            .transition(Card.swap)
        }
        .padding(16)
        .transcriptCard()
        .sensoryFeedback(.selection, trigger: taps)
    }

    private var options: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(spacing: 0) {
                ForEach(Array(card.options.enumerated()), id: \.offset) { index, option in
                    if index > 0 { Rectangle().fill(Theme.hairline).frame(height: 1).padding(.leading, 48) }
                    Button {
                        taps += 1
                        client.send(.answer(botId: botId, messageId: messageId, option: index))
                    } label: {
                        OptionRow(index: index, text: option)
                    }
                    .buttonStyle(.pressable)
                }
            }
            .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            if let expiresAt = card.expiresAt {
                ExpiryLine(expiresAt: expiresAt)
            }
        }
    }
}

/// A tool call held for approval in a bot's chat: the exact call, what Always would cover, and the four choices.
struct PermissionCardView: View {
    let messageId: MessageID
    let card: PermissionCard
    let scope: ApprovalScope
    let decision: (PermissionChoice) -> ClientMessage

    @AccessibilityFocusState private var focus: CardFocus?
    @State private var sentHere = false

    var body: some View {
        AtDeadline(card.expiresAt) { now in
            let answer = card.answer(at: now)
            Settling(answer) { answer in
                PermissionCardBody(
                    messageId: messageId, card: card, title: card.label, scope: scope, answer: answer, decision: decision,
                    focus: $focus, onSend: { sentHere = true }
                )
            }
            .announcesClose(card: card, answer: answer, here: sentHere, focus: $focus)
        }
    }
}

/// The work row that shows the step a session's card holds back, and that step.
struct HeldStep: Equatable, Sendable {
    let row: ItemID
    let step: ToolStep

    static func find(_ stepId: String?, in items: [SessionItem]) -> HeldStep? {
        guard let stepId else { return nil }
        for case let .work(row, _, steps) in items.reversed() {
            if let step = steps.first(where: { $0.id == stepId }) { return HeldStep(row: row, step: step) }
        }
        return nil
    }
}

extension EnvironmentValues {
    /// Scrolls a session's thread to a step and marks it for a moment. nil outside a thread.
    @Entry var revealStep: (@MainActor @Sendable (HeldStep) -> Void)? = nil
    /// The step id "Show the step" marked. Its work run opens and tints it.
    @Entry var revealedStep: String? = nil
}

/// A permission card in a session's thread. It names the subagent that asked and links to the step it holds back.
/// Once closed it folds to one line, so answered cards never push the running work off screen. A tap opens the whole
/// card in a sheet: the thread keeps its bottom still, so a card opened in place would grow upward under the top bar.
struct SessionPermissionCard: View {
    let sessionId: SessionID
    let permission: SessionPermission
    let model: ThreadModel

    @State private var sheet = false
    /// The step "Show the step" asked for from the sheet, revealed once the sheet is gone.
    @State private var pendingReveal: HeldStep?
    @Environment(\.revealStep) private var revealStep
    @AccessibilityFocusState private var focus: CardFocus?
    @State private var sentHere = false

    var body: some View {
        let card = permission.card
        let held = HeldStep.find(permission.stepId, in: model.items)
        AtDeadline(card.expiresAt) { now in
            let answer = card.answer(at: now)
            Settling(answer) { answer in
                if let answer {
                    ClosedApprovalRow(permission: permission, outcome: answer.outcome(step: held?.step), focus: $focus) { sheet = true }
                } else {
                    full(answer: nil, held: held)
                }
            }
            .announcesClose(card: card, answer: answer, step: held?.step, here: sentHere, focus: $focus)
        }
        .sheet(isPresented: $sheet, onDismiss: {
            if let pendingReveal { revealStep?(pendingReveal) }
            pendingReveal = nil
        }) {
            ScrollView {
                full(answer: card.answer, held: held, close: { sheet = false }, reveal: revealStep.map { _ in
                    { held in
                        pendingReveal = held
                        sheet = false
                    }
                })
                .padding(16)
            }
            .presentationDragIndicator(.visible)
        }
    }

    /// reveal: what "Show the step" does. In the thread it scrolls there; from the sheet it closes the sheet first.
    private func full(
        answer: PermissionAnswer?, held: HeldStep?, close: (() -> Void)? = nil, reveal: ((HeldStep) -> Void)? = nil
    ) -> some View {
        let reveal = reveal ?? revealStep
        return PermissionCardBody(
            messageId: permission.cardId, card: permission.card, title: permission.title, scope: .session, answer: answer,
            decision: { .sessionDecide(sessionId: sessionId, cardId: permission.cardId, choice: $0) },
            focus: $focus, onSend: { sentHere = true },
            step: held?.step, fillsColumn: true,
            reveal: held.flatMap { held in reveal.map { reveal in { reveal(held) } } },
            close: close
        )
    }
}

/// An answered card folded to its outcome and command: "sleeper two · Allowed once" over "perl -e 'sleep 30'", or
/// "Bash · Allowed once" when the main thread asked. A tap opens the whole card in a sheet. At the accessibility sizes
/// the command and the chevron wait for that sheet, and the text stops growing at the second accessibility size: past
/// that, three folded cards alone fill the screen and push the running work off it.
private struct ClosedApprovalRow: View {
    let permission: SessionPermission
    let outcome: PermissionOutcome
    let focus: AccessibilityFocusState<CardFocus?>.Binding
    let open: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                glyph
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(permission.asker) · \(outcome.short)")
                        .foregroundStyle(Theme.secondary)
                        .lineLimit(3)
                    if !typeSize.isAccessibilitySize {
                        Text(permission.card.detail)
                            .font(.ui(.footnote, design: .monospaced))
                            .foregroundStyle(Theme.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !typeSize.isAccessibilitySize { chevron }
            }
            .font(.ui(.subheadline))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: HitTarget.minHeight)
            .transcriptCard(fillsColumn: true)
        }
        .buttonStyle(.pressable)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityLabel([permission.title, outcome.text, permission.card.detail].map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 }.joined(separator: ". "))
        .accessibilityHint("Shows the whole request")
        .accessibilityFocused(focus, equals: .outcome)
    }

    private var glyph: some View {
        Image(systemName: outcome.glyph).foregroundStyle(outcome.color).accessibilityHidden(true)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.ui(.footnote, weight: .semibold))
            .foregroundStyle(Theme.tertiary)
            .accessibilityHidden(true)
    }
}

extension PermissionOutcome {
    var color: Color {
        switch tone {
        case .allowed: AvatarColor.green.color
        case .refused, .failed: Theme.danger
        case .ended: Theme.tertiary
        }
    }
}

/// Where VoiceOver sits on a card: one of its choices, or the line that says how it closed.
enum CardFocus: Hashable {
    case choice(PermissionChoice)
    case outcome
}

private let a11yLog = Logger(subsystem: "dev.claudiobot.app", category: "a11y")

extension View {
    /// Speaks an open card closing, whatever closed it: this phone's choice once the bridge confirms it, another
    /// device, Stop, or its deadline passing. A VoiceOver user on one of its choices is moved to the outcome, since the
    /// choices are gone. here: this phone sent a choice for the card.
    func announcesClose(
        card: PermissionCard, answer: PermissionAnswer?, step: ToolStep? = nil, here: Bool,
        focus: AccessibilityFocusState<CardFocus?>.Binding
    ) -> some View {
        modifier(CloseAnnouncer(card: card, answer: answer, step: step, here: here, focus: focus))
    }
}

private struct CloseAnnouncer: ViewModifier {
    let card: PermissionCard
    let answer: PermissionAnswer?
    let step: ToolStep?
    let here: Bool
    let focus: AccessibilityFocusState<CardFocus?>.Binding

    @State private var onChoice = false

    func body(content: Content) -> some View {
        content
            .onChange(of: focus.wrappedValue) { _, now in
                if answer == nil { onChoice = if case .choice? = now { true } else { false } }
            }
            .onChange(of: answer) { old, new in
                guard old == nil, let new else { return }
                let said = new.announcement(card: card, step: step, here: here)
                var text = AttributedString(said)
                text.accessibilitySpeechAnnouncementPriority = .high
                AccessibilityNotification.Announcement(text).post()
                a11yLog.debug("announced \(said, privacy: .public)")
                guard onChoice else { return }
                Task {
                    // The outcome fades in after the choices fade out (Card.swap); focus set before it exists is lost.
                    try? await Task.sleep(for: .milliseconds(400))
                    focus.wrappedValue = .outcome
                }
            }
    }
}

private struct PermissionCardBody: View {
    let messageId: MessageID
    let card: PermissionCard
    let title: String
    let scope: ApprovalScope
    let answer: PermissionAnswer?
    let decision: (PermissionChoice) -> ClientMessage
    let focus: AccessibilityFocusState<CardFocus?>.Binding
    let onSend: () -> Void
    var step: ToolStep?
    var fillsColumn = false
    var reveal: (() -> Void)?
    /// Set when the card shows in a sheet.
    var close: (() -> Void)?

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.dynamicTypeSize) private var typeSize

    private var sent: PermissionChoice? { store.pendingDecisions[messageId] }

    private func send(_ choice: PermissionChoice) {
        onSend()
        client.send(decision(choice))
        AccessibilityNotification.Announcement("\(choice.button), sending").post()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .font(.ui(.subheadline, weight: .semibold))
                    .foregroundStyle(answer == nil ? Theme.attention : Theme.tertiary)
                Text(title)
                    .font(.ui(.headline, weight: .semibold))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                if let close {
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.ui(.footnote, weight: .semibold))
                            .foregroundStyle(Theme.tertiary)
                            .frame(minWidth: HitTarget.minHeight, minHeight: HitTarget.minHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
                }
            }
            if case .agent(_, let title) = card.from {
                Label(title, systemImage: "gearshape.fill")
                    .font(.ui(.footnote))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
            }
            if let reveal {
                Button(action: reveal) {
                    Label("Show the step", systemImage: "arrow.up.forward")
                        .font(.ui(.footnote, weight: .semibold))
                        .foregroundStyle(Theme.link)
                        .frame(minHeight: HitTarget.minHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Scrolls to where it runs in the thread")
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(card.tool)
                    .font(.ui(.caption, weight: .medium))
                    .foregroundStyle(Theme.tertiary)
                Text(card.detail)
                    .font(.ui(.subheadline, design: .monospaced))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(card.tool): \(card.detail)")

            Group {
                if let answer {
                    let outcome = answer.outcome(step: step)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: outcome.glyph)
                            .foregroundStyle(outcome.color)
                        Text(outcome.text)
                            .font(.ui(.subheadline, weight: outcome.tone == .ended ? .regular : .semibold))
                            .foregroundStyle(outcome.tone == .ended ? Theme.tertiary : Theme.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityFocused(focus, equals: .outcome)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        if let scopeLine = card.scopeLine(scope) {
                            Text(scopeLine)
                                .font(.ui(.footnote))
                                .foregroundStyle(Theme.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        buttons
                        ExpiryLine(expiresAt: card.expiresAt)
                    }
                }
            }
            .transition(Card.swap)
        }
        .padding(16)
        .transcriptCard(fillsColumn: fillsColumn)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title). \(card.commandHead)")
        .sensoryFeedback(trigger: sent) { _, choice in
            choice.map { $0.allows ? .success : .warning }
        }
    }

    /// Names the tool and command each choice decides, so a VoiceOver user with several cards open can tell them
    /// apart, and keeps the visible word for Voice Control.
    private func spoken(_ button: some View, _ choice: PermissionChoice) -> some View {
        button
            .accessibilityLabel(card.spokenLabel(choice))
            .accessibilityInputLabels([choice.button])
            .accessibilityHint(choice.consequence(scope))
            .accessibilityFocused(focus, equals: .choice(choice))
    }

    #if os(macOS)
    /// One row of standard buttons, refusals on the left and Allow Once as the prominent default on the right. Return
    /// is left to the composer: a stray Return should send a message, never run a held tool call. Each button's
    /// consequence is its tooltip.
    private var buttons: some View {
        HStack(spacing: 8) {
            choiceButton(.deny)
            choiceButton(.never)
            Spacer(minLength: 8)
            if card.choices.contains(.always) { choiceButton(.always) }
            choiceButton(.once)
        }
        .controlSize(.large)
        .disabled(sent != nil)
    }

    @ViewBuilder
    private func choiceButton(_ choice: PermissionChoice) -> some View {
        let button = Button {
            send(choice)
        } label: {
            HStack(spacing: 6) {
                if sent == choice { SendingSpinner() }
                Text(choice.button)
            }
        }
        .sending(sent == choice)
        .help(choice.consequence(scope))
        switch choice {
        case .once:
            spoken(button.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black), choice)
        case .always:
            spoken(button.buttonStyle(.bordered), choice)
        case .deny, .never:
            spoken(button.buttonStyle(.bordered).foregroundStyle(Theme.danger), choice)
        }
    }
    #else
    /// The choices that run the call above the ones that do not, two to a row, or one per row once the words no
    /// longer fit half the card. Each choice's consequence sits under its button.
    @ViewBuilder
    private var buttons: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(card.choices, id: \.self) { choice($0) }
            }
            .disabled(sent != nil)
        } else {
            let rows = [card.choices.filter(\.allows), card.choices.filter { !$0.allows }]
            Grid(alignment: .topLeading, horizontalSpacing: 8, verticalSpacing: 12) {
                ForEach(rows, id: \.self) { row in
                    GridRow {
                        ForEach(row, id: \.self) { choice($0).gridCellColumns(row.count == 1 ? 2 : 1) }
                    }
                }
            }
            .disabled(sent != nil)
        }
    }

    private func choice(_ choice: PermissionChoice) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            spoken(choiceButton(choice), choice)
            // Capped like a folded card's line: at the largest sizes four of them would take two screens of their own.
            Text(choice.consequence(scope))
                .font(.ui(.caption))
                .foregroundStyle(Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                .accessibilityHidden(true)
        }
    }

    private func choiceButton(_ choice: PermissionChoice) -> some View {
        Button {
            send(choice)
        } label: {
            HStack(spacing: 6) {
                if sent == choice { SendingSpinner() }
                Text(choice.button)
            }
            .font(.ui(.subheadline, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .foregroundStyle(foreground(choice))
            .background(background(choice), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(sent == nil || sent == choice ? 1 : 0.5)
        }
        .buttonStyle(.pressable)
        .sending(sent == choice)
    }

    private func foreground(_ choice: PermissionChoice) -> Color {
        switch choice {
        case .once: .black
        case .always: .white
        case .deny, .never: Theme.danger
        }
    }

    private func background(_ choice: PermissionChoice) -> Color {
        choice == .once ? .white : Theme.inset
    }
    #endif
}

/// The spinner on a tapped choice. The button's value says "Sending", so the spinner itself stays silent.
struct SendingSpinner: View {
    var body: some View {
        ProgressView().controlSize(.mini).accessibilityHidden(true)
    }
}

extension View {
    func sending(_ isSending: Bool) -> some View {
        accessibilityValue(isSending ? "Sending" : "")
    }
}

extension TimelineSchedule where Self == ExplicitTimelineSchedule<[Date]> {
    /// Redraws now and once more at the deadline, so a card closes on time without a bridge frame.
    /// The past entry matters: before its first entry a timeline reports that entry's date, not the clock.
    static func deadline(_ date: Date?) -> Self {
        .explicit([.distantPast] + (date.map { [$0] } ?? []))
    }
}

/// Draws its content with the current time, and once more when the deadline passes, so a card closes on time without a
/// bridge frame. A TimelineView on `.deadline` stayed on its first entry while the thread sat still, so an open card
/// never expired on screen.
struct AtDeadline<Content: View>: View {
    let deadline: Date?
    let content: (Date) -> Content

    @State private var passed: Date?

    init(_ deadline: Date?, @ViewBuilder content: @escaping (Date) -> Content) {
        self.deadline = deadline
        self.content = content
    }

    var body: some View {
        content(max(passed ?? .distantPast, .now))
            .task(id: deadline) {
                guard let deadline else { return }
                let wait = deadline.timeIntervalSinceNow
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                if !Task.isCancelled { passed = max(deadline, .now) }
            }
    }
}

/// "Expires in 1 hr, 40 min" under an open card.
private struct ExpiryLine: View {
    let expiresAt: Date

    var body: some View {
        Text("Expires in \(Text(expiresAt, style: .relative))")
            .font(.ui(.footnote))
            .foregroundStyle(Theme.tertiary)
    }
}

private struct ClosedLine: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Theme.tertiary)
    }
}

private struct OptionRow: View {
    let index: Int
    let text: String
    var chosen: AvatarColor?

    var body: some View {
        HStack(spacing: 12) {
            if let chosen {
                LetterBadge(index: index, fill: chosen.accent, ink: chosen.onAccent)
            } else {
                LetterBadge(index: index)
            }
            Text(text)
                .font(.ui(size: 17))
                .foregroundStyle(chosen == nil ? .white : Theme.secondary)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if chosen != nil {
                Image(systemName: "checkmark").font(.ui(size: 14, weight: .semibold)).foregroundStyle(AvatarColor.green.color)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A centered gray system line. Tapping it opens the first thing it names.
struct EventLineView: View {
    let segments: [EventSegment]
    let onPeer: (Peer) -> Void

    private var target: Peer? {
        segments.lazy.compactMap { if case .chip(let peer) = $0 { peer } else { nil } }.first
    }

    var body: some View {
        Button {
            if let target { onPeer(target) }
        } label: {
            segments.reduce(Text(verbatim: "")) { line, segment in
                switch segment {
                case .text(let s): Text("\(line)\(Text(s))")
                case .chip(let peer): Text("\(line)\(Self.chip(peer))")
                }
            }
            .font(.ui(size: 13))
            .foregroundStyle(Theme.tertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
        }
        .buttonStyle(.plain)
        .disabled(target == nil)
    }

    private static func chip(_ peer: Peer) -> Text {
        let light = Color(hex: 0xC9C9CC)
        switch peer {
        case let .bot(_, name, avatar):
            return Text("\(AvatarSnapshot.image(avatar)) \(Text(name).foregroundStyle(avatar.color.accent).fontWeight(.semibold))")
        case .agent(_, let title):
            return Text("\(Image(systemName: "gearshape.fill")) \(title)").foregroundStyle(light)
        case .routine(_, let name):
            return Text("\(Image(systemName: "timer")) \(name)").foregroundStyle(light)
        case .unknown:
            return Text(peer.label).foregroundStyle(light)
        }
    }
}

/// Small avatars drawn once into images, so they can sit inline in a line of text.
@MainActor
enum AvatarSnapshot {
    private static var cache: [Avatar: Image] = [:]

    static func image(_ avatar: Avatar, size: CGFloat = 15) -> Image {
        if let image = cache[avatar] { return image }
        let renderer = ImageRenderer(content: AvatarView(avatar: avatar, size: size))
        renderer.scale = 3
        let image = renderer.platformImage ?? Image(systemName: "circle.fill")
        cache[avatar] = image
        return image
    }
}
