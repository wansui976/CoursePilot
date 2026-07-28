import Foundation
import Tauri

struct CloudSyncArgs: Decodable, Sendable {
  let rootPath: String
  let containerIdentifier: String?
  let expectedAccountIDHash: String?
}

@available(iOS 17.0, *)
final class CloudSyncPlugin: Plugin {
  private let managers = CloudSyncManagerRegistry()

  @objc public func start(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloudSyncArgs.self)
    Task {
      do {
        let manager = try await managers.manager(for: args)
        let status = try await manager.start(expectedAccountIDHash: args.expectedAccountIDHash)
        invoke.resolve(Self.dictionary(status))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func account(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloudSyncArgs.self)
    Task {
      do {
        let manager = try await managers.manager(for: args)
        let status = try await manager.inspectAccount()
        invoke.resolve(Self.dictionary(status))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func status(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloudSyncArgs.self)
    Task {
      do {
        let manager = try await managers.manager(for: args)
        let status = await manager.currentStatus()
        invoke.resolve(Self.dictionary(status))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func syncNow(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloudSyncArgs.self)
    Task {
      do {
        let manager = try await managers.manager(for: args)
        let status = try await manager.syncNow(expectedAccountIDHash: args.expectedAccountIDHash)
        invoke.resolve(Self.dictionary(status))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func stop(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloudSyncArgs.self)
    Task {
      do {
        let manager = try await managers.manager(for: args)
        let status = await manager.stop()
        invoke.resolve(Self.dictionary(status))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  private static func dictionary(_ status: CloudSyncStatus) -> [String: Any] {
    var result: [String: Any] = [
      "accountStatus": status.accountStatus,
      "started": status.started,
      "pendingChanges": status.pendingChanges,
    ]
    if let accountIDHash = status.accountIDHash {
      result["accountIDHash"] = accountIDHash
    }
    if let error = status.lastError {
      result["lastError"] = error
    }
    return result
  }
}

@available(iOS 17.0, *)
private actor CloudSyncManagerRegistry {
  private var managers: [String: CloudSyncManager] = [:]

  func manager(for args: CloudSyncArgs) throws -> CloudSyncManager {
    let key = "\(args.containerIdentifier ?? "default")\0\(args.rootPath)"
    if let manager = managers[key] {
      return manager
    }
    let manager = try CloudSyncManager(
      rootPath: args.rootPath,
      containerIdentifier: args.containerIdentifier
    )
    managers[key] = manager
    return manager
  }
}

@_cdecl("init_plugin_cloud_sync")
func initCloudSyncPlugin() -> Plugin {
  if #available(iOS 17.0, *) {
    return CloudSyncPlugin()
  }
  fatalError("Cloud sync requires iOS 17 or newer")
}
