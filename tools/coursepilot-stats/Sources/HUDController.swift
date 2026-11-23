import AppKit
import SwiftUI

/// 无边框、置顶、跟随所有桌面空间的悬浮窗。
final class HUDPanel: NSPanel {
    // 不抢焦点：点按钮、拖卡片都不会把你正在用的 App 切到后台。
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class HUDController {
    static weak var shared: HUDController?

    private let store: AppStore
    private var panel: HUDPanel?
    private let defaults = UserDefaults.standard
    private static let originKey = "hudOrigin"

    init(store: AppStore) {
        self.store = store
        HUDController.shared = self
    }

    private var isVisible: Bool {
        panel?.isVisible ?? false
    }

    func setVisible(_ visible: Bool) {
        visible ? show() : hide()
    }

    func toggle() {
        isVisible ? hide() : show()
    }

    func show() {
        let panel = panel ?? makePanel()
        self.panel = panel
        if defaults.string(forKey: Self.originKey) != nil {
            restoreOrigin()
        } else {
            placeTopRight(panel)
        }
        // 卡片变高（比如加了新的一行）之后，旧坐标可能把它顶到菜单栏上，这里拉回可见区。
        clampIntoVisibleArea()
        panel.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    // MARK: - 构建

    private func makePanel() -> HUDPanel {
        let panel = HUDPanel(
            contentRect: NSRect(x: 0, y: 0, width: 303, height: 160),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.animationBehavior = .utilityWindow
        panel.title = "CoursePilot 数据"

        let hosting = NSHostingView(rootView: HUDView(
            store: store,
            onClose: { [weak self] in
                self?.hide()
                self?.store.showHUD = false
            },
            onOpen: { [weak self] in self?.openRepo() }
        ))
        hosting.frame = NSRect(x: 0, y: 0, width: 303, height: 160)
        panel.contentView = hosting
        panel.layoutIfNeeded()
        let fitting = hosting.fittingSize
        if fitting.height > 0 {
            panel.setContentSize(NSSize(width: 303, height: fitting.height))
        }

        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { _ in
            Task { @MainActor in
                HUDController.shared?.saveOrigin()
            }
        }

        return panel
    }

    // MARK: - 位置

    private func placeTopRight(_ panel: NSPanel) {
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let visible = screen.visibleFrame
        let size = panel.frame.size
        let margin: CGFloat = 16
        let origin = NSPoint(
            x: visible.maxX - size.width - margin,
            y: visible.maxY - size.height - margin
        )
        panel.setFrameOrigin(origin)
        saveOrigin()
    }

    /// 保证整张卡片留在屏幕可见区（visibleFrame 已经扣掉菜单栏和 Dock）。
    private func clampIntoVisibleArea() {
        guard let panel else { return }
        guard let screen = panel.screen ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let visible = screen.visibleFrame
        let margin: CGFloat = 8
        var frame = panel.frame
        frame.origin.x = min(max(frame.origin.x, visible.minX + margin), visible.maxX - frame.width - margin)
        frame.origin.y = min(max(frame.origin.y, visible.minY + margin), visible.maxY - frame.height - margin)
        guard frame.origin != panel.frame.origin else { return }
        panel.setFrameOrigin(frame.origin)
        saveOrigin()
    }

    func saveOrigin() {
        guard let panel else { return }
        defaults.set(NSStringFromPoint(panel.frame.origin), forKey: Self.originKey)
    }

    func restoreOrigin() {
        guard let panel, let stored = defaults.string(forKey: Self.originKey) else { return }
        let origin = NSPointFromString(stored)
        let frame = NSRect(origin: origin, size: panel.frame.size)
        if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) }) {
            panel.setFrameOrigin(origin)
            clampIntoVisibleArea()
        } else {
            placeTopRight(panel)
        }
    }

    // MARK: - 动作

    private func openRepo() {
        if let url = URL(string: "https://github.com/\(GitHubClient.repo)") {
            NSWorkspace.shared.open(url)
        }
    }
}
