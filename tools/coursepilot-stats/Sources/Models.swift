import Foundation

/// 一次抓取得到的仓库数据。
struct RepoStats: Codable, Equatable {
    var stars: Int
    var forks: Int
    var watchers: Int
    var issues: Int
    var downloads: Int
    var releaseCount: Int
    var latestTag: String?
    var latestDownloads: Int
    var fetchedAt: Date
}

/// 某一天最后一次采样时看到的累计下载量。用来算「今天新增」。
struct DailyTotal: Codable, Equatable {
    /// 本地日期，yyyy-MM-dd。
    var day: String
    var total: Int
}

enum StatsError: LocalizedError {
    case rateLimited(reset: Date?)
    case http(Int, String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .rateLimited(let reset):
            if let reset {
                let f = DateFormatter()
                f.dateFormat = "HH:mm"
                return "GitHub 限流，\(f.string(from: reset)) 后恢复"
            }
            return "GitHub 限流，请稍后再试"
        case .http(let code, let message):
            return "GitHub 返回 \(code)：\(message)"
        case .network(let message):
            return "网络错误：\(message)"
        }
    }
}

enum Fmt {
    /// 数字：小于一万用千分位，大于一万用「万」。
    static func count(_ n: Int) -> String {
        if n >= 100_000_000 { return String(format: "%.1f亿", Double(n) / 100_000_000) }
        if n >= 10_000 { return String(format: "%.1f万", Double(n) / 10_000) }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.groupingSeparator = ","
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    static func ago(_ date: Date?) -> String {
        guard let date else { return "尚未获取" }
        let seconds = Date().timeIntervalSince(date)
        if seconds < 0 { return "刚刚" }
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
        let f = DateFormatter()
        f.dateFormat = "M月d日 HH:mm"
        return f.string(from: date)
    }

    static func clock(_ date: Date?) -> String {
        guard let date else { return "--:--" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }
}
