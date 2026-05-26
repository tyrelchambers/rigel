# Foundation + Pods Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the claude-k8s Mac app: SwiftUI shell, kubectl/claude subprocess wrappers, the `ContextHandoffBuilder` seam, and one fully-wired panel (Pods) that can hand off context to the persistent Claude chat region.

**Architecture:** Single SwiftUI macOS app (SPM-built, macOS 14+). Two long-lived subprocesses per active kubeconfig context: `kubectl get pods --watch -o json` for live pod data, and `claude --output-format stream-json --input-format stream-json` for the conversation engine. A pure-function `ContextHandoffBuilder` serializes a pod selection into a prompt string and writes it to claude's stdin. Stream-json output renders into the always-visible chat region (40 % of window width, per layout C from the design spec).

**Tech Stack:** Swift 5.10+, SwiftUI, macOS 14+ deployment target, Swift Package Manager (no Xcode project for v1 — `swift run` is the dev loop), [Yams](https://github.com/jpsim/Yams) for kubeconfig YAML, Apple `AttributedString` for streaming markdown. Tests via XCTest.

**Out of scope (deferred to follow-up plans):** LogsPanel, AlertsPanel, NodesPanel, runbook menu, full context switching, polished permission UX, status bar indicators.

---

## File Structure

```
claude-k8s/
├── Package.swift                                 # SPM manifest (executable target)
├── Sources/
│   └── ClaudeK8s/
│       ├── ClaudeK8sApp.swift                    # @main app entry
│       ├── Shell/
│       │   ├── MainWindow.swift                  # 3-region layout (60px nav + 60% panel + 40% chat)
│       │   ├── NavStrip.swift                    # left icon strip
│       │   └── StatusBar.swift                   # bottom status (16px)
│       ├── Cluster/
│       │   ├── ClusterContextManager.swift       # kubeconfig parsing + active context
│       │   ├── KubeconfigParser.swift            # pure YAML → Codable
│       │   ├── KubectlClient.swift               # Process wrapper, one-shot + watch
│       │   ├── KubectlStreamParser.swift         # streaming JSON value tokenizer
│       │   ├── WatchEvent.swift                  # ADDED/MODIFIED/DELETED + object
│       │   └── KubeTypes.swift                   # Pod, ObjectMeta minimal Codable
│       ├── Chat/
│       │   ├── ClaudeSession.swift               # claude subprocess lifecycle
│       │   ├── ClaudeEvent.swift                 # typed event enum
│       │   ├── StreamJsonParser.swift            # line-delimited JSON for claude
│       │   ├── ChatViewModel.swift               # @Observable, owns ClaudeSession
│       │   ├── ChatView.swift                    # SwiftUI rendering
│       │   ├── PermissionSheet.swift             # native sheet for tool perms
│       │   └── MessageRenderer.swift             # markdown → AttributedString
│       ├── Handoff/
│       │   ├── PanelSelection.swift              # selection enum (pod, ...)
│       │   └── ContextHandoffBuilder.swift       # pure function → prompt
│       ├── Panels/
│       │   ├── PanelKind.swift                   # enum: .pods (Logs/Alerts/Nodes later)
│       │   └── Pods/
│       │       ├── PodsPanel.swift               # SwiftUI Table view
│       │       └── PodsViewModel.swift           # @Observable, owns watch stream
│       ├── State/
│       │   └── SessionStore.swift                # JSON-on-disk for session IDs
│       └── Util/
│           └── ProcessAsync.swift                # async helpers around Process
├── Tests/
│   └── ClaudeK8sTests/
│       ├── KubectlStreamParserTests.swift
│       ├── KubeTypesDecodingTests.swift
│       ├── KubeconfigParserTests.swift
│       ├── StreamJsonParserTests.swift
│       ├── ContextHandoffBuilderTests.swift
│       └── Fixtures/
│           ├── pods-list.json
│           ├── watch-events-pretty.json
│           ├── claude-stream.jsonl
│           └── kubeconfig-min.yaml
├── docs/superpowers/
│   ├── specs/2026-05-26-claude-k8s-mac-app-design.md
│   └── plans/2026-05-26-foundation-and-pods-panel.md   # this file
└── .gitignore
```

Files split by responsibility, not by layer. Each unit has one job. Cluster/, Chat/, and Handoff/ never import each other except through `ContextHandoffBuilder` (the seam).

---

## Tasks

### Task 1: Bootstrap the Swift package

**Files:**
- Create: `Package.swift`

- [ ] **Step 1: Init the executable package**

Run from `/Users/tyrelchambers/home/claude-k8s/`:

```bash
swift package init --type executable --name ClaudeK8s
```

Expected: creates `Sources/ClaudeK8s/main.swift`, `Tests/ClaudeK8sTests/...`, and a starter `Package.swift`.

- [ ] **Step 2: Replace Package.swift with the real manifest**

```swift
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
```

- [ ] **Step 3: Delete the starter main.swift**

Run: `rm Sources/ClaudeK8s/main.swift`

(The real `@main` lives in `ClaudeK8sApp.swift` — added next task.)

- [ ] **Step 4: Verify package resolves and builds**

Run: `swift build`
Expected: build succeeds, no warnings about main.swift, fetches Yams.

- [ ] **Step 5: Commit**

```bash
git add Package.swift Sources/ Tests/
git commit -m "feat: bootstrap Swift package with Yams dep"
```

---

### Task 2: App entry + 3-region window shell (placeholders)

**Files:**
- Create: `Sources/ClaudeK8s/ClaudeK8sApp.swift`
- Create: `Sources/ClaudeK8s/Shell/MainWindow.swift`
- Create: `Sources/ClaudeK8s/Shell/NavStrip.swift`
- Create: `Sources/ClaudeK8s/Shell/StatusBar.swift`

- [ ] **Step 1: Create the @main app entry**

`Sources/ClaudeK8s/ClaudeK8sApp.swift`:

```swift
import SwiftUI

@main
struct ClaudeK8sApp: App {
    var body: some Scene {
        WindowGroup("claude-k8s") {
            MainWindow()
                .frame(minWidth: 1000, minHeight: 600)
        }
        .windowResizability(.contentSize)
    }
}
```

- [ ] **Step 2: Create NavStrip placeholder**

`Sources/ClaudeK8s/Shell/NavStrip.swift`:

```swift
import SwiftUI

struct NavStrip: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "shippingbox.fill").font(.title2)
            Image(systemName: "text.alignleft").font(.title2).foregroundStyle(.tertiary)
            Image(systemName: "bell").font(.title2).foregroundStyle(.tertiary)
            Image(systemName: "server.rack").font(.title2).foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxHeight: .infinity)
        .padding(.vertical, 16)
        .frame(width: 60)
        .background(.thinMaterial)
    }
}
```

- [ ] **Step 3: Create StatusBar placeholder**

`Sources/ClaudeK8s/Shell/StatusBar.swift`:

```swift
import SwiftUI

struct StatusBar: View {
    var body: some View {
        HStack(spacing: 12) {
            Text("context: —").font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Text("claude: idle").font(.caption2).foregroundStyle(.secondary)
            Text("kubectl: ok").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .frame(height: 18)
        .background(.thinMaterial)
    }
}
```

- [ ] **Step 4: Create MainWindow with the 60/40 split**

`Sources/ClaudeK8s/Shell/MainWindow.swift`:

```swift
import SwiftUI

struct MainWindow: View {
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip()

                HSplitView {
                    // Panel region (left, ~60%)
                    VStack {
                        Text("Pods panel goes here")
                            .foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))

                    // Chat region (right, ~40%)
                    VStack {
                        Text("Chat goes here")
                            .foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
    }
}
```

- [ ] **Step 5: Build and run**

Run: `swift run ClaudeK8s`
Expected: a window opens showing the nav strip on the left, the two regions split 60/40, and the status bar at the bottom.

- [ ] **Step 6: Commit**

```bash
git add Sources/ClaudeK8s/
git commit -m "feat: SwiftUI shell with 3-region layout"
```

---

### Task 3: Process async helpers

**Files:**
- Create: `Sources/ClaudeK8s/Util/ProcessAsync.swift`

- [ ] **Step 1: Write the helper**

`Sources/ClaudeK8s/Util/ProcessAsync.swift`:

```swift
import Foundation

enum ProcessError: Error, CustomStringConvertible {
    case nonZeroExit(code: Int32, stderr: String)
    case launchFailed(underlying: Error)
    case stdoutClosed

    var description: String {
        switch self {
        case .nonZeroExit(let code, let stderr):
            return "process exited with code \(code): \(stderr)"
        case .launchFailed(let err):
            return "process launch failed: \(err)"
        case .stdoutClosed:
            return "process stdout closed unexpectedly"
        }
    }
}

/// Run a one-shot subprocess and collect its full stdout. Throws if exit != 0.
func runProcess(_ launchPath: String, args: [String], env: [String: String]? = nil) async throws -> Data {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        if let env { proc.environment = env }

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        proc.terminationHandler = { p in
            let out = outPipe.fileHandleForReading.readDataToEndOfFile()
            let err = errPipe.fileHandleForReading.readDataToEndOfFile()
            if p.terminationStatus == 0 {
                cont.resume(returning: out)
            } else {
                let errStr = String(data: err, encoding: .utf8) ?? ""
                cont.resume(throwing: ProcessError.nonZeroExit(code: p.terminationStatus, stderr: errStr))
            }
        }

        do {
            try proc.run()
        } catch {
            cont.resume(throwing: ProcessError.launchFailed(underlying: error))
        }
    }
}

/// Resolve a binary on PATH (e.g. "kubectl", "claude") to an absolute path.
func resolveBinary(_ name: String) -> String? {
    let env = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
    for dir in env.split(separator: ":") {
        let candidate = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return nil
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Util/ProcessAsync.swift
git commit -m "feat: add Process async helpers"
```

---

### Task 4: KubeTypes — minimal Pod + ObjectMeta

**Files:**
- Create: `Sources/ClaudeK8s/Cluster/KubeTypes.swift`
- Create: `Tests/ClaudeK8sTests/KubeTypesDecodingTests.swift`
- Create: `Tests/ClaudeK8sTests/Fixtures/pods-list.json`

- [ ] **Step 1: Create a fixture from a real `kubectl get pods` response**

`Tests/ClaudeK8sTests/Fixtures/pods-list.json` (this is a slimmed-down realistic response; do **not** include real cluster data — these are placeholders):

```json
{
  "kind": "List",
  "items": [
    {
      "metadata": {
        "name": "fieldnotes-7d9c8b6f5d-xk2vp",
        "namespace": "default",
        "uid": "11111111-2222-3333-4444-555555555555",
        "creationTimestamp": "2026-05-20T10:00:00Z",
        "labels": { "app": "fieldnotes" }
      },
      "spec": {
        "nodeName": "k8s",
        "containers": [{ "name": "nginx", "image": "ghcr.io/tyrelchambers/fieldnotes:latest" }]
      },
      "status": {
        "phase": "Running",
        "podIP": "10.42.0.42",
        "containerStatuses": [
          { "name": "nginx", "ready": true, "restartCount": 0,
            "state": { "running": { "startedAt": "2026-05-20T10:00:01Z" } } }
        ]
      }
    },
    {
      "metadata": {
        "name": "postiz-844c9f-abcde",
        "namespace": "default",
        "uid": "66666666-7777-8888-9999-aaaaaaaaaaaa",
        "creationTimestamp": "2026-05-22T15:30:00Z",
        "labels": { "app": "postiz" }
      },
      "spec": {
        "nodeName": "k3s-slave",
        "containers": [{ "name": "postiz", "image": "ghcr.io/gitroomhq/postiz-app:latest" }]
      },
      "status": {
        "phase": "Pending",
        "containerStatuses": [
          { "name": "postiz", "ready": false, "restartCount": 3,
            "state": { "waiting": { "reason": "CrashLoopBackOff" } } }
        ]
      }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`Tests/ClaudeK8sTests/KubeTypesDecodingTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class KubeTypesDecodingTests: XCTestCase {
    func test_decodePodList_extractsBothPods() throws {
        let url = Bundle.module.url(forResource: "pods-list", withExtension: "json")!
        let data = try Data(contentsOf: url)
        let list = try JSONDecoder().decode(KubeList<Pod>.self, from: data)

        XCTAssertEqual(list.items.count, 2)
        XCTAssertEqual(list.items[0].metadata.name, "fieldnotes-7d9c8b6f5d-xk2vp")
        XCTAssertEqual(list.items[0].status?.phase, "Running")
        XCTAssertEqual(list.items[0].spec?.nodeName, "k8s")

        XCTAssertEqual(list.items[1].metadata.name, "postiz-844c9f-abcde")
        XCTAssertEqual(list.items[1].status?.phase, "Pending")
        XCTAssertEqual(list.items[1].status?.containerStatuses?.first?.state?.waiting?.reason, "CrashLoopBackOff")
    }
}
```

- [ ] **Step 3: Run test to verify it fails (KubeList/Pod undefined)**

Run: `swift test --filter KubeTypesDecodingTests`
Expected: build failure with "cannot find 'KubeList' / 'Pod' in scope".

- [ ] **Step 4: Implement KubeTypes**

`Sources/ClaudeK8s/Cluster/KubeTypes.swift`:

```swift
import Foundation

struct KubeList<T: Codable>: Codable {
    let items: [T]
}

struct ObjectMeta: Codable, Hashable {
    let name: String
    let namespace: String?
    let uid: String
    let creationTimestamp: Date?
    let labels: [String: String]?
}

struct Pod: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: PodSpec?
    let status: PodStatus?

    var id: String { metadata.uid }
}

struct PodSpec: Codable, Hashable {
    let nodeName: String?
    let containers: [Container]
}

struct Container: Codable, Hashable {
    let name: String
    let image: String?
}

struct PodStatus: Codable, Hashable {
    let phase: String?
    let podIP: String?
    let containerStatuses: [ContainerStatus]?
}

struct ContainerStatus: Codable, Hashable {
    let name: String
    let ready: Bool
    let restartCount: Int
    let state: ContainerState?
}

struct ContainerState: Codable, Hashable {
    let running: RunningState?
    let waiting: WaitingState?
    let terminated: TerminatedState?
}

struct RunningState: Codable, Hashable { let startedAt: Date? }
struct WaitingState: Codable, Hashable { let reason: String?; let message: String? }
struct TerminatedState: Codable, Hashable {
    let reason: String?
    let message: String?
    let exitCode: Int?
}
```

- [ ] **Step 5: Configure JSON decoder for ISO8601 dates**

The default `JSONDecoder` doesn't parse Kubernetes' ISO8601 timestamps. Add an extension:

Append to `Sources/ClaudeK8s/Cluster/KubeTypes.swift`:

```swift
extension JSONDecoder {
    static var kube: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
```

And update the test to use `JSONDecoder.kube`:

```swift
let list = try JSONDecoder.kube.decode(KubeList<Pod>.self, from: data)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `swift test --filter KubeTypesDecodingTests`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Sources/ClaudeK8s/Cluster/KubeTypes.swift Tests/ClaudeK8sTests/KubeTypesDecodingTests.swift Tests/ClaudeK8sTests/Fixtures/pods-list.json
git commit -m "feat: minimal Pod + ObjectMeta Codable types"
```

---

### Task 5: KubectlStreamParser — streaming JSON value tokenizer

This is the trickiest parser. `kubectl get … --watch -o json` outputs JSON values back-to-back, **pretty-printed** (not JSONL), so we can't split on newlines. We need a brace-counting tokenizer that respects strings and escapes.

**Files:**
- Create: `Sources/ClaudeK8s/Cluster/KubectlStreamParser.swift`
- Create: `Tests/ClaudeK8sTests/KubectlStreamParserTests.swift`
- Create: `Tests/ClaudeK8sTests/Fixtures/watch-events-pretty.json`

- [ ] **Step 1: Create the multi-object pretty-printed fixture**

`Tests/ClaudeK8sTests/Fixtures/watch-events-pretty.json` — two pod objects back-to-back, pretty-printed, with strings that contain braces:

```json
{
    "kind": "Pod",
    "metadata": {
        "name": "fieldnotes-7d9c8b6f5d-xk2vp",
        "namespace": "default",
        "annotations": {
            "config": "{\"nested\":\"value with }\"}"
        }
    },
    "status": { "phase": "Running" }
}{
    "kind": "Pod",
    "metadata": {
        "name": "postiz-844c9f-abcde",
        "namespace": "default"
    },
    "status": { "phase": "Pending" }
}
```

- [ ] **Step 2: Write the failing test**

`Tests/ClaudeK8sTests/KubectlStreamParserTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class KubectlStreamParserTests: XCTestCase {
    func test_splitsTwoPrettyPrintedObjects() throws {
        let url = Bundle.module.url(forResource: "watch-events-pretty", withExtension: "json")!
        let data = try Data(contentsOf: url)

        var parser = KubectlStreamParser()
        var values: [Data] = []
        parser.feed(data) { values.append($0) }

        XCTAssertEqual(values.count, 2)

        // Each emitted Data must be standalone-decodable.
        let first = try JSONSerialization.jsonObject(with: values[0]) as? [String: Any]
        XCTAssertEqual(first?["kind"] as? String, "Pod")

        let second = try JSONSerialization.jsonObject(with: values[1]) as? [String: Any]
        let meta = second?["metadata"] as? [String: Any]
        XCTAssertEqual(meta?["name"] as? String, "postiz-844c9f-abcde")
    }

    func test_handlesPartialThenComplete() {
        var parser = KubectlStreamParser()
        var values: [Data] = []
        parser.feed(Data("{\"a\":1}{\"b\"".utf8)) { values.append($0) }
        XCTAssertEqual(values.count, 1)
        parser.feed(Data(":2}".utf8)) { values.append($0) }
        XCTAssertEqual(values.count, 2)
    }

    func test_handlesStringWithEscapedBraces() {
        var parser = KubectlStreamParser()
        var values: [Data] = []
        parser.feed(Data(#"{"s":"a\"}b"}"#.utf8)) { values.append($0) }
        XCTAssertEqual(values.count, 1)
        XCTAssertEqual(values[0], Data(#"{"s":"a\"}b"}"#.utf8))
    }
}
```

- [ ] **Step 3: Run tests to verify they fail (parser undefined)**

Run: `swift test --filter KubectlStreamParserTests`
Expected: build failure.

- [ ] **Step 4: Implement the parser**

`Sources/ClaudeK8s/Cluster/KubectlStreamParser.swift`:

```swift
import Foundation

/// Streaming JSON value tokenizer.
/// Splits a byte stream containing zero or more back-to-back JSON values (possibly
/// pretty-printed with embedded whitespace and braces inside strings) into individual
/// `Data` chunks, each of which is a standalone-decodable JSON value.
///
/// Handles:
/// - Pretty-printed objects (whitespace between fields)
/// - Strings containing braces and escaped quotes
/// - Partial input across multiple `feed(_:)` calls
struct KubectlStreamParser {
    private var buffer = Data()
    private var depth = 0
    private var inString = false
    private var escaped = false
    private var valueStart: Int? = nil

    mutating func feed(_ chunk: Data, emit: (Data) -> Void) {
        let baseOffset = buffer.count
        buffer.append(chunk)

        var i = baseOffset
        while i < buffer.count {
            let b = buffer[i]
            if escaped {
                escaped = false
            } else if inString {
                if b == 0x5C /* \ */ { escaped = true }
                else if b == 0x22 /* " */ { inString = false }
            } else {
                switch b {
                case 0x22: inString = true                              // "
                case 0x7B: // {
                    if depth == 0 { valueStart = i }
                    depth += 1
                case 0x7D: // }
                    depth -= 1
                    if depth == 0, let start = valueStart {
                        let value = buffer.subdata(in: start..<(i + 1))
                        emit(value)
                        valueStart = nil
                    }
                default: break
                }
            }
            i += 1
        }

        // Compact: drop everything up to the start of an in-progress value
        // (or the whole buffer if we're between values).
        if depth == 0 {
            buffer.removeAll(keepingCapacity: true)
        } else if let start = valueStart, start > 0 {
            buffer.removeFirst(start)
            valueStart = 0
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `swift test --filter KubectlStreamParserTests`
Expected: all three tests PASS.

- [ ] **Step 6: Commit**

```bash
git add Sources/ClaudeK8s/Cluster/KubectlStreamParser.swift Tests/ClaudeK8sTests/KubectlStreamParserTests.swift Tests/ClaudeK8sTests/Fixtures/watch-events-pretty.json
git commit -m "feat: streaming JSON value tokenizer for kubectl --watch -o json"
```

---

### Task 6: WatchEvent type

`kubectl get … --watch -o json` emits raw object updates without an explicit event type wrapper. The "added vs modified vs deleted" distinction comes from `--output-watch-events=true`, which wraps each value in `{"type": "ADDED|MODIFIED|DELETED", "object": {...}}`. We'll use that flag.

**Files:**
- Create: `Sources/ClaudeK8s/Cluster/WatchEvent.swift`

- [ ] **Step 1: Write the type**

`Sources/ClaudeK8s/Cluster/WatchEvent.swift`:

```swift
import Foundation

enum WatchEventType: String, Codable {
    case added = "ADDED"
    case modified = "MODIFIED"
    case deleted = "DELETED"
    case error = "ERROR"
    case bookmark = "BOOKMARK"
}

struct WatchEvent<T: Codable>: Codable {
    let type: WatchEventType
    let object: T
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Cluster/WatchEvent.swift
git commit -m "feat: typed kubectl watch event"
```

---

### Task 7: KubectlClient — one-shot get + watch stream

**Files:**
- Create: `Sources/ClaudeK8s/Cluster/KubectlClient.swift`

- [ ] **Step 1: Write the one-shot get**

`Sources/ClaudeK8s/Cluster/KubectlClient.swift`:

```swift
import Foundation

enum KubectlClientError: Error, CustomStringConvertible {
    case kubectlNotFound
    case decoding(underlying: Error, raw: String)

    var description: String {
        switch self {
        case .kubectlNotFound: return "kubectl not found on PATH"
        case .decoding(let err, let raw):
            return "kubectl output decode failed: \(err)\nraw: \(raw.prefix(500))"
        }
    }
}

actor KubectlClient {
    nonisolated let kubectl: String   // immutable, accessed sync from MainWindow handoff
    private(set) var context: String?

    init(context: String? = nil) throws {
        guard let path = resolveBinary("kubectl") else {
            throw KubectlClientError.kubectlNotFound
        }
        self.kubectl = path
        self.context = context
    }

    func setContext(_ ctx: String?) { self.context = ctx }

    private func contextArgs() -> [String] {
        context.map { ["--context", $0] } ?? []
    }

    /// One-shot get.
    func getList<T: Codable>(_ resource: String, namespace: String? = nil, type: T.Type = T.self) async throws -> KubeList<T> {
        var args = contextArgs() + ["get", resource, "-o", "json"]
        if let ns = namespace { args.append(contentsOf: ["-n", ns]) } else { args.append("-A") }

        let data = try await runProcess(kubectl, args: args)
        do {
            return try JSONDecoder.kube.decode(KubeList<T>.self, from: data)
        } catch {
            throw KubectlClientError.decoding(underlying: error, raw: String(data: data, encoding: .utf8) ?? "")
        }
    }

    /// Long-lived watch. Returns an AsyncThrowingStream of typed WatchEvent values.
    /// On crash, the stream finishes — callers are responsible for restart backoff.
    nonisolated func watch<T: Codable & Sendable>(_ resource: String, namespace: String? = nil, type: T.Type = T.self) -> AsyncThrowingStream<WatchEvent<T>, Error> {
        AsyncThrowingStream { continuation in
            Task {
                let ctxArgs = await contextArgs()
                var args = ctxArgs + ["get", resource, "--watch", "--output-watch-events=true", "-o", "json"]
                if let ns = namespace { args.append(contentsOf: ["-n", ns]) } else { args.append("-A") }

                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: kubectl)
                proc.arguments = args
                let outPipe = Pipe()
                let errPipe = Pipe()
                proc.standardOutput = outPipe
                proc.standardError = errPipe

                continuation.onTermination = { _ in
                    if proc.isRunning { proc.terminate() }
                }

                var parser = KubectlStreamParser()
                outPipe.fileHandleForReading.readabilityHandler = { handle in
                    let chunk = handle.availableData
                    guard !chunk.isEmpty else { return }
                    parser.feed(chunk) { valueData in
                        do {
                            let event = try JSONDecoder.kube.decode(WatchEvent<T>.self, from: valueData)
                            continuation.yield(event)
                        } catch {
                            continuation.finish(throwing: KubectlClientError.decoding(underlying: error, raw: String(data: valueData, encoding: .utf8) ?? ""))
                        }
                    }
                }

                proc.terminationHandler = { _ in
                    outPipe.fileHandleForReading.readabilityHandler = nil
                    continuation.finish()
                }

                do {
                    try proc.run()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Cluster/KubectlClient.swift
git commit -m "feat: KubectlClient with one-shot get and watch stream"
```

---

### Task 8: KubeconfigParser

**Files:**
- Create: `Sources/ClaudeK8s/Cluster/KubeconfigParser.swift`
- Create: `Tests/ClaudeK8sTests/KubeconfigParserTests.swift`
- Create: `Tests/ClaudeK8sTests/Fixtures/kubeconfig-min.yaml`

- [ ] **Step 1: Create the fixture**

`Tests/ClaudeK8sTests/Fixtures/kubeconfig-min.yaml`:

```yaml
apiVersion: v1
kind: Config
current-context: homelab
contexts:
  - name: homelab
    context:
      cluster: homelab-cluster
      user: tyrel
      namespace: default
  - name: prod
    context:
      cluster: prod-cluster
      user: tyrel
clusters:
  - name: homelab-cluster
    cluster:
      server: https://100.96.213.121:6443
users:
  - name: tyrel
    user:
      client-certificate-data: REDACTED
      client-key-data: REDACTED
```

- [ ] **Step 2: Write the failing test**

`Tests/ClaudeK8sTests/KubeconfigParserTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class KubeconfigParserTests: XCTestCase {
    func test_parsesContextsAndCurrent() throws {
        let url = Bundle.module.url(forResource: "kubeconfig-min", withExtension: "yaml")!
        let yaml = try String(contentsOf: url)

        let config = try KubeconfigParser.parse(yaml)

        XCTAssertEqual(config.currentContext, "homelab")
        XCTAssertEqual(config.contexts.count, 2)
        XCTAssertEqual(config.contexts.map(\.name).sorted(), ["homelab", "prod"])
        XCTAssertEqual(config.contexts.first(where: { $0.name == "homelab" })?.namespace, "default")
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `swift test --filter KubeconfigParserTests`
Expected: build failure (`KubeconfigParser` undefined).

- [ ] **Step 4: Implement**

`Sources/ClaudeK8s/Cluster/KubeconfigParser.swift`:

```swift
import Foundation
import Yams

struct KubeContext: Hashable, Identifiable {
    let name: String
    let cluster: String
    let user: String
    let namespace: String?
    var id: String { name }
}

struct Kubeconfig {
    let currentContext: String?
    let contexts: [KubeContext]
}

enum KubeconfigParser {
    enum ParseError: Error { case malformed(String) }

    static func parse(_ yaml: String) throws -> Kubeconfig {
        guard let root = try Yams.load(yaml: yaml) as? [String: Any] else {
            throw ParseError.malformed("top-level not a map")
        }
        let current = root["current-context"] as? String
        let entries = (root["contexts"] as? [[String: Any]]) ?? []

        let contexts: [KubeContext] = entries.compactMap { entry in
            guard let name = entry["name"] as? String,
                  let inner = entry["context"] as? [String: Any],
                  let cluster = inner["cluster"] as? String,
                  let user = inner["user"] as? String else { return nil }
            return KubeContext(
                name: name,
                cluster: cluster,
                user: user,
                namespace: inner["namespace"] as? String
            )
        }
        return Kubeconfig(currentContext: current, contexts: contexts)
    }

    static func loadDefault() throws -> Kubeconfig {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let path = home.appendingPathComponent(".kube/config")
        let yaml = try String(contentsOf: path)
        return try parse(yaml)
    }
}
```

- [ ] **Step 5: Run tests**

Run: `swift test --filter KubeconfigParserTests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Sources/ClaudeK8s/Cluster/KubeconfigParser.swift Tests/ClaudeK8sTests/KubeconfigParserTests.swift Tests/ClaudeK8sTests/Fixtures/kubeconfig-min.yaml
git commit -m "feat: kubeconfig YAML parser"
```

---

### Task 9: ClusterContextManager

**Files:**
- Create: `Sources/ClaudeK8s/Cluster/ClusterContextManager.swift`

- [ ] **Step 1: Write the manager**

`Sources/ClaudeK8s/Cluster/ClusterContextManager.swift`:

```swift
import Foundation
import Observation

@Observable
final class ClusterContextManager {
    var available: [KubeContext] = []
    var active: KubeContext? = nil
    var loadError: String? = nil

    func reload() {
        do {
            let cfg = try KubeconfigParser.loadDefault()
            self.available = cfg.contexts
            self.active = cfg.contexts.first(where: { $0.name == cfg.currentContext }) ?? cfg.contexts.first
            self.loadError = nil
        } catch {
            self.loadError = "\(error)"
        }
    }

    func setActive(_ context: KubeContext) {
        self.active = context
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Cluster/ClusterContextManager.swift
git commit -m "feat: cluster context manager"
```

---

### Task 10: PodsViewModel

**Files:**
- Create: `Sources/ClaudeK8s/Panels/Pods/PodsViewModel.swift`

- [ ] **Step 1: Write the view model**

`Sources/ClaudeK8s/Panels/Pods/PodsViewModel.swift`:

```swift
import Foundation
import Observation

@Observable
final class PodsViewModel {
    var pods: [Pod] = []
    var error: String? = nil
    var isLoading = false

    private var watchTask: Task<Void, Never>?
    private var client: KubectlClient?

    func start(context: String?) {
        watchTask?.cancel()
        do {
            let c = try KubectlClient(context: context)
            self.client = c
            self.isLoading = true
            self.error = nil

            watchTask = Task { [weak self] in
                // Initial list seed
                do {
                    let list = try await c.getList("pods", type: Pod.self)
                    await MainActor.run { self?.pods = list.items; self?.isLoading = false }
                } catch {
                    await MainActor.run { self?.error = "\(error)"; self?.isLoading = false }
                }

                // Watch for changes
                let stream = c.watch("pods", type: Pod.self)
                do {
                    for try await event in stream {
                        if Task.isCancelled { break }
                        await MainActor.run { self?.apply(event) }
                    }
                } catch {
                    await MainActor.run { self?.error = "\(error)" }
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
    }

    private func apply(_ event: WatchEvent<Pod>) {
        switch event.type {
        case .added, .modified:
            if let idx = pods.firstIndex(where: { $0.metadata.uid == event.object.metadata.uid }) {
                pods[idx] = event.object
            } else {
                pods.append(event.object)
            }
        case .deleted:
            pods.removeAll { $0.metadata.uid == event.object.metadata.uid }
        case .error, .bookmark:
            break
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Panels/Pods/PodsViewModel.swift
git commit -m "feat: PodsViewModel with watch reconciliation"
```

---

### Task 11: PodsPanel SwiftUI view

**Files:**
- Create: `Sources/ClaudeK8s/Panels/Pods/PodsPanel.swift`
- Create: `Sources/ClaudeK8s/Panels/PanelKind.swift`

- [ ] **Step 1: Add PanelKind enum**

`Sources/ClaudeK8s/Panels/PanelKind.swift`:

```swift
import Foundation

enum PanelKind: Hashable {
    case pods
    // .logs, .alerts, .nodes added in follow-up plans
}
```

- [ ] **Step 2: Write the PodsPanel view**

`Sources/ClaudeK8s/Panels/Pods/PodsPanel.swift`:

```swift
import SwiftUI

struct PodsPanel: View {
    @Bindable var contextManager: ClusterContextManager
    @State private var viewModel = PodsViewModel()
    @State private var selection: Pod.ID? = nil

    let onAskClaude: (Pod) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Pods").font(.headline)
                Spacer()
                if viewModel.isLoading { ProgressView().controlSize(.small) }
                Text("\(viewModel.pods.count)").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            if let err = viewModel.error {
                Text(err).font(.caption).foregroundStyle(.red).padding(.horizontal, 12)
            }

            Table(viewModel.pods, selection: $selection) {
                TableColumn("Namespace") { Text($0.metadata.namespace ?? "—") }
                TableColumn("Name") { Text($0.metadata.name) }
                TableColumn("Status") { pod in
                    Text(pod.status?.phase ?? "—")
                        .foregroundStyle(statusColor(pod))
                }
                TableColumn("Restarts") { pod in
                    Text("\(pod.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0)")
                }
                TableColumn("Node") { Text($0.spec?.nodeName ?? "—") }
            }
            .contextMenu(forSelectionType: Pod.ID.self) { ids in
                if let id = ids.first, let pod = viewModel.pods.first(where: { $0.id == id }) {
                    Button("Ask Claude about this pod") { onAskClaude(pod) }
                }
            }
        }
        .onAppear { viewModel.start(context: contextManager.active?.name) }
        .onDisappear { viewModel.stop() }
        .onChange(of: contextManager.active) { _, newValue in
            viewModel.start(context: newValue?.name)
        }
    }

    private func statusColor(_ pod: Pod) -> Color {
        switch pod.status?.phase {
        case "Running": return .green
        case "Pending": return .yellow
        case "Failed": return .red
        default: return .secondary
        }
    }
}
```

- [ ] **Step 3: Wire PodsPanel into MainWindow (replace the placeholder)**

Edit `Sources/ClaudeK8s/Shell/MainWindow.swift` to use the actual panel:

```swift
import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var pendingHandoff: String? = nil  // wired in Task 17

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip()

                HSplitView {
                    PodsPanel(contextManager: contextManager) { pod in
                        // Placeholder — Task 17 will wire to ChatViewModel
                        pendingHandoff = "Ask Claude about pod \(pod.metadata.name)"
                    }
                    .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))

                    VStack {
                        Text(pendingHandoff ?? "Chat goes here").foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
        .onAppear { contextManager.reload() }
    }
}
```

- [ ] **Step 4: Smoke test against live cluster**

Run: `swift run ClaudeK8s`
Expected: window opens, after ~1s the pod list populates from your homelab cluster. Right-click a pod → "Ask Claude about this pod" should show the placeholder text in the right pane.

- [ ] **Step 5: Commit**

```bash
git add Sources/ClaudeK8s/Panels/ Sources/ClaudeK8s/Shell/MainWindow.swift
git commit -m "feat: PodsPanel with live watch and Ask Claude action"
```

---

### Task 12: StreamJsonParser — line-delimited JSON for claude

Claude Code's `--output-format stream-json` emits one JSON object per **newline** (true JSONL). Much simpler than the kubectl parser.

**Files:**
- Create: `Sources/ClaudeK8s/Chat/StreamJsonParser.swift`
- Create: `Tests/ClaudeK8sTests/StreamJsonParserTests.swift`
- Create: `Tests/ClaudeK8sTests/Fixtures/claude-stream.jsonl`

- [ ] **Step 1: Create a fixture from real `claude` output**

To capture a real fixture later, run: `claude --output-format stream-json -p "say hi" > Tests/ClaudeK8sTests/Fixtures/claude-stream.jsonl`. For this task, hand-write a minimal fixture matching the documented shape:

`Tests/ClaudeK8sTests/Fixtures/claude-stream.jsonl`:

```
{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"claude-opus-4-7"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" world"}]}}
{"type":"result","subtype":"success","session_id":"sess-abc-123","total_cost_usd":0.001}
```

- [ ] **Step 2: Write the failing test**

`Tests/ClaudeK8sTests/StreamJsonParserTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class StreamJsonParserTests: XCTestCase {
    func test_splitsByNewlinesIncludingPartials() {
        var parser = StreamJsonParser()
        var lines: [String] = []
        parser.feed("{\"a\":1}\n{\"b".data(using: .utf8)!) { lines.append(String(data: $0, encoding: .utf8)!) }
        XCTAssertEqual(lines, ["{\"a\":1}"])
        parser.feed("\":2}\n".data(using: .utf8)!) { lines.append(String(data: $0, encoding: .utf8)!) }
        XCTAssertEqual(lines, ["{\"a\":1}", "{\"b\":2}"])
    }

    func test_parsesFixtureFile() throws {
        let url = Bundle.module.url(forResource: "claude-stream", withExtension: "jsonl")!
        let data = try Data(contentsOf: url)

        var parser = StreamJsonParser()
        var lines: [Data] = []
        parser.feed(data) { lines.append($0) }
        XCTAssertEqual(lines.count, 4)
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `swift test --filter StreamJsonParserTests`
Expected: build failure.

- [ ] **Step 4: Implement the parser**

`Sources/ClaudeK8s/Chat/StreamJsonParser.swift`:

```swift
import Foundation

/// Line-delimited JSON parser. Each `\n` terminates a value.
struct StreamJsonParser {
    private var buffer = Data()

    mutating func feed(_ chunk: Data, emit: (Data) -> Void) {
        buffer.append(chunk)
        while let newlineIdx = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<newlineIdx)
            buffer.removeSubrange(0..<(newlineIdx + 1))
            if !line.isEmpty {
                emit(line)
            }
        }
    }
}
```

- [ ] **Step 5: Run tests**

Run: `swift test --filter StreamJsonParserTests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Sources/ClaudeK8s/Chat/StreamJsonParser.swift Tests/ClaudeK8sTests/StreamJsonParserTests.swift Tests/ClaudeK8sTests/Fixtures/claude-stream.jsonl
git commit -m "feat: line-delimited JSON stream parser for claude"
```

---

### Task 13: ClaudeEvent

**Files:**
- Create: `Sources/ClaudeK8s/Chat/ClaudeEvent.swift`

- [ ] **Step 1: Write the event enum**

Claude Code's stream-json emits a small set of envelope shapes. We decode only the fields we need; everything else is ignored.

`Sources/ClaudeK8s/Chat/ClaudeEvent.swift`:

```swift
import Foundation

enum ClaudeEvent {
    case systemInit(sessionId: String, model: String?)
    case assistantText(text: String)
    case toolUse(id: String, name: String, input: [String: Any])
    case permissionRequest(toolUseId: String, toolName: String, input: [String: Any])
    case result(sessionId: String, costUSD: Double?)
    case unknown(raw: String)
}

enum ClaudeEventDecoder {
    /// Best-effort decode a single stream-json line into a ClaudeEvent.
    /// Tolerant of schema drift: unknown shapes return .unknown(raw:).
    static func decode(_ line: Data) -> ClaudeEvent {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            return .unknown(raw: String(data: line, encoding: .utf8) ?? "")
        }
        let type = (obj["type"] as? String) ?? ""
        let subtype = (obj["subtype"] as? String) ?? ""

        switch (type, subtype) {
        case ("system", "init"):
            return .systemInit(
                sessionId: (obj["session_id"] as? String) ?? "",
                model: obj["model"] as? String
            )

        case ("assistant", _):
            let message = obj["message"] as? [String: Any]
            let content = message?["content"] as? [[String: Any]] ?? []
            // Concatenate any text blocks; surface tool_use separately.
            var text = ""
            var toolUses: [ClaudeEvent] = []
            for block in content {
                let bt = block["type"] as? String
                if bt == "text", let t = block["text"] as? String { text += t }
                else if bt == "tool_use",
                        let id = block["id"] as? String,
                        let name = block["name"] as? String {
                    let input = (block["input"] as? [String: Any]) ?? [:]
                    toolUses.append(.toolUse(id: id, name: name, input: input))
                }
            }
            // If only text, return one event; if a tool_use was emitted alongside text,
            // callers should expect text first then handle the tool via separate decoding paths.
            if !toolUses.isEmpty, text.isEmpty {
                return toolUses[0]
            } else {
                return .assistantText(text: text)
            }

        case ("result", _):
            return .result(
                sessionId: (obj["session_id"] as? String) ?? "",
                costUSD: obj["total_cost_usd"] as? Double
            )

        case ("permission_request", _):
            return .permissionRequest(
                toolUseId: (obj["tool_use_id"] as? String) ?? "",
                toolName: (obj["tool_name"] as? String) ?? "",
                input: (obj["input"] as? [String: Any]) ?? [:]
            )

        default:
            return .unknown(raw: String(data: line, encoding: .utf8) ?? "")
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Chat/ClaudeEvent.swift
git commit -m "feat: typed ClaudeEvent + tolerant decoder"
```

---

### Task 14: ClaudeSession — subprocess lifecycle

**Files:**
- Create: `Sources/ClaudeK8s/Chat/ClaudeSession.swift`

- [ ] **Step 1: Write the session class**

`Sources/ClaudeK8s/Chat/ClaudeSession.swift`:

```swift
import Foundation

enum ClaudeSessionError: Error, CustomStringConvertible {
    case claudeNotFound
    case notRunning
    var description: String {
        switch self {
        case .claudeNotFound: return "claude not found on PATH (install Claude Code CLI first)"
        case .notRunning: return "claude process is not running"
        }
    }
}

actor ClaudeSession {
    let binaryPath: String
    private var proc: Process?
    private var stdinPipe: Pipe?
    private var continuation: AsyncStream<ClaudeEvent>.Continuation?
    var sessionId: String?

    init(resumingSessionId: String? = nil) throws {
        guard let path = resolveBinary("claude") else {
            throw ClaudeSessionError.claudeNotFound
        }
        self.binaryPath = path
        self.sessionId = resumingSessionId
    }

    /// Start the subprocess. Returns an AsyncStream of events.
    func start() -> AsyncStream<ClaudeEvent> {
        AsyncStream { (cont: AsyncStream<ClaudeEvent>.Continuation) in
            self.continuation = cont

            let p = Process()
            p.executableURL = URL(fileURLWithPath: binaryPath)
            var args = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]
            if let sid = sessionId { args.append(contentsOf: ["--resume", sid]) }
            p.arguments = args

            let outPipe = Pipe()
            let errPipe = Pipe()
            let inPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = errPipe
            p.standardInput = inPipe
            self.stdinPipe = inPipe

            var parser = StreamJsonParser()
            outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let chunk = handle.availableData
                guard !chunk.isEmpty else { return }
                parser.feed(chunk) { line in
                    let event = ClaudeEventDecoder.decode(line)
                    if case .systemInit(let sid, _) = event {
                        Task { await self?.recordSessionId(sid) }
                    }
                    cont.yield(event)
                }
            }

            p.terminationHandler = { _ in
                outPipe.fileHandleForReading.readabilityHandler = nil
                cont.finish()
            }

            do {
                try p.run()
                self.proc = p
            } catch {
                cont.finish()
            }

            cont.onTermination = { [weak self] _ in
                Task { await self?.terminate() }
            }
        }
    }

    private func recordSessionId(_ sid: String) {
        self.sessionId = sid
    }

    /// Send a user message as stream-json input.
    func send(_ userText: String) throws {
        guard let pipe = stdinPipe else { throw ClaudeSessionError.notRunning }
        let payload: [String: Any] = [
            "type": "user",
            "message": [
                "role": "user",
                "content": [["type": "text", "text": userText]]
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        pipe.fileHandleForWriting.write(data)
        pipe.fileHandleForWriting.write(Data("\n".utf8))
    }

    /// Approve or deny a pending permission request.
    func answerPermission(toolUseId: String, allow: Bool) throws {
        guard let pipe = stdinPipe else { throw ClaudeSessionError.notRunning }
        let payload: [String: Any] = [
            "type": "permission_decision",
            "tool_use_id": toolUseId,
            "decision": allow ? "allow" : "deny"
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        pipe.fileHandleForWriting.write(data)
        pipe.fileHandleForWriting.write(Data("\n".utf8))
    }

    func terminate() {
        if let p = proc, p.isRunning { p.terminate() }
        try? stdinPipe?.fileHandleForWriting.close()
        proc = nil
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Chat/ClaudeSession.swift
git commit -m "feat: ClaudeSession subprocess lifecycle + send/permission API"
```

---

### Task 15: ChatViewModel

**Files:**
- Create: `Sources/ClaudeK8s/Chat/ChatViewModel.swift`

- [ ] **Step 1: Write the view model**

`Sources/ClaudeK8s/Chat/ChatViewModel.swift`:

```swift
import Foundation
import Observation

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: Role
    var text: String

    enum Role { case user, assistant, system }
}

struct PendingPermission: Identifiable {
    let id = UUID()
    let toolUseId: String
    let toolName: String
    let inputDescription: String
}

@MainActor
@Observable
final class ChatViewModel {
    var messages: [ChatMessage] = []
    var inputText: String = ""
    var isStreaming = false
    var pendingPermission: PendingPermission? = nil
    var sessionId: String? = nil
    var error: String? = nil

    private var session: ClaudeSession?
    private var pumpTask: Task<Void, Never>?

    func start(resumingSessionId: String? = nil) {
        stop()
        do {
            let s = try ClaudeSession(resumingSessionId: resumingSessionId)
            self.session = s
            self.sessionId = resumingSessionId
            pumpTask = Task { [weak self] in
                let eventStream = await s.start()
                for await event in eventStream {
                    await self?.handle(event)
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
        Task { await session?.terminate() }
        session = nil
    }

    /// Send a free-form user message.
    func send(_ text: String) {
        guard let session else { return }
        messages.append(ChatMessage(role: .user, text: text))
        isStreaming = true
        Task { try? await session.send(text) }
    }

    /// Send a prebuilt context-handoff prompt (e.g. "Ask Claude about this pod").
    func sendHandoff(_ prompt: String) {
        send(prompt)
    }

    func answerPermission(allow: Bool) {
        guard let pending = pendingPermission, let session else { return }
        self.pendingPermission = nil
        Task { try? await session.answerPermission(toolUseId: pending.toolUseId, allow: allow) }
    }

    func handle(_ event: ClaudeEvent) {
        switch event {
        case .systemInit(let sid, _):
            sessionId = sid
        case .assistantText(let chunk):
            if var last = messages.last, last.role == .assistant {
                last.text += chunk
                messages[messages.count - 1] = last
            } else {
                messages.append(ChatMessage(role: .assistant, text: chunk))
            }
        case .toolUse(let id, let name, let input):
            // Render as a system-style message; the real permission flow uses .permissionRequest.
            let desc = (try? String(data: JSONSerialization.data(withJSONObject: input), encoding: .utf8)) ?? "{}"
            messages.append(ChatMessage(role: .system, text: "🔧 tool: \(name) (id=\(id))\n\(desc.prefix(200))"))
        case .permissionRequest(let toolUseId, let toolName, let input):
            let desc = (try? String(data: JSONSerialization.data(withJSONObject: input), encoding: .utf8)) ?? "{}"
            pendingPermission = PendingPermission(toolUseId: toolUseId, toolName: toolName, inputDescription: desc)
        case .result:
            isStreaming = false
        case .unknown:
            break
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add Sources/ClaudeK8s/Chat/ChatViewModel.swift
git commit -m "feat: ChatViewModel with streaming aggregation"
```

---

### Task 16: ChatView SwiftUI + PermissionSheet

**Files:**
- Create: `Sources/ClaudeK8s/Chat/ChatView.swift`
- Create: `Sources/ClaudeK8s/Chat/PermissionSheet.swift`
- Create: `Sources/ClaudeK8s/Chat/MessageRenderer.swift`

- [ ] **Step 1: Markdown renderer helper**

`Sources/ClaudeK8s/Chat/MessageRenderer.swift`:

```swift
import Foundation
import SwiftUI

enum MessageRenderer {
    static func render(_ text: String) -> AttributedString {
        // AttributedString(markdown:) is line-oriented; for streaming text it works
        // well enough for v1. Fenced code blocks render as plain text.
        if let s = try? AttributedString(markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return s
        }
        return AttributedString(text)
    }
}
```

- [ ] **Step 2: PermissionSheet view**

`Sources/ClaudeK8s/Chat/PermissionSheet.swift`:

```swift
import SwiftUI

struct PermissionSheet: View {
    let pending: PendingPermission
    let onApprove: () -> Void
    let onDeny: () -> Void

    private static let destructivePattern = #/(?i)\b(delete|drain|destroy|rm\s+-rf|reset)\b/#

    private var isDestructive: Bool {
        (try? PermissionSheet.destructivePattern.firstMatch(in: pending.inputDescription)) != nil
    }

    @State private var acknowledged = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: isDestructive ? "exclamationmark.triangle.fill" : "wrench.and.screwdriver.fill")
                    .foregroundStyle(isDestructive ? .red : .blue)
                Text("Tool permission requested")
                    .font(.headline)
            }
            Text(pending.toolName).font(.title3).monospaced()
            ScrollView {
                Text(pending.inputDescription)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 200)
            .background(Color(NSColor.controlBackgroundColor))
            .cornerRadius(6)

            if isDestructive {
                Toggle("I understand this looks destructive", isOn: $acknowledged)
                    .toggleStyle(.checkbox)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("Deny", role: .cancel) { onDeny() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Approve") { onApprove() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isDestructive && !acknowledged)
                    .buttonStyle(.borderedProminent)
                    .tint(isDestructive ? .red : .accentColor)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}
```

- [ ] **Step 3: ChatView**

`Sources/ClaudeK8s/Chat/ChatView.swift`:

```swift
import SwiftUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Claude").font(.headline)
                if viewModel.isStreaming {
                    ProgressView().controlSize(.small)
                }
                Spacer()
                if let sid = viewModel.sessionId {
                    Text("session: \(sid.prefix(8))")
                        .font(.caption2).monospaced()
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(viewModel.messages) { msg in
                            MessageBubble(message: msg).id(msg.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    if let last = viewModel.messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            Divider()

            HStack(spacing: 8) {
                TextField("Ask Claude…", text: $viewModel.inputText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .onSubmit { sendInput() }
                Button("Send", action: sendInput)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(8)
        }
        .sheet(item: $viewModel.pendingPermission) { pending in
            PermissionSheet(
                pending: pending,
                onApprove: { viewModel.answerPermission(allow: true) },
                onDeny: { viewModel.answerPermission(allow: false) }
            )
        }
        .onAppear { viewModel.start() }
        .onDisappear { viewModel.stop() }
    }

    private func sendInput() {
        let text = viewModel.inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        viewModel.send(text)
        viewModel.inputText = ""
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            roleIcon
            VStack(alignment: .leading, spacing: 4) {
                Text(MessageRenderer.render(message.text))
                    .textSelection(.enabled)
            }
            .padding(8)
            .background(bg)
            .cornerRadius(8)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private var roleIcon: some View {
        switch message.role {
        case .user: Image(systemName: "person.crop.circle.fill").foregroundStyle(.blue)
        case .assistant: Image(systemName: "sparkles").foregroundStyle(.purple)
        case .system: Image(systemName: "gear").foregroundStyle(.secondary)
        }
    }

    private var bg: Color {
        switch message.role {
        case .user: return Color.blue.opacity(0.12)
        case .assistant: return Color.purple.opacity(0.08)
        case .system: return Color.secondary.opacity(0.10)
        }
    }
}
```

- [ ] **Step 4: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add Sources/ClaudeK8s/Chat/ChatView.swift Sources/ClaudeK8s/Chat/PermissionSheet.swift Sources/ClaudeK8s/Chat/MessageRenderer.swift
git commit -m "feat: ChatView, PermissionSheet, MessageRenderer"
```

---

### Task 17: PanelSelection + ContextHandoffBuilder

**Files:**
- Create: `Sources/ClaudeK8s/Handoff/PanelSelection.swift`
- Create: `Sources/ClaudeK8s/Handoff/ContextHandoffBuilder.swift`
- Create: `Tests/ClaudeK8sTests/ContextHandoffBuilderTests.swift`

- [ ] **Step 1: Write the PanelSelection enum**

`Sources/ClaudeK8s/Handoff/PanelSelection.swift`:

```swift
import Foundation

enum PanelSelection {
    case pod(Pod, describe: String, recentEvents: String)
    // .logSlice, .alert, .node added in follow-up plans
}
```

- [ ] **Step 2: Write the failing test**

`Tests/ClaudeK8sTests/ContextHandoffBuilderTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class ContextHandoffBuilderTests: XCTestCase {
    func test_podHandoffIncludesNameNamespaceAndDescribe() {
        let pod = Pod(
            metadata: ObjectMeta(
                name: "postiz-844c9f-abcde",
                namespace: "default",
                uid: "abc",
                creationTimestamp: nil,
                labels: ["app": "postiz"]
            ),
            spec: PodSpec(nodeName: "k3s-slave", containers: [Container(name: "postiz", image: "ghcr.io/x/y:latest")]),
            status: PodStatus(phase: "Pending", podIP: nil, containerStatuses: [
                ContainerStatus(name: "postiz", ready: false, restartCount: 3, state: ContainerState(
                    running: nil, waiting: WaitingState(reason: "CrashLoopBackOff", message: nil), terminated: nil
                ))
            ])
        )
        let describe = "Name: postiz-844c9f-abcde\nNamespace: default\nNode: k3s-slave/100.99.155.125\n..."
        let events = "10s    Warning   BackOff    pod/postiz-844c9f-abcde   Back-off restarting failed container"

        let prompt = ContextHandoffBuilder.build(.pod(pod, describe: describe, recentEvents: events))

        XCTAssertTrue(prompt.contains("postiz-844c9f-abcde"))
        XCTAssertTrue(prompt.contains("default"))
        XCTAssertTrue(prompt.contains("CrashLoopBackOff"))
        XCTAssertTrue(prompt.contains("kubectl describe"))
        XCTAssertTrue(prompt.contains("kubectl get events"))
        XCTAssertTrue(prompt.contains("BackOff"))
    }
}
```

- [ ] **Step 3: Run test, verify failure**

Run: `swift test --filter ContextHandoffBuilderTests`
Expected: build failure (`ContextHandoffBuilder` undefined).

- [ ] **Step 4: Implement**

`Sources/ClaudeK8s/Handoff/ContextHandoffBuilder.swift`:

```swift
import Foundation

enum ContextHandoffBuilder {
    static func build(_ selection: PanelSelection) -> String {
        switch selection {
        case .pod(let pod, let describe, let events):
            let phase = pod.status?.phase ?? "Unknown"
            let restarts = pod.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0
            return """
            Pod **\(pod.metadata.name)** in namespace **\(pod.metadata.namespace ?? "default")** is in phase \(phase) on node \(pod.spec?.nodeName ?? "?") with \(restarts) restart(s).

            What's wrong with it, and what should I do? Look at the data below first; ask me to run more commands if you need additional context.

            kubectl describe pod/\(pod.metadata.name) -n \(pod.metadata.namespace ?? "default"):
            ```
            \(describe)
            ```

            kubectl get events -n \(pod.metadata.namespace ?? "default") --field-selector involvedObject.name=\(pod.metadata.name):
            ```
            \(events)
            ```
            """
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `swift test --filter ContextHandoffBuilderTests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Sources/ClaudeK8s/Handoff/ Tests/ClaudeK8sTests/ContextHandoffBuilderTests.swift
git commit -m "feat: ContextHandoffBuilder for pod selections (the seam)"
```

---

### Task 18: Wire "Ask Claude about this pod" end-to-end

**Files:**
- Modify: `Sources/ClaudeK8s/Shell/MainWindow.swift`

- [ ] **Step 1: Wire MainWindow to use a real ChatViewModel and forward the handoff**

Replace `Sources/ClaudeK8s/Shell/MainWindow.swift`:

```swift
import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var chat = ChatViewModel()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip()

                HSplitView {
                    PodsPanel(contextManager: contextManager) { pod in
                        handoff(pod: pod)
                    }
                    .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))

                    ChatView(viewModel: chat)
                        .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
        .onAppear { contextManager.reload() }
    }

    private func handoff(pod: Pod) {
        Task {
            guard let ctx = contextManager.active?.name else { return }
            do {
                let client = try KubectlClient(context: ctx)
                async let describeData: Data = runProcess(
                    client.kubectl,
                    args: ["--context", ctx, "describe", "pod", pod.metadata.name, "-n", pod.metadata.namespace ?? "default"]
                )
                async let eventsData: Data = runProcess(
                    client.kubectl,
                    args: ["--context", ctx, "get", "events", "-n", pod.metadata.namespace ?? "default",
                           "--field-selector", "involvedObject.name=\(pod.metadata.name)"]
                )
                let describeBytes = (try? await describeData) ?? Data()
                let eventsBytes = (try? await eventsData) ?? Data()
                let describe = String(data: describeBytes, encoding: .utf8) ?? ""
                let events = String(data: eventsBytes, encoding: .utf8) ?? ""

                let prompt = ContextHandoffBuilder.build(.pod(pod, describe: describe, recentEvents: events))
                await MainActor.run { chat.sendHandoff(prompt) }
            } catch {
                await MainActor.run { chat.error = "\(error)" }
            }
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 3: Smoke test end-to-end**

Prerequisites:
- `kubectl` on PATH, working against your homelab cluster
- `claude` on PATH, already logged in (run `claude /login` first if not)

Run: `swift run ClaudeK8s`

Expected:
1. Window opens, pod table populates within ~1 s
2. Right-click any pod → "Ask Claude about this pod"
3. Chat region streams Claude's response analyzing that pod
4. If Claude requests a tool (e.g. `Bash: kubectl logs ...`), a permission sheet appears with approve/deny — destructive commands show a red badge requiring an "I understand" checkbox

- [ ] **Step 4: Commit**

```bash
git add Sources/ClaudeK8s/Shell/MainWindow.swift
git commit -m "feat: wire Ask Claude end-to-end with pod context handoff"
```

---

### Task 19: SessionStore — persist Claude session id per context

This is the bare minimum to survive app restarts without losing conversation state per context.

**Files:**
- Create: `Sources/ClaudeK8s/State/SessionStore.swift`
- Modify: `Sources/ClaudeK8s/Shell/MainWindow.swift`

- [ ] **Step 1: Write SessionStore**

`Sources/ClaudeK8s/State/SessionStore.swift`:

```swift
import Foundation

@MainActor
final class SessionStore {
    static let shared = SessionStore()
    private let url: URL

    private struct Storage: Codable {
        var sessionsByContext: [String: String]  // context-name → claude session id
    }

    private var storage: Storage

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = support.appendingPathComponent("com.tyrelchambers.claude-k8s")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.url = dir.appendingPathComponent("sessions.json")

        if let data = try? Data(contentsOf: url),
           let s = try? JSONDecoder().decode(Storage.self, from: data) {
            self.storage = s
        } else {
            self.storage = Storage(sessionsByContext: [:])
        }
    }

    func sessionId(for context: String) -> String? {
        storage.sessionsByContext[context]
    }

    func setSessionId(_ id: String, for context: String) {
        storage.sessionsByContext[context] = id
        persist()
    }

    private func persist() {
        do {
            let data = try JSONEncoder().encode(storage)
            let tmp = url.appendingPathExtension("tmp")
            try data.write(to: tmp, options: .atomic)
            _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } catch {
            NSLog("SessionStore persist failed: \(error)")
        }
    }
}
```

- [ ] **Step 2: Wire SessionStore into MainWindow / ChatViewModel**

Modify `MainWindow.swift` `body` to start chat with the saved session id when the context becomes known. Replace the `.onAppear` block:

```swift
        .onAppear {
            contextManager.reload()
            if let ctx = contextManager.active?.name {
                let saved = SessionStore.shared.sessionId(for: ctx)
                chat.start(resumingSessionId: saved)
            }
        }
        .onChange(of: contextManager.active) { _, newCtx in
            if let ctx = newCtx?.name {
                let saved = SessionStore.shared.sessionId(for: ctx)
                chat.stop()
                chat.start(resumingSessionId: saved)
            }
        }
        .onChange(of: chat.sessionId) { _, newSid in
            if let sid = newSid, let ctx = contextManager.active?.name {
                SessionStore.shared.setSessionId(sid, for: ctx)
            }
        }
```

- [ ] **Step 3: Build**

Run: `swift build`
Expected: success.

- [ ] **Step 4: Verify persistence across launches**

1. `swift run ClaudeK8s`
2. Send a message to Claude in the chat
3. Note the session id shown in the chat header (e.g. `sess-abcd…`)
4. Quit the app, relaunch via `swift run ClaudeK8s`
5. Same session id should appear in the header; ask "what did we just discuss?" — Claude should remember.

- [ ] **Step 5: Commit**

```bash
git add Sources/ClaudeK8s/State/SessionStore.swift Sources/ClaudeK8s/Shell/MainWindow.swift
git commit -m "feat: SessionStore persists claude session id per kubeconfig context"
```

---

### Task 20: Final integration verification

This task has no new code — it confirms the v1 foundation works end-to-end against the live cluster.

- [ ] **Step 1: Verify the app launches cleanly**

Run: `swift run ClaudeK8s`
Expected: no compile warnings, no runtime errors in stderr.

- [ ] **Step 2: Verify live pod table**

In the running app:
- Pod table populates within ~1 s of launch
- Status colors reflect `Running` (green), `Pending` (yellow), `Failed` (red)
- Restart counts are accurate
- Sorting by any column works

- [ ] **Step 3: Verify watch reconciliation**

In a separate terminal: `kubectl delete pod <some-test-pod>` — confirm the row disappears from the table within ~1 s.
Then `kubectl apply` it back — confirm the row reappears.

- [ ] **Step 4: Verify Ask Claude handoff**

- Right-click a pod → "Ask Claude about this pod"
- Chat streams a response that references the pod by name
- Session id appears in chat header

- [ ] **Step 5: Verify permission flow**

- In the chat: ask Claude "run `kubectl logs <pod>` for me"
- Claude requests permission to run Bash
- Permission sheet appears with the kubectl command shown
- Approve → command runs, output streams back into the chat

- [ ] **Step 6: Verify destructive-command guardrail**

- Ask Claude: "delete the test pod for me"
- When the permission sheet appears for a `kubectl delete` command, the red destructive badge should appear with an "I understand this looks destructive" checkbox required before approve activates.

- [ ] **Step 7: Verify session resume across restarts**

- Send Claude a memorable message ("the magic word is purple unicorn")
- Quit the app
- Relaunch via `swift run ClaudeK8s`
- Ask "what's the magic word?" — Claude should recall "purple unicorn"

- [ ] **Step 8: Commit a status note**

```bash
git commit --allow-empty -m "chore: v1 foundation verified end-to-end against homelab cluster"
```

---

## Notes for the implementing engineer

- **Claude Code stream-json schema may drift.** The decoder in `ClaudeEvent` is intentionally tolerant — unknown shapes return `.unknown(raw:)` instead of throwing. If you see frequent `.unknown` events, capture a fresh fixture with `claude --output-format stream-json -p "test" > Tests/ClaudeK8sTests/Fixtures/claude-stream.jsonl` and extend the decoder.
- **`kubectl describe` is text, not JSON.** That's why the handoff task shells out to `runProcess` directly instead of going through `KubectlClient.getList`.
- **macOS Keychain prompt on first claude spawn.** macOS may show a one-time keychain access dialog the first time the unsigned `swift run` binary spawns `claude` (because the OAuth token is scoped to the original `claude` signing identity). Click "Always Allow." If it loops, the fallback is to run `claude /login` once from a terminal launched by this app.
- **The chat region is a SwiftUI `ScrollViewReader`-driven `Text`-stack.** For long sessions this will slow down. Follow-up plan polish: virtualize the message list and consider an `NSTextView`-backed renderer.
- **Frequent commits.** Every task ends with a commit. Don't batch tasks into a single commit — the per-task history is what lets us bisect failures later.
- **No fallbacks were added that weren't explicitly requested.** Per project convention, anything that looks like a "just in case" path should be removed.
