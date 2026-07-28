// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "mobile-files",
  platforms: [
    .macOS(.v14),
    .iOS(.v17),
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
