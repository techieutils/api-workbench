// Run from the repository root: swift scripts/normalize-macos-icon.swift
// Keep the original PNG intact; inset macOS artwork to match standard Dock sizing.
import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let sourceURL = root.appendingPathComponent("packages/api-workbench-assets/src/icons/icon.png")
guard let source = NSImage(contentsOf: sourceURL) else { fatalError("Cannot load native icon") }
let iconset = root.appendingPathComponent("dist/macos-icon/AppIcon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
func render(_ size: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let inset = CGFloat(size) * (80.0 / 1024.0)
    source.draw(in: NSRect(x: inset, y: inset, width: CGFloat(size) - 2 * inset,
        height: CGFloat(size) - 2 * inset), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}
for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let dock = try render(1024)
for theme in ["", "light/", "dark/"] {
    try dock.write(to: root.appendingPathComponent("packages/api-workbench-assets/src/icons/\(theme)icon-mac.png"))
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("packages/api-workbench-assets/src/icons/icon.icns").path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("iconutil failed") }
for theme in ["light", "dark"] {
    let data = try Data(contentsOf: root.appendingPathComponent("packages/api-workbench-assets/src/icons/icon.icns"))
    try data.write(to: root.appendingPathComponent("packages/api-workbench-assets/src/icons/\(theme)/icon.icns"))
}
print("Generated macOS icons with 80px padding per edge at 1024px.")
