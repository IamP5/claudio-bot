import SwiftUI

struct ChatRowView: View {
    let row: ChatRow
    let bot: Bot
    let onPeer: (Peer) -> Void

    var body: some View {
        switch row {
        case .separator(let date):
            Text(TimeLabel.separator(date))
                .font(.system(size: 13))
                .foregroundStyle(Theme.tertiary)
                .frame(maxWidth: .infinity)
        case .message(let message):
            switch message {
            case let .user(_, _, text, attachments, _):
                UserBubble(text: text, attachments: attachments, color: bot.avatar.color)
            case let .bot(_, _, text):
                BotBubble(text: text)
            case let .question(id, _, card):
                QuestionCardView(botId: bot.id, messageId: id, card: card, color: bot.avatar.color)
            case let .permission(id, _, card):
                PermissionCardView(botId: bot.id, messageId: id, card: card)
            case let .exchange(_, _, peer, sent, received):
                EventLineView(segments: EventLine.exchange(peer: peer, sent: sent, received: received), onPeer: onPeer)
            case let .note(_, _, text, refs):
                EventLineView(segments: EventLine.note(text, refs: refs), onPeer: onPeer)
            case .unknown:
                EmptyView()
            }
        }
    }
}

struct BotBubble: View {
    let text: String

    var body: some View {
        HStack(spacing: 0) {
            MarkdownText(text: text)
                .font(.system(size: 17))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Spacer(minLength: 36)
        }
    }
}

struct UserBubble: View {
    let text: String
    let attachments: [Attachment]
    let color: AvatarColor

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(attachments, id: \.path) { attachment in
                    Label(attachment.name, systemImage: attachment.mime.hasPrefix("image/") ? "photo" : "doc")
                        .font(.subheadline)
                        .lineLimit(1)
                }
                if !text.isEmpty {
                    Text(MarkdownText.inline(text))
                        .font(.system(size: 17))
                        .tint(color.onAccent)
                }
            }
            .foregroundStyle(color.onAccent)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(color.accent, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
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
            QuestionCardBody(botId: botId, messageId: messageId, card: card, answer: card.answer(at: .now), color: color)
        }
    }
}

private struct QuestionCardBody: View {
    let botId: BotID
    let messageId: MessageID
    let card: QuestionCard
    let answer: Answer?
    let color: AvatarColor

    @Environment(BridgeClient.self) private var client
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var taps = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Text(card.question)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if answer == nil {
                    Button {
                        client.send(.dismiss(botId: botId, messageId: messageId))
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.tertiary)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss question")
                }
            }
            switch answer {
            case nil:
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
            case .option(let index) where card.options.indices.contains(index):
                OptionRow(index: index, text: card.options[index], chosen: color)
                    .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            case .expired:
                ClosedLine(text: "Expired. Nobody answered in time.")
            default:
                ClosedLine(text: "Dismissed")
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.trailing, 20)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: answer)
        .sensoryFeedback(.selection, trigger: taps)
    }
}

/// A tool call held for approval: the exact call, what Always would cover, and the four choices.
struct PermissionCardView: View {
    let botId: BotID
    let messageId: MessageID
    let card: PermissionCard

    var body: some View {
        TimelineView(.deadline(card.expiresAt)) { _ in
            PermissionCardBody(botId: botId, messageId: messageId, card: card, answer: card.answer(at: .now))
        }
    }
}

private struct PermissionCardBody: View {
    let botId: BotID
    let messageId: MessageID
    let card: PermissionCard
    let answer: PermissionAnswer?

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var sent: PermissionChoice? { store.pendingDecisions[messageId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(answer == nil ? Theme.attention : Theme.tertiary)
                Text(card.label)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .agent(_, let title) = card.from {
                Label(title, systemImage: "gearshape.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(card.tool)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.tertiary)
                Text(card.detail)
                    .font(.system(size: 15, design: .monospaced))
                    .foregroundStyle(answer == nil ? .white : Theme.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(Theme.inset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(card.tool): \(card.detail)")

            switch answer {
            case nil:
                buttons
                Text("Always allows \(card.always).")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                ExpiryLine(expiresAt: card.expiresAt)
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
            case .closed:
                ClosedLine(text: "Closed. It did not run.")
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.trailing, 20)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: answer)
        .sensoryFeedback(trigger: sent) { _, choice in
            choice.map { $0.allows ? .success : .warning }
        }
    }

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
            client.send(.decide(botId: botId, messageId: messageId, choice: choice))
        } label: {
            HStack(spacing: 6) {
                if sent == choice { ProgressView().controlSize(.mini) }
                Text(choice.button)
            }
            .font(.system(size: 15, weight: .semibold))
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
            .font(.system(size: 13))
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
                .font(.system(size: 17))
                .foregroundStyle(chosen == nil ? .white : Theme.secondary)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if chosen != nil {
                Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(AvatarColor.green.color)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
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
            .font(.system(size: 13))
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
        let image = renderer.uiImage.map { Image(uiImage: $0) } ?? Image(systemName: "circle.fill")
        cache[avatar] = image
        return image
    }
}
