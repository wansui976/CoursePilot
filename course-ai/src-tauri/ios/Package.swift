// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "mobile-files",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "mobile-files",
      type: .static,
      targets: ["mobile-files"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "./.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "mobile-files",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
