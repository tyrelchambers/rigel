import Foundation

/// Accumulates per-(workload, container) usage samples for the current clock
/// hour in memory. When the hour rolls over, `ingest` returns the completed
/// hour's buckets for the caller to persist. Only touched from ClusterCache's
/// pod-metrics poll callback (which runs on the main actor), so plain mutable
/// state is safe here.
final class MetricsCollector {
    struct OwnerRef: Sendable, Hashable {
        let kind: String     // "deployment" | "statefulset" | "daemonset"
        let name: String
    }

    private struct Key: Hashable {
        let namespace: String
        let kind: String
        let name: String
        let container: String
    }

    private var currentHour: Int?
    private var cpu: [Key: [Double]] = [:]   // cores
    private var mem: [Key: [Double]] = [:]   // bytes

    /// Feed one metrics poll. `ownerFor` maps a pod (ns/name) to its owning
    /// workload, or nil to skip (bare pods, jobs, unmatched). Returns the
    /// previous hour's buckets when the wall clock has advanced to a new hour.
    func ingest(_ items: [PodMetrics], now: Date = Date(), ownerFor: (PodMetrics) -> OwnerRef?) -> [MetricsBucket] {
        let hour = Int(now.timeIntervalSince1970) / 3600
        var flushed: [MetricsBucket] = []
        if let prev = currentHour, prev != hour {
            flushed = buildBuckets(hourEpoch: prev)
            cpu.removeAll(keepingCapacity: true)
            mem.removeAll(keepingCapacity: true)
        }
        currentHour = hour

        for item in items {
            guard let owner = ownerFor(item) else { continue }
            let ns = item.metadata.namespace ?? "default"
            for c in item.containers {
                let key = Key(namespace: ns, kind: owner.kind, name: owner.name, container: c.name)
                cpu[key, default: []].append(ResourceQuantity.cpuCores(c.usage.cpu))
                mem[key, default: []].append(ResourceQuantity.bytes(c.usage.memory))
            }
        }
        return flushed
    }

    private func buildBuckets(hourEpoch: Int) -> [MetricsBucket] {
        cpu.compactMap { key, cpuSamples in
            guard !cpuSamples.isEmpty, let memSamples = mem[key] else { return nil }
            return MetricsBucket(
                namespace: key.namespace, workloadKind: key.kind, workloadName: key.name, container: key.container,
                hourEpoch: hourEpoch,
                cpuAvg: Self.avg(cpuSamples), cpuP95: Self.p95(cpuSamples), cpuMax: cpuSamples.max() ?? 0,
                memAvg: Self.avg(memSamples), memP95: Self.p95(memSamples), memMax: memSamples.max() ?? 0
            )
        }
    }

    static func avg(_ xs: [Double]) -> Double {
        xs.isEmpty ? 0 : xs.reduce(0, +) / Double(xs.count)
    }

    /// Nearest-rank p95.
    static func p95(_ xs: [Double]) -> Double {
        guard !xs.isEmpty else { return 0 }
        let sorted = xs.sorted()
        let idx = Int((0.95 * Double(sorted.count - 1)).rounded())
        return sorted[min(max(idx, 0), sorted.count - 1)]
    }
}
