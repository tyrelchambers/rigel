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
}
