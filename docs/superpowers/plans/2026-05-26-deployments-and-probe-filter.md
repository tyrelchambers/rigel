# Deployments-driven logs + Probe-noise filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the per-pod logs picker with a per-Deployment picker (k9s-style), so selecting one Deployment streams logs from *all* its pods merged with each line labeled by the source pod. Add a "Hide probes" toggle (default ON) that filters out kubelet health-check noise.

**Architecture:** Use kubectl's built-in label-selector log following — `kubectl logs -f -l <selector> --prefix --timestamps -n <ns>` — one process per Deployment instead of one process per pod, with each line auto-prefixed `[pod/<name>/<container>]`. New `LogStream` actor replaces `PodLogStream`. Line parsing extracts the prefix into `LogLine.sourcePod`. `LogNoiseFilter` is a pure function applied in the view model.

---

## Tasks

### Task 1: Add Deployment Codable type + fixture test

Modify `Sources/ClaudeK8s/Cluster/KubeTypes.swift` — append:

```swift
struct Deployment: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: DeploymentSpec?
    let status: DeploymentStatus?
    var id: String { metadata.uid }
}

struct DeploymentSpec: Codable, Hashable {
    let replicas: Int?
    let selector: LabelSelector?
}

struct DeploymentStatus: Codable, Hashable {
    let replicas: Int?
    let readyReplicas: Int?
    let availableReplicas: Int?
    let updatedReplicas: Int?
}

struct LabelSelector: Codable, Hashable {
    let matchLabels: [String: String]?
}

extension Deployment {
    var labelSelector: String {
        let pairs = spec?.selector?.matchLabels ?? [:]
        return pairs.sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: ",")
    }
}
```

Create `Tests/ClaudeK8sTests/Fixtures/deployments-list.json`:

```json
{
  "kind": "List",
  "items": [
    {
      "metadata": {"name": "fieldnotes", "namespace": "default", "uid": "dep-1111", "creationTimestamp": "2026-05-20T10:00:00Z", "labels": {"app": "fieldnotes"}},
      "spec": {"replicas": 2, "selector": {"matchLabels": {"app": "fieldnotes"}}},
      "status": {"replicas": 2, "readyReplicas": 2, "availableReplicas": 2, "updatedReplicas": 2}
    },
    {
      "metadata": {"name": "postiz", "namespace": "default", "uid": "dep-3333", "creationTimestamp": "2026-05-22T15:30:00Z", "labels": {"app": "postiz"}},
      "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "postiz", "tier": "web"}}},
      "status": {"replicas": 1, "readyReplicas": 0, "availableReplicas": 0, "updatedReplicas": 1}
    }
  ]
}
```

Append test to `Tests/ClaudeK8sTests/KubeTypesDecodingTests.swift`:

```swift
    func test_decodeDeploymentList_extractsSelectorAndReadyReplicas() throws {
        let url = Bundle.module.url(forResource: "deployments-list", withExtension: "json")!
        let data = try Data(contentsOf: url)
        let list = try JSONDecoder.kube.decode(KubeList<Deployment>.self, from: data)
        XCTAssertEqual(list.items.count, 2)
        let fieldnotes = list.items.first(where: { $0.metadata.name == "fieldnotes" })!
        XCTAssertEqual(fieldnotes.status?.readyReplicas, 2)
        XCTAssertEqual(fieldnotes.labelSelector, "app=fieldnotes")
        let postiz = list.items.first(where: { $0.metadata.name == "postiz" })!
        XCTAssertEqual(postiz.status?.readyReplicas, 0)
        XCTAssertEqual(postiz.labelSelector, "app=postiz,tier=web")
    }
```

Run tests. Commit `feat: Deployment Codable type with labelSelector helper`.

---

### Task 2: LogNoiseFilter + tests

Create `Tests/ClaudeK8sTests/LogNoiseFilterTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class LogNoiseFilterTests: XCTestCase {
    func test_dropsKubeProbeUserAgent() {
        let line = LogLine(sourcePod: "x", timestamp: nil, text: #"10.42.0.1 - - "GET / HTTP/1.1" 200 612 "-" "kube-probe/1.30""#, colorIndex: 0)
        XCTAssertTrue(LogNoiseFilter.isProbe(line))
    }

    func test_dropsCommonHealthPaths() {
        for path in ["/healthz", "/health", "/ready", "/readyz", "/live", "/livez"] {
            let line = LogLine(sourcePod: "x", timestamp: nil, text: #"172.16.0.1 - - "GET \#(path) HTTP/1.1" 200"#, colorIndex: 0)
            XCTAssertTrue(LogNoiseFilter.isProbe(line), "expected probe detection for \(path)")
        }
    }

    func test_keepsRegularRequests() {
        let line = LogLine(sourcePod: "x", timestamp: nil, text: #"203.0.113.5 - - "GET /api/v1/notes HTTP/1.1" 200 1532 "-" "Mozilla/5.0""#, colorIndex: 0)
        XCTAssertFalse(LogNoiseFilter.isProbe(line))
    }

    func test_keepsErrorLines() {
        let line = LogLine(sourcePod: "x", timestamp: nil, text: "ERROR: connection refused", colorIndex: 0)
        XCTAssertFalse(LogNoiseFilter.isProbe(line))
    }
}
```

Create `Sources/ClaudeK8s/Panels/Logs/LogNoiseFilter.swift`:

```swift
import Foundation

enum LogNoiseFilter {
    private static let probeUAPattern = #/kube-probe/#
    private static let probePathPattern = #/\s(?:GET|HEAD)\s+/(?:healthz|health|readyz|ready|livez|live|ping)(?:\s|\?|$)/#

    static func isProbe(_ line: LogLine) -> Bool {
        if (try? probeUAPattern.firstMatch(in: line.text)) != nil { return true }
        if (try? probePathPattern.firstMatch(in: line.text)) != nil { return true }
        return false
    }
}
```

Run tests. Commit `feat: LogNoiseFilter — drop kube-probe and health-endpoint noise`.

---

### Task 3: Replace PodLogStream with LogStream (label-selector based)

Delete `Sources/ClaudeK8s/Panels/Logs/PodLogStream.swift`. Create `Sources/ClaudeK8s/Panels/Logs/LogStream.swift`:

```swift
import Foundation

actor LogStream {
    nonisolated let kubectl: String
    nonisolated let context: String?
    nonisolated let namespace: String
    nonisolated let labelSelector: String
    nonisolated let streamKey: String
    private var proc: Process?

    init(namespace: String, labelSelector: String, streamKey: String, context: String?) throws {
        guard let path = resolveBinary("kubectl") else { throw KubectlClientError.kubectlNotFound }
        self.kubectl = path
        self.context = context
        self.namespace = namespace
        self.labelSelector = labelSelector
        self.streamKey = streamKey
    }

    nonisolated func stream() -> AsyncStream<LogLine> {
        AsyncStream { continuation in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: kubectl)
            var args: [String] = []
            if let context { args.append(contentsOf: ["--context", context]) }
            args.append(contentsOf: [
                "logs", "-f", "--timestamps", "--prefix=true", "--all-containers=true",
                "-n", namespace, "-l", labelSelector,
                "--max-log-requests=20",
                "--tail=200",
            ])
            p.arguments = args

            let outPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = Pipe()

            var parser = LogLineStreamParser(sourcePod: streamKey, colorIndex: 0)
            outPipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                    return
                }
                parser.feed(chunk) { line in continuation.yield(line) }
            }

            p.terminationHandler = { _ in
                outPipe.fileHandleForReading.readabilityHandler = nil
                continuation.finish()
            }

            continuation.onTermination = { _ in
                if p.isRunning { p.terminate() }
            }

            do {
                try p.run()
                Task { await self.setProc(p) }
            } catch {
                continuation.finish()
            }
        }
    }

    private func setProc(_ p: Process) { self.proc = p }

    func terminate() {
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
    }
}
```

Project won't build between this commit and Task 5 — expected. Commit `refactor: LogStream takes a label selector instead of single pod`.

---

### Task 4: Update LogLineParser to extract `[pod/name/container]` prefix

Append to `Tests/ClaudeK8sTests/LogLineParserTests.swift`:

```swift
    func test_extractsKubectlPrefix() {
        let raw = "[pod/fieldnotes-7d9c8b6f5d-xk2vp/nginx] 2026-05-26T18:42:01.123Z GET / 200"
        let line = LogLineParser.parse(raw, sourcePod: "fallback", colorIndex: 5)
        XCTAssertEqual(line.sourcePod, "fieldnotes-7d9c8b6f5d-xk2vp")
        XCTAssertNotNil(line.timestamp)
        XCTAssertEqual(line.text, "GET / 200")
        XCTAssertEqual(line.colorIndex, PodColorAssigner.colorIndex(for: "fieldnotes-7d9c8b6f5d-xk2vp"))
    }

    func test_keepsFallbackSourceWhenNoPrefix() {
        let line = LogLineParser.parse("plain log line", sourcePod: "fallback-key", colorIndex: 3)
        XCTAssertEqual(line.sourcePod, "fallback-key")
        XCTAssertEqual(line.colorIndex, 3)
    }
```

Replace the `parse` function in `Sources/ClaudeK8s/Panels/Logs/LogLineParser.swift`:

```swift
    private static let prefixPattern = #/^\[pod/([^/\]]+)/[^\]]+\]\s+/#

    static func parse(_ raw: String, sourcePod: String, colorIndex: Int) -> LogLine {
        var working = raw
        var effectiveSource = sourcePod
        var effectiveColor = colorIndex

        if let match = try? prefixPattern.firstMatch(in: working) {
            let podName = String(match.output.1)
            effectiveSource = podName
            effectiveColor = PodColorAssigner.colorIndex(for: podName)
            working.removeSubrange(match.range)
        }

        if let spaceIdx = working.firstIndex(of: " ") {
            let timestampPrefix = String(working[..<spaceIdx])
            let rest = String(working[working.index(after: spaceIdx)...])
            if let ts = iso8601.date(from: timestampPrefix) {
                return LogLine(sourcePod: effectiveSource, timestamp: ts, text: rest, colorIndex: effectiveColor)
            }
        }
        return LogLine(sourcePod: effectiveSource, timestamp: nil, text: working, colorIndex: effectiveColor)
    }
```

Run tests — 5 LogLineParserTests pass. Commit `feat: LogLineParser extracts kubectl --prefix pod prefix`.

---

### Task 5: Rewrite LogsViewModel for deployments

Replace `Sources/ClaudeK8s/Panels/Logs/LogsViewModel.swift`:

```swift
import Foundation
import Observation

@MainActor
@Observable
final class LogsViewModel {
    var availableDeployments: [Deployment] = []
    var selectedDeploymentKeys: Set<String> = []
    var lines: [LogLine] = []
    var maxLines: Int = 5000
    var filter: String = ""
    var hideProbes = true
    var isPaused = false
    var error: String? = nil

    private var listClient: KubectlClient?
    private var listTask: Task<Void, Never>?
    private var streams: [String: Task<Void, Never>] = [:]

    var filteredLines: [LogLine] {
        var out = lines
        if hideProbes {
            out = out.filter { !LogNoiseFilter.isProbe($0) }
        }
        if !filter.isEmpty {
            let needle = filter
            out = out.filter { $0.text.localizedCaseInsensitiveContains(needle) }
        }
        return out
    }

    func start(context: String?) {
        stopAll()
        do {
            let c = try KubectlClient(context: context)
            self.listClient = c
            listTask = Task { [weak self] in
                do {
                    let list = try await c.getList("deployments", type: Deployment.self)
                    await MainActor.run {
                        self?.availableDeployments = list.items.sorted { a, b in
                            let aNs = a.metadata.namespace ?? ""
                            let bNs = b.metadata.namespace ?? ""
                            if aNs != bNs { return aNs < bNs }
                            return a.metadata.name < b.metadata.name
                        }
                    }
                } catch {
                    await MainActor.run { self?.error = "\(error)" }
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func toggleSelection(_ deployment: Deployment, context: String?) {
        let key = "\(deployment.metadata.namespace ?? "default")/\(deployment.metadata.name)"
        if selectedDeploymentKeys.contains(key) {
            selectedDeploymentKeys.remove(key)
            streams[key]?.cancel()
            streams.removeValue(forKey: key)
        } else {
            selectedDeploymentKeys.insert(key)
            startStream(deployment: deployment, key: key, context: context)
        }
    }

    private func startStream(deployment: Deployment, key: String, context: String?) {
        let selector = deployment.labelSelector
        guard !selector.isEmpty else {
            self.error = "deployment \(key) has no spec.selector.matchLabels"
            return
        }
        let ns = deployment.metadata.namespace ?? "default"

        let task = Task { [weak self] in
            do {
                let s = try LogStream(namespace: ns, labelSelector: selector, streamKey: key, context: context)
                let stream = s.stream()
                for await line in stream {
                    if Task.isCancelled { break }
                    await MainActor.run { self?.appendLine(line) }
                }
            } catch {
                await MainActor.run { self?.error = "\(error)" }
            }
        }
        streams[key] = task
    }

    private func appendLine(_ line: LogLine) {
        guard !isPaused else { return }
        lines.append(line)
        if lines.count > maxLines {
            lines.removeFirst(lines.count - maxLines)
        }
    }

    func stopAll() {
        listTask?.cancel()
        listTask = nil
        for (_, t) in streams { t.cancel() }
        streams.removeAll()
    }

    func clear() {
        lines.removeAll()
    }
}
```

Build should succeed now. Commit `feat: LogsViewModel deployments-driven with hideProbes toggle`.

---

### Task 6: Update LogsPanel UI

Replace `Sources/ClaudeK8s/Panels/Logs/LogsPanel.swift`:

```swift
import SwiftUI

struct LogsPanel: View {
    @Bindable var contextManager: ClusterContextManager
    @State private var viewModel = LogsViewModel()
    let onAskClaude: (LogLine, [LogLine]) -> Void

    private static let palette: [Color] = [
        .blue, .green, .orange, .purple, .pink, .cyan, .yellow, .mint,
    ]

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Deployments").font(.headline).padding(.horizontal, 12).padding(.top, 8)
                List {
                    ForEach(viewModel.availableDeployments) { dep in
                        let key = "\(dep.metadata.namespace ?? "default")/\(dep.metadata.name)"
                        Button {
                            viewModel.toggleSelection(dep, context: contextManager.active?.name)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: viewModel.selectedDeploymentKeys.contains(key) ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(viewModel.selectedDeploymentKeys.contains(key) ? Color.accentColor : .secondary)
                                VStack(alignment: .leading) {
                                    Text(dep.metadata.name).font(.caption).lineLimit(1)
                                    HStack(spacing: 4) {
                                        Text(dep.metadata.namespace ?? "—")
                                        Text("·")
                                        let ready = dep.status?.readyReplicas ?? 0
                                        let total = dep.status?.replicas ?? 0
                                        Text("\(ready)/\(total)")
                                            .foregroundStyle(ready < total ? Color.red : .secondary)
                                    }
                                    .font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(minWidth: 240, idealWidth: 280)

            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    TextField("filter (case-insensitive substring)", text: $viewModel.filter)
                        .textFieldStyle(.roundedBorder)
                    Toggle("Hide probes", isOn: $viewModel.hideProbes)
                        .toggleStyle(.checkbox)
                        .help("Filters out 'kube-probe/' and common health endpoints (/healthz, /ready, /live, ...)")
                    Button(viewModel.isPaused ? "Resume" : "Pause") {
                        viewModel.isPaused.toggle()
                    }
                    Button("Clear") { viewModel.clear() }
                }
                .padding(8)

                if let err = viewModel.error {
                    Text(err).font(.caption).foregroundStyle(.red).padding(.horizontal, 8)
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(viewModel.filteredLines) { line in
                                LogLineRow(line: line, color: Self.palette[line.colorIndex])
                                    .id(line.id)
                                    .contextMenu {
                                        Button("Ask Claude about this line") {
                                            let surrounding = surroundingLines(of: line)
                                            onAskClaude(line, surrounding)
                                        }
                                    }
                            }
                        }
                        .padding(.horizontal, 8).padding(.bottom, 8)
                    }
                    .onChange(of: viewModel.lines.count) { _, _ in
                        if !viewModel.isPaused, let last = viewModel.filteredLines.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .onAppear { viewModel.start(context: contextManager.active?.name) }
        .onDisappear { viewModel.stopAll() }
        .onChange(of: contextManager.active) { _, newCtx in
            viewModel.start(context: newCtx?.name)
        }
    }

    private func surroundingLines(of line: LogLine) -> [LogLine] {
        guard let idx = viewModel.lines.firstIndex(where: { $0.id == line.id }) else { return [] }
        let start = max(0, idx - 5)
        let end = min(viewModel.lines.count, idx + 6)
        return Array(viewModel.lines[start..<end])
    }
}

struct LogLineRow: View {
    let line: LogLine
    let color: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Rectangle().fill(color).frame(width: 3)
            Text(line.sourcePod).font(.caption2).foregroundStyle(color).frame(width: 180, alignment: .leading)
            if let ts = line.timestamp {
                Text(ts.formatted(date: .omitted, time: .standard))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(nil)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
    }
}
```

Build clean. Run tests. Commit `feat: LogsPanel deployments sidebar + Hide probes toggle`.

---

### Task 7: Manual smoke test

`swift run ClaudeK8s`. Logs panel sidebar shows Deployments (with ready/total replicas). Click a deployment → logs from all its pods stream in, labeled per-pod. "Hide probes" toggle on by default — probe noise suppressed. Toggle off → noise returns. Right-click → Ask Claude works.

Empty commit: `chore: Plan 3 (Deployments + probe filter) verified end-to-end`.
