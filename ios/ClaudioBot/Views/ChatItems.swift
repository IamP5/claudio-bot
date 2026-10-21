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
                PermissionCardView(messageId: id, card: card) { .decide(botId: bot.id, messageId: id, choice: $0) }
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
        TimelineView(.deadline(card.expiresAt)) { _ in
            Settling(card.answer(at: .now)) { answer in
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

/// A tool call held for approval: the exact call, what Always would cover, and the four choices. A bot's chat and a
/// session's thread show the same card; each says which frame a choice sends.
struct PermissionCardView: View {
    let messageId: MessageID
    let card: PermissionCard
    let decision: (PermissionChoice) -> ClientMessage
    /// In a session's thread the card spans the column, like the cards around it.
    var fillsColumn = false

    var body: some View {
        TimelineView(.deadline(card.expiresAt)) { _ in
            Settling(card.answer(at: .now)) { answer in
                PermissionCardBody(messageId: messageId, card: card, answer: answer, decision: decision, fillsColumn: fillsColumn)
            }
        }
    }
}

private struct PermissionCardBody: View {
    let messageId: MessageID
    let card: PermissionCard
    let answer: PermissionAnswer?
    let decision: (PermissionChoice) -> ClientMessage
    let fillsColumn: Bool

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client

    private var sent: PermissionChoice? { store.pendingDecisions[messageId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .font(.ui(size: 14, weight: .semibold))
                    .foregroundStyle(answer == nil ? Theme.attention : Theme.tertiary)
                Text(card.label)
                    .font(.ui(size: 17, weight: .semibold))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .agent(_, let title) = card.from {
                Label(title, systemImage: "gearshape.fill")
                    .font(.ui(size: 13))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(card.tool)
                    .font(.ui(size: 12, weight: .medium))
                    .foregroundStyle(Theme.tertiary)
                Text(card.detail)
                    .font(.ui(size: 15, design: .monospaced))
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
                switch answer {
                case nil:
                    VStack(alignment: .leading, spacing: 12) {
                        buttons
                        Text("Always allows \(card.always).")
                            .font(.ui(size: 13))
                            .foregroundStyle(Theme.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                        ExpiryLine(expiresAt: card.expiresAt)
                    }
                case .chose(let choice):
                    HStack(spacing: 8) {
                        Image(systemName: choice.allows ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(choice.allows ? AvatarColor.green.color : Theme.danger)
                        Text(choice.outcome)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.secondary)
                    }
                    .accessibilityElement(children: .combine)
                case .expired:
                    ClosedLine(text: "Expired. It did not run.")
                case .stopped, .closed:
                    ClosedLine(text: "Closed. It did not run.")
                }
            }
            .transition(Card.swap)
        }
        .padding(16)
        .transcriptCard(fillsColumn: fillsColumn)
        .sensoryFeedback(trigger: sent) { _, choice in
            choice.map { $0.allows ? .success : .warning }
        }
    }

    #if os(macOS)
    /// One row of standard buttons, refusals on the left and Allow Once as the prominent default on the right. Return
    /// is left to the composer: a stray Return should send a message, never run a held tool call.
    private var buttons: some View {
        HStack(spacing: 8) {
            choiceButton(.deny)
            choiceButton(.never)
            Spacer(minLength: 8)
            choiceButton(.always)
            choiceButton(.once)
        }
        .controlSize(.large)
        .disabled(sent != nil)
    }

    @ViewBuilder
    private func choiceButton(_ choice: PermissionChoice) -> some View {
        let button = Button {
            client.send(decision(choice))
        } label: {
            HStack(spacing: 6) {
                if sent == choice { ProgressView().controlSize(.mini) }
                Text(choice.button)
            }
        }
        switch choice {
        case .once:
            button.buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black)
        case .always:
            button.buttonStyle(.bordered)
        case .deny, .never:
            button.buttonStyle(.bordered).foregroundStyle(Theme.danger)
        }
    }
    #else
    private var buttons: some View {
        Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            GridRow {
                choiceButton(.once)
                choiceButton(.always)
            }
            GridRow {
                choiceButton(.deny)
                choiceButton(.never)
            }
        }
        .disabled(sent != nil)
    }

    private func choiceButton(_ choice: PermissionChoice) -> some View {
        Button {
            client.send(decision(choice))
        } label: {
            HStack(spacing: 6) {
                if sent == choice { ProgressView().controlSize(.mini) }
                Text(choice.button)
            }
            .font(.ui(size: 15, weight: .semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .foregroundStyle(foreground(choice))
            .background(background(choice), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(sent == nil || sent == choice ? 1 : 0.5)
        }
        .buttonStyle(.pressable)
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

extension TimelineSchedule where Self == ExplicitTimelineSchedule<[Date]> {
    /// Redraws now and once more at the deadline, so a card closes on time without a bridge frame.
    /// The past entry matters: before its first entry a timeline reports that entry's date, not the clock.
    static func deadline(_ date: Date?) -> Self {
        .explicit([.distantPast] + (date.map { [$0] } ?? []))
    }
}

/// "Expires in 1 hr, 40 min" under an open card.
private struct ExpiryLine: View {
    let expiresAt: Date

    var body: some View {
        Text("Expires in \(Text(expiresAt, style: .relative))")
            .font(.ui(size: 13))
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
