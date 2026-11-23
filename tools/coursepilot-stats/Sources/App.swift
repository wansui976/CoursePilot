import AppKit
import SwiftUI

@main
@MainActor
struct CoursePilotStatsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = AppStore.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent(store: store)
        } label: {
            Text(store.menuBarTitle)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hud: HUDController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let previewPath = PreviewRenderer.requestedPath()
        let isTool = previewPath != nil || Diagnostics.isRequested

        // 单实例：开机自启拉起时如果已经在跑，就安静退出，不要出现两张卡片。
        // 渲染预览 / 诊断这类开发用小工具不参与单实例检查。
        if !isTool, let bundleID = Bundle.main.bundleIdentifier {
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
                .filter { $0.processIdentifier != getpid() }
            if !others.isEmpty {
                NSApp.terminate(nil)
                return
            }
        }

        if let path = previewPath {
            PreviewRenderer.render(to: path)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
            return
        }

        let store = AppStore.shared
        hud = HUDController(store: store)
        // 手动打开 App 时总是把卡片显示出来（即使上次是隐藏状态），避免找不到入口。
        store.showHUD = true
        hud?.show()
        store.start()

        if Diagnostics.isRequested {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
                Diagnostics.dump()
                NSApp.terminate(nil)
            }
        }

        // 屏幕变化（插拔显示器、改分辨率）后把卡片拉回可见区域。
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { _ in
            Task { @MainActor in
                HUDController.shared?.restoreOrigin()
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if AppStore.shared.showHUD {
            HUDController.shared?.show()
        }
        return true
    }
}

@MainActor
struct MenuContent: View {
    @ObservedObject var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            header
            dailyLine
            Divider()
            toggles
            Divider()
            actions
            Text(store.statusText)
                .font(.system(size: 9.5))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(width: 272)
    }

    private var header: some View {
        HStack(spacing: 9) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.56, green: 0.36, blue: 1.0),
                                 Color(red: 0.20, green: 0.55, blue: 1.0)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 28, height: 28)
                .overlay(
                    Text("CP")
                        .font(.system(size: 11, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text("CoursePilot 数据")
                    .font(.system(size: 12.5, weight: .semibold))
                Text(store.stats.map { "★ \($0.stars)  ·  ↓ \($0.downloads)" } ?? "正在获取…")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 4)

            Button {
                store.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .semibold))
                    .opacity(store.isRefreshing ? 0.35 : 1)
            }
            .buttonStyle(.borderless)
            .help("立即刷新")
        }
    }

    @ViewBuilder
    private var dailyLine: some View {
        if let daily = store.dailyDelta {
            HStack(spacing: 4) {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(Color(red: 0.20, green: 0.78, blue: 0.45))
                Text("\(daily.days <= 1 ? "今天" : "近 \(daily.days) 天")新增 \(Fmt.count(daily.delta)) 次下载")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
    }

    private var toggles: some View {
        VStack(alignment: .leading, spacing: 9) {
            Toggle("右上角悬浮卡片", isOn: $store.showHUD)
                .toggleStyle(.switch)
                .controlSize(.small)
                .font(.system(size: 12))

            Toggle("开机自动启动", isOn: $store.launchAtLogin)
                .toggleStyle(.switch)
                .controlSize(.small)
                .font(.system(size: 12))

            HStack(spacing: 8) {
                Text("刷新频率")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Picker("", selection: $store.refreshMinutes) {
                    Text("1 分钟").tag(1)
                    Text("5 分钟").tag(5)
                    Text("10 分钟").tag(10)
                    Text("30 分钟").tag(30)
                    Text("60 分钟").tag(60)
                }
                .labelsHidden()
                .frame(width: 96)
            }

            if let message = store.lastLoginError {
                Text(message)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button("打开仓库") { openRepo() }
            Button("下载页") {
                if let url = URL(string: "https://github.com/\(GitHubClient.repo)/releases") {
                    NSWorkspace.shared.open(url)
                }
            }
            Spacer(minLength: 4)
            Button("退出") { NSApp.terminate(nil) }
        }
        .controlSize(.small)
        .font(.system(size: 11))
    }

    private func openRepo() {
        if let url = URL(string: "https://github.com/\(GitHubClient.repo)") {
            NSWorkspace.shared.open(url)
        }
    }
}
