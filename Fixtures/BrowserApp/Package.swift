// swift-tools-version: 6.4
import PackageDescription

let package = Package(
  name: "BrowserApp",
  platforms: [.macOS(.v15)],
  dependencies: [
    .package(url: "https://github.com/SwiftTUI/swift-tui.git", exact: "0.14.0")
  ],
  targets: [
    .executableTarget(
      name: "BrowserApp",
      dependencies: [
        .product(name: "SwiftTUIRuntime", package: "swift-tui"),
        .product(name: "SwiftTUIWASI", package: "swift-tui"),
      ]
    )
  ]
)
