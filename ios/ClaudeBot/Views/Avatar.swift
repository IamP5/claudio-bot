import SwiftUI

extension AvatarColor {
    /// Sampled from the reference picker.
    var color: Color {
        switch self {
        case .white: Color(hex: 0xF7F7F7)
        case .brown: Color(hex: 0x8C6641)
        case .red: Color(hex: 0xEC4045)
        case .orange: Color(hex: 0xEC702D)
        case .amber: Color(hex: 0xF19B38)
        case .green: Color(hex: 0x5CC67A)
        case .teal: Color(hex: 0x54B9A7)
        case .blue: Color(hex: 0x3B81F6)
        case .purple: Color(hex: 0x875BF2)
        case .pink: Color(hex: 0xEC4599)
        case .gray, .unknown: Color(hex: 0x8A8A8A)
        }
    }

    /// The tint for the user's bubbles, chosen letters and the send button. White reads as light gray on dark.
    var accent: Color {
        self == .white ? Color(hex: 0xE8E8E8) : color
    }

    /// Text drawn on top of `accent`.
    var onAccent: Color {
        switch self {
        case .white, .amber: .black
        default: .white
        }
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

/// The outline of a bot's body. Every shape is built in unit space around the origin, then scaled to fit.
struct AvatarBody: Shape {
    let shape: AvatarShape

    func path(in rect: CGRect) -> Path {
        let outline = Outline(shape)
        let bounds = outline.bounds
        let scale = min(rect.width / bounds.width, rect.height / bounds.height)
        let transform = CGAffineTransform(translationX: rect.midX, y: rect.midY)
            .scaledBy(x: scale, y: scale)
            .translatedBy(x: -bounds.midX, y: -bounds.midY)
        return outline.path.applying(transform)
    }
}

private struct Outline {
    let path: Path
    var bounds: CGRect { path.boundingRect }

    init(_ shape: AvatarShape) {
        switch shape {
        case .circle, .unknown:
            path = Path(ellipseIn: CGRect(x: -1, y: -1, width: 2, height: 2))
        case .cloud:
            path = Self.radial(rotation: 8, stretch: CGSize(width: 1.14, height: 0.9)) { Self.lobes($0, count: 5, depth: 0.08) }
        case .diamond:
            path = Self.rounded(Self.box(width: 1.8, height: 1.62), corner: 0.3, rotation: -18)
        case .star4:
            path = Self.radial(rotation: 6) { 0.56 + 0.44 * pow((1 + cos(4 * $0)) / 2, 0.75) }
        case .flower:
            path = Self.radial(rotation: 45) { Self.lobes($0, count: 4, depth: 0.16) }
        case .blob:
            path = Self.radial(rotation: 0, stretch: CGSize(width: 1.1, height: 0.92)) {
                1 + 0.13 * cos(2 * $0 + 0.9) + 0.07 * cos(3 * $0 - 0.4) - 0.05 * Self.lobes($0 - 2.2, count: 2, depth: 1)
            }
        case .scallop:
            path = Self.radial(rotation: 4) { Self.lobes($0, count: 8, depth: 0.16) }
        case .drop:
            path = Self.radial(rotation: 0) { theta in
                let toward = cos(theta - (-.pi * 0.66))
                return 0.9 + 0.62 * pow(max(0, toward), 4)
            }
        case .pill:
            path = Self.rounded(Self.box(width: 2.1, height: 1.32), corner: 0.64, rotation: -10)
        case .triangle:
            path = Self.rounded(Self.regular(3, rotation: 0), corner: 0.24, rotation: 4)
        case .pentagon:
            path = Self.rounded(Self.regular(5, rotation: -90), corner: 0.26, rotation: -22)
        case .star6:
            path = Self.radial(rotation: 12) { 0.68 + 0.32 * pow((1 + cos(6 * $0)) / 2, 0.7) }
        case .hexagon:
            path = Self.rounded(Self.regular(6, rotation: 0), corner: 0.3, rotation: 12)
        }
    }

    /// Bumps like overlapping circles: round tops with narrow valleys.
    static func lobes(_ theta: Double, count: Double, depth: Double) -> Double {
        let wave = abs(cos(count / 2 * theta))
        return 1 - depth + depth * pow(wave, 0.55)
    }

    static func radial(rotation: Double, stretch: CGSize = CGSize(width: 1, height: 1), radius: (Double) -> Double) -> Path {
        let steps = 240
        let turn = rotation * .pi / 180
        var path = Path()
        for i in 0..<steps {
            let theta = Double(i) / Double(steps) * 2 * .pi
            let r = radius(theta)
            let x = r * cos(theta) * stretch.width
            let y = r * sin(theta) * stretch.height
            let point = CGPoint(x: x * cos(turn) - y * sin(turn), y: x * sin(turn) + y * cos(turn))
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }

    static func regular(_ sides: Int, rotation: Double) -> [CGPoint] {
        (0..<sides).map { i in
            let theta = (Double(i) / Double(sides) * 360 + rotation) * .pi / 180
            return CGPoint(x: cos(theta), y: sin(theta))
        }
    }

    static func box(width: Double, height: Double) -> [CGPoint] {
        [CGPoint(x: -width / 2, y: -height / 2), CGPoint(x: width / 2, y: -height / 2),
         CGPoint(x: width / 2, y: height / 2), CGPoint(x: -width / 2, y: height / 2)]
    }

    static func rounded(_ corners: [CGPoint], corner: Double, rotation: Double) -> Path {
        let turn = CGAffineTransform(rotationAngle: rotation * .pi / 180)
        let points = corners.map { $0.applying(turn) }
        let n = points.count
        var path = Path()
        let start = CGPoint(x: (points[n - 1].x + points[0].x) / 2, y: (points[n - 1].y + points[0].y) / 2)
        path.move(to: start)
        for i in 0..<n {
            path.addArc(tangent1End: points[i], tangent2End: points[(i + 1) % n], radius: corner)
        }
        path.closeSubpath()
        return path
    }
}

/// Where the eyes sit on each body, as fractions of the avatar's frame.
private struct Face {
    var left: CGPoint
    var right: CGPoint
    var tilt: Double = -18

    static func of(_ shape: AvatarShape) -> Face {
        switch shape {
        case .circle, .unknown: Face(left: CGPoint(x: 0.53, y: 0.36), right: CGPoint(x: 0.74, y: 0.3), tilt: -32)
        case .drop: Face(left: CGPoint(x: 0.55, y: 0.44), right: CGPoint(x: 0.73, y: 0.41))
        case .pill: Face(left: CGPoint(x: 0.55, y: 0.44), right: CGPoint(x: 0.73, y: 0.41))
        case .triangle: Face(left: CGPoint(x: 0.42, y: 0.42), right: CGPoint(x: 0.6, y: 0.42), tilt: -10)
        case .star4, .star6: Face(left: CGPoint(x: 0.45, y: 0.43), right: CGPoint(x: 0.61, y: 0.41))
        default: Face(left: CGPoint(x: 0.47, y: 0.43), right: CGPoint(x: 0.69, y: 0.39))
        }
    }
}

/// The bot character: a flat body with two slanted eyes, plus the orange badge when it waits on the user.
struct AvatarView: View {
    let avatar: Avatar
    var size: CGFloat = 40
    var needsAttention = false
    /// Bobs and blinks while the bot is typing.
    var animated = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !animated)) { context in
            let t = animated ? context.date.timeIntervalSinceReferenceDate : 0
            character(time: t)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if needsAttention { AttentionBadge(size: max(12, size * 0.28)).offset(x: size * 0.06, y: size * 0.04) }
        }
        .accessibilityHidden(true)
    }

    private func character(time t: Double) -> some View {
        let face = Face.of(avatar.shape)
        let bob = animated ? sin(t * 5) * size * 0.05 : 0
        let blink = animated && t.truncatingRemainder(dividingBy: 2.6) < 0.14
        return ZStack {
            AvatarBody(shape: avatar.shape)
                .fill(avatar.color.color)
                .overlay(
                    AvatarBody(shape: avatar.shape)
                        .fill(LinearGradient(colors: [.white.opacity(0.1), .clear, .black.opacity(0.06)], startPoint: .top, endPoint: .bottom))
                )
            eye(at: face.left, tilt: face.tilt, blink: blink)
            eye(at: face.right, tilt: face.tilt, blink: blink)
        }
        .frame(width: size, height: size)
        .rotationEffect(.degrees(animated ? sin(t * 2.5) * 6 : 0))
        .offset(y: bob)
    }

    private func eye(at point: CGPoint, tilt: Double, blink: Bool) -> some View {
        Capsule()
            .fill(Color(hex: 0x161616))
            .frame(width: size * 0.095, height: size * (blink ? 0.03 : 0.21))
            .rotationEffect(.degrees(tilt))
            .position(x: point.x * size, y: point.y * size)
    }
}

struct AttentionBadge: View {
    var size: CGFloat = 14

    var body: some View {
        Circle()
            .fill(AvatarColor.amber.color)
            .overlay(Image(systemName: "star.fill").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(.white))
            .frame(width: size, height: size)
            .background(Circle().fill(Theme.background).padding(-size * 0.14))
    }
}
