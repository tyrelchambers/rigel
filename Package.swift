// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ClaudeK8s",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ClaudeK8s", targets: ["ClaudeK8s"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudeK8s",
            dependencies: ["Yams"],
            path: "Sources/ClaudeK8s"
        ),
        .testTarget(
            name: "ClaudeK8sTests",
            dependencies: ["ClaudeK8s"],
            path: "Tests/ClaudeK8sTests",
            resources: [.process("Fixtures")]
        ),
    ]
)
