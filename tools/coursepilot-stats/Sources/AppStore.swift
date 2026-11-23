import Foundation
import SwiftUI

/// 全局状态：数据、缓存、刷新节奏、两个开关。
@MainActor
final class AppStore: ObservableObject {
    static let shared = AppStore()

    @Published private(set) var stats: RepoStats?
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var isRefreshing = false
    @Published private(set) var starDelta = 0
    @Published private(set) var downloadDelta = 0
    /// 每天一条累计值，用来算每日新增。GitHub 不提供按天的下载量，只能自己记账。
    @Published private(set) var dailyTotals: [DailyTotal] = []

    @Published var showHUD: Bool {
        didSet {
            defaults.set(showHUD, forKey: Keys.showHUD)
            HUDController.shared?.setVisible(showHUD)
        }
    }

    @Published var launchAtLogin: Bool {
        didSet {
            guard launchAtLogin != LoginItem.isEnabled else { return }
            if let error = LoginItem.setEnabled(launchAtLogin) {
                lastLoginError = error
                launchAtLogin = !launchAtLogin
            }
        }
    }

    @Published var refreshMinutes: Int {
        didSet {
            defaults.set(refreshMinutes, forKey: Keys.refresh)
            restartTimer()
        }
    }

    @Published private(set) var lastLoginError: String?

    private let defaults = UserDefaults.standard
    private var timer: Timer?

    private enum Keys {
        static let cache = "cachedStats"
        static let showHUD = "showHUD"
        static let launchAtLogin = "launchAtLogin"
        static let refresh = "refreshMinutes"
        static let daily = "dailyTotals"
    }

    /// 日期差最多保留 90 天。
    private static let maxDailyEntries = 90

    private init() {
        defaults.register(defaults: [
            Keys.showHUD: true,
            Keys.launchAtLogin: false,
            Keys.refresh: 5,
        ])
        showHUD = defaults.bool(forKey: Keys.showHUD)
        refreshMinutes = max(1, defaults.integer(forKey: Keys.refresh))
        launchAtLogin = LoginItem.isEnabled

        if let data = defaults.data(forKey: Keys.cache),
           let cached = try? JSONDecoder().decode(RepoStats.self, from: data) {
            stats = cached
            lastUpdated = cached.fetchedAt
        }
        if let data = defaults.data(forKey: Keys.daily),
           let history = try? JSONDecoder().decode([DailyTotal].self, from: data) {
            dailyTotals = history
        }
    }

    /// 由 AppDelegate 在悬浮窗创建之后调用。
    func start() {
        restartTimer()
        refresh()
    }

    func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true

        Task { [weak self] in
            guard let self else { return }
            let token = ProcessInfo.processInfo.environment["GITHUB_TOKEN"]
                ?? UserDefaults.standard.string(forKey: "githubToken")
            do {
                let fresh = try await GitHubClient.shared.fetch(token: token)
                self.apply(fresh)
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.fail(message)
            }
        }
    }

    private func apply(_ fresh: RepoStats) {
        let old = stats
        starDelta = max(0, fresh.stars - (old?.stars ?? fresh.stars))
        downloadDelta = max(0, fresh.downloads - (old?.downloads ?? fresh.downloads))
        stats = fresh
        lastUpdated = fresh.fetchedAt
        lastError = nil
        isRefreshing = false
        if let data = try? JSONEncoder().encode(fresh) {
            defaults.set(data, forKey: Keys.cache)
        }
        recordDaily(fresh.downloads)
    }

    // MARK: - 每日下载量

    /// 记下今天此刻的累计下载量（同一天多次刷新只留最新的一次）。
    private func recordDaily(_ total: Int) {
        let today = Self.dayKeyFormatter.string(from: Date())
        if let index = dailyTotals.firstIndex(where: { $0.day == today }) {
            guard dailyTotals[index].total != total else { return }
            dailyTotals[index].total = total
        } else {
            dailyTotals.append(DailyTotal(day: today, total: total))
        }
        if dailyTotals.count > Self.maxDailyEntries {
            dailyTotals.removeFirst(dailyTotals.count - Self.maxDailyEntries)
        }
        if let data = try? JSONEncoder().encode(dailyTotals) {
            defaults.set(data, forKey: Keys.daily)
        }
    }

    struct DailyDelta: Equatable {
        /// 距上一条记录的间隔天数（1 = 昨天）。
        let days: Int
        let delta: Int
    }

    /// 今天比上一次记录涨了多少。没有历史记录时返回 nil。
    var dailyDelta: DailyDelta? {
        let today = Self.dayKeyFormatter.string(from: Date())
        guard let current = dailyTotals.last(where: { $0.day == today }),
              let previous = dailyTotals.last(where: { $0.day < today }),
              let gap = Self.daysBetween(previous.day, today)
        else { return nil }
        return DailyDelta(days: gap, delta: max(0, current.total - previous.total))
    }

    private static let dayKeyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// 只比较日历日：统一按 UTC 解析，避免夏令时那天算出 23 小时。
    private static let dayParseFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static func daysBetween(_ from: String, _ to: String) -> Int? {
        guard let start = dayParseFormatter.date(from: from),
              let end = dayParseFormatter.date(from: to) else { return nil }
        return Int(end.timeIntervalSince(start) / 86_400)
    }

    private func fail(_ message: String) {
        lastError = message
        isRefreshing = false
    }

    private func restartTimer() {
        timer?.invalidate()
        let interval = TimeInterval(max(1, refreshMinutes) * 60)
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        timer.tolerance = interval * 0.1
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    // MARK: - 展示用

    var menuBarTitle: String {
        guard let stats else { return "★ CoursePilot" }
        return "★ \(Fmt.count(stats.stars))  ↓ \(Fmt.count(stats.downloads))"
    }

    var statusText: String {
        if let lastError { return lastError }
        guard stats != nil else { return "正在获取…" }
        var text = "更新于 \(Fmt.ago(lastUpdated))"
        if let tag = stats?.latestTag { text += " · \(tag)" }
        return text
    }

    /// 预览渲染时用的假数据。
    func loadSample() {
        stats = RepoStats(
            stars: 36,
            forks: 2,
            watchers: 2,
            issues: 0,
            downloads: 263,
            releaseCount: 16,
            latestTag: "v0.3.8",
            latestDownloads: 0,
            fetchedAt: Date().addingTimeInterval(-180)
        )
        lastUpdated = stats?.fetchedAt
        starDelta = 3
        downloadDelta = 12
        // 预览用的假历史：昨天 250 → 今天 263，好看到「今天 +13」的样子。
        let today = Self.dayKeyFormatter.string(from: Date())
        let yesterday = Self.dayKeyFormatter.string(from: Date().addingTimeInterval(-86_400))
        dailyTotals = [
            DailyTotal(day: yesterday, total: 250),
            DailyTotal(day: today, total: 263),
        ]
    }
}
