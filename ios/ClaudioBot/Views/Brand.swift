import SwiftUI

/// The app's mark: the default bot, big and glossy, on a dark tile behind a gold outline of the flag's rhombus. The app icon (`scripts/make-icon.sh`) and the
/// launch splash both draw it from here.
enum Brand {
    /// The splash's first frame, and the launch screen's color, so the hand-off doesn't flash.
    static let launch = Color(hex: 0x111111)
    static let background = LinearGradient(colors: [Color(hex: 0x2A2A2A), launch], startPoint: .top, endPoint: .bottom)
    static let body: [Color] = [.white, Color(hex: 0xEDEDED), Color(hex: 0xB9B9B9), Color(hex: 0x6E6E6E)]
    static let eyes = Color(hex: 0x141414)
    static let gold = Color(hex: 0xA88B45).opacity(0.78)
}

/// The bot as a sphere with two slanted eyes, filling its frame. `lid` is how open the eyes are, 1 wide open, and
/// `look` moves both eyes by a fraction of the diameter.
struct BrandCharacter: View {
    var lid = 1.0
    var look = CGSize.zero

    var body: some View {
        GeometryReader { proxy in
            let d = min(proxy.size.width, proxy.size.height)
            ZStack {
                Circle().fill(
                    RadialGradient(colors: Brand.body, center: UnitPoint(x: 0.3, y: 0.2), startRadius: 0, endRadius: d * 0.75)
                )
                Circle()
                    .strokeBorder(
                        LinearGradient(colors: [.white.opacity(0.9), .clear], startPoint: .topLeading, endPoint: .center),
                        lineWidth: d * 0.008
                    )
                // The default avatar's face (`Face.of(.circle)`), so the mark and a white bot in the app are one character.
                eye(d).offset(x: (0.03 + look.width) * d, y: (-0.14 + look.height) * d)
                eye(d).offset(x: (0.24 + look.width) * d, y: (-0.2 + look.height) * d)
            }
            .frame(width: d, height: d)
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }

    private func eye(_ d: CGFloat) -> some View {
        Capsule()
            .fill(Brand.eyes)
            .frame(width: d * 0.095, height: d * 0.21 * max(lid, 0.14))
            .rotationEffect(.degrees(-32))
    }
}

/// The app icon's square: the character rising from the bottom of the tile, which crops it, in front of the flag's
/// rhombus. Only the rhombus's top and its right point show around the head, so it reads as a shape behind the bot.
struct BrandIcon: View {
    var side: CGFloat = 1024

    var body: some View {
        ZStack(alignment: .topLeading) {
            Brand.background
            Rhombus()
                .stroke(Brand.gold, lineWidth: side * 0.012)
                .frame(width: side * 0.918, height: side * 0.586)
                .position(x: side * 0.5, y: side * 0.332)
            BrandCharacter()
                .frame(width: side * 1.12, height: side * 1.12)
                .shadow(color: .black.opacity(0.5), radius: side * 0.03, y: side * 0.01)
                .position(x: side * 0.43, y: side * 0.74)
        }
        .frame(width: side, height: side)
        .clipped()
    }
}

private struct Rhombus: Shape {
    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: rect.midX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
            p.closeSubpath()
        }
    }
}
