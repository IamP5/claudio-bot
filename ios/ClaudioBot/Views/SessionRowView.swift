import SwiftUI

/// Built from values only, so SwiftUI skips it when the row did not change.
struct SessionRowView: View, Equatable {
    let row: SessionRow
    var avatar: Avatar?
    var depth = 0
    var isLast = false
    var now: Date = .now
    var freshness = ListFreshness.live

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var badge: CGFloat = 18
    @ScaledMetric(relativeTo: .body) private var indent: CGFloat = 20

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.row == b.row && a.avatar == b.avatar && a.depth == b.depth && a.isLast == b.isLast && a.freshness == b.freshness
            && a.time == b.time
    }

    private nonisolated var time: RowTime { RowTime(row, now: freshness.ageReference(now: now)) }
    private var emphasized: Bool { row.unread || row.needsYou }

    /// At accessibility sizes the title keeps two lines and the status, time and unread dot share one line under it,
    /// so a few rows still fit on screen.
    var body: some View {
        let accessible = typeSize.isAccessibilitySize
        HStack(alignment: accessible ? .top : .center, spacing: 10) {
            OriginBadge(origin: row.origin, avatar: avatar, size: badge)
            if accessible {
                VStack(alignment: .leading, spacing: 4) {
                    lines(limit: 2)
                    status
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                lines(limit: 1)
                    .layoutPriority(1)
                Spacer(minLength: 0)
                status
            }
        }
        #if os(macOS)
        // A sidebar row on the Mac, sized for the pointer rather than a finger.
        .padding(.vertical, 5)
        .padding(.leading, CGFloat(depth) * indent)
        #else
        .padding(.vertical, accessible ? 10 : 11)
        .padding(.leading, CGFloat(depth) * indent)
        .frame(minHeight: 44)
        #endif
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

    private func lines(limit: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.title)
                .font(.body.weight(emphasized ? .medium : .regular))
                .foregroundStyle(emphasized ? Color.white : Color.white.opacity(row.hidden ? 0.5 : 0.86))
                .lineLimit(limit)
            if let detail = RowDetail(row) {
                Text(detail.shown)
                    .font(.caption)
                    .foregroundStyle(detail.tone == .alarm ? Theme.danger : Theme.secondary)
                    .lineLimit(limit)
            }
        }
    }

    private var status: some View {
        HStack(spacing: 8) {
            if row.hidden {
                Image(systemName: "eye.slash").font(.caption2).foregroundStyle(Theme.secondary)
            }
            MirrorGlyph(mirror: row.mirror)
            if let pr = row.pr { PullRequestChip(pr: pr) }
            Text(time.short)
                .font(.caption.monospacedDigit())
                .foregroundStyle(Theme.secondary)
                .fixedSize()
            let mark = SessionMark(row, freshness: freshness)
            SessionMarkView(mark: mark)
                .overlay { if mark == nil && row.unread { UnreadDot() } }
            if mark != nil && row.unread { UnreadDot() }
        }
    }
}

/// In the mark's place on a row at rest, and beside the mark on a row that is failed, working or needs you.
struct UnreadDot: View {
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 8

    var body: some View {
        Circle().fill(Theme.unread).frame(width: size, height: size)
            .accessibilityHidden(true)
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
            case .lastKnownWorking:
                WorkingRing(size: size * 0.9, color: Theme.tertiary, spinning: false)
            case .failed:
                Image(systemName: "xmark.circle").foregroundStyle(Theme.danger)
            case .unavailable:
                Image(systemName: "slash.circle").foregroundStyle(Theme.secondary)
            case .parked:
                Image(systemName: "pause.circle").foregroundStyle(Theme.secondary)
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
    var spinning = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let still = reduceMotion || !spinning
        TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
            Circle()
                .trim(from: 0.12, to: 0.82)
                .stroke(color, style: StrokeStyle(lineWidth: max(1.5, size * 0.16), lineCap: .round))
                .rotationEffect(.degrees(still ? 0 : turn * 360))
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

    /// A glyph per state, so the state never rests on color.
    static func symbol(_ state: PullRequestState?) -> String {
        switch state {
        case .merged: "arrow.triangle.merge"
        case .closed: "xmark.square"
        case .open, .unknown, nil: "arrow.triangle.pull"
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: Self.symbol(pr.state))
                .font(.caption2.weight(.semibold))
            Text("\(pr.number)")
                .font(.caption.monospacedDigit())
        }
        .foregroundStyle(Self.color(pr.state))
        .fixedSize()
        .accessibilityHidden(true)
    }
}

/// Only a failed copy to the Claude app shows on the row. A pending one is on its way and needs nothing from the
/// user, and a glyph for it read as work in progress on a session at rest.
struct MirrorGlyph: View {
    let mirror: SessionMirror

    var body: some View {
        if mirror == .failed {
            Label("Not in Claude app", systemImage: "exclamationmark.triangle.fill")
                .labelStyle(.titleAndIcon)
                .font(.caption2)
                .foregroundStyle(Theme.attention)
                .fixedSize()
                .accessibilityLabel(SessionText.mirrorFailed)
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
