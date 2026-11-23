import AppKit
import SwiftUI

/// 开发用：`CoursePilotStats --diagnose` 打印屏幕 / 状态栏 / 悬浮窗的实际情况。
@MainActor
enum Diagnostics {
    static var isRequested: Bool {
        CommandLine.arguments.contains("--diagnose")
    }

    static func dump() {
        let screens = NSScreen.screens.map { screen -> String in
            "  frame=\(screen.frame) visible=\(screen.visibleFrame) scale=\(screen.backingScaleFactor)"
        }
        print("== screens ==")
        screens.forEach { print($0) }

        print("== status bar ==")
        print("  thickness=\(NSStatusBar.system.thickness)")
        for window in NSApp.windows {
            print("  window \(type(of: window)) frame=\(window.frame) visible=\(window.isVisible) level=\(window.level.rawValue) title=\(window.title)")
            if window.className.contains("StatusBar") || window.level.rawValue >= 25 {
                if let button = window.contentView?.subviews.first as? NSButton {
                    print("    button title=\"\(button.title)\" frame=\(button.frame) hidden=\(button.isHidden)")
                }
            }
        }
        print("== app ==")
        print("  policy=\(NSApp.activationPolicy().rawValue) bundle=\(Bundle.main.bundleIdentifier ?? "-")")
        print("  defaults origin=\(UserDefaults.standard.string(forKey: "hudOrigin") ?? "-")")
        let app = AppStore.shared
        print("  lastError=\(app.lastError ?? "nil")")
        print("  stats stars=\(app.stats?.stars ?? -1) downloads=\(app.stats?.downloads ?? -1)")
        let token = UserDefaults.standard.string(forKey: "githubToken")
        print("  token=\(token.map { "已配置(长度 \($0.count))" } ?? "未配置")")
    }
}
