import SwiftUI
import Testing
import UIKit
@testable import ClaudioBot

private func luminance(_ color: Color) -> Double {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
    func linear(_ c: CGFloat) -> Double {
        let c = Double(c)
        return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

private func contrast(_ a: Color, _ b: Color) -> Double {
    let (x, y) = (luminance(a), luminance(b))
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
}

private let colors: [AvatarColor] = [.white, .brown, .red, .orange, .amber, .green, .teal, .blue, .purple, .pink, .gray, .unknown("mauve")]

struct AccentContrastTests {
    @Test(arguments: colors)
    func textOnAccentMeetsAA(_ color: AvatarColor) {
        #expect(contrast(color.accent, color.onAccent) >= 4.5, "\(color)")
    }
}
