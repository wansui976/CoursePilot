import SwiftUI

/// 悬浮卡片的全部内容。
@MainActor
struct HUDView: View {
    @ObservedObject var store: AppStore
    var isPreview = false
    var onClose: () -> Void = {}
    var onOpen: () -> Void = {}

    private var dotColor: Color {
        if store.lastError != nil { return .orange }
        if store.stats == nil { return .gray }
        return .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            header
            statsRow
            dailyRow
            footer
        }
        .padding(13)
        .frame(width: 303)
        .background(background)
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.8)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture(count: 2) { onOpen() }
        .contextMenu {
            Button("刷新") { store.refresh() }
            Button(store.showHUD ? "隐藏悬浮窗" : "显示悬浮窗") {
                store.showHUD.toggle()
            }
            Divider()
            Button("打开 GitHub 仓库") { onOpen() }
            Button("退出") { NSApp.terminate(nil) }
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: 9) {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.56, green: 0.36, blue: 1.0),
                                 Color(red: 0.20, green: 0.55, blue: 1.0)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 30, height: 30)
                .overlay(
                    Text("CP")
                        .font(.system(size: 11.5, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                )
                .shadow(color: .black.opacity(0.18), radius: 3, y: 1)

            VStack(alignment: .leading, spacing: 1) {
                Text("CoursePilot")
                    .font(.system(size: 13, weight: .semibold))
                Text("wansui976/CoursePilot")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            Circle()
                .fill(dotColor)
                .frame(width: 6, height: 6)
                .shadow(color: dotColor.opacity(0.6), radius: 3)
                .help(store.statusText)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(Color.primary.opacity(0.07)))
            }
            .buttonStyle(.plain)
            .help("隐藏悬浮窗（⌘ 菜单栏图标里可以再打开）")
        }
    }

    // MARK: - 数字

    private var statsRow: some View {
        HStack(spacing: 7) {
            StatTile(
                icon: "star.fill",
                label: "收藏",
                value: Fmt.count(store.stats?.stars ?? 0),
                delta: store.starDelta,
                tint: Color(red: 1.0, green: 0.65, blue: 0.13)
            )
            StatTile(
                icon: "arrow.down.to.line",
                label: "下载",
                value: Fmt.count(store.stats?.downloads ?? 0),
                delta: store.downloadDelta,
                tint: downloadTint
            )
        }
    }

    // MARK: - 每日新增

    private var downloadTint: Color { Color(red: 0.20, green: 0.78, blue: 0.45) }

    /// GitHub 不给按天的下载量，这里是本机每天记一次累计值再做差。
    private var dailyRow: some View {
        HStack(spacing: 5) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(downloadTint)

            if let daily = store.dailyDelta {
                Text(daily.days <= 1 ? "今天" : "近 \(daily.days) 天")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Text("+\(Fmt.count(daily.delta))")
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(downloadTint)

                Spacer(minLength: 4)
            } else {
                Text("今天新增 —")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)

                Spacer(minLength: 4)

                Text("明天起有数据")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 2)
        .help("每天记一次累计下载量，两次的差就是当天新增；App 没运行的那天会合并到下一次。GitHub 不提供按天的下载数据。")
    }

    // MARK: - 底部

    private var footer: some View {
        HStack(spacing: 5) {
            Text(store.statusText)
                .font(.system(size: 9.5))
                .foregroundStyle(store.lastError == nil ? Color.secondary : Color.orange)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 4)

            iconButton("arrow.clockwise", help: "立即刷新") { store.refresh() }
            iconButton("arrow.up.right.square", help: "打开 GitHub 仓库") { onOpen() }
        }
    }

    private func iconButton(_ name: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 17, height: 17)
                .background(Circle().fill(Color.primary.opacity(0.07)))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    // MARK: - 背景

    private var background: some View {
        ZStack {
            if isPreview {
                Color(nsColor: .windowBackgroundColor)
            } else {
                VisualEffectBackdrop()
            }
            LinearGradient(
                colors: [Color.white.opacity(0.07), Color.white.opacity(0.0)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }
}

/// 一块统计小方砖。
private struct StatTile: View {
    let icon: String
    let label: String
    let value: String
    let delta: Int
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(tint)
                Text(label)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                if delta > 0 {
                    Text("+\(delta)")
                        .font(.system(size: 8.5, weight: .bold, design: .rounded))
                        .foregroundStyle(tint)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color.primary.opacity(0.055))
        )
    }
}

/// 让窗口背景真正透出桌面（毛玻璃）。
struct VisualEffectBackdrop: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        view.state = .active
        view.isEmphasized = false
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blending
        view.state = .active
    }
}
