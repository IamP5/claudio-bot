import SwiftUI

/// Built from values only, so SwiftUI skips it when the row did not change.
struct SessionRowView: View, Equatable {
    let row: SessionRow
    var avatar: Avatar?
    var depth = 0
    var isLast = false
    var now: Date = .now

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var badge: CGFloat = 18
    @ScaledMetric(relativeTo: .body) private var indent: CGFloat = 20

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.row == b.row && a.avatar == b.avatar && a.depth == b.depth && a.isLast == b.isLast && SessionText.age(a.row.lastAt, now: a.now) == SessionText.age(b.row.lastAt, now: b.now)
    }

    private var emphasized: Bool { row.unread || row.needsYou }

    var body: some View {
        let accessible = typeSize.isAccessibilitySize
        HStack(alignment: accessible ? .top : .center, spacing: 10) {
            OriginBadge(origin: row.origin, avatar: avatar, size: badge)
            let line = accessible ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 8))
            line {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.body.weight(emphasized ? .medium : .regular))
                        .foregroundStyle(emphasized ? Color.white : Color.white.opacity(row.hidden ? 0.5 : 0.86))
                        .lineLimit(accessible ? 4 : 1)
                    if row.status == .parked {
                        Text(SessionText.parked(row.holder))
                            .font(.caption)
                            .foregroundStyle(Theme.secondary)
                            .lineLimit(accessible ? 3 : 1)
                    }
                }
                .frame(maxWidth: accessible ? .infinity : nil, alignment: .leading)
                .layoutPriority(1)
                if !accessible { Spacer(minLength: 0) }
                HStack(spacing: 8) {
                    MirrorGlyph(mirror: row.mirror)
                    if let pr = row.pr { PullRequestChip(pr: pr) }
                    Text(SessionText.age(row.lastAt, now: now))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.tertiary)
                        .fixedSize()
                    SessionMarkView(mark: SessionMark(row))
                }
            }
        }
        .padding(.vertical, accessible ? 10 : 11)
        .padding(.leading, CGFloat(depth) * indent)
        .frame(minHeight: 44)
        .overlay(alignment: .leading) {
            if depth > 0 {
                IndentGuide(isLast: isLast)
                    .stroke(Color.white.opacity(0.14), style: StrokeStyle(lineWidth: 1, lineCap: .round))
                    .frame(width: indent * 0.6)
                    .padding(.leading, CGFloat(depth - 1) * indent + badge / 2)
            }
        }
        .contentShape(Rectangle())
    }
}

struct OriginBadge: View {
    let origin: SessionOrigin
    var avatar: Avatar?
    var size: CGFloat = 18

    var body: some View {
        Group {
            if origin == .agent, let avatar {
                AvatarView(avatar: avatar, size: size)
            } else {
                Image(systemName: Self.symbol(origin))
                    .font(.ui(size: size * 0.68, weight: .regular))
                    .foregroundStyle(Theme.tertiary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    static func symbol(_ origin: SessionOrigin) -> String {
        switch origin {
        case .phone: "iphone"
        case .agent: "gearshape"
        case .desktop: "macwindow"
        case .terminal: "terminal"
        case .sdk: "curlybraces"
        case .cloud: "cloud"
        case .unknown: "circle.dashed"
        }
    }
}

struct SessionMarkView: View {
    let mark: SessionMark?
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 13

    var body: some View {
        Group {
            switch mark {
            case .needsYou:
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.attention)
            case .working:
                WorkingRing(size: size * 0.9)
            case .failed:
                Image(systemName: "xmark.circle").foregroundStyle(Theme.danger)
            case .parked:
                Image(systemName: "pause.circle").foregroundStyle(Theme.secondary)
            case .unread:
                Circle().fill(Theme.unread).frame(width: size * 0.62, height: size * 0.62)
            case nil:
                Color.clear
            }
        }
        .font(.ui(size: size, weight: .semibold))
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct WorkingRing: View {
    var size: CGFloat = 12
    var color: Color = AvatarColor.orange.color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
            Circle()
                .trim(from: 0.12, to: 0.82)
                .stroke(color, style: StrokeStyle(lineWidth: max(1.5, size * 0.16), lineCap: .round))
                .rotationEffect(.degrees(reduceMotion ? 0 : turn * 360))
        }
        .frame(width: size, height: size)
    }
}

struct PullRequestChip: View {
    let pr: SessionPullRequest

    /// GitHub's dark-theme state colors, which keep their contrast on the app's background.
    static func color(_ state: PullRequestState?) -> Color {
        switch state {
        case .open: Color(hex: 0x3FB950)
        case .merged: Color(hex: 0xA371F7)
        case .closed: Color(hex: 0xF85149)
        case .unknown, nil: Theme.secondary
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.triangle.pull")
                .font(.caption2.weight(.semibold))
            Text("\(pr.number)")
                .font(.caption.monospacedDigit())
        }
        .foregroundStyle(Self.color(pr.state))
        .fixedSize()
        .accessibilityHidden(true)
    }
}

struct MirrorGlyph: View {
    let mirror: SessionMirror

    var body: some View {
        switch mirror {
        case .pending:
            Image(systemName: "arrow.triangle.2.circlepath").font(.caption2).foregroundStyle(Theme.tertiary)
                .accessibilityHidden(true)
        case .failed:
            Image(systemName: "exclamationmark.triangle").font(.caption2).foregroundStyle(Theme.tertiary)
                .accessibilityHidden(true)
        default:
            EmptyView()
        }
    }
}

struct IndentGuide: Shape {
    let isLast: Bool

    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: rect.minX, y: rect.minY))
            if isLast {
                let r = min(6, rect.width / 2)
                p.addLine(to: CGPoint(x: rect.minX, y: rect.midY - r))
                p.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.midY), control: CGPoint(x: rect.minX, y: rect.midY))
                p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            } else {
                p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            }
        }
    }
}
