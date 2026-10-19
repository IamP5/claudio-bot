import SwiftUI

/// The dark palette, sampled from the reference screenshots. The app always runs dark.
enum Theme {
    static let background = Color(hex: 0x141414)
    static let bubble = Color(hex: 0x222222)
    static let card = Color(hex: 0x202020)
    static let inset = Color(hex: 0x161616)
    static let raised = Color(hex: 0x2C2C2E)
    static let letter = Color(hex: 0x3A3A3C)
    static let secondary = Color(hex: 0x9A9A9E)
    static let tertiary = Color(hex: 0x6E6E72)
    static let hairline = Color.white.opacity(0.08)
    static let unread = Color(hex: 0x3B7BF0)
    static let link = Color(hex: 0x4C8DF6)
    /// The color of "needs you": the attention badge, approvals.
    static let attention = AvatarColor.amber.color
    static let danger = AvatarColor.red.color
}

extension Font {
    /// The app's type scale, written in iPhone points. A Mac reads at 13pt body, so each size maps to its Mac
    /// counterpart from the Grok Bot reference (message 14, row name 14, preview and event lines 13).
    static func ui(size: CGFloat, weight: Weight = .regular, design: Design = .default) -> Font {
        .system(size: macSize(size), weight: weight, design: design)
    }

    private static func macSize(_ size: CGFloat) -> CGFloat {
        #if os(macOS)
        switch size {
        case ...13: size
        case ..<15: 13
        case ..<18: 14
        default: (size * 0.8).rounded()
        }
        #else
        size
        #endif
    }
}
