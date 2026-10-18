import AppKit
import SwiftUI

@MainActor
func render(to path: String) {
    let renderer = ImageRenderer(content: BrandIcon())
    renderer.scale = 1
    guard let cg = renderer.cgImage else { fatalError("render failed") }
    // App Store icons must be opaque, so the alpha channel is dropped.
    let ctx = CGContext(
        data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

MainActor.assumeIsolated { render(to: CommandLine.arguments.dropFirst().first ?? "AppIcon.png") }
