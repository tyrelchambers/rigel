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
}
