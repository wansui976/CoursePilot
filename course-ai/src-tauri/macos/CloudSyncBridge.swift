import Foundation

@available(macOS 14.0, *)
private final class MacCloudSyncBridge: @unchecked Sendable {
  static let shared = MacCloudSyncBridge()

  private let lock = NSLock()
  private var managers: [String: CloudSyncManager] = [:]

  private func manager(for rootPath: String, containerIdentifier: String?) throws -> CloudSyncManager {
    lock.lock()
    defer { lock.unlock() }
    let key = "\(containerIdentifier ?? "default")\0\(rootPath)"
    if let manager = managers[key] {
      return manager
    }
    let manager = try CloudSyncManager(
      rootPath: rootPath,
      containerIdentifier: containerIdentifier
    )
    managers[key] = manager
    return manager
  }

  func start(
    rootPath: String,
    containerIdentifier: String?,
    expectedAccountIDHash: String?
  ) -> CloudSyncStatus {
    run(rootPath: rootPath, containerIdentifier: containerIdentifier) { manager in
      try await manager.start(expectedAccountIDHash: expectedAccountIDHash)
    }
  }

  func account(rootPath: String, containerIdentifier: String?) -> CloudSyncStatus {
    run(rootPath: rootPath, containerIdentifier: containerIdentifier) { manager in
      try await manager.inspectAccount()
    }
  }

  func status(rootPath: String, containerIdentifier: String?) -> CloudSyncStatus {
    run(rootPath: rootPath, containerIdentifier: containerIdentifier) { manager in
      await manager.currentStatus()
    }
  }

  func syncNow(
    rootPath: String,
    containerIdentifier: String?,
    expectedAccountIDHash: String?
  ) -> CloudSyncStatus {
    run(rootPath: rootPath, containerIdentifier: containerIdentifier) { manager in
      try await manager.syncNow(expectedAccountIDHash: expectedAccountIDHash)
    }
  }

  func stop(rootPath: String, containerIdentifier: String?) -> CloudSyncStatus {
    run(rootPath: rootPath, containerIdentifier: containerIdentifier) { manager in
      await manager.stop()
    }
  }

  private func run(
    rootPath: String,
    containerIdentifier: String?,
    operation: @escaping @Sendable (CloudSyncManager) async throws -> CloudSyncStatus
  ) -> CloudSyncStatus {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<CloudSyncStatus, Error>?
    Task.detached {
      do {
        let manager = try self.manager(for: rootPath, containerIdentifier: containerIdentifier)
        result = .success(try await operation(manager))
      } catch {
        result = .failure(error)
      }
      semaphore.signal()
    }
    semaphore.wait()
    switch result {
    case .success(let status):
      return status
    case .failure(let error):
      return CloudSyncStatus(
        accountStatus: "error",
        accountIDHash: nil,
        started: false,
        pendingChanges: 0,
        lastError: error.localizedDescription
      )
    case .none:
      return CloudSyncStatus(
        accountStatus: "error",
        accountIDHash: nil,
        started: false,
        pendingChanges: 0,
        lastError: "CloudKit bridge completed without a result"
      )
    }
  }
}

@_cdecl("course_cloud_sync_account")
public func courseCloudSyncAccount(
  _ rootPath: UnsafePointer<CChar>,
  _ containerIdentifier: UnsafePointer<CChar>
) -> UnsafeMutablePointer<CChar>? {
  encodeStatus(
    MacCloudSyncBridge.shared.account(
      rootPath: String(cString: rootPath),
      containerIdentifier: String(cString: containerIdentifier)
    )
  )
}

@_cdecl("course_cloud_sync_start")
public func courseCloudSyncStart(
  _ rootPath: UnsafePointer<CChar>,
  _ containerIdentifier: UnsafePointer<CChar>,
  _ expectedAccountIDHash: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
  encodeStatus(
    MacCloudSyncBridge.shared.start(
      rootPath: String(cString: rootPath),
      containerIdentifier: String(cString: containerIdentifier),
      expectedAccountIDHash: expectedAccountIDHash.map(String.init(cString:))
    )
  )
}

@_cdecl("course_cloud_sync_status")
public func courseCloudSyncStatus(
  _ rootPath: UnsafePointer<CChar>,
  _ containerIdentifier: UnsafePointer<CChar>
) -> UnsafeMutablePointer<CChar>? {
  encodeStatus(
    MacCloudSyncBridge.shared.status(
      rootPath: String(cString: rootPath),
      containerIdentifier: String(cString: containerIdentifier)
    )
  )
}

@_cdecl("course_cloud_sync_now")
public func courseCloudSyncNow(
  _ rootPath: UnsafePointer<CChar>,
  _ containerIdentifier: UnsafePointer<CChar>,
  _ expectedAccountIDHash: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
  encodeStatus(
    MacCloudSyncBridge.shared.syncNow(
      rootPath: String(cString: rootPath),
      containerIdentifier: String(cString: containerIdentifier),
      expectedAccountIDHash: expectedAccountIDHash.map(String.init(cString:))
    )
  )
}

@_cdecl("course_cloud_sync_stop")
public func courseCloudSyncStop(
  _ rootPath: UnsafePointer<CChar>,
  _ containerIdentifier: UnsafePointer<CChar>
) -> UnsafeMutablePointer<CChar>? {
  encodeStatus(
    MacCloudSyncBridge.shared.stop(
      rootPath: String(cString: rootPath),
      containerIdentifier: String(cString: containerIdentifier)
    )
  )
}

@_cdecl("course_cloud_sync_free")
public func courseCloudSyncFree(_ pointer: UnsafeMutablePointer<CChar>?) {
  guard let pointer else { return }
  free(pointer)
}

@available(macOS 14.0, *)
private func encodeStatus(_ status: CloudSyncStatus) -> UnsafeMutablePointer<CChar>? {
  guard let data = try? JSONEncoder().encode(status),
        let json = String(data: data, encoding: .utf8) else {
    return nil
  }
  return strdup(json)
}
