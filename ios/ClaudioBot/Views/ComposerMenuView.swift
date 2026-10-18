import SwiftUI

/// The "@" and "/" lists above the composer. The first row is what Return picks.
struct ComposerMenuView: View {
    let menu: ComposerMenu
    let onMention: (MentionCandidate) -> Void
    let onCommand: (Command) -> Void

    private var count: Int {
        switch menu {
        case .mentions(_, let candidates): candidates.count
        case .commands(_, let commands): commands.count
        }
    }

    var body: some View {
        Group {
            // A short list sizes to its rows. A long one scrolls inside about five of them.
            if count <= 5 {
                rows
            } else {
                ScrollView { rows }
                    .frame(height: 264)
            }
        }
        .background(Theme.card.opacity(0.97), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.hairline))
    }

    private var rows: some View {
            VStack(spacing: 0) {
                switch menu {
                case .mentions(_, let candidates):
                    ForEach(Array(candidates.enumerated()), id: \.element.id) { index, candidate in
                        Button { onMention(candidate) } label: {
                            MentionRow(candidate: candidate)
                                .modifier(MenuRowStyle(highlighted: index == 0))
                        }
                        .buttonStyle(.plain)
                    }
                case .commands(_, let commands):
                    ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                        Button { onCommand(command) } label: {
                            CommandRow(command: command)
                                .modifier(MenuRowStyle(highlighted: index == 0))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(6)
    }
}

private struct MenuRowStyle: ViewModifier {
    let highlighted: Bool

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(highlighted ? Theme.raised : .clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
    }
}

private struct MentionRow: View {
    let candidate: MentionCandidate

    var body: some View {
        HStack(spacing: 10) {
            switch candidate {
            case .bot(let bot):
                AvatarView(avatar: bot.avatar, size: 26)
                Text(bot.name).foregroundStyle(.white).lineLimit(1)
                Spacer(minLength: 8)
                Text("Bot").foregroundStyle(Theme.tertiary)
            case .connector(let connector):
                Image(systemName: "puzzlepiece.extension.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.secondary)
                    .frame(width: 26, height: 26)
                    .background(Theme.letter, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                Text(connector.name).foregroundStyle(.white).lineLimit(1)
                Text(connector.mentionState).foregroundStyle(Theme.tertiary).lineLimit(1)
                Spacer(minLength: 8)
                Text("Plugin").foregroundStyle(Theme.tertiary)
            }
        }
        .font(.system(size: 16))
        .accessibilityElement(children: .combine)
    }
}

private struct CommandRow: View {
    let command: Command

    var body: some View {
        let parts = CommandMenu.parts(command.name)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text("/\(Text(parts.plugin.map { "\($0):" } ?? "").foregroundStyle(Theme.tertiary))\(parts.command)")
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                if !command.argumentHint.isEmpty {
                    Text(command.argumentHint)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(Theme.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if command.source == .builtin {
                    Text("Built-in")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.letter, in: Capsule())
                }
            }
            if !command.description.isEmpty {
                Text(command.description)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
