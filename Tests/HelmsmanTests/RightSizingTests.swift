import XCTest
@testable import Helmsman

final class RightSizingTests: XCTestCase {
    private let mi = 1024.0 * 1024.0

    // MARK: - Quantity emitters

    func test_cpuQuantityString() {
        XCTAssertEqual(ResourceQuantity.cpuQuantityString(0.25), "250m")
        XCTAssertEqual(ResourceQuantity.cpuQuantityString(2.0), "2")
        XCTAssertEqual(ResourceQuantity.cpuQuantityString(0.0), "10m")     // floor 10m
        XCTAssertEqual(ResourceQuantity.cpuQuantityString(0.123), "130m")  // round up to 10m
    }

    func test_memQuantityString() {
        XCTAssertEqual(ResourceQuantity.memQuantityString(320 * mi), "320Mi")
        XCTAssertEqual(ResourceQuantity.memQuantityString(2 * 1024 * mi), "2Gi")
        XCTAssertEqual(ResourceQuantity.memQuantityString(1), "1Mi")       // floor 1Mi
    }

    // MARK: - Analysis verdicts

    private func stats(cpuPeak: Double = 0, cpuTyp: Double = 0, memPeak: Double = 0, memTyp: Double = 0, hours: Int = 48) -> WindowStats {
        WindowStats(container: "app", cpuPeak: cpuPeak, cpuTypical: cpuTyp, memPeak: memPeak, memTypical: memTyp, hoursCovered: hours)
    }

    func test_insufficientData_underMinHours() {
        let cur = ContainerResources(container: "app", cpuRequest: 0.5, cpuLimit: 1, memRequest: 256 * mi, memLimit: 512 * mi)
        let r = RightSizing.analyze(current: cur, stats: stats(hours: 5))
        XCTAssertEqual(r.verdict, .insufficientData)
        XCTAssertFalse(r.hasSuggestion)
    }

    func test_overProvisioned_whenRequestFarAboveTypical() {
        // Requesting 2Gi but typically using 200Mi, peak 300Mi.
        let cur = ContainerResources(container: "app", cpuRequest: 1, cpuLimit: 2, memRequest: 2048 * mi, memLimit: 4096 * mi)
        let r = RightSizing.analyze(current: cur, stats: stats(cpuPeak: 0.1, cpuTyp: 0.05, memPeak: 300 * mi, memTyp: 200 * mi))
        XCTAssertEqual(r.verdict, .overProvisioned)
        XCTAssertNotNil(r.suggestedMemRequest)
        // Suggested mem limit ≈ peak × 1.2.
        XCTAssertEqual(r.suggestedMemLimit!, 300 * mi * 1.2, accuracy: 1)
    }

    func test_atRisk_whenPeakNearMemLimit() {
        // Peak 480Mi against a 512Mi limit → ≥90%.
        let cur = ContainerResources(container: "app", cpuRequest: 0.2, cpuLimit: 0.5, memRequest: 256 * mi, memLimit: 512 * mi)
        let r = RightSizing.analyze(current: cur, stats: stats(cpuPeak: 0.1, cpuTyp: 0.05, memPeak: 480 * mi, memTyp: 300 * mi))
        XCTAssertEqual(r.verdict, .atRisk)
    }

    func test_unset_whenRequestsMissing() {
        let cur = ContainerResources(container: "app", cpuRequest: nil, cpuLimit: nil, memRequest: nil, memLimit: nil)
        let r = RightSizing.analyze(current: cur, stats: stats(cpuPeak: 0.1, cpuTyp: 0.05, memPeak: 100 * mi, memTyp: 80 * mi))
        XCTAssertEqual(r.verdict, .unset)
        XCTAssertTrue(r.hasSuggestion)   // still suggests values to set
    }

    func test_ok_whenAligned() {
        let cur = ContainerResources(container: "app", cpuRequest: 0.1, cpuLimit: 0.3, memRequest: 220 * mi, memLimit: 400 * mi)
        let r = RightSizing.analyze(current: cur, stats: stats(cpuPeak: 0.15, cpuTyp: 0.09, memPeak: 300 * mi, memTyp: 200 * mi))
        XCTAssertEqual(r.verdict, .ok)
    }

    // MARK: - p95

    func test_collector_p95_nearestRank() {
        let xs = (1...100).map { Double($0) }
        // nearest-rank: round(0.95 × 99) = 94 → sorted[94] = 95
        XCTAssertEqual(MetricsCollector.p95(xs), 95, accuracy: 0.0001)
        XCTAssertEqual(MetricsCollector.avg([1, 2, 3, 4]), 2.5, accuracy: 0.0001)
    }

    // MARK: - setResources action

    func test_setResources_invocation() {
        let action = WorkloadAction.setResources(kind: "deployment", name: "web", namespace: "default",
                                                 container: "app", requests: "cpu=250m,memory=320Mi", limits: "cpu=1,memory=512Mi")
        XCTAssertEqual(action.kubectlInvocations(), [.args([
            "set", "resources", "deployment/web", "-c", "app",
            "--requests=cpu=250m,memory=320Mi", "--limits=cpu=1,memory=512Mi", "-n", "default"
        ])])
        XCTAssertFalse(action.isHighRisk)
        XCTAssertFalse(action.needsAcknowledge)
    }

    // MARK: - MetricsStore round-trip

    func test_metricsStore_writeAggregateAndRetention() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("helmsman-metrics-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let store = try MetricsStore(context: "unit-test", directory: tmp)
        let baseHour = 480_000   // arbitrary recent-ish hour epoch
        let buckets = (0..<48).map { i in
            MetricsBucket(namespace: "default", workloadKind: "deployment", workloadName: "web", container: "app",
                          hourEpoch: baseHour + i,
                          cpuAvg: 0.1, cpuP95: 0.2, cpuMax: 0.3 + Double(i) * 0.001,
                          memAvg: 100, memP95: 200, memMax: 300 + Double(i))
        }
        // now far enough ahead that all buckets are within 30d retention.
        let now = Date(timeIntervalSince1970: Double(baseHour + 48) * 3600)
        try await store.writeBuckets(buckets, now: now)

        let agg = try await store.aggregate(namespace: "default", kind: "deployment", name: "web")
        XCTAssertEqual(agg.count, 1)
        XCTAssertEqual(agg[0].hoursCovered, 48)
        XCTAssertEqual(agg[0].memPeak, 300 + 47, accuracy: 0.001)   // MAX(memMax)
        XCTAssertEqual(agg[0].cpuTypical, 0.2, accuracy: 0.001)     // AVG(cpuP95)

        // Retention: a bucket 31 days older than `now` should be swept on next write.
        let old = MetricsBucket(namespace: "default", workloadKind: "deployment", workloadName: "old", container: "app",
                                hourEpoch: baseHour - 31 * 24, cpuAvg: 0, cpuP95: 0, cpuMax: 0, memAvg: 0, memP95: 0, memMax: 0)
        try await store.writeBuckets([old], now: now)
        let oldAgg = try await store.aggregate(namespace: "default", kind: "deployment", name: "old")
        XCTAssertTrue(oldAgg.isEmpty, "buckets past 30d retention should be swept")
    }
}
