// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "CloudSyncCore",
  platforms: [
    .macOS(.v14),
    .iOS(.v17),
  ],
  products: [
    .library(name: "CloudSyncCore", targets: ["CloudSyncCore"])
  ],
  targets: [
    .target(name: "CloudSyncCore"),
    .testTarget(name: "CloudSyncCoreTests", dependencies: ["CloudSyncCore"]),
  ]
)
