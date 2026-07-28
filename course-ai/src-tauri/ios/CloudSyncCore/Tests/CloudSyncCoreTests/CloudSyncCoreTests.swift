import CloudSyncCore
import Foundation
import XCTest

final class CloudSyncCoreTests: XCTestCase {
  private let key = "00112233445566778899aabbccddeeff"

  private func configuration() -> ProbeConfiguration {
    ProbeConfiguration(
      protocolVersion: 1,
      sessionID: "session-1",
      sessionKey: key,
      participantID: "responder",
      accountProof: "account-proof",
      expiresAtMS: 10_000
    )
  }

  private func request() -> ProbeRequest {
    let unsigned = ProbeRequest(
      protocolVersion: 1,
      sessionID: "session-1",
      messageID: "message-1",
      senderParticipantID: "sender",
      nonce: "nonce-1",
      accountProof: "account-proof",
      issuedAtMS: 1_000,
      expiresAtMS: 10_000,
      mac: ""
    )
    return ProbeRequest(
      protocolVersion: unsigned.protocolVersion,
      sessionID: unsigned.sessionID,
      messageID: unsigned.messageID,
      senderParticipantID: unsigned.senderParticipantID,
      nonce: unsigned.nonce,
      accountProof: unsigned.accountProof,
      issuedAtMS: unsigned.issuedAtMS,
      expiresAtMS: unsigned.expiresAtMS,
      mac: CloudSyncProbeCore.hmac(
        CloudSyncProbeCore.requestMACMaterial(unsigned),
        key: key
      )
    )
  }

  func testDuplicateRequestUpdatesOneLogicalReceipt() {
    let request = request()
    let configuration = configuration()
    XCTAssertTrue(CloudSyncProbeCore.verifyRequest(request, configuration: configuration))

    let first = CloudSyncProbeCore.prepareReceipt(
      request: request,
      configuration: configuration,
      previous: nil,
      trigger: "automatic",
      appState: "background",
      nowMS: 2_000
    )
    let replay = CloudSyncProbeCore.prepareReceipt(
      request: request,
      configuration: configuration,
      previous: first,
      trigger: "explicit",
      appState: "active",
      nowMS: 3_000
    )

    XCTAssertEqual(first.receipt.messageID, replay.receipt.messageID)
    XCTAssertEqual(first.receipt.observedDeliveries, 1)
    XCTAssertEqual(replay.receipt.observedDeliveries, 2)
    XCTAssertEqual(replay.receipt.appliedCount, 1)
    XCTAssertEqual(replay.receipt.firstDelivery.trigger, "automatic")
    XCTAssertEqual(replay.receipt.firstDelivery.appState, "background")
    XCTAssertTrue(
      CloudSyncProbeCore.constantTimeEquals(
        replay.receipt.mac,
        CloudSyncProbeCore.hmac(
          CloudSyncProbeCore.receiptMACMaterial(replay.receipt),
          key: key
        )
      )
    )
  }

  func testHMACMatchesRustWireVector() {
    XCTAssertEqual(
      CloudSyncProbeCore.hmac(
        "The quick brown fox jumps over the lazy dog",
        key: "key"
      ),
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    )
  }

  func testAccountSwitchQuarantinesOldStateAndSpool() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "coursepilot-cloud-sync-tests-\(UUID().uuidString)",
      isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: root) }
    try CloudSyncProbeCore.prepareAccountScopedState(for: "account-a", rootURL: root)
    let outgoing = root.appendingPathComponent("outgoing", isDirectory: true)
    try FileManager.default.createDirectory(at: outgoing, withIntermediateDirectories: true)
    let marker = outgoing.appendingPathComponent("old.json")
    try Data("old-account".utf8).write(to: marker)
    let state = root.appendingPathComponent("state", isDirectory: true)
    try Data("session-key".utf8).write(
      to: state.appendingPathComponent("probe-config.json")
    )
    let priorQuarantineState = root.appendingPathComponent(
      "quarantine/prior/state",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: priorQuarantineState,
      withIntermediateDirectories: true
    )
    try Data("session-key".utf8).write(
      to: priorQuarantineState.appendingPathComponent("probe-session.json")
    )

    XCTAssertThrowsError(
      try CloudSyncProbeCore.prepareAccountScopedState(for: "account-b", rootURL: root)
    )

    XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: outgoing.path))
    let quarantine = root.appendingPathComponent("quarantine", isDirectory: true)
    let snapshots = try FileManager.default.contentsOfDirectory(
      at: quarantine,
      includingPropertiesForKeys: nil
    ).filter { $0.lastPathComponent.hasPrefix("account-change-") }
    XCTAssertEqual(snapshots.count, 1)
    let oldOutgoing = snapshots[0]
      .appendingPathComponent("outgoing", isDirectory: true)
      .appendingPathComponent("old.json")
    XCTAssertTrue(FileManager.default.fileExists(atPath: oldOutgoing.path))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: snapshots[0].appendingPathComponent("state/probe-config.json").path
      )
    )
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: root.appendingPathComponent(
          "quarantine/prior/state/probe-session.json"
        ).path
      )
    )
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: root.appendingPathComponent("state/account-binding.txt").path
      )
    )
  }
}
