# Cluster Visualizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four visualizations to Helmsman — Overview cluster gauges + reclaimable-waste headline, an event-volume timeline, a node→pod treemap (new Topology tab), and a Right-Sizing 24h usage-band chart — on a shared `Charts/` module of reusable views and pure, tested aggregation/layout functions.

**Architecture:** Pure functions (`Viz` aggregations, `TreemapLayout`) hold all logic and get unit-tested; SwiftUI/Swift-Charts views stay thin wrappers. Three of the four features read existing `ClusterCache` snapshots reactively (zero new fetching); only the usage-band chart adds a Prometheus range query, gated on a configured backend with an honest empty state otherwise.

**Tech Stack:** Swift 5.10, SwiftUI, Apple Swift Charts (macOS 14 target), XCTest. Build: `swift build`. Test: `swift test --filter <name>`.

---

## File Structure

**New files:**
- `Sources/Helmsman/Charts/Aggregations.swift` — `enum Viz`: cluster totals, waste summary, event buckets, treemap model (pure).
- `Sources/Helmsman/Charts/TreemapLayout.swift` — squarified treemap rect packing (pure).
- `Sources/Helmsman/Charts/ChartTheme.swift` — shared health→color mapping for viz views.
- `Sources/Helmsman/Charts/RingGauge.swift` — circular usage gauge (native SwiftUI shapes).
- `Sources/Helmsman/Charts/EventTimeline.swift` — event-volume ribbon (Swift Charts `BarMark`).
- `Sources/Helmsman/Charts/ClusterTreemap.swift` — node treemap view over `Viz.TreemapNode` (GeometryReader + `TreemapLayout`).
- `Sources/Helmsman/Charts/UsageBandChart.swift` — usage area + request/limit rule lines (Swift Charts).
- `Sources/Helmsman/Metrics/UsageSeriesSource.swift` — Prometheus range-query → `[UsagePoint]`, plus `PromRangeResponse`.
- `Sources/Helmsman/Panels/Topology/TopologyPanel.swift` — the new Topology tab.
- `Tests/HelmsmanTests/VizAggregationsTests.swift`, `Tests/HelmsmanTests/TreemapLayoutTests.swift`, `Tests/HelmsmanTests/UsageSeriesSourceTests.swift`.

**Modified files:**
- `Sources/Helmsman/Cluster/ClusterCache.swift` — add `promRangeQuery(path:)`.
- `Sources/Helmsman/Panels/PanelKind.swift` — add `.topology` case + nav entry.
- `Sources/Helmsman/Shell/MainWindow.swift` — route `.topology`; pass `rightSizingVM` to Overview; wire treemap pod-select.
- `Sources/Helmsman/Panels/Overview/OverviewPanel.swift` — gauges row + waste card + compact timeline.
- `Sources/Helmsman/Panels/Events/EventsPanel.swift` — timeline ribbon above the list.
- `Sources/Helmsman/Panels/RightSizing/RightSizingPanel.swift` — drop in `WorkloadUsageBands` in the workload detail.

**Note on view testing:** this codebase has no SwiftUI snapshot/view tests — logic is tested, views are verified by `swift build` + a manual run. This plan follows that convention: pure functions are TDD'd; view tasks gate on a clean build and a manual checkpoint.

---

## Task 1: Aggregations — cluster resource totals

**Files:**
- Create: `Sources/Helmsman/Charts/Aggregations.swift`
- Test: `Tests/HelmsmanTests/VizAggregationsTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/HelmsmanTests/VizAggregationsTests.swift`:

```swift
import XCTest
@testable import Helmsman

final class VizAggregationsTests: XCTestCase {

    private func node(_ name: String, cpu: String, mem: String) -> Node {
        Node(
            metadata: ObjectMeta(name: name, namespace: nil, uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: NodeStatus(capacity: ["cpu": cpu, "memory": mem], allocatable: ["cpu": cpu, "memory": mem], conditions: nil, addresses: nil, nodeInfo: nil)
        )
    }

    private func nodeMetric(_ name: String, cpu: String, mem: String) -> NodeMetrics {
        NodeMetrics(metadata: .init(name: name), usage: .init(cpu: cpu, memory: mem))
    }

    func test_clusterResourceTotals_sumsUsageAndAllocatable() {
        let nodes = [node("a", cpu: "4", mem: "8Gi"), node("b", cpu: "4", mem: "8Gi")]
        let metrics = ["a": nodeMetric("a", cpu: "2", mem: "4Gi"),
                       "b": nodeMetric("b", cpu: "1", mem: "2Gi")]
        let t = Viz.clusterResourceTotals(nodes: nodes, metrics: metrics)
        XCTAssertEqual(t.cpuAllocatable, 8, accuracy: 0.001)
        XCTAssertEqual(t.cpuUsed, 3, accuracy: 0.001)
        XCTAssertEqual(t.cpuFraction, 3.0 / 8.0, accuracy: 0.001)
        XCTAssertEqual(t.memAllocatable, 16 * 1024 * 1024 * 1024, accuracy: 1)
        XCTAssertEqual(t.memUsed, 6 * 1024 * 1024 * 1024, accuracy: 1)
    }

    func test_clusterResourceTotals_missingMetricsCountsZeroUsage() {
        let nodes = [node("a", cpu: "4", mem: "8Gi")]
        let t = Viz.clusterResourceTotals(nodes: nodes, metrics: [:])
        XCTAssertEqual(t.cpuUsed, 0, accuracy: 0.001)
        XCTAssertEqual(t.cpuAllocatable, 4, accuracy: 0.001)
        XCTAssertEqual(t.cpuFraction, 0, accuracy: 0.001)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter VizAggregationsTests`
Expected: FAIL — compile error, `Viz` is not defined.

- [ ] **Step 3: Write minimal implementation**

Create `Sources/Helmsman/Charts/Aggregations.swift`:

```swift
import Foundation

/// Pure aggregation/layout helpers behind the cluster visualizations. No UI,
/// no I/O — everything here is unit-tested.
enum Viz {

    // MARK: - Cluster resource totals (Overview gauges)

    struct ResourceTotals: Equatable {
        var cpuUsed: Double = 0          // cores
        var cpuAllocatable: Double = 0
        var memUsed: Double = 0          // bytes
        var memAllocatable: Double = 0

        var cpuFraction: Double { cpuAllocatable > 0 ? min(cpuUsed / cpuAllocatable, 1) : 0 }
        var memFraction: Double { memAllocatable > 0 ? min(memUsed / memAllocatable, 1) : 0 }
    }

    /// Cluster-wide used vs allocatable, summed across nodes. Allocatable falls
    /// back to capacity when a node omits it; missing metrics count as 0 usage.
    static func clusterResourceTotals(nodes: [Node], metrics: [String: NodeMetrics]) -> ResourceTotals {
        var t = ResourceTotals()
        for node in nodes {
            let cap = node.status?.capacity ?? [:]
            let alloc = node.status?.allocatable ?? [:]
            if let cpu = alloc["cpu"] ?? cap["cpu"] { t.cpuAllocatable += ResourceQuantity.cpuCores(cpu) }
            if let mem = alloc["memory"] ?? cap["memory"] { t.memAllocatable += ResourceQuantity.bytes(mem) }
            if let m = metrics[node.metadata.name] {
                t.cpuUsed += ResourceQuantity.cpuCores(m.usage.cpu)
                t.memUsed += ResourceQuantity.bytes(m.usage.memory)
            }
        }
        return t
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter VizAggregationsTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Charts/Aggregations.swift Tests/HelmsmanTests/VizAggregationsTests.swift
git commit -m "feat(viz): cluster resource totals aggregation"
```

---

## Task 2: Aggregations — reclaimable-waste summary

**Files:**
- Modify: `Sources/Helmsman/Charts/Aggregations.swift`
- Test: `Tests/HelmsmanTests/VizAggregationsTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `VizAggregationsTests.swift` (inside the class). The fixture fills the verbose `RightSizingResult` with zeros except the fields `reclaimableMemBytes` reads (`verdict`, `memRequest`, `suggestedMemRequest`):

```swift
    private func rsResult(verdict: RightSizingVerdict, memRequest: Double?, suggestedMemRequest: Double?) -> RightSizingResult {
        RightSizingResult(
            container: "c", verdict: verdict, hoursCovered: 48,
            cpuPeak: 0, cpuTypical: 0, memPeak: 0, memTypical: 0,
            cpuRequest: nil, cpuLimit: nil, memRequest: memRequest, memLimit: nil,
            suggestedCpuRequest: nil, suggestedCpuLimit: nil,
            suggestedMemRequest: suggestedMemRequest, suggestedMemLimit: nil,
            rationale: ""
        )
    }

    private func workload(_ name: String, _ results: [RightSizingResult]) -> WorkloadRightSizing {
        WorkloadRightSizing(kind: "deployment", name: name, namespace: "default", containers: results)
    }

    func test_wasteSummary_sumsOverProvisionedReclaimable() {
        let a = workload("a", [rsResult(verdict: .overProvisioned, memRequest: 1_000, suggestedMemRequest: 400)]) // 600
        let b = workload("b", [rsResult(verdict: .overProvisioned, memRequest: 500, suggestedMemRequest: 200)])   // 300
        let ok = workload("c", [rsResult(verdict: .ok, memRequest: 999, suggestedMemRequest: 1)])                 // ignored (not over-provisioned)
        let s = Viz.wasteSummary([a, b, ok])
        XCTAssertEqual(s.reclaimableBytes, 900, accuracy: 0.001)
        XCTAssertEqual(s.workloadCount, 2)
    }

    func test_wasteSummary_emptyWhenNothingReclaimable() {
        let s = Viz.wasteSummary([workload("c", [rsResult(verdict: .ok, memRequest: 100, suggestedMemRequest: 10)])])
        XCTAssertEqual(s.reclaimableBytes, 0, accuracy: 0.001)
        XCTAssertEqual(s.workloadCount, 0)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter VizAggregationsTests/test_wasteSummary_sumsOverProvisionedReclaimable`
Expected: FAIL — `Viz.wasteSummary` is not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `enum Viz` in `Aggregations.swift`:

```swift
    // MARK: - Reclaimable-waste summary (Overview headline)

    struct WasteSummary: Equatable {
        var reclaimableBytes: Double = 0
        var workloadCount: Int = 0
    }

    /// Total reclaimable memory across workloads, counting only those with a
    /// positive reclaimable figure. `WorkloadRightSizing.reclaimableMemBytes`
    /// already sums over over-provisioned containers.
    static func wasteSummary(_ results: [WorkloadRightSizing]) -> WasteSummary {
        var s = WasteSummary()
        for w in results {
            let r = w.reclaimableMemBytes
            if r > 0 { s.reclaimableBytes += r; s.workloadCount += 1 }
        }
        return s
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter VizAggregationsTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Charts/Aggregations.swift Tests/HelmsmanTests/VizAggregationsTests.swift
git commit -m "feat(viz): reclaimable-waste summary aggregation"
```

---

## Task 3: Aggregations — event timeline buckets

**Files:**
- Modify: `Sources/Helmsman/Charts/Aggregations.swift`
- Test: `Tests/HelmsmanTests/VizAggregationsTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `VizAggregationsTests.swift`:

```swift
    private func event(_ uid: String, warning: Bool, at: Date) -> K8sEvent {
        K8sEvent(
            metadata: ObjectMeta(name: uid, namespace: "default", uid: uid, creationTimestamp: at, labels: nil, annotations: nil),
            type: warning ? "Warning" : "Normal", reason: "R", message: "m", count: 1,
            firstTimestamp: at, lastTimestamp: at, involvedObject: nil
        )
    }

    func test_eventBuckets_partitionsByTimeAndSeverity() {
        let now = Date(timeIntervalSince1970: 100_000)
        let span: TimeInterval = 4    // 4 seconds, 4 buckets of 1s each
        let events = [
            event("w0", warning: true,  at: now.addingTimeInterval(-3.5)), // bucket 0
            event("n0", warning: false, at: now.addingTimeInterval(-3.1)), // bucket 0
            event("w3", warning: true,  at: now.addingTimeInterval(-0.2)), // bucket 3
            event("old", warning: true, at: now.addingTimeInterval(-10)),  // out of window → ignored
        ]
        let buckets = Viz.eventBuckets(events, now: now, span: span, count: 4)
        XCTAssertEqual(buckets.count, 4)
        XCTAssertEqual(buckets[0].warnings, 1)
        XCTAssertEqual(buckets[0].normal, 1)
        XCTAssertEqual(buckets[3].warnings, 1)
        XCTAssertEqual(buckets[1].total, 0)
    }

    func test_eventBuckets_nowBoundaryLandsInLastBucket() {
        let now = Date(timeIntervalSince1970: 100_000)
        let buckets = Viz.eventBuckets([event("e", warning: true, at: now)], now: now, span: 4, count: 4)
        XCTAssertEqual(buckets[3].warnings, 1)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter VizAggregationsTests/test_eventBuckets_partitionsByTimeAndSeverity`
Expected: FAIL — `Viz.eventBuckets` is not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `enum Viz` in `Aggregations.swift`:

```swift
    // MARK: - Event timeline buckets

    struct EventBucket: Equatable, Identifiable {
        let index: Int
        let start: Date
        var warnings: Int
        var normal: Int
        var id: Int { index }
        var total: Int { warnings + normal }
    }

    /// Partition events into `count` equal slots spanning `[now - span, now]`.
    /// Events without a usable timestamp or outside the window are dropped; an
    /// event exactly at `now` lands in the final bucket.
    static func eventBuckets(_ events: [K8sEvent], now: Date, span: TimeInterval, count: Int) -> [EventBucket] {
        precondition(count > 0 && span > 0)
        let slot = span / Double(count)
        let start = now.addingTimeInterval(-span)
        var buckets = (0..<count).map {
            EventBucket(index: $0, start: start.addingTimeInterval(Double($0) * slot), warnings: 0, normal: 0)
        }
        for e in events {
            guard let when = e.when, when >= start, when <= now else { continue }
            var idx = Int(when.timeIntervalSince(start) / slot)
            if idx >= count { idx = count - 1 }
            if idx < 0 { idx = 0 }
            if e.isWarning { buckets[idx].warnings += 1 } else { buckets[idx].normal += 1 }
        }
        return buckets
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter VizAggregationsTests`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Charts/Aggregations.swift Tests/HelmsmanTests/VizAggregationsTests.swift
git commit -m "feat(viz): event timeline bucketing aggregation"
```

---

## Task 4: Aggregations — treemap model

**Files:**
- Modify: `Sources/Helmsman/Charts/Aggregations.swift`
- Test: `Tests/HelmsmanTests/VizAggregationsTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `VizAggregationsTests.swift`:

```swift
    private func pod(_ name: String, node: String?, phase: String, restarts: Int) -> Pod {
        Pod(
            metadata: ObjectMeta(name: name, namespace: "default", uid: "uid-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: PodSpec(nodeName: node, containers: []),
            status: PodStatus(phase: phase, podIP: nil,
                              containerStatuses: [ContainerStatus(name: "c", ready: true, restartCount: restarts, state: nil)])
        )
    }

    func test_treemapModel_groupsByNodeWithValuesAndHealth() {
        let pods = [
            pod("a", node: "n1", phase: "Running", restarts: 0),
            pod("b", node: "n1", phase: "Running", restarts: 3),   // warning
            pod("c", node: "n2", phase: "Failed",  restarts: 0),   // failed
        ]
        let nodes = [node("n1", cpu: "4", mem: "8Gi"), node("n2", cpu: "4", mem: "8Gi")]
        let history: [String: [PodMetricSample]] = [
            "default/a": [PodMetricSample(cpuCores: 0.5, memBytes: 100)],
            "default/b": [PodMetricSample(cpuCores: 1.5, memBytes: 200)],
            "default/c": [PodMetricSample(cpuCores: 0.1, memBytes: 50)],
        ]
        let model = Viz.treemapModel(pods: pods, nodes: nodes, history: history, metric: .cpu)
        XCTAssertEqual(model.map(\.name), ["n1", "n2"])              // node order preserved
        XCTAssertEqual(model[0].pods.map(\.name), ["b", "a"])        // sorted by value desc
        XCTAssertEqual(model[0].pods[0].value, 1.5, accuracy: 0.001)
        XCTAssertEqual(model[0].pods[0].health, .warning)
        XCTAssertEqual(model[1].pods[0].health, .failed)
    }

    func test_treemapModel_unscheduledPodsGrouped() {
        let pods = [pod("a", node: nil, phase: "Pending", restarts: 0)]
        let model = Viz.treemapModel(pods: pods, nodes: [], history: [:], metric: .cpu)
        XCTAssertEqual(model.map(\.name), ["(unscheduled)"])
        XCTAssertEqual(model[0].pods[0].value, 0, accuracy: 0.001) // no history → 0
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter VizAggregationsTests/test_treemapModel_groupsByNodeWithValuesAndHealth`
Expected: FAIL — `Viz.treemapModel` is not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `enum Viz` in `Aggregations.swift`:

```swift
    // MARK: - Treemap model (Topology tab)

    enum TreemapMetric { case cpu, memory }
    enum PodHealth: Equatable { case healthy, warning, failed }

    struct TreemapPod: Equatable, Identifiable {
        let id: String          // pod uid
        let name: String
        let namespace: String
        let value: Double       // cpu cores or mem bytes (0 when no metrics)
        let health: PodHealth
    }

    struct TreemapNode: Equatable, Identifiable {
        let name: String
        let pods: [TreemapPod]
        var id: String { name }
        var total: Double { pods.reduce(0) { $0 + $1.value } }
    }

    /// Group pods under their assigned node (unscheduled pods under
    /// "(unscheduled)"), valued by latest CPU/mem sample and tagged with a
    /// health from phase + restart count. Nodes keep cluster list order; pods
    /// sort by value descending.
    static func treemapModel(pods: [Pod], nodes: [Node], history: [String: [PodMetricSample]], metric: TreemapMetric) -> [TreemapNode] {
        func value(for pod: Pod) -> Double {
            let key = "\(pod.metadata.namespace ?? "default")/\(pod.metadata.name)"
            guard let s = history[key]?.last else { return 0 }
            return metric == .cpu ? s.cpuCores : s.memBytes
        }
        func health(for pod: Pod) -> PodHealth {
            if pod.status?.phase == "Failed" { return .failed }
            let restarts = (pod.status?.containerStatuses ?? []).reduce(0) { $0 + $1.restartCount }
            return restarts > 0 ? .warning : .healthy
        }

        var byNode: [String: [TreemapPod]] = [:]
        for pod in pods {
            let node = pod.spec?.nodeName ?? "(unscheduled)"
            byNode[node, default: []].append(TreemapPod(
                id: pod.metadata.uid, name: pod.metadata.name,
                namespace: pod.metadata.namespace ?? "default",
                value: value(for: pod), health: health(for: pod)))
        }
        let nodeOrder = nodes.map(\.metadata.name)
        let ordered = nodeOrder.filter { byNode[$0] != nil }
            + byNode.keys.filter { !nodeOrder.contains($0) }.sorted()
        return ordered.map { name in
            TreemapNode(name: name, pods: (byNode[name] ?? []).sorted { $0.value > $1.value })
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter VizAggregationsTests`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Charts/Aggregations.swift Tests/HelmsmanTests/VizAggregationsTests.swift
git commit -m "feat(viz): node/pod treemap model aggregation"
```

---

## Task 5: Squarified treemap layout

**Files:**
- Create: `Sources/Helmsman/Charts/TreemapLayout.swift`
- Test: `Tests/HelmsmanTests/TreemapLayoutTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/HelmsmanTests/TreemapLayoutTests.swift`:

```swift
import XCTest
import CoreGraphics
@testable import Helmsman

final class TreemapLayoutTests: XCTestCase {

    func test_squarify_areasAreProportionalAndCoverRect() {
        let rect = CGRect(x: 0, y: 0, width: 60, height: 10)   // area 600
        let weights = [3.0, 2.0, 1.0]                          // total 6 → scale 100
        let rects = TreemapLayout.squarify(weights, in: rect)
        XCTAssertEqual(rects.count, 3)
        XCTAssertEqual(rects[0].width * rects[0].height, 300, accuracy: 0.001)
        XCTAssertEqual(rects[1].width * rects[1].height, 200, accuracy: 0.001)
        XCTAssertEqual(rects[2].width * rects[2].height, 100, accuracy: 0.001)
        let covered = rects.reduce(0.0) { $0 + $1.width * $1.height }
        XCTAssertEqual(covered, 600, accuracy: 0.001)
    }

    func test_squarify_zeroWeightsGetZeroRect() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 100)
        let rects = TreemapLayout.squarify([1.0, 0.0, 1.0], in: rect)
        XCTAssertEqual(rects[1], .zero)
        XCTAssertEqual(rects[0].width * rects[0].height, 5000, accuracy: 0.001)
    }

    func test_squarify_emptyOrDegenerateReturnsZeros() {
        XCTAssertTrue(TreemapLayout.squarify([], in: CGRect(x: 0, y: 0, width: 10, height: 10)).isEmpty)
        let rects = TreemapLayout.squarify([1, 1], in: .zero)
        XCTAssertEqual(rects, [.zero, .zero])
    }

    func test_squarify_rectsStayInsideBounds() {
        let rect = CGRect(x: 0, y: 0, width: 200, height: 120)
        let rects = TreemapLayout.squarify([5, 3, 2, 8, 1, 4], in: rect)
        for r in rects where r != .zero {
            XCTAssertGreaterThanOrEqual(r.minX, -0.001)
            XCTAssertGreaterThanOrEqual(r.minY, -0.001)
            XCTAssertLessThanOrEqual(r.maxX, rect.width + 0.001)
            XCTAssertLessThanOrEqual(r.maxY, rect.height + 0.001)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter TreemapLayoutTests`
Expected: FAIL — `TreemapLayout` is not defined.

- [ ] **Step 3: Write minimal implementation**

Create `Sources/Helmsman/Charts/TreemapLayout.swift`:

```swift
import CoreGraphics

/// Squarified treemap layout. Maps positive weights to rects (same order)
/// packed into `rect` to keep tiles close to square. Each rect's area equals
/// its share of the total area exactly; zero/negative weights get `.zero`.
enum TreemapLayout {
    static func squarify(_ weights: [Double], in rect: CGRect) -> [CGRect] {
        var result = [CGRect](repeating: .zero, count: weights.count)
        let total = weights.reduce(0, +)
        guard total > 0, rect.width > 0, rect.height > 0 else { return result }

        let scale = Double(rect.width * rect.height) / total
        let items = weights.enumerated()
            .filter { $0.element > 0 }
            .map { (index: $0.offset, area: $0.element * scale) }

        var free = rect
        var i = 0
        while i < items.count {
            let side = Double(min(free.width, free.height))
            var row = [items[i]]
            var j = i + 1
            while j < items.count {
                let next = row + [items[j]]
                if worstRatio(next, side: side) <= worstRatio(row, side: side) {
                    row = next; j += 1
                } else { break }
            }
            free = layoutRow(row, in: free, into: &result)
            i = j
        }
        return result
    }

    private static func worstRatio(_ row: [(index: Int, area: Double)], side: Double) -> Double {
        let sum = row.reduce(0) { $0 + $1.area }
        guard sum > 0, side > 0 else { return .greatestFiniteMagnitude }
        let maxA = row.map(\.area).max() ?? 0
        let minA = row.map(\.area).min() ?? 0
        guard minA > 0 else { return .greatestFiniteMagnitude }
        let s2 = side * side, sum2 = sum * sum
        return max((s2 * maxA) / sum2, sum2 / (s2 * minA))
    }

    /// Lay a row along the shorter dimension of `free`; return the remaining
    /// rect. Each tile's area equals its `area` value exactly.
    private static func layoutRow(_ row: [(index: Int, area: Double)], in free: CGRect, into result: inout [CGRect]) -> CGRect {
        let sum = row.reduce(0) { $0 + $1.area }
        guard sum > 0 else { return free }
        if free.width >= free.height {
            let rowW = CGFloat(sum) / free.height
            var y = free.minY
            for item in row {
                let h = CGFloat(item.area) / CGFloat(sum) * free.height
                result[item.index] = CGRect(x: free.minX, y: y, width: rowW, height: h)
                y += h
            }
            return CGRect(x: free.minX + rowW, y: free.minY, width: free.width - rowW, height: free.height)
        } else {
            let rowH = CGFloat(sum) / free.width
            var x = free.minX
            for item in row {
                let w = CGFloat(item.area) / CGFloat(sum) * free.width
                result[item.index] = CGRect(x: x, y: free.minY, width: w, height: rowH)
                x += w
            }
            return CGRect(x: free.minX, y: free.minY + rowH, width: free.width, height: free.height - rowH)
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `swift test --filter TreemapLayoutTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Charts/TreemapLayout.swift Tests/HelmsmanTests/TreemapLayoutTests.swift
git commit -m "feat(viz): squarified treemap layout"
```

---

## Task 6: ChartTheme + RingGauge view

**Files:**
- Create: `Sources/Helmsman/Charts/ChartTheme.swift`, `Sources/Helmsman/Charts/RingGauge.swift`

No unit tests (pure SwiftUI views/constants — verified by build + manual run, per codebase convention).

- [ ] **Step 1: Create ChartTheme**

Create `Sources/Helmsman/Charts/ChartTheme.swift`:

```swift
import SwiftUI

/// Shared color mapping for the cluster visualizations, so the treemap,
/// timeline and gauges read consistently against the app `Theme`.
enum ChartTheme {
    static func color(for health: Viz.PodHealth) -> Color {
        switch health {
        case .healthy: return Theme.Status.running
        case .warning: return Theme.Status.pending
        case .failed:  return Theme.Status.failed
        }
    }

    /// Ring/usage tint by load fraction: accent → amber → red as it fills.
    static func loadColor(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.75: return Theme.Accent.primary
        case ..<0.9:  return Theme.Status.pending
        default:      return Theme.Status.failed
        }
    }
}
```

- [ ] **Step 2: Create RingGauge**

Create `Sources/Helmsman/Charts/RingGauge.swift`:

```swift
import SwiftUI

/// Circular usage gauge: an arc filled to `fraction`, a percentage in the
/// middle, a title and a detail caption. Native SwiftUI shapes (no Charts).
struct RingGauge: View {
    let title: String
    let fraction: Double      // 0...1
    let detail: String        // e.g. "3 / 8 cores"

    private var clamped: Double { min(max(fraction, 0), 1) }

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().stroke(Theme.Surface.sunken, lineWidth: 10)
                Circle()
                    .trim(from: 0, to: clamped)
                    .stroke(ChartTheme.loadColor(clamped), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.4), value: clamped)
                Text("\(Int((clamped * 100).rounded()))%")
                    .font(Theme.Font.mono(18, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            .frame(width: 84, height: 84)
            Text(title)
                .font(Theme.Font.body(11, weight: .semibold))
                .foregroundStyle(Theme.Foreground.secondary)
                .textCase(.uppercase).tracking(0.5)
            Text(detail)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(14)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }
}
```

- [ ] **Step 3: Build to verify it compiles**

Run: `swift build`
Expected: Build complete, no errors.

- [ ] **Step 4: Commit**

```bash
git add Sources/Helmsman/Charts/ChartTheme.swift Sources/Helmsman/Charts/RingGauge.swift
git commit -m "feat(viz): ChartTheme + RingGauge view"
```

---

## Task 7: Wire gauges + waste headline into Overview (#3)

**Files:**
- Modify: `Sources/Helmsman/Panels/Overview/OverviewPanel.swift`
- Modify: `Sources/Helmsman/Shell/MainWindow.swift:420-426` (Overview call site)

- [ ] **Step 1: Pass rightSizingVM into OverviewPanel**

In `OverviewPanel.swift`, add the property after the existing `databasesVM` (line 6):

```swift
    @Bindable var databasesVM: DatabasesViewModel
    @Bindable var rightSizingVM: RightSizingViewModel
    let onInvestigate: () -> Void
```

In `MainWindow.swift`, update the `.overview` case (currently lines 420-426) to pass it:

```swift
        case .overview:
            OverviewPanel(
                cache: cache,
                contextManager: contextManager,
                databasesVM: databasesVM,
                rightSizingVM: rightSizingVM,
                onInvestigate: investigateCluster
            )
```

- [ ] **Step 2: Add the gauges row + waste card to OverviewPanel**

In `OverviewPanel.swift`, insert `gaugesRow` into `body` between `header` and `topRow`:

```swift
            VStack(alignment: .leading, spacing: 12) {
                header
                gaugesRow
                topRow
                middleRow
                warningsCard
            }
```

Add these members to the `OverviewPanel` struct (e.g. after `topRow`). They reuse the file-private `Card`/`MetricRow` primitives already defined at the bottom of the file:

```swift
    // MARK: - Gauges row: Cluster CPU | Cluster Memory | Reclaimable

    private var gaugesRow: some View {
        let totals = Viz.clusterResourceTotals(nodes: cache.nodes, metrics: cache.nodeMetrics)
        let waste = Viz.wasteSummary(rightSizingVM.results)
        return HStack(alignment: .top, spacing: 12) {
            if cache.metricsAvailable && totals.cpuAllocatable > 0 {
                RingGauge(
                    title: "Cluster CPU",
                    fraction: totals.cpuFraction,
                    detail: "\(ResourceQuantity.formatCores(totals.cpuUsed)) / \(ResourceQuantity.formatCores(totals.cpuAllocatable))"
                )
                RingGauge(
                    title: "Cluster Memory",
                    fraction: totals.memFraction,
                    detail: "\(ResourceQuantity.formatBytes(totals.memUsed)) / \(ResourceQuantity.formatBytes(totals.memAllocatable))"
                )
            } else {
                metricsUnavailableCard
            }
            wasteCard(waste)
        }
    }

    private var metricsUnavailableCard: some View {
        Card(title: "Cluster Usage", icon: "gauge.with.dots.needle.bottom.50percent") {
            Text("metrics-server unavailable — install it to see live CPU/memory usage.")
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func wasteCard(_ waste: Viz.WasteSummary) -> some View {
        Card(title: "Reclaimable", icon: "arrow.down.right.circle.fill") {
            if waste.workloadCount > 0 {
                MetricRow(
                    big: ResourceQuantity.formatBytes(waste.reclaimableBytes),
                    caption: "across \(waste.workloadCount) workload\(waste.workloadCount == 1 ? "" : "s")"
                )
                Text("Memory you could give back by right-sizing over-provisioned workloads.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                MetricRow(big: "—", caption: "no data yet")
                Text("Open Right-Sizing to analyze workloads and surface reclaimable memory.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `swift build`
Expected: Build complete, no errors.

- [ ] **Step 4: Manual checkpoint**

Run the app (`swift run Helmsman`), open Overview. Expected: two ring gauges (Cluster CPU, Cluster Memory) showing percentages, plus a "Reclaimable" card. Visit Right-Sizing once, return to Overview → the Reclaimable card now shows a byte figure and workload count. (If metrics-server isn't installed, the "Cluster Usage" unavailable card shows instead.)

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Panels/Overview/OverviewPanel.swift Sources/Helmsman/Shell/MainWindow.swift
git commit -m "feat(overview): cluster usage gauges + reclaimable-waste headline"
```

---

## Task 8: EventTimeline view + wire into Events and Overview (#4)

**Files:**
- Create: `Sources/Helmsman/Charts/EventTimeline.swift`
- Modify: `Sources/Helmsman/Panels/Events/EventsPanel.swift`
- Modify: `Sources/Helmsman/Panels/Overview/OverviewPanel.swift`

- [ ] **Step 1: Create the EventTimeline view**

Create `Sources/Helmsman/Charts/EventTimeline.swift`:

```swift
import SwiftUI
import Charts

/// Stacked-bar ribbon of event volume over a recent window: normal events in
/// muted grey, warnings in red, one bar per time bucket. Surfaces incident
/// clusters ("everything went red at 2am") at a glance.
struct EventTimeline: View {
    let buckets: [Viz.EventBucket]
    var height: CGFloat = 70

    private var isEmpty: Bool { buckets.allSatisfy { $0.total == 0 } }

    var body: some View {
        Group {
            if isEmpty {
                Text("No events in the last 24 hours.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: height)
            } else {
                Chart(buckets) { b in
                    BarMark(x: .value("Time", b.start), y: .value("Normal", b.normal), width: .ratio(0.9))
                        .foregroundStyle(Theme.Foreground.tertiary.opacity(0.5))
                    BarMark(x: .value("Time", b.start), y: .value("Warnings", b.warnings), width: .ratio(0.9))
                        .foregroundStyle(Theme.Status.failed)
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                        AxisGridLine().foregroundStyle(Theme.Border.subtle)
                        AxisValueLabel(format: .dateTime.hour())
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisGridLine().foregroundStyle(Theme.Border.subtle)
                        AxisValueLabel()
                    }
                }
                .frame(height: height)
            }
        }
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `swift build`
Expected: Build complete, no errors.

- [ ] **Step 3: Wire into EventsPanel**

In `EventsPanel.swift`, insert the ribbon between `filterBar` and the error/list block in `body`:

```swift
        VStack(alignment: .leading, spacing: 0) {
            header
            filterBar
            timelineRibbon

            if let err = viewModel.error {
```

Add this computed property to the `EventsPanel` struct (e.g. after `filterBar`):

```swift
    private var timelineRibbon: some View {
        EventTimeline(buckets: Viz.eventBuckets(viewModel.cache.events, now: Date(), span: 24 * 3600, count: 48))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Theme.Surface.elevated)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }
```

- [ ] **Step 4: Wire a compact ribbon into Overview**

In `OverviewPanel.swift`, add `eventTimelineCard` to `body` between `middleRow` and `warningsCard`:

```swift
                middleRow
                eventTimelineCard
                warningsCard
```

Add this member to the `OverviewPanel` struct:

```swift
    private var eventTimelineCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "waveform.path.ecg").font(.system(size: 11)).foregroundStyle(Theme.Accent.primary)
                Text("Event activity — last 24h")
                    .font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textCase(.uppercase).tracking(0.5)
                Spacer()
            }
            EventTimeline(buckets: Viz.eventBuckets(cache.events, now: Date(), span: 24 * 3600, count: 48), height: 56)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }
```

- [ ] **Step 5: Build + manual checkpoint**

Run: `swift build`
Expected: Build complete, no errors.
Then `swift run Helmsman`: the Events tab shows a stacked-bar ribbon above the list; Overview shows an "Event activity" card. With no recent events both show the "No events in the last 24 hours." empty state.

- [ ] **Step 6: Commit**

```bash
git add Sources/Helmsman/Charts/EventTimeline.swift Sources/Helmsman/Panels/Events/EventsPanel.swift Sources/Helmsman/Panels/Overview/OverviewPanel.swift
git commit -m "feat(events): event-volume timeline ribbon on Events + Overview"
```

---

## Task 9: ClusterTreemap view

**Files:**
- Create: `Sources/Helmsman/Charts/ClusterTreemap.swift`

- [ ] **Step 1: Create the treemap views**

Create `Sources/Helmsman/Charts/ClusterTreemap.swift`:

```swift
import SwiftUI

/// One node's pods laid out as a squarified treemap. Tiles are sized by
/// CPU/mem usage and colored by health; pods with no metrics floor to a small
/// dimmed tile so they still appear. Tapping a tile calls `onSelect`.
struct NodeTreemap: View {
    let node: Viz.TreemapNode
    let metric: Viz.TreemapMetric
    let onSelect: (Viz.TreemapPod) -> Void

    var body: some View {
        GeometryReader { geo in
            let maxV = node.pods.map(\.value).max() ?? 0
            let floor = max(maxV * 0.03, 1)                       // keep zero-usage pods visible
            let weights = node.pods.map { max($0.value, floor) }
            let rects = TreemapLayout.squarify(weights, in: CGRect(origin: .zero, size: geo.size))
            ForEach(Array(node.pods.enumerated()), id: \.element.id) { i, pod in
                let r = rects[i]
                if r != .zero {
                    tile(pod, size: r.size)
                        .frame(width: r.width, height: r.height)
                        .position(x: r.midX, y: r.midY)
                        .onTapGesture { onSelect(pod) }
                        .help("\(pod.namespace)/\(pod.name) — \(formatted(pod.value))")
                }
            }
        }
    }

    private func tile(_ pod: Viz.TreemapPod, size: CGSize) -> some View {
        let dimmed = pod.value <= 0
        return ChartTheme.color(for: pod.health).opacity(dimmed ? 0.35 : 0.85)
            .overlay(Rectangle().strokeBorder(Theme.Surface.primary, lineWidth: 1))
            .overlay(alignment: .topLeading) {
                if size.width > 46 && size.height > 18 {
                    Text(pod.name)
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Foreground.inverse)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(3)
                }
            }
    }

    private func formatted(_ value: Double) -> String {
        metric == .cpu ? ResourceQuantity.formatCores(value) : ResourceQuantity.formatBytes(value)
    }
}

/// A node's treemap framed in a titled card (node name + pod count + total).
struct NodeTreemapCard: View {
    let node: Viz.TreemapNode
    let metric: Viz.TreemapMetric
    let onSelect: (Viz.TreemapPod) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "server.rack").font(.system(size: 11)).foregroundStyle(Theme.Accent.primary)
                Text(node.name).font(Theme.Font.mono(11, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                Spacer()
                Text("\(node.pods.count) pods · \(total)")
                    .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
            }
            NodeTreemap(node: node, metric: metric, onSelect: onSelect)
                .frame(height: 160)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .padding(12)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    private var total: String {
        metric == .cpu ? ResourceQuantity.formatCores(node.total) : ResourceQuantity.formatBytes(node.total)
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `swift build`
Expected: Build complete, no errors.

- [ ] **Step 3: Commit**

```bash
git add Sources/Helmsman/Charts/ClusterTreemap.swift
git commit -m "feat(viz): cluster treemap node + tile views"
```

---

## Task 10: TopologyPanel + new tab (#1)

**Files:**
- Create: `Sources/Helmsman/Panels/Topology/TopologyPanel.swift`
- Modify: `Sources/Helmsman/Panels/PanelKind.swift`
- Modify: `Sources/Helmsman/Shell/MainWindow.swift`

- [ ] **Step 1: Add the `.topology` PanelKind**

In `PanelKind.swift`:

Add the case after `.nodes` (line 11):
```swift
    case nodes
    case topology
```

Add to the "Cluster" nav group (line 42) — place it next to Nodes:
```swift
        NavGroup(title: "Cluster", panels: [.namespaces, .nodes, .topology, .rbac]),
```

Add to `icon` (in the switch):
```swift
        case .topology:    return "rectangle.3.group.fill"
```

Add to `title`:
```swift
        case .topology:    return "Topology"
```

Add to `subtitle`:
```swift
        case .topology:    return "Cluster map"
```

Add to `isNamespaceScoped` — it is **not** namespace-scoped, so add it to the `false` branch:
```swift
        case .overview, .assistant, .namespaces, .nodes, .topology, .databases,
             .catalog, .logs, .settings:
            return false
```

- [ ] **Step 2: Create TopologyPanel**

Create `Sources/Helmsman/Panels/Topology/TopologyPanel.swift`:

```swift
import SwiftUI

struct TopologyPanel: View {
    @Bindable var cache: ClusterCache
    let onSelectPod: (Viz.TreemapPod) -> Void

    @State private var metric: Viz.TreemapMetric = .cpu

    private var model: [Viz.TreemapNode] {
        Viz.treemapModel(pods: cache.pods, nodes: cache.nodes, history: cache.podMetricsHistory, metric: metric)
    }

    private let columns = [GridItem(.adaptive(minimum: 320), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if model.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(model) { node in
                            NodeTreemapCard(node: node, metric: metric, onSelect: onSelectPod)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.topology)
            Spacer()
            Picker("", selection: $metric) {
                Text("CPU").tag(Viz.TreemapMetric.cpu)
                Text("Memory").tag(Viz.TreemapMetric.memory)
            }
            .pickerStyle(.segmented).frame(width: 160).labelsHidden()
            legend
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var legend: some View {
        HStack(spacing: 10) {
            swatch(.healthy, "Healthy")
            swatch(.warning, "Restarts")
            swatch(.failed, "Failed")
        }
    }

    private func swatch(_ health: Viz.PodHealth, _ label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(ChartTheme.color(for: health)).frame(width: 9, height: 9)
            Text(label).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "rectangle.3.group").font(.system(size: 28)).foregroundStyle(Theme.Foreground.tertiary)
            Text("No pods to map yet.").font(Theme.Font.body(13)).foregroundStyle(Theme.Foreground.secondary)
            Text("Tile size reflects live CPU/memory usage from metrics-server.")
                .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
```

- [ ] **Step 3: Route the panel in MainWindow**

In `MainWindow.swift`, add a case to `panelView` after the `.nodes` case (line 468-469):

```swift
        case .topology:
            TopologyPanel(cache: cache, onSelectPod: { pod in
                podsVM.search = pod.name
                selectedPanel = .pods
            })
```

- [ ] **Step 4: Build + run the PanelKind coverage test**

Run: `swift build`
Expected: Build complete (the `.topology` case is handled in every `PanelKind` switch and routed in `MainWindow`).

Run: `swift test --filter PanelKind`
Expected: PASS — the nav-group coverage test still sees every case exactly once (`.topology` is in the Cluster group).

- [ ] **Step 5: Manual checkpoint**

`swift run Helmsman`: a new "Topology" item appears under Cluster in the sidebar. It renders one card per node, each a treemap of its pods sized by CPU (toggle to Memory). Tapping a tile jumps to the Pods tab filtered to that pod name.

- [ ] **Step 6: Commit**

```bash
git add Sources/Helmsman/Panels/Topology/TopologyPanel.swift Sources/Helmsman/Panels/PanelKind.swift Sources/Helmsman/Shell/MainWindow.swift
git commit -m "feat(topology): cluster treemap tab"
```

---

## Task 11: Prometheus range query plumbing

**Files:**
- Create: `Sources/Helmsman/Metrics/UsageSeriesSource.swift`
- Modify: `Sources/Helmsman/Cluster/ClusterCache.swift`
- Test: `Tests/HelmsmanTests/UsageSeriesSourceTests.swift`

- [ ] **Step 1: Write the failing test**

Create `Tests/HelmsmanTests/UsageSeriesSourceTests.swift`:

```swift
import XCTest
@testable import Helmsman

final class UsageSeriesSourceTests: XCTestCase {

    func test_promRangeResponse_decodesMatrixValues() throws {
        let json = """
        {"status":"success","data":{"resultType":"matrix","result":[
          {"metric":{},"values":[[1000,"0.5"],[1300,"1.25"]]}
        ]}}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(PromRangeResponse.self, from: json)
        XCTAssertEqual(resp.status, "success")
        let pts = resp.data.result.first?.values ?? []
        XCTAssertEqual(pts.count, 2)
        XCTAssertEqual(pts[0].time, 1000, accuracy: 0.001)
        XCTAssertEqual(pts[1].value, 1.25, accuracy: 0.001)
    }

    func test_series_returnsEmptyForLocalBackend() async {
        let cache = ClusterCache()
        let source = UsageSeriesSource(backend: .local)
        let pts = await source.series(via: cache, namespace: "default", name: "web", metric: .cpu)
        XCTAssertTrue(pts.isEmpty)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --filter UsageSeriesSourceTests`
Expected: FAIL — `PromRangeResponse` / `UsageSeriesSource` are not defined.

- [ ] **Step 3: Add the range-query method to ClusterCache**

In `ClusterCache.swift`, add directly below the existing `promInstantQuery(path:)` (after line 303):

```swift
    /// Run a Prometheus-compatible range query (`/api/v1/query_range`) through
    /// the API-server proxy. Returns nil if no client or the query fails.
    func promRangeQuery(path: String) async -> PromRangeResponse? {
        guard let client else { return nil }
        return try? await client.getRaw(path, type: PromRangeResponse.self)
    }
```

- [ ] **Step 4: Create UsageSeriesSource**

Create `Sources/Helmsman/Metrics/UsageSeriesSource.swift`:

```swift
import Foundation

/// Decoded Prometheus/VictoriaMetrics range-query response
/// (`/api/v1/query_range`). Mirrors `PromQueryResponse` but with a values array.
struct PromRangeResponse: Decodable, Sendable {
    let status: String
    let data: Data

    struct Data: Decodable, Sendable {
        let resultType: String
        let result: [Series]
    }

    struct Series: Decodable, Sendable {
        let metric: [String: String]
        let values: [Point]
    }

    /// `[<unix seconds, Double>, "<value, String>"]`.
    struct Point: Decodable, Sendable {
        let time: Double
        let value: Double
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            time = (try? c.decode(Double.self)) ?? 0
            let s = (try? c.decode(String.self)) ?? ""
            value = Double(s) ?? .nan
        }
    }
}

/// One point on a usage-over-time series.
struct UsagePoint: Identifiable, Equatable {
    let date: Date
    let value: Double      // cpu cores or mem bytes
    var id: Date { date }
}

/// Pulls a workload's aggregate usage time series from a Prometheus-compatible
/// backend via the API-server proxy. Returns [] when the backend isn't
/// Prometheus or the query fails — the panel renders its empty state.
struct UsageSeriesSource {
    let backend: MetricsBackendConfig
    enum Metric { case cpu, memory }

    static let windowSeconds = 24 * 3600
    static let stepSeconds = 300

    func series(via cache: ClusterCache, namespace: String, name: String, metric: Metric, now: Date = Date()) async -> [UsagePoint] {
        guard let base = backend.proxyBase else { return [] }
        let sel = #"namespace="\#(namespace)",pod=~"\#(name)-.*",container!="",container!="POD""#
        let promql: String
        switch metric {
        case .cpu:    promql = "sum(rate(container_cpu_usage_seconds_total{\(sel)}[5m]))"
        case .memory: promql = "sum(container_memory_working_set_bytes{\(sel)})"
        }
        let end = Int(now.timeIntervalSince1970)
        let start = end - Self.windowSeconds
        guard let q = promql.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return [] }
        let path = "\(base)/api/v1/query_range?query=\(q)&start=\(start)&end=\(end)&step=\(Self.stepSeconds)"

        guard let resp = await cache.promRangeQuery(path: path),
              resp.status == "success",
              let series = resp.data.result.first else { return [] }
        return series.values
            .filter { $0.value.isFinite }
            .map { UsagePoint(date: Date(timeIntervalSince1970: $0.time), value: $0.value) }
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `swift test --filter UsageSeriesSourceTests`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add Sources/Helmsman/Metrics/UsageSeriesSource.swift Sources/Helmsman/Cluster/ClusterCache.swift Tests/HelmsmanTests/UsageSeriesSourceTests.swift
git commit -m "feat(metrics): Prometheus range query + usage series source"
```

---

## Task 12: UsageBandChart + WorkloadUsageBands view

**Files:**
- Create: `Sources/Helmsman/Charts/UsageBandChart.swift`

- [ ] **Step 1: Create the chart + self-fetching container view**

Create `Sources/Helmsman/Charts/UsageBandChart.swift`:

```swift
import SwiftUI
import Charts

/// Usage-over-time area with request/limit reference lines. Pure presentation —
/// the series and reference values are passed in.
struct UsageBandChart: View {
    let points: [UsagePoint]
    let request: Double?
    let limit: Double?
    let format: (Double) -> String

    var body: some View {
        Chart {
            ForEach(points) { p in
                AreaMark(x: .value("Time", p.date), y: .value("Usage", p.value))
                    .foregroundStyle(.linearGradient(
                        colors: [Theme.Accent.primary.opacity(0.35), Theme.Accent.primary.opacity(0.02)],
                        startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Time", p.date), y: .value("Usage", p.value))
                    .foregroundStyle(Theme.Accent.primary)
                    .interpolationMethod(.monotone)
            }
            if let request {
                RuleMark(y: .value("Request", request))
                    .foregroundStyle(Theme.Status.running)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("request \(format(request))").font(Theme.Font.mono(9)).foregroundStyle(Theme.Status.running)
                    }
            }
            if let limit {
                RuleMark(y: .value("Limit", limit))
                    .foregroundStyle(Theme.Status.failed)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("limit \(format(limit))").font(Theme.Font.mono(9)).foregroundStyle(Theme.Status.failed)
                    }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) { v in
                AxisGridLine().foregroundStyle(Theme.Border.subtle)
                AxisValueLabel {
                    if let d = v.as(Double.self) { Text(format(d)).font(Theme.Font.mono(9)) }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                AxisGridLine().foregroundStyle(Theme.Border.subtle)
                AxisValueLabel(format: .dateTime.hour())
            }
        }
        .frame(height: 150)
    }
}

/// Self-contained 24h usage panel for one workload: a CPU/Memory toggle, the
/// chart, and the Prometheus-only empty state. Fetches via `UsageSeriesSource`
/// whenever the metric or workload changes; renders the empty state when the
/// configured backend isn't Prometheus.
struct WorkloadUsageBands: View {
    @Bindable var cache: ClusterCache
    let backend: MetricsBackendConfig
    let workload: WorkloadRightSizing

    @State private var metric: UsageSeriesSource.Metric = .cpu
    @State private var points: [UsagePoint] = []
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Usage — last 24h")
                    .font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textCase(.uppercase).tracking(0.5)
                Spacer()
                Picker("", selection: $metric) {
                    Text("CPU").tag(UsageSeriesSource.Metric.cpu)
                    Text("Memory").tag(UsageSeriesSource.Metric.memory)
                }
                .pickerStyle(.segmented).frame(width: 160).labelsHidden()
                .disabled(!backend.isPrometheus)
            }

            content
        }
        .task(id: reloadKey) { await load() }
    }

    private var reloadKey: String {
        "\(workload.id)|\(metric == .cpu ? "cpu" : "mem")|\(backend.isPrometheus)"
    }

    @ViewBuilder private var content: some View {
        if !backend.isPrometheus {
            emptyState(
                icon: "chart.xyaxis.line",
                title: "Connect a metrics backend for usage history",
                detail: "Pick a Prometheus or VictoriaMetrics source in the picker above to see 24-hour usage bands."
            )
        } else if loading && points.isEmpty {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).frame(height: 150)
        } else if points.isEmpty {
            emptyState(
                icon: "questionmark.circle",
                title: "No usage data for the last 24h",
                detail: "The metrics backend returned no samples for this workload."
            )
        } else {
            UsageBandChart(points: points, request: requestLine, limit: limitLine, format: formatter)
        }
    }

    private func emptyState(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 20)).foregroundStyle(Theme.Foreground.tertiary)
            Text(title).font(Theme.Font.body(12, weight: .medium)).foregroundStyle(Theme.Foreground.secondary)
            Text(detail).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity).frame(height: 150)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var formatter: (Double) -> String {
        metric == .cpu ? ResourceQuantity.formatCores : ResourceQuantity.formatBytes
    }

    // Reference lines = sum of present per-container requests/limits for the
    // selected metric (matches the summed PromQL series). nil when none set.
    private var requestLine: Double? {
        let vals = workload.containers.compactMap { metric == .cpu ? $0.cpuRequest : $0.memRequest }
        return vals.isEmpty ? nil : vals.reduce(0, +)
    }
    private var limitLine: Double? {
        let vals = workload.containers.compactMap { metric == .cpu ? $0.cpuLimit : $0.memLimit }
        return vals.isEmpty ? nil : vals.reduce(0, +)
    }

    private func load() async {
        guard backend.isPrometheus else { points = []; return }
        loading = true
        defer { loading = false }
        let source = UsageSeriesSource(backend: backend)
        points = await source.series(via: cache, namespace: workload.namespace, name: workload.name, metric: metric)
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `swift build`
Expected: Build complete, no errors.

- [ ] **Step 3: Commit**

```bash
git add Sources/Helmsman/Charts/UsageBandChart.swift
git commit -m "feat(viz): usage-band chart + self-fetching workload usage view"
```

---

## Task 13: Wire usage bands into Right-Sizing (#2)

**Files:**
- Modify: `Sources/Helmsman/Panels/RightSizing/RightSizingPanel.swift`

- [ ] **Step 1: Locate the workload detail area**

Open `Sources/Helmsman/Panels/RightSizing/RightSizingPanel.swift` and find where a single workload's per-container detail is rendered (the expanded row / detail section that has access to a `WorkloadRightSizing` value — typically named `w` or `workload`, matching the `viewModel.filtered` / expansion pattern used by the other panels). Identify:
  - the `WorkloadRightSizing` value in scope (call it `w`),
  - the view model property name (the panel holds `viewModel: RightSizingViewModel`).

- [ ] **Step 2: Insert the usage bands**

At the bottom of that per-workload detail `VStack` (after the container rows), add:

```swift
            WorkloadUsageBands(
                cache: viewModel.cache,
                backend: viewModel.backend,
                workload: w
            )
            .padding(.top, 8)
```

If the detail content is a separate child `View` struct that only receives a `WorkloadRightSizing` (not the view model), thread `cache` and `backend` into that child: add `let cache: ClusterCache` and `let backend: MetricsBackendConfig` stored properties to it and pass `viewModel.cache` / `viewModel.backend` from the parent at the call site. Do not add new fetching to the view model — `WorkloadUsageBands` fetches itself.

- [ ] **Step 3: Build to verify it compiles**

Run: `swift build`
Expected: Build complete, no errors.

- [ ] **Step 4: Manual checkpoint**

`swift run Helmsman`, open Right-Sizing, expand a workload:
  - With a Prometheus/VictoriaMetrics source selected: a "Usage — last 24h" area chart with request/limit dashed reference lines, CPU/Memory toggle.
  - With "Local history" selected: the "Connect a metrics backend for usage history" empty state (no fallback to local data).

- [ ] **Step 5: Commit**

```bash
git add Sources/Helmsman/Panels/RightSizing/RightSizingPanel.swift
git commit -m "feat(right-sizing): 24h usage-band chart per workload"
```

---

## Task 14: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `swift build`
Expected: Build complete, no warnings introduced by new files.

- [ ] **Step 2: Full test suite**

Run: `swift test`
Expected: All tests pass, including `VizAggregationsTests` (8), `TreemapLayoutTests` (4), `UsageSeriesSourceTests` (2), and the existing `PanelKind` coverage test.

- [ ] **Step 3: Manual smoke test of all four features**

`swift run Helmsman` and confirm:
1. Overview: ring gauges + reclaimable headline + event-activity card.
2. Events: timeline ribbon above the list.
3. Topology: new tab, node treemaps, CPU/Mem toggle, tap-to-Pods.
4. Right-Sizing: usage-band chart (Prometheus) / empty state (local).

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore(viz): cluster visualizations verification pass" || echo "nothing to commit"
```

---

## Self-Review Notes (author)

- **Spec coverage:** #1 Topology → Tasks 4,5,9,10. #2 Usage bands → Tasks 11,12,13 (Prometheus-only + empty state ✓). #3 Gauges + waste → Tasks 1,2,6,7. #4 Event timeline → Tasks 3,8. Shared foundation → Tasks 1–6. Empty-state-not-fallback honored in Tasks 7 (gauges), 8 (timeline), 13 (usage bands), 10 (topology). ✓
- **Build order matches spec:** Foundation → #3 → #4 → #1 → #2. ✓
- **Type consistency:** `Viz.*`, `TreemapLayout.squarify`, `PromRangeResponse`, `UsageSeriesSource`, `UsagePoint`, `WorkloadUsageBands` used identically across tasks. Verified against real signatures: `ResourceQuantity.cpuCores/bytes/formatCores/formatBytes`, `ClusterCache.{nodes,nodeMetrics,pods,podMetricsHistory,events,promRangeQuery}`, `MetricsBackendConfig.{proxyBase,isPrometheus,local}`, `RightSizingViewModel.{cache,backend,results}`, `WorkloadRightSizing.{containers,reclaimableMemBytes,namespace,name,id}`, `RightSizingResult` fields, `K8sEvent.when/isWarning`, `Node`/`NodeStatus`/`NodeMetrics`/`Pod`/`ContainerStatus` initializers (mirrored from `SuggestedActionTests` fixtures). ✓
- **Topology selection** reuses the existing `podsVM.search` + `selectedPanel = .pods` pattern from `MainWindow` (`AssistantPanel.onShowPod`). ✓
```
