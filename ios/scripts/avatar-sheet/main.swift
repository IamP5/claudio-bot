import AppKit
import SwiftUI

// Renders every avatar shape and color to one PNG, so the shapes can be compared with the reference picker.
@MainActor
func render() {
    let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "avatars.png")
    let sheet = VStack(spacing: 18) {
        HStack(spacing: 18) {
            ForEach(AvatarShape.allCases, id: \.rawValue) { shape in
                AvatarView(avatar: Avatar(shape: shape, color: .white), size: 64)
            }
        }
        HStack(spacing: 18) {
            ForEach(Array(AvatarColor.allCases.enumerated()), id: \.offset) { i, color in
                AvatarView(avatar: Avatar(shape: AvatarShape.allCases[i % 13], color: color), size: 64, needsAttention: i == 0)
            }
        }
        HStack(spacing: 18) {
            ForEach(AvatarShape.allCases, id: \.rawValue) { shape in
                AvatarView(avatar: Avatar(shape: shape, color: .red), size: 32)
            }
        }
    }
    .padding(24)
    .background(Theme.background)
    let renderer = ImageRenderer(content: sheet)
    renderer.scale = 2
    guard let image = renderer.cgImage else { fatalError("render failed") }
    let rep = NSBitmapImageRep(cgImage: image)
    try! rep.representation(using: .png, properties: [:])!.write(to: out)
    print(out.path)
}

render()
