import AppKit
import SwiftUI

@MainActor
func render(to path: String, mac: Bool) {
    let renderer = ImageRenderer(content: BrandIcon())
    renderer.scale = 1
    guard let cg = renderer.cgImage else { fatalError("render failed") }
    let size = CGRect(x: 0, y: 0, width: cg.width, height: cg.height)
    // App Store icons must be opaque, so the iOS icon drops the alpha channel. The Mac icon keeps it for the margin
    // around its tile.
    let ctx = CGContext(
        data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: (mac ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast).rawValue
    )!
    if mac {
        // Apple's macOS icon grid: an 824/1024 rounded tile, centered a little high, over a soft shadow.
        let side = size.width * 824 / 1024
        let tile = CGRect(x: (size.width - side) / 2, y: (size.height - side) / 2 + size.height * 0.01, width: side, height: side)
        let shape = CGPath(roundedRect: tile, cornerWidth: side * 0.225, cornerHeight: side * 0.225, transform: nil)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -size.height * 0.01), blur: size.height * 0.03, color: CGColor(gray: 0, alpha: 0.5))
        ctx.addPath(shape)
        ctx.setFillColor(CGColor(gray: 0.1, alpha: 1))
        ctx.fillPath()
        ctx.restoreGState()
        ctx.addPath(shape)
        ctx.clip()
        ctx.draw(cg, in: tile)
    } else {
        ctx.draw(cg, in: size)
    }
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

MainActor.assumeIsolated {
    var args = Array(CommandLine.arguments.dropFirst())
    let mac = args.first == "--mac"
    if mac { args.removeFirst() }
    render(to: args.first ?? (mac ? "AppIcon-mac.png" : "AppIcon.png"), mac: mac)
}
