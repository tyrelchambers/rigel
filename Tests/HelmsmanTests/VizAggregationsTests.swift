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
}
