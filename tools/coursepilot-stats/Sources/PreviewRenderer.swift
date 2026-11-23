import AppKit
import SwiftUI

/// 开发用：`CoursePilotStats --render-preview /tmp/hud.png`
/// 不依赖截屏权限，直接把悬浮卡片离屏渲染成图片，方便检查排版。
@MainActor
enum PreviewRenderer {
    static func requestedPath() -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--render-preview"), index + 1 < args.count else {
            return nil
        }
        return args[index + 1]
    }

    static func render(to path: String) {
        let store = AppStore.shared
        store.loadSample()

        let hosting = NSHostingView(rootView: HUDView(store: store, isPreview: true))
        hosting.frame = NSRect(x: 0, y: 0, width: 303, height: 170)

        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        let appearance = CommandLine.arguments.contains("--appearance")
            ? (CommandLine.arguments.last == "light" ? "NSAppearanceNameAqua" : "NSAppearanceNameDarkAqua")
            : "NSAppearanceNameDarkAqua"
        window.appearance = NSAppearance(named: NSAppearance.Name(appearance))
        window.contentView = hosting
        window.orderFront(nil)
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()

        RunLoop.current.run(until: Date().addingTimeInterval(0.4))

        let size = hosting.fittingSize
        let scale: CGFloat = 2
        hosting.frame = NSRect(origin: .zero, size: size)

        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * scale),
            pixelsHigh: Int(size.height * scale),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return }

        rep.size = size
        hosting.cacheDisplay(in: hosting.bounds, to: rep)

        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: URL(fileURLWithPath: path))
        window.orderOut(nil)
    }
}
