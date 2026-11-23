import Foundation

/// 开机自启：写一个 LaunchAgent，不依赖 SMAppService 的签名要求。
enum LoginItem {
    static let label = "com.wansui976.coursepilotstats"

    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static var isEnabled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    /// 返回 nil 表示成功，否则返回错误说明。
    @discardableResult
    static func setEnabled(_ enabled: Bool) -> String? {
        let fm = FileManager.default
        if enabled {
            guard let executable = Bundle.main.executablePath else {
                return "找不到可执行文件，无法设置开机自启"
            }
            let plist: [String: Any] = [
                "Label": label,
                "ProgramArguments": [executable],
                "RunAtLoad": true,
                "KeepAlive": false,
                "ProcessType": "Interactive",
                "StandardOutPath": "/tmp/coursepilot-stats.out.log",
                "StandardErrorPath": "/tmp/coursepilot-stats.err.log",
            ]
            do {
                try fm.createDirectory(at: plistURL.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
                let data = try PropertyListSerialization.data(fromPropertyList: plist,
                                                              format: .xml,
                                                              options: 0)
                try data.write(to: plistURL, options: .atomic)
            } catch {
                return "写入登录项失败：\(error.localizedDescription)"
            }
            _ = run("/bin/launchctl", ["bootout", "gui/\(getuid())/\(label)"])
            let boot = run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", plistURL.path])
            if boot.status != 0, !boot.output.isEmpty {
                return "launchctl 报错：\(boot.output.trimmingCharacters(in: .whitespacesAndNewlines))"
            }
            return nil
        } else {
            _ = run("/bin/launchctl", ["bootout", "gui/\(getuid())/\(label)"])
            try? fm.removeItem(at: plistURL)
            return nil
        }
    }

    private static func run(_ path: String, _ arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (-1, error.localizedDescription)
        }
    }
}
