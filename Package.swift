// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Helmsman",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Helmsman", targets: ["Helmsman"]),
        .executable(name: "HelmsmanMCP", targets: ["HelmsmanMCP"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
    ],
    targets: [
        .executableTarget(
            name: "Helmsman",
            dependencies: [
                "Yams",
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ],
            path: "Sources/Helmsman",
            resources: [.process("Resources")]
        ),
        .executableTarget(
            name: "HelmsmanMCP",
            path: "Sources/HelmsmanMCP"
        ),
        .testTarget(
            name: "HelmsmanTests",
            dependencies: ["Helmsman"],
            path: "Tests/HelmsmanTests",
            resources: [.process("Fixtures")]
        ),
    ]
)
