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

    func test_eventBuckets_windowStartBoundaryLandsInFirstBucket() {
        let now = Date(timeIntervalSince1970: 100_000)
        let span: TimeInterval = 4
        let buckets = Viz.eventBuckets([event("s", warning: false, at: now.addingTimeInterval(-span))],
                                        now: now, span: span, count: 4)
        XCTAssertEqual(buckets[0].normal, 1)
    }

    func test_treemapModel_memoryMetricUsesMemBytes() {
        let pods = [pod("a", node: "n1", phase: "Running", restarts: 0)]
        let nodes = [node("n1", cpu: "4", mem: "8Gi")]
        let history: [String: [PodMetricSample]] = ["default/a": [PodMetricSample(cpuCores: 0.5, memBytes: 4096)]]
        let model = Viz.treemapModel(pods: pods, nodes: nodes, history: history, metric: .memory)
        XCTAssertEqual(model[0].pods[0].value, 4096, accuracy: 0.001)
    }

    func test_treemapModel_unscheduledPodsGrouped() {
        let pods = [pod("a", node: nil, phase: "Pending", restarts: 0)]
        let model = Viz.treemapModel(pods: pods, nodes: [], history: [:], metric: .cpu)
        XCTAssertEqual(model.map(\.name), ["(unscheduled)"])
        XCTAssertEqual(model[0].pods[0].value, 0, accuracy: 0.001) // no history → 0
    }
}
