# Logs Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a multi-pod live-log tail panel to ClaudeK8s. Users select N pods, see their logs merged into a single scrolling stream color-coded by source pod, can filter via regex, pause/resume, and right-click any line to send it to Claude with surrounding context.

**Architecture:** Each selected pod gets one long-lived `kubectl logs -f` subprocess; `LogsViewModel` merges their stdout streams into a unified `[LogLine]` capped at N most-recent lines. SwiftUI renders the merged list with per-pod accent colors. A new `.logs` case in `PanelKind` plus NavStrip wiring lets the user switch panels; MainWindow holds the selected `PanelKind` and routes accordingly. `PanelSelection.logSlice` extends the handoff seam so right-click-on-a-log-line generates a useful Claude prompt.

**Tech Stack:** Same as Plan 1 — Swift 5.10, SwiftUI, macOS 14, kubectl subprocess. No new dependencies. `NSColor.controlAccentColor` family + hash-based color selection for per-pod accents.

**Out of scope (deferred):** Persistent log buffer beyond what `kubectl logs --since` returns (would need SQLite). SigNoz integration for historical logs. Multi-line log entry detection (assume one line = one entry).

---

## File Structure

```
claude-k8s/
├── Sources/ClaudeK8s/
│   ├── Panels/
│   │   ├── PanelKind.swift                          # MODIFY: add .logs case
│   │   └── Logs/                                    # NEW
│   │       ├── LogLine.swift                        # NEW: { sourcePod, ts, text, colorIndex }
│   │       ├── PodColorAssigner.swift               # NEW: stable hash → color index
│   │       ├── PodLogStream.swift                   # NEW: actor, one kubectl logs -f subprocess
│   │       ├── LogsViewModel.swift                  # NEW: owns N PodLogStreams, merge + filter
│   │       ├── LogLineParser.swift                  # NEW: byte stream → LogLine values
│   │       └── LogsPanel.swift                      # NEW: SwiftUI view, multi-select + scrolling
│   ├── Shell/
│   │   ├── NavStrip.swift                           # MODIFY: clickable icons, selection callback
│   │   └── MainWindow.swift                         # MODIFY: route on selected PanelKind
│   ├── Handoff/
│   │   ├── PanelSelection.swift                     # MODIFY: add .logSlice case
│   │   └── ContextHandoffBuilder.swift              # MODIFY: handle .logSlice
├── Tests/ClaudeK8sTests/
│   ├── LogLineParserTests.swift                     # NEW
│   ├── PodColorAssignerTests.swift                  # NEW
│   └── ContextHandoffBuilderLogSliceTests.swift     # NEW
```

---

## Tasks

### Task 1: PanelKind + NavStrip + MainWindow routing

**Files:**
- Modify: `Sources/ClaudeK8s/Panels/PanelKind.swift`
- Modify: `Sources/ClaudeK8s/Shell/NavStrip.swift`
- Modify: `Sources/ClaudeK8s/Shell/MainWindow.swift`

- [ ] **Step 1: Extend PanelKind**

`Sources/ClaudeK8s/Panels/PanelKind.swift`:

```swift
import Foundation

enum PanelKind: Hashable, CaseIterable, Identifiable {
    case pods
    case logs
    // .alerts, .nodes added in follow-up plans

    var id: Self { self }

    var icon: String {
        switch self {
        case .pods: return "shippingbox.fill"
        case .logs: return "text.alignleft"
        }
    }

    var title: String {
        switch self {
        case .pods: return "Pods"
        case .logs: return "Logs"
        }
    }
}
```

- [ ] **Step 2: Make NavStrip selectable**

Replace `Sources/ClaudeK8s/Shell/NavStrip.swift`:

```swift
import SwiftUI

struct NavStrip: View {
    @Binding var selection: PanelKind

    var body: some View {
        VStack(spacing: 16) {
            ForEach(PanelKind.allCases) { kind in
                Button {
                    selection = kind
                } label: {
                    Image(systemName: kind.icon)
                        .font(.title2)
                        .frame(width: 32, height: 32)
                        .foregroundStyle(selection == kind ? Color.accentColor : .tertiary)
                        .background(selection == kind ? Color.accentColor.opacity(0.15) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .help(kind.title)
            }
            Spacer()
        }
        .frame(maxHeight: .infinity)
        .padding(.vertical, 16)
        .frame(width: 60)
        .background(.thinMaterial)
    }
}
```

- [ ] **Step 3: Modify MainWindow to route on selection**

Replace `Sources/ClaudeK8s/Shell/MainWindow.swift`:

```swift
import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var chat = ChatViewModel()
    @State private var selectedPanel: PanelKind = .pods

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip(selection: $selectedPanel)

                HSplitView {
                    panelView
                        .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(NSColor.windowBackgroundColor))

                    ChatView(viewModel: chat)
                        .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
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
    }

    @ViewBuilder private var panelView: some View {
        switch selectedPanel {
        case .pods:
            PodsPanel(contextManager: contextManager) { pod in
                handoffPod(pod)
            }
        case .logs:
            LogsPanel(contextManager: contextManager) { line, surrounding in
                handoffLogSlice(line: line, surrounding: surrounding)
            }
        }
    }

    private func handoffPod(_ pod: Pod) {
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

    private func handoffLogSlice(line: LogLine, surrounding: [LogLine]) {
        let prompt = ContextHandoffBuilder.build(.logSlice(line: line, surrounding: surrounding))
        chat.sendHandoff(prompt)
    }
}
```

- [ ] **Step 4: Build**

Note this will not compile yet — `LogsPanel` and `LogLine` are defined in Tasks 2–7. Skip `swift build` here; we'll build after Task 7.

(Alternative: temporarily comment out the `.logs` case in `panelView` until Task 7 lands. Up to the implementer; either is fine.)

- [ ] **Step 5: Commit**

```bash
git add Sources/ClaudeK8s/Panels/PanelKind.swift Sources/ClaudeK8s/Shell/NavStrip.swift Sources/ClaudeK8s/Shell/MainWindow.swift
git commit -m "feat: PanelKind routing in NavStrip and MainWindow"
```

---

### Task 2: LogLine type

**File:** `Sources/ClaudeK8s/Panels/Logs/LogLine.swift`

- [ ] **Step 1: Write**

```swift
import Foundation

struct LogLine: Identifiable, Hashable {
    let id = UUID()
    let sourcePod: String        // "namespace/podName"
    let timestamp: Date?          // parsed from kubectl logs --timestamps
    let text: String
    let colorIndex: Int           // 0-7, stable per pod via PodColorAssigner
}
```

- [ ] **Step 2: Build, commit `feat: LogLine type` against the new file.**

---

### Task 3: PodColorAssigner + test

**Files:**
- `Sources/ClaudeK8s/Panels/Logs/PodColorAssigner.swift`
- `Tests/ClaudeK8sTests/PodColorAssignerTests.swift`

- [ ] **Step 1: Failing test**

`Tests/ClaudeK8sTests/PodColorAssignerTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class PodColorAssignerTests: XCTestCase {
    func test_stableSameKeyAcrossInstances() {
        XCTAssertEqual(PodColorAssigner.colorIndex(for: "default/postiz-844c9f-abcde"),
                       PodColorAssigner.colorIndex(for: "default/postiz-844c9f-abcde"))
    }

    func test_resultInPaletteRange() {
        for i in 0..<50 {
            let idx = PodColorAssigner.colorIndex(for: "default/pod-\(i)")
            XCTAssertGreaterThanOrEqual(idx, 0)
            XCTAssertLessThan(idx, PodColorAssigner.paletteSize)
        }
    }

    func test_differentKeysDistributeAcrossPalette() {
        var counts = Array(repeating: 0, count: PodColorAssigner.paletteSize)
        for i in 0..<800 {
            counts[PodColorAssigner.colorIndex(for: "default/pod-\(i)")] += 1
        }
        // Crude distribution check — every bucket should see at least one hit.
        for c in counts { XCTAssertGreaterThan(c, 0) }
    }
}
```

Run `swift test --filter PodColorAssignerTests` — expect undefined-symbol failure.

- [ ] **Step 2: Implement**

`Sources/ClaudeK8s/Panels/Logs/PodColorAssigner.swift`:

```swift
import Foundation

enum PodColorAssigner {
    static let paletteSize = 8

    /// Stable hash of a pod key to a color palette index.
    /// Stable across instances and process restarts.
    static func colorIndex(for key: String) -> Int {
        // FNV-1a 32-bit
        var hash: UInt32 = 2166136261
        for byte in key.utf8 {
            hash ^= UInt32(byte)
            hash &*= 16777619
        }
        return Int(hash % UInt32(paletteSize))
    }
}
```

Run tests — all 3 pass. Commit `feat: stable per-pod color index assignment` against both files.

---

### Task 4: LogLineParser + test

`kubectl logs -f --timestamps` outputs lines like:

```
2026-05-26T18:42:01.123456789Z log message body
```

Parser: split on newline, then on first whitespace; first half is RFC3339 timestamp, second half is the message. If the timestamp doesn't parse, the whole line is treated as text with no timestamp.

**Files:**
- `Sources/ClaudeK8s/Panels/Logs/LogLineParser.swift`
- `Tests/ClaudeK8sTests/LogLineParserTests.swift`

- [ ] **Step 1: Failing test**

`Tests/ClaudeK8sTests/LogLineParserTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class LogLineParserTests: XCTestCase {
    func test_parsesTimestampedLine() {
        let raw = "2026-05-26T18:42:01.123Z hello world"
        let line = LogLineParser.parse(raw, sourcePod: "default/x", colorIndex: 3)
        XCTAssertEqual(line.text, "hello world")
        XCTAssertNotNil(line.timestamp)
        XCTAssertEqual(line.colorIndex, 3)
        XCTAssertEqual(line.sourcePod, "default/x")
    }

    func test_parsesUntimestampedLine() {
        let line = LogLineParser.parse("plain text", sourcePod: "default/x", colorIndex: 0)
        XCTAssertEqual(line.text, "plain text")
        XCTAssertNil(line.timestamp)
    }

    func test_streamsMultipleLinesFromBuffer() {
        var parser = LogLineStreamParser(sourcePod: "default/x", colorIndex: 0)
        var lines: [LogLine] = []
        parser.feed(Data("first\nsecond\nthi".utf8)) { lines.append($0) }
        XCTAssertEqual(lines.map(\.text), ["first", "second"])
        parser.feed(Data("rd\n".utf8)) { lines.append($0) }
        XCTAssertEqual(lines.map(\.text), ["first", "second", "third"])
    }
}
```

- [ ] **Step 2: Implement**

`Sources/ClaudeK8s/Panels/Logs/LogLineParser.swift`:

```swift
import Foundation

enum LogLineParser {
    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parse(_ raw: String, sourcePod: String, colorIndex: Int) -> LogLine {
        // Try to split on first whitespace; treat prefix as RFC3339 if it parses.
        if let spaceIdx = raw.firstIndex(of: " ") {
            let prefix = String(raw[..<spaceIdx])
            let rest = String(raw[raw.index(after: spaceIdx)...])
            if let ts = iso8601.date(from: prefix) {
                return LogLine(sourcePod: sourcePod, timestamp: ts, text: rest, colorIndex: colorIndex)
            }
        }
        return LogLine(sourcePod: sourcePod, timestamp: nil, text: raw, colorIndex: colorIndex)
    }
}

/// Splits a byte stream into LogLines by newline, buffering partial lines.
struct LogLineStreamParser {
    let sourcePod: String
    let colorIndex: Int
    private var buffer = Data()

    init(sourcePod: String, colorIndex: Int) {
        self.sourcePod = sourcePod
        self.colorIndex = colorIndex
    }

    mutating func feed(_ chunk: Data, emit: (LogLine) -> Void) {
        buffer.append(chunk)
        while let newlineIdx = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<newlineIdx)
            buffer = Data(buffer[(newlineIdx + 1)...])
            if let s = String(data: line, encoding: .utf8), !s.isEmpty {
                emit(LogLineParser.parse(s, sourcePod: sourcePod, colorIndex: colorIndex))
            }
        }
    }
}
```

Run tests — all 3 pass. Commit `feat: log line parser (timestamp + streaming buffer)` against both files.

---

### Task 5: PodLogStream actor

One long-lived `kubectl logs -f --timestamps` subprocess per pod.

**File:** `Sources/ClaudeK8s/Panels/Logs/PodLogStream.swift`

```swift
import Foundation

actor PodLogStream {
    nonisolated let podKey: String          // "namespace/name"
    nonisolated let kubectl: String
    nonisolated let context: String?
    nonisolated let namespace: String
    nonisolated let podName: String
    nonisolated let colorIndex: Int
    private var proc: Process?

    init(namespace: String, podName: String, context: String?, colorIndex: Int) throws {
        guard let path = resolveBinary("kubectl") else { throw KubectlClientError.kubectlNotFound }
        self.kubectl = path
        self.context = context
        self.namespace = namespace
        self.podName = podName
        self.podKey = "\(namespace)/\(podName)"
        self.colorIndex = colorIndex
    }

    /// Starts the subprocess and returns a stream of LogLine values.
    nonisolated func stream() -> AsyncStream<LogLine> {
        AsyncStream { continuation in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: kubectl)
            var args: [String] = []
            if let context { args.append(contentsOf: ["--context", context]) }
            args.append(contentsOf: ["logs", "-f", "--timestamps", "-n", namespace, podName])
            p.arguments = args

            let outPipe = Pipe()
            p.standardOutput = outPipe
            p.standardError = Pipe()  // ignored — kubectl writes "no such pod" etc here, but we just stop

            var parser = LogLineStreamParser(sourcePod: podKey, colorIndex: colorIndex)
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

Build, commit `feat: PodLogStream actor wrapping kubectl logs -f`.

---

### Task 6: LogsViewModel — multi-pod merge + filter

**File:** `Sources/ClaudeK8s/Panels/Logs/LogsViewModel.swift`

```swift
import Foundation
import Observation

@MainActor
@Observable
final class LogsViewModel {
    var availablePods: [Pod] = []
    var selectedPodKeys: Set<String> = []         // "namespace/name"
    var lines: [LogLine] = []                      // newest at end
    var maxLines: Int = 5000
    var filter: String = ""
    var isPaused = false
    var error: String? = nil

    private var listClient: KubectlClient?
    private var listTask: Task<Void, Never>?
    private var streams: [String: Task<Void, Never>] = [:]   // key → stream task

    var filteredLines: [LogLine] {
        if filter.isEmpty { return lines }
        let needle = filter
        return lines.filter { $0.text.localizedCaseInsensitiveContains(needle) }
    }

    func start(context: String?) {
        stopAll()
        do {
            let c = try KubectlClient(context: context)
            self.listClient = c
            listTask = Task { [weak self] in
                do {
                    let list = try await c.getList("pods", type: Pod.self)
                    await MainActor.run { self?.availablePods = list.items.sorted {
                        ($0.metadata.namespace ?? "") < ($1.metadata.namespace ?? "")
                            || ($0.metadata.name < $1.metadata.name)
                    } }
                } catch {
                    await MainActor.run { self?.error = "\(error)" }
                }
            }
        } catch {
            self.error = "\(error)"
        }
    }

    func toggleSelection(_ pod: Pod, context: String?) {
        let key = "\(pod.metadata.namespace ?? "default")/\(pod.metadata.name)"
        if selectedPodKeys.contains(key) {
            selectedPodKeys.remove(key)
            streams[key]?.cancel()
            streams.removeValue(forKey: key)
            lines.removeAll { $0.sourcePod == key }
        } else {
            selectedPodKeys.insert(key)
            startStream(pod: pod, key: key, context: context)
        }
    }

    private func startStream(pod: Pod, key: String, context: String?) {
        let colorIndex = PodColorAssigner.colorIndex(for: key)
        let ns = pod.metadata.namespace ?? "default"
        let name = pod.metadata.name

        let task = Task { [weak self] in
            do {
                let s = try PodLogStream(namespace: ns, podName: name, context: context, colorIndex: colorIndex)
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

Build, commit `feat: LogsViewModel multi-pod merge + filter + pause`.

---

### Task 7: LogsPanel SwiftUI view

**File:** `Sources/ClaudeK8s/Panels/Logs/LogsPanel.swift`

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
            // Left: pod selector
            VStack(alignment: .leading, spacing: 0) {
                Text("Pods").font(.headline).padding(.horizontal, 12).padding(.top, 8)
                List {
                    ForEach(viewModel.availablePods) { pod in
                        let key = "\(pod.metadata.namespace ?? "default")/\(pod.metadata.name)"
                        Button {
                            viewModel.toggleSelection(pod, context: contextManager.active?.name)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: viewModel.selectedPodKeys.contains(key) ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(viewModel.selectedPodKeys.contains(key) ? Self.palette[PodColorAssigner.colorIndex(for: key)] : .secondary)
                                VStack(alignment: .leading) {
                                    Text(pod.metadata.name).font(.caption).lineLimit(1)
                                    Text(pod.metadata.namespace ?? "—").font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(minWidth: 220, idealWidth: 260)

            // Right: merged log stream
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    TextField("filter (case-insensitive substring)", text: $viewModel.filter)
                        .textFieldStyle(.roundedBorder)
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

    /// Surrounding lines = up to 5 lines before + 5 lines after the target line.
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

Build, commit `feat: LogsPanel SwiftUI view`.

---

### Task 8: Extend ContextHandoffBuilder for logSlice

**Files:**
- Modify: `Sources/ClaudeK8s/Handoff/PanelSelection.swift`
- Modify: `Sources/ClaudeK8s/Handoff/ContextHandoffBuilder.swift`
- New: `Tests/ClaudeK8sTests/ContextHandoffBuilderLogSliceTests.swift`

- [ ] **Step 1: Add `.logSlice` case to PanelSelection**

```swift
import Foundation

enum PanelSelection {
    case pod(Pod, describe: String, recentEvents: String)
    case logSlice(line: LogLine, surrounding: [LogLine])
    // .alert, .node added in follow-up plans
}
```

- [ ] **Step 2: Failing test**

`Tests/ClaudeK8sTests/ContextHandoffBuilderLogSliceTests.swift`:

```swift
import XCTest
@testable import ClaudeK8s

final class ContextHandoffBuilderLogSliceTests: XCTestCase {
    func test_logSliceIncludesPodAndSurrounding() {
        let target = LogLine(sourcePod: "default/postiz-x", timestamp: nil, text: "ERROR: connection refused", colorIndex: 0)
        let surrounding = [
            LogLine(sourcePod: "default/postiz-x", timestamp: nil, text: "connecting to postgres", colorIndex: 0),
            target,
            LogLine(sourcePod: "default/postiz-x", timestamp: nil, text: "retry 1/3", colorIndex: 0),
        ]
        let prompt = ContextHandoffBuilder.build(.logSlice(line: target, surrounding: surrounding))

        XCTAssertTrue(prompt.contains("default/postiz-x"))
        XCTAssertTrue(prompt.contains("connection refused"))
        XCTAssertTrue(prompt.contains("connecting to postgres"))
        XCTAssertTrue(prompt.contains("retry 1/3"))
    }
}
```

- [ ] **Step 3: Implement case in ContextHandoffBuilder**

Add to the `switch selection` in `ContextHandoffBuilder.build`:

```swift
        case .logSlice(let target, let surrounding):
            let context = surrounding.map { l -> String in
                let ts = l.timestamp.map { "\($0.formatted(date: .omitted, time: .standard)) " } ?? ""
                let marker = (l.id == target.id) ? "→ " : "  "
                return "\(marker)\(ts)\(l.text)"
            }.joined(separator: "\n")
            return """
            From pod **\(target.sourcePod)** — log line marked with → is what I want to ask about:

            ```
            \(context)
            ```

            What's happening, and what should I do?
            """
```

Run tests, all pass. Commit `feat: ContextHandoffBuilder handles .logSlice` against the three files.

---

### Task 9: Integration smoke test (manual)

- [ ] **Step 1: Build clean**

`swift build` from `/Users/tyrelchambers/home/claude-k8s/` — zero new errors. Warnings expected (Swift 6 concurrency from `var parser` captures, same as Plan 1).

- [ ] **Step 2: Run and verify**

`swift run ClaudeK8s`

Expected:
1. Window opens with two icons in the nav strip: pods (highlighted) and logs.
2. Click the logs icon — panel switches to Logs view. Pod list appears in the left subpane.
3. Click a pod's checkbox — log lines stream in within ~1 s, colored with that pod's accent.
4. Click a second pod — its lines interleave, colored differently.
5. Filter box: type a substring → filters live.
6. Pause → stream stops appending; Resume → stream catches up.
7. Right-click a line → "Ask Claude about this line" → drawer streams analysis with ±5 surrounding lines as context.

- [ ] **Step 3: Empty commit marking the plan complete**

```bash
git commit --allow-empty -m "chore: Plan 2 (Logs panel) verified end-to-end against homelab cluster"
```
