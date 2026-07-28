import CryptoKit
import Foundation

public struct ProbeConfiguration: Codable, Sendable {
  public let protocolVersion: UInt8
  public let sessionID: String
  public let sessionKey: String
  public let participantID: String
  public let accountProof: String
  public let expiresAtMS: Int64

  public init(
    protocolVersion: UInt8,
    sessionID: String,
    sessionKey: String,
    participantID: String,
    accountProof: String,
    expiresAtMS: Int64
  ) {
    self.protocolVersion = protocolVersion
    self.sessionID = sessionID
    self.sessionKey = sessionKey
    self.participantID = participantID
    self.accountProof = accountProof
    self.expiresAtMS = expiresAtMS
  }
}

public struct ProbeRequest: Codable, Sendable {
  public let protocolVersion: UInt8
  public let sessionID: String
  public let messageID: String
  public let senderParticipantID: String
  public let nonce: String
  public let accountProof: String
  public let issuedAtMS: Int64
  public let expiresAtMS: Int64
  public let mac: String

  public init(
    protocolVersion: UInt8,
    sessionID: String,
    messageID: String,
    senderParticipantID: String,
    nonce: String,
    accountProof: String,
    issuedAtMS: Int64,
    expiresAtMS: Int64,
    mac: String
  ) {
    self.protocolVersion = protocolVersion
    self.sessionID = sessionID
    self.messageID = messageID
    self.senderParticipantID = senderParticipantID
    self.nonce = nonce
    self.accountProof = accountProof
    self.issuedAtMS = issuedAtMS
    self.expiresAtMS = expiresAtMS
    self.mac = mac
  }
}

public struct ProbeDeliveryEvidence: Codable, Sendable {
  public let trigger: String
  public let appState: String
  public let receivedAtMS: Int64

  public init(trigger: String, appState: String, receivedAtMS: Int64) {
    self.trigger = trigger
    self.appState = appState
    self.receivedAtMS = receivedAtMS
  }
}

public struct ProbeReceipt: Codable, Sendable {
  public let protocolVersion: UInt8
  public let sessionID: String
  public let messageID: String
  public let inReplyTo: String
  public let responderParticipantID: String
  public let echoedNonce: String
  public let accountProof: String
  public let firstDelivery: ProbeDeliveryEvidence
  public let observedDeliveries: UInt32
  public let appliedCount: UInt32
  public let mac: String

  public init(
    protocolVersion: UInt8,
    sessionID: String,
    messageID: String,
    inReplyTo: String,
    responderParticipantID: String,
    echoedNonce: String,
    accountProof: String,
    firstDelivery: ProbeDeliveryEvidence,
    observedDeliveries: UInt32,
    appliedCount: UInt32,
    mac: String
  ) {
    self.protocolVersion = protocolVersion
    self.sessionID = sessionID
    self.messageID = messageID
    self.inReplyTo = inReplyTo
    self.responderParticipantID = responderParticipantID
    self.echoedNonce = echoedNonce
    self.accountProof = accountProof
    self.firstDelivery = firstDelivery
    self.observedDeliveries = observedDeliveries
    self.appliedCount = appliedCount
    self.mac = mac
  }
}

public struct ProbeJournalEntry: Codable, Sendable {
  public var receipt: ProbeReceipt
  public var acked: Bool

  public init(receipt: ProbeReceipt, acked: Bool) {
    self.receipt = receipt
    self.acked = acked
  }
}

public enum CloudSyncProbeCore {
  public enum AccountScopeError: LocalizedError {
    case accountChanged

    public var errorDescription: String? {
      "iCloud account changed; sync is paused"
    }
  }

  public static func prepareReceipt(
    request: ProbeRequest,
    configuration: ProbeConfiguration,
    previous: ProbeJournalEntry?,
    trigger: String,
    appState: String,
    nowMS: Int64
  ) -> ProbeJournalEntry {
    let firstDelivery = previous?.receipt.firstDelivery ?? ProbeDeliveryEvidence(
      trigger: trigger,
      appState: appState,
      receivedAtMS: nowMS
    )
    let previousDeliveries = previous?.receipt.observedDeliveries ?? 0
    let deliveries = previousDeliveries == UInt32.max ? UInt32.max : previousDeliveries + 1
    let messageID = hmac(
      "receipt\0\(request.messageID)\0\(configuration.participantID)",
      key: configuration.sessionKey
    )
    let unsigned = ProbeReceipt(
      protocolVersion: configuration.protocolVersion,
      sessionID: configuration.sessionID,
      messageID: messageID,
      inReplyTo: request.messageID,
      responderParticipantID: configuration.participantID,
      echoedNonce: request.nonce,
      accountProof: configuration.accountProof,
      firstDelivery: firstDelivery,
      observedDeliveries: deliveries,
      appliedCount: 1,
      mac: ""
    )
    let receipt = ProbeReceipt(
      protocolVersion: unsigned.protocolVersion,
      sessionID: unsigned.sessionID,
      messageID: unsigned.messageID,
      inReplyTo: unsigned.inReplyTo,
      responderParticipantID: unsigned.responderParticipantID,
      echoedNonce: unsigned.echoedNonce,
      accountProof: unsigned.accountProof,
      firstDelivery: unsigned.firstDelivery,
      observedDeliveries: unsigned.observedDeliveries,
      appliedCount: unsigned.appliedCount,
      mac: hmac(receiptMACMaterial(unsigned), key: configuration.sessionKey)
    )
    return ProbeJournalEntry(receipt: receipt, acked: false)
  }

  public static func verifyRequest(
    _ request: ProbeRequest,
    configuration: ProbeConfiguration
  ) -> Bool {
    let expected = hmac(requestMACMaterial(request), key: configuration.sessionKey)
    return constantTimeEquals(request.mac, expected)
  }

  public static func requestMACMaterial(_ request: ProbeRequest) -> String {
    [
      "request",
      String(request.protocolVersion),
      request.sessionID,
      request.messageID,
      request.senderParticipantID,
      request.nonce,
      request.accountProof,
      String(request.issuedAtMS),
      String(request.expiresAtMS),
    ].joined(separator: "\0")
  }

  public static func receiptMACMaterial(_ receipt: ProbeReceipt) -> String {
    [
      "receipt",
      String(receipt.protocolVersion),
      receipt.sessionID,
      receipt.messageID,
      receipt.inReplyTo,
      receipt.responderParticipantID,
      receipt.echoedNonce,
      receipt.accountProof,
      receipt.firstDelivery.trigger,
      receipt.firstDelivery.appState,
      String(receipt.firstDelivery.receivedAtMS),
      String(receipt.observedDeliveries),
      String(receipt.appliedCount),
    ].joined(separator: "\0")
  }

  public static func hmac(_ material: String, key: String) -> String {
    let authenticationCode = HMAC<SHA256>.authenticationCode(
      for: Data(material.utf8),
      using: SymmetricKey(data: Data(key.utf8))
    )
    return authenticationCode.map { String(format: "%02x", $0) }.joined()
  }

  public static func constantTimeEquals(_ left: String, _ right: String) -> Bool {
    let leftBytes = Array(left.utf8)
    let rightBytes = Array(right.utf8)
    guard leftBytes.count == rightBytes.count else {
      return false
    }
    return zip(leftBytes, rightBytes).reduce(UInt8(0)) { difference, pair in
      difference | (pair.0 ^ pair.1)
    } == 0
  }

  public static func prepareAccountScopedState(for accountIDHash: String, rootURL: URL) throws {
    let stateURL = rootURL.appendingPathComponent("state", isDirectory: true)
    let bindingURL = stateURL.appendingPathComponent("account-binding.txt")
    try FileManager.default.createDirectory(at: stateURL, withIntermediateDirectories: true)
    if FileManager.default.fileExists(atPath: bindingURL.path) {
      let stored = try String(contentsOf: bindingURL, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      guard stored == accountIDHash else {
        try quarantineAccountScopedState(rootURL: rootURL)
        throw AccountScopeError.accountChanged
      }
      return
    }
    try atomicWrite(Data(accountIDHash.utf8), to: bindingURL)
  }

  public static func quarantineAccountScopedState(rootURL: URL) throws {
    let outgoingURL = rootURL.appendingPathComponent("outgoing", isDirectory: true)
    let incomingURL = rootURL.appendingPathComponent("incoming", isDirectory: true)
    let ackURL = rootURL.appendingPathComponent("ack", isDirectory: true)
    let stateURL = rootURL.appendingPathComponent("state", isDirectory: true)
    let recordStateURL = stateURL.appendingPathComponent("records", isDirectory: true)
    let quarantineBase = rootURL.appendingPathComponent("quarantine", isDirectory: true)
    try removeProbeSecretsRecursively(from: rootURL)
    try FileManager.default.createDirectory(at: quarantineBase, withIntermediateDirectories: true)
    let timestamp = Int64(Date().timeIntervalSince1970 * 1_000)
    let destination = quarantineBase.appendingPathComponent(
      "account-change-\(timestamp)-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    for source in [outgoingURL, incomingURL, ackURL, stateURL] {
      guard FileManager.default.fileExists(atPath: source.path) else {
        continue
      }
      try FileManager.default.moveItem(
        at: source,
        to: destination.appendingPathComponent(source.lastPathComponent, isDirectory: true)
      )
    }
    for directory in [
      outgoingURL,
      incomingURL,
      ackURL,
      ackURL.appendingPathComponent("processing", isDirectory: true),
      ackURL.appendingPathComponent("invalid", isDirectory: true),
      stateURL,
      recordStateURL,
    ] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
  }

  private static func atomicWrite(_ data: Data, to destination: URL) throws {
    try data.write(to: destination, options: [.atomic])
  }

  private static func removeProbeSecretsRecursively(from directory: URL) throws {
    guard FileManager.default.fileExists(atPath: directory.path) else {
      return
    }
    for entry in try FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
    ) {
      let values = try entry.resourceValues(
        forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
      )
      if values.isSymbolicLink == true {
        continue
      }
      if values.isDirectory == true {
        try removeProbeSecretsRecursively(from: entry)
      } else if values.isRegularFile == true,
                ["probe-config.json", "probe-session.json", "probe-journal.json"]
                  .contains(entry.lastPathComponent) {
        try FileManager.default.removeItem(at: entry)
      }
    }
  }
}
