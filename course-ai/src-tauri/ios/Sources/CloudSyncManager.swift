import CloudKit
#if canImport(CloudSyncCore)
import CloudSyncCore
#endif
import CryptoKit
import Foundation
#if os(iOS)
import UIKit
#endif

struct CloudSyncStatus: Encodable, Sendable {
  let accountStatus: String
  let accountIDHash: String?
  let started: Bool
  let pendingChanges: Int
  let lastError: String?
}

@available(iOS 17.0, macOS 14.0, *)
actor CloudSyncManager: CKSyncEngineDelegate {
  static let zoneName = "CoursePilotUserZone"
  static let cloudRecordType = "SyncEnvelope"

  private let container: CKContainer
  private let rootURL: URL
  private let outgoingURL: URL
  private let incomingURL: URL
  private let ackURL: URL
  private let stateURL: URL
  private let recordStateURL: URL
  private let accountBindingURL: URL
  private let probeConfigurationURL: URL
  private let probeJournalURL: URL
  private let zone: CKRecordZone
  private let accountHashContainer: String
  private var syncEngine: CKSyncEngine?
  private var engineAccountIDHash: String?
  private var outgoingByRecordName: [String: URL] = [:]
  private var accountStatus = "unknown"
  private var accountIDHash: String?
  private var started = false
  private var lastError: String?
  private var lifecycleGeneration: UInt64 = 0
  private var cancellationSequence: UInt64 = 0
  private var pendingCancellation: (id: UInt64, task: Task<Void, Never>)?
  private var explicitFetchDepth = 0

  init(rootPath: String, containerIdentifier: String?) throws {
    rootURL = URL(fileURLWithPath: rootPath, isDirectory: true)
    outgoingURL = rootURL.appendingPathComponent("outgoing", isDirectory: true)
    incomingURL = rootURL.appendingPathComponent("incoming", isDirectory: true)
    ackURL = rootURL.appendingPathComponent("ack", isDirectory: true)
    stateURL = rootURL.appendingPathComponent("state", isDirectory: true)
    recordStateURL = stateURL.appendingPathComponent("records", isDirectory: true)
    accountBindingURL = stateURL.appendingPathComponent("account-binding.txt")
    probeConfigurationURL = stateURL.appendingPathComponent("probe-config.json")
    probeJournalURL = stateURL.appendingPathComponent("probe-journal.json")
    container = containerIdentifier.map(CKContainer.init(identifier:)) ?? CKContainer.default()
    zone = CKRecordZone(zoneName: Self.zoneName)
    accountHashContainer = containerIdentifier ?? "default"

    for directory in [rootURL, outgoingURL, incomingURL, ackURL, stateURL, recordStateURL] {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
    }
  }

  func inspectAccount() async throws -> CloudSyncStatus {
    let generation = lifecycleGeneration
    let account = try await loadAccountIdentity()
    guard generation == lifecycleGeneration else {
      return status()
    }
    accountStatus = account.status
    accountIDHash = account.hash
    if account.status != "available", syncEngine != nil {
      await deactivateEngine(lastError: "iCloud account is unavailable: \(account.status)")
    }
    return status()
  }

  private func verifyAccount(
    expectedAccountIDHash: String?,
    generation: UInt64
  ) async throws -> String {
    let account = try await loadAccountIdentity()
    try ensureCurrent(generation)
    accountStatus = account.status
    accountIDHash = account.hash
    guard account.status == "available", let accountIDHash = account.hash else {
      throw CloudSyncError.accountUnavailable(account.status)
    }
    guard let expectedAccountIDHash else {
      throw CloudSyncError.accountBindingRequired
    }
    guard accountIDHash == expectedAccountIDHash else {
      throw CloudSyncError.accountChanged
    }
    return accountIDHash
  }

  private func makeSyncEngine(accountIDHash: String) throws -> CKSyncEngine {
    if let syncEngine {
      guard engineAccountIDHash == accountIDHash else {
        throw CloudSyncError.accountChanged
      }
      return syncEngine
    }
    try prepareAccountScopedState(for: accountIDHash)
    var configuration = CKSyncEngine.Configuration(
      database: container.privateCloudDatabase,
      stateSerialization: try Self.loadEngineState(from: stateURL),
      delegate: self
    )
    configuration.automaticallySync = true
    configuration.subscriptionID = "CoursePilotSyncSubscription"
    let engine = CKSyncEngine(configuration)
    syncEngine = engine
    engineAccountIDHash = accountIDHash
    return engine
  }

  private func loadAccountIdentity() async throws -> (status: String, hash: String?) {
    let status = Self.accountStatusName(try await container.accountStatus())
    guard status == "available" else {
      return (status, nil)
    }
    let recordID = try await container.userRecordID()
    return (
      status,
      Self.hashAccountID(recordID, containerIdentifier: accountHashContainer)
    )
  }

  private func ensureCurrent(_ generation: UInt64) throws {
    guard generation == lifecycleGeneration else {
      throw CloudSyncError.operationSuperseded
    }
  }

  private func ensureCurrent(
    _ syncEngine: CKSyncEngine,
    generation: UInt64
  ) throws {
    try ensureCurrent(generation)
    guard self.syncEngine === syncEngine else {
      throw CloudSyncError.operationSuperseded
    }
  }

  private func waitForPendingCancellation() async {
    guard let pendingCancellation else {
      return
    }
    await pendingCancellation.task.value
    if self.pendingCancellation?.id == pendingCancellation.id {
      self.pendingCancellation = nil
    }
  }

  private func deactivateEngine(lastError: String?) async {
    lifecycleGeneration &+= 1
    let engine = syncEngine
    syncEngine = nil
    engineAccountIDHash = nil
    outgoingByRecordName.removeAll(keepingCapacity: false)
    started = false
    self.lastError = lastError

    if let engine {
      cancellationSequence &+= 1
      let id = cancellationSequence
      let task = Task {
        await engine.cancelOperations()
      }
      pendingCancellation = (id, task)
    }
    await waitForPendingCancellation()
  }

  func start(expectedAccountIDHash: String?) async throws -> CloudSyncStatus {
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    await waitForPendingCancellation()

    do {
      try ensureCurrent(generation)
      let accountIDHash = try await verifyAccount(
        expectedAccountIDHash: expectedAccountIDHash,
        generation: generation
      )
      let syncEngine = try makeSyncEngine(accountIDHash: accountIDHash)
      try ensureCurrent(syncEngine, generation: generation)
      try await ensureZone(syncEngine)
      try ensureCurrent(syncEngine, generation: generation)
      try recoverProbeReceipts(syncEngine)
      try await fetchChangesExplicitly(syncEngine)
      try ensureCurrent(syncEngine, generation: generation)
      started = true
      lastError = nil
      return status()
    } catch {
      let operationError = error
      if generation == lifecycleGeneration {
        await deactivateEngine(lastError: operationError.localizedDescription)
        if case CloudSyncError.accountChanged = operationError {
          do {
            try quarantineAccountScopedState()
          } catch {
            lastError = "iCloud account changed and old sync state could not be quarantined: \(error.localizedDescription)"
            throw error
          }
        }
      }
      throw operationError
    }
  }

  func syncNow(expectedAccountIDHash: String?) async throws -> CloudSyncStatus {
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    await waitForPendingCancellation()
    guard started, let syncEngine else {
      throw CloudSyncError.engineUnavailable
    }

    do {
      try ensureCurrent(syncEngine, generation: generation)
      let accountIDHash = try await verifyAccount(
        expectedAccountIDHash: expectedAccountIDHash,
        generation: generation
      )
      guard engineAccountIDHash == accountIDHash else {
        throw CloudSyncError.accountChanged
      }
      try ensureCurrent(syncEngine, generation: generation)

      // Pull first so an explicit sync cannot upload before observing server state.
      try await fetchChangesExplicitly(syncEngine)
      try ensureCurrent(syncEngine, generation: generation)
      let recheckedAccountIDHash = try await verifyAccount(
        expectedAccountIDHash: expectedAccountIDHash,
        generation: generation
      )
      guard engineAccountIDHash == recheckedAccountIDHash else {
        throw CloudSyncError.accountChanged
      }
      try ensureCurrent(syncEngine, generation: generation)
      try enqueueOutgoingFiles(syncEngine)
      try await syncEngine.sendChanges()
      try ensureCurrent(syncEngine, generation: generation)
      lastError = nil
      return status()
    } catch {
      let operationError = error
      if generation == lifecycleGeneration {
        await deactivateEngine(lastError: operationError.localizedDescription)
        if case CloudSyncError.accountChanged = operationError {
          do {
            try quarantineAccountScopedState()
          } catch {
            lastError = "iCloud account changed and old sync state could not be quarantined: \(error.localizedDescription)"
            throw error
          }
        }
      }
      throw operationError
    }
  }

  func stop() async -> CloudSyncStatus {
    await deactivateEngine(lastError: nil)
    return status()
  }

  func currentStatus() -> CloudSyncStatus {
    status()
  }

  func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    guard self.syncEngine === syncEngine else {
      return
    }
    do {
      switch event {
      case .stateUpdate(let update):
        try persistEngineState(update.stateSerialization)
      case .accountChange(let change):
        switch change.changeType {
        case .signIn:
          let generation = lifecycleGeneration
          let account = try await loadAccountIdentity()
          guard generation == lifecycleGeneration, self.syncEngine === syncEngine else {
            return
          }
          accountStatus = account.status
          accountIDHash = account.hash
          guard account.status == "available", account.hash == engineAccountIDHash else {
            await deactivateEngine(lastError: "iCloud account changed; sync is paused")
            try quarantineAccountScopedState()
            return
          }
        case .signOut:
          accountStatus = "noAccount"
          accountIDHash = nil
          await deactivateEngine(lastError: "iCloud account signed out; sync is paused")
          try resetEngineStatePreservingSpool()
        case .switchAccounts:
          accountStatus = "unknown"
          accountIDHash = nil
          await deactivateEngine(lastError: "iCloud account changed; sync is paused")
          try quarantineAccountScopedState()
        @unknown default:
          accountStatus = "unknown"
          accountIDHash = nil
          await deactivateEngine(lastError: "iCloud account state changed; sync is paused")
          try quarantineAccountScopedState()
        }
      case .fetchedRecordZoneChanges(let changes):
        let trigger = explicitFetchDepth > 0 ? "explicit" : "automatic"
        let appState = await Self.currentProbeAppState()
        for modification in changes.modifications {
          try persistFetchedRecord(modification.record)
          try await handleProbeRequest(
            modification.record,
            trigger: trigger,
            appState: appState,
            syncEngine: syncEngine
          )
        }
      case .sentRecordZoneChanges(let changes):
        for record in changes.savedRecords {
          try persistSystemFields(record)
          try writeAck(for: record, error: nil)
          try markProbeReceiptAcked(record)
          try removeOutgoingFile(for: record.recordID.recordName)
        }
        for failure in changes.failedRecordSaves {
          try writeAck(for: failure.record, error: failure.error.localizedDescription)
        }
      case .fetchedDatabaseChanges(let changes):
        if changes.deletions.contains(where: { $0.zoneID == zone.zoneID }) {
          await deactivateEngine(lastError: "CloudKit sync zone was deleted")
        }
      case .sentDatabaseChanges(let changes):
        if let failure = changes.failedZoneSaves.first(where: { $0.zone.zoneID == zone.zoneID }) {
          lastError = failure.error.localizedDescription
        }
      case .didFetchRecordZoneChanges(let event):
        if let error = event.error {
          lastError = error.localizedDescription
        }
      default:
        break
      }
    } catch {
      if self.syncEngine === syncEngine {
        lastError = error.localizedDescription
      }
    }
  }

  func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext,
    syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    guard self.syncEngine === syncEngine else {
      return nil
    }
    let pending = syncEngine.state.pendingRecordZoneChanges.filter {
      context.options.scope.contains($0)
    }
    return await CKSyncEngine.RecordZoneChangeBatch(pendingChanges: pending) { recordID in
      await self.recordToSave(for: recordID, syncEngine: syncEngine)
    }
  }

  private func fetchChangesExplicitly(_ syncEngine: CKSyncEngine) async throws {
    explicitFetchDepth += 1
    defer { explicitFetchDepth -= 1 }
    try await syncEngine.fetchChanges()
  }

  func prepareAccountScopedState(for accountIDHash: String) throws {
    try Self.prepareAccountScopedState(for: accountIDHash, rootURL: rootURL)
  }

  static func prepareAccountScopedState(for accountIDHash: String, rootURL: URL) throws {
    try CloudSyncProbeCore.prepareAccountScopedState(for: accountIDHash, rootURL: rootURL)
  }

  private func resetEngineStatePreservingSpool() throws {
    let engineStateURL = stateURL.appendingPathComponent("cksyncengine.plist")
    if FileManager.default.fileExists(atPath: engineStateURL.path) {
      try FileManager.default.removeItem(at: engineStateURL)
    }
    if FileManager.default.fileExists(atPath: recordStateURL.path) {
      try FileManager.default.removeItem(at: recordStateURL)
    }
    try FileManager.default.createDirectory(
      at: recordStateURL,
      withIntermediateDirectories: true
    )
  }

  func quarantineAccountScopedState() throws {
    try Self.quarantineAccountScopedState(rootURL: rootURL)
  }

  static func quarantineAccountScopedState(rootURL: URL) throws {
    try CloudSyncProbeCore.quarantineAccountScopedState(rootURL: rootURL)
  }

  private func ensureZone(_ syncEngine: CKSyncEngine) async throws {
    let alreadyPending = syncEngine.state.pendingDatabaseChanges.contains { change in
      if case .saveZone(let candidate) = change {
        return candidate.zoneID == zone.zoneID
      }
      return false
    }
    if !alreadyPending {
      syncEngine.state.add(pendingDatabaseChanges: [.saveZone(zone)])
    }
    try await syncEngine.sendChanges()
  }

  private func enqueueOutgoingFiles(_ syncEngine: CKSyncEngine) throws {
    outgoingByRecordName.removeAll(keepingCapacity: true)
    let files = try FileManager.default.contentsOfDirectory(
      at: outgoingURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ).filter { $0.pathExtension == "json" }

    var pendingRecordNames = Set<String>()
    for change in syncEngine.state.pendingRecordZoneChanges {
      switch change {
      case .saveRecord(let recordID), .deleteRecord(let recordID):
        pendingRecordNames.insert(recordID.recordName)
      @unknown default:
        continue
      }
    }

    var additions: [CKSyncEngine.PendingRecordZoneChange] = []
    for file in files {
      let envelope = try Self.readEnvelope(file)
      let recordID = Self.recordID(
        recordType: envelope.recordType,
        recordID: envelope.recordID,
        zoneID: zone.zoneID
      )
      if let currentFile = outgoingByRecordName[recordID.recordName] {
        let current = try Self.readEnvelope(currentFile)
        guard Self.isNewer(envelope.version, than: current.version) else {
          continue
        }
      }
      outgoingByRecordName[recordID.recordName] = file
    }

    for recordName in outgoingByRecordName.keys.sorted() {
      if pendingRecordNames.insert(recordName).inserted {
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zone.zoneID)
        additions.append(.saveRecord(recordID))
      }
    }
    if !additions.isEmpty {
      syncEngine.state.add(pendingRecordZoneChanges: additions)
    }
  }

  private func recordToSave(
    for recordID: CKRecord.ID,
    syncEngine: CKSyncEngine
  ) -> CKRecord? {
    guard self.syncEngine === syncEngine else {
      return nil
    }
    guard let file = outgoingByRecordName[recordID.recordName] else {
      return nil
    }
    do {
      let envelope = try Self.readEnvelope(file)
      let record = try loadSystemRecord(recordID: recordID) ?? CKRecord(
        recordType: Self.cloudRecordType,
        recordID: recordID
      )
      record["schemaVersion"] = NSNumber(value: envelope.schemaVersion)
      record["entityType"] = envelope.recordType as CKRecordValue
      record["entityID"] = envelope.recordID as CKRecordValue
      record["operation"] = envelope.operation as CKRecordValue
      record["versionCounter"] = NSNumber(value: envelope.version.counter)
      record["versionDevice"] = envelope.version.device as CKRecordValue
      record["updatedAt"] = NSNumber(value: envelope.updatedAt)
      record["payloadJSON"] = envelope.payloadJSON as CKRecordValue
      return record
    } catch {
      lastError = error.localizedDescription
      return nil
    }
  }

  private func persistFetchedRecord(_ record: CKRecord) throws {
    guard record.recordType == Self.cloudRecordType,
          let envelope = Self.envelope(from: record) else {
      return
    }
    if try loadProbeConfiguration() != nil,
       envelope.recordType != "SyncProbeRequest",
       envelope.recordType != "SyncProbeReceipt" {
      return
    }
    try persistSystemFields(record)
    let fileMaterial =
      "\(record.recordID.recordName)\0\(envelope.version.counter)\0\(envelope.version.device)"
    let name = "record-\(Self.sha256Hex(fileMaterial)).json"
    try Self.atomicWrite(envelope.data, to: incomingURL.appendingPathComponent(name))
  }

  private func persistSystemFields(_ record: CKRecord) throws {
    let archiver = NSKeyedArchiver(requiringSecureCoding: true)
    record.encodeSystemFields(with: archiver)
    archiver.finishEncoding()
    try Self.atomicWrite(
      archiver.encodedData,
      to: systemFieldsURL(for: record.recordID.recordName)
    )
  }

  private func loadSystemRecord(recordID: CKRecord.ID) throws -> CKRecord? {
    var url = systemFieldsURL(for: recordID.recordName)
    if !FileManager.default.fileExists(atPath: url.path),
       Self.isSafeLegacyFileComponent(recordID.recordName) {
      let legacyURL = recordStateURL.appendingPathComponent("\(recordID.recordName).system")
      if FileManager.default.fileExists(atPath: legacyURL.path) {
        url = legacyURL
      }
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }
    let unarchiver = try NSKeyedUnarchiver(forReadingFrom: Data(contentsOf: url))
    unarchiver.requiresSecureCoding = true
    defer { unarchiver.finishDecoding() }
    return CKRecord(coder: unarchiver)
  }

  private func writeAck(for record: CKRecord, error: String?) throws {
    guard let envelope = Self.envelope(from: record) else {
      return
    }
    var object: [String: Any] = [
      "recordType": envelope.recordType,
      "recordID": envelope.recordID,
      "version": [
        "counter": envelope.version.counter,
        "device": envelope.version.device,
      ],
      "updatedAt": envelope.updatedAt,
    ]
    if let changeTag = record.recordChangeTag {
      object["changeTag"] = changeTag
    }
    if let error {
      object["error"] = error
    }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    let suffix = error == nil ? "ok" : "failed"
    let fileMaterial = "\(record.recordID.recordName)\0\(envelope.version.counter)\0\(suffix)"
    let name = "ack-\(Self.sha256Hex(fileMaterial)).json"
    try Self.atomicWrite(data, to: ackURL.appendingPathComponent(name))
  }

  private func systemFieldsURL(for recordName: String) -> URL {
    recordStateURL.appendingPathComponent("record-\(Self.sha256Hex(recordName)).system")
  }

  private func removeOutgoingFile(for recordName: String) throws {
    guard let url = outgoingByRecordName.removeValue(forKey: recordName) else {
      return
    }
    do {
      try FileManager.default.removeItem(at: url)
    } catch CocoaError.fileNoSuchFile {
      return
    }
  }

  private func handleProbeRequest(
    _ record: CKRecord,
    trigger: String,
    appState: String,
    syncEngine: CKSyncEngine
  ) async throws {
    guard let configuration = try loadProbeConfiguration(),
          let envelope = Self.envelope(from: record),
          envelope.recordType == "SyncProbeRequest",
          let payloadData = envelope.payloadJSON.data(using: .utf8),
          let request = try? JSONDecoder().decode(ProbeRequest.self, from: payloadData) else {
      return
    }
    let nowMS = Int64(Date().timeIntervalSince1970 * 1_000)
    guard request.protocolVersion == configuration.protocolVersion,
          request.sessionID == configuration.sessionID,
          request.senderParticipantID != configuration.participantID,
          request.accountProof == configuration.accountProof,
          request.expiresAtMS >= nowMS,
          configuration.expiresAtMS >= nowMS,
          CloudSyncProbeCore.verifyRequest(request, configuration: configuration) else {
      return
    }

    var journal = try loadProbeJournal()
    let previous = journal[request.messageID]
    let entry = CloudSyncProbeCore.prepareReceipt(
      request: request,
      configuration: configuration,
      previous: previous,
      trigger: trigger,
      appState: appState,
      nowMS: nowMS
    )
    journal[request.messageID] = entry
    try persistProbeJournal(journal)
    try writeProbeReceipt(entry.receipt, configuration: configuration)
    try enqueueOutgoingFiles(syncEngine)
  }

  private func recoverProbeReceipts(_ syncEngine: CKSyncEngine) throws {
    guard let configuration = try loadProbeConfiguration() else {
      return
    }
    let nowMS = Int64(Date().timeIntervalSince1970 * 1_000)
    guard configuration.expiresAtMS >= nowMS else {
      return
    }
    for entry in try loadProbeJournal().values where !entry.acked {
      try writeProbeReceipt(entry.receipt, configuration: configuration)
    }
    try enqueueOutgoingFiles(syncEngine)
  }

  private func markProbeReceiptAcked(_ record: CKRecord) throws {
    guard let envelope = Self.envelope(from: record),
          envelope.recordType == "SyncProbeReceipt",
          let payloadData = envelope.payloadJSON.data(using: .utf8),
          let receipt = try? JSONDecoder().decode(ProbeReceipt.self, from: payloadData) else {
      return
    }
    var journal = try loadProbeJournal()
    guard var entry = journal[receipt.inReplyTo],
          entry.receipt.messageID == receipt.messageID,
          entry.receipt.observedDeliveries == receipt.observedDeliveries else {
      return
    }
    entry.acked = true
    journal[receipt.inReplyTo] = entry
    try persistProbeJournal(journal)
  }

  private func writeProbeReceipt(
    _ receipt: ProbeReceipt,
    configuration: ProbeConfiguration
  ) throws {
    guard receipt.sessionID == configuration.sessionID else {
      throw CloudSyncError.invalidProbe("receipt session")
    }
    let payloadData = try JSONEncoder().encode(receipt)
    let payload = try JSONSerialization.jsonObject(with: payloadData)
    let object: [String: Any] = [
      "schemaVersion": 1,
      "recordType": "SyncProbeReceipt",
      "recordID": receipt.messageID,
      "operation": "save",
      "version": [
        "counter": Int64(receipt.observedDeliveries),
        "device": configuration.participantID,
      ],
      "updatedAt": Int64(Date().timeIntervalSince1970 * 1_000),
      "payload": payload,
    ]
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    let name = "probe-receipt-\(Self.sha256Hex(receipt.messageID)).json"
    try Self.atomicWrite(data, to: outgoingURL.appendingPathComponent(name))
  }

  private func loadProbeConfiguration() throws -> ProbeConfiguration? {
    guard FileManager.default.fileExists(atPath: probeConfigurationURL.path) else {
      return nil
    }
    return try JSONDecoder().decode(
      ProbeConfiguration.self,
      from: Data(contentsOf: probeConfigurationURL)
    )
  }

  private func loadProbeJournal() throws -> [String: ProbeJournalEntry] {
    guard FileManager.default.fileExists(atPath: probeJournalURL.path) else {
      return [:]
    }
    return try JSONDecoder().decode(
      [String: ProbeJournalEntry].self,
      from: Data(contentsOf: probeJournalURL)
    )
  }

  private func persistProbeJournal(_ journal: [String: ProbeJournalEntry]) throws {
    try Self.atomicWrite(try JSONEncoder().encode(journal), to: probeJournalURL)
  }

  private static func currentProbeAppState() async -> String {
    #if os(iOS)
    return await MainActor.run {
      switch UIApplication.shared.applicationState {
      case .background: return "background"
      case .inactive: return "inactive"
      case .active: return "active"
      @unknown default: return "unknown"
      }
    }
    #else
    return "active"
    #endif
  }

  private func persistEngineState(_ serialization: CKSyncEngine.State.Serialization) throws {
    let data = try PropertyListEncoder().encode(serialization)
    try Self.atomicWrite(data, to: stateURL.appendingPathComponent("cksyncengine.plist"))
  }

  private func status() -> CloudSyncStatus {
    CloudSyncStatus(
      accountStatus: accountStatus,
      accountIDHash: accountIDHash,
      started: started,
      pendingChanges: syncEngine?.state.pendingRecordZoneChanges.count ?? 0,
      lastError: lastError
    )
  }

  private static func loadEngineState(
    from stateDirectory: URL
  ) throws -> CKSyncEngine.State.Serialization? {
    let url = stateDirectory.appendingPathComponent("cksyncengine.plist")
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }
    return try PropertyListDecoder().decode(
      CKSyncEngine.State.Serialization.self,
      from: Data(contentsOf: url)
    )
  }

  private static func readEnvelope(_ url: URL) throws -> DiskEnvelope {
    let data = try Data(contentsOf: url)
    let object = try JSONSerialization.jsonObject(with: data)
    guard let dictionary = object as? [String: Any],
          let schemaVersion = (dictionary["schemaVersion"] as? NSNumber)?.int64Value,
          let recordType = dictionary["recordType"] as? String,
          let recordID = dictionary["recordID"] as? String,
          let operation = dictionary["operation"] as? String,
          let updatedAt = (dictionary["updatedAt"] as? NSNumber)?.int64Value,
          let version = dictionary["version"] as? [String: Any],
          let counter = (version["counter"] as? NSNumber)?.int64Value,
          let device = version["device"] as? String,
          let payload = dictionary["payload"] else {
      throw CloudSyncError.invalidEnvelope(url.lastPathComponent)
    }
    let payloadData = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    guard let payloadJSON = String(data: payloadData, encoding: .utf8) else {
      throw CloudSyncError.invalidEnvelope(url.lastPathComponent)
    }
    return DiskEnvelope(
      schemaVersion: schemaVersion,
      recordType: recordType,
      recordID: recordID,
      operation: operation,
      version: .init(counter: counter, device: device),
      updatedAt: updatedAt,
      payloadJSON: payloadJSON,
      data: data
    )
  }

  private static func envelope(from record: CKRecord) -> DiskEnvelope? {
    guard let schemaVersion = (record["schemaVersion"] as? NSNumber)?.int64Value,
          let recordType = record["entityType"] as? String,
          let recordID = record["entityID"] as? String,
          let operation = record["operation"] as? String,
          let counter = (record["versionCounter"] as? NSNumber)?.int64Value,
          let device = record["versionDevice"] as? String,
          let updatedAt = (record["updatedAt"] as? NSNumber)?.int64Value,
          let payloadJSON = record["payloadJSON"] as? String,
          let payloadData = payloadJSON.data(using: .utf8),
          let payload = try? JSONSerialization.jsonObject(with: payloadData) else {
      return nil
    }
    let object: [String: Any] = [
      "schemaVersion": schemaVersion,
      "recordType": recordType,
      "recordID": recordID,
      "operation": operation,
      "version": ["counter": counter, "device": device],
      "updatedAt": updatedAt,
      "payload": payload,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
      return nil
    }
    return DiskEnvelope(
      schemaVersion: schemaVersion,
      recordType: recordType,
      recordID: recordID,
      operation: operation,
      version: .init(counter: counter, device: device),
      updatedAt: updatedAt,
      payloadJSON: payloadJSON,
      data: data
    )
  }

  private static func recordID(
    recordType: String,
    recordID: String,
    zoneID: CKRecordZone.ID
  ) -> CKRecord.ID {
    let name = "Sync-" + sha256Hex("\(recordType)\0\(recordID)")
    return CKRecord.ID(recordName: name, zoneID: zoneID)
  }

  private static func isNewer(_ candidate: DiskEnvelope.Version, than current: DiskEnvelope.Version) -> Bool {
    if candidate.counter != current.counter {
      return candidate.counter > current.counter
    }
    return candidate.device > current.device
  }

  private static func hashAccountID(
    _ recordID: CKRecord.ID,
    containerIdentifier: String
  ) -> String {
    let material = "coursepilot.cloudkit.account.v1\0\(containerIdentifier)\0\(recordID.recordName)"
    return "sha256:" + sha256Hex(material)
  }

  private static func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private static func isSafeLegacyFileComponent(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && !value.contains("/") && !value.contains("\\")
  }

  private static func atomicWrite(_ data: Data, to destination: URL) throws {
    try data.write(to: destination, options: [.atomic])
  }

  private static func accountStatusName(_ status: CKAccountStatus) -> String {
    switch status {
    case .available: return "available"
    case .noAccount: return "noAccount"
    case .restricted: return "restricted"
    case .couldNotDetermine: return "couldNotDetermine"
    case .temporarilyUnavailable: return "temporarilyUnavailable"
    @unknown default: return "unknown"
    }
  }
}

private struct DiskEnvelope {
  struct Version {
    let counter: Int64
    let device: String
  }

  let schemaVersion: Int64
  let recordType: String
  let recordID: String
  let operation: String
  let version: Version
  let updatedAt: Int64
  let payloadJSON: String
  let data: Data
}

private enum CloudSyncError: LocalizedError {
  case invalidEnvelope(String)
  case invalidProbe(String)
  case engineUnavailable
  case operationSuperseded
  case accountUnavailable(String)
  case accountBindingRequired
  case accountChanged

  var errorDescription: String? {
    switch self {
    case .invalidEnvelope(let name):
      return "Invalid sync envelope: \(name)"
    case .invalidProbe(let detail):
      return "Invalid CloudKit probe: \(detail)"
    case .engineUnavailable:
      return "Cloud sync engine is not running"
    case .operationSuperseded:
      return "Cloud sync operation was superseded by a lifecycle change"
    case .accountUnavailable(let status):
      return "iCloud account is unavailable: \(status)"
    case .accountBindingRequired:
      return "iCloud account must be bound before sync starts"
    case .accountChanged:
      return "iCloud account changed; sync is paused"
    }
  }
}
