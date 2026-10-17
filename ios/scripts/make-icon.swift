#!/usr/bin/env swift
// Usage: swift ios/scripts/make-icon.swift <output.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.png")

let space = CGColorSpace(name: CGColorSpace.sRGB)!
// noneSkipLast keeps the PNG opaque; App Store icons must not carry alpha.
let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
)!

let orange = CGColor(srgbRed: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1)
ctx.setFillColor(orange)
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

let center = CGPoint(x: Double(size) / 2, y: Double(size) / 2)
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineCap(.round)

let rays = 12
for i in 0..<rays {
    let angle = Double(i) / Double(rays) * 2 * .pi + .pi / 2
    let long = i % 2 == 0
    let inner = 70.0
    let outer = long ? 330.0 : 250.0
    ctx.setLineWidth(long ? 74 : 60)
    ctx.move(to: CGPoint(x: center.x + cos(angle) * inner, y: center.y + sin(angle) * inner))
    ctx.addLine(to: CGPoint(x: center.x + cos(angle) * outer, y: center.y + sin(angle) * outer))
    ctx.strokePath()
}

ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
ctx.fillEllipse(in: CGRect(x: center.x - 110, y: center.y - 110, width: 220, height: 220))

let image = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(out.path)") }
print("wrote \(out.path)")
