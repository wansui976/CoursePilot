import Foundation

/// 只读 GitHub 公开接口，两次请求即可拿到 star 数和全部 release 的下载量。
struct GitHubClient {
    static let shared = GitHubClient()
    static let repo = "wansui976/CoursePilot"

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 40
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    func fetch(repo: String = GitHubClient.repo, token: String? = nil) async throws -> RepoStats {
        let info: RepoDTO = try await get("/repos/\(repo)", token: token)

        var releases: [ReleaseDTO] = []
        var page = 1
        while page <= 5 {
            let batch: [ReleaseDTO] = try await get("/repos/\(repo)/releases?per_page=100&page=\(page)", token: token)
            releases.append(contentsOf: batch)
            if batch.count < 100 { break }
            page += 1
        }

        let published = releases.filter { !$0.draft }
        let downloads = published.reduce(0) { $0 + $1.downloads }
        let latest = published.first

        return RepoStats(
            stars: info.stargazersCount,
            forks: info.forksCount,
            watchers: info.subscribersCount ?? 0,
            issues: info.openIssuesCount,
            downloads: downloads,
            releaseCount: published.count,
            latestTag: latest?.tagName,
            latestDownloads: latest?.downloads ?? 0,
            fetchedAt: Date()
        )
    }

    // MARK: - 底层请求

    private func request(path: String, token: String?) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://api.github.com" + path)!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("CoursePilotStats/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func get<T: Decodable>(_ path: String, token: String?) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request(path: path, token: token))
        } catch {
            throw StatsError.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw StatsError.network("没有收到响应")
        }

        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 403 || http.statusCode == 429 {
                let reset = http.value(forHTTPHeaderField: "X-RateLimit-Reset")
                    .flatMap { TimeInterval($0) }
                    .map { Date(timeIntervalSince1970: $0) }
                throw StatsError.rateLimited(reset: reset)
            }
            let body = String((String(data: data, encoding: .utf8) ?? "未知错误").prefix(120))
            throw StatsError.http(http.statusCode, body)
        }

        do {
            let decoder = JSONDecoder()
            return try decoder.decode(T.self, from: data)
        } catch {
            throw StatsError.network("数据解析失败：\(error.localizedDescription)")
        }
    }

    // MARK: - DTO

    private struct RepoDTO: Decodable {
        let stargazersCount: Int
        let forksCount: Int
        let subscribersCount: Int?
        let openIssuesCount: Int

        enum CodingKeys: String, CodingKey {
            case stargazersCount = "stargazers_count"
            case forksCount = "forks_count"
            case subscribersCount = "subscribers_count"
            case openIssuesCount = "open_issues_count"
        }
    }

    private struct ReleaseDTO: Decodable {
        let tagName: String
        let draft: Bool
        let assets: [AssetDTO]

        var downloads: Int { assets.reduce(0) { $0 + $1.downloadCount } }

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case draft
            case assets
        }
    }

    private struct AssetDTO: Decodable {
        let downloadCount: Int
        enum CodingKeys: String, CodingKey {
            case downloadCount = "download_count"
        }
    }
}
