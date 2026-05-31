import Foundation
import Observation

/// One workload's right-sizing results (one entry per container).
struct WorkloadRightSizing: Identifiable, Hashable {
    let kind: String        // "deployment" | "statefulset" | "daemonset"
    let name: String
    let namespace: String
    let containers: [RightSizingResult]
    var id: String { "\(namespace)/\(kind)/\(name)" }

    /// Most urgent verdict across containers, for the row badge & sorting.
    var worst: RightSizingVerdict {
        let order: [RightSizingVerdict] = [.atRisk, .unset, .overProvisioned, .ok, .insufficientData]
        for v in order where containers.contains(where: { $0.verdict == v }) { return v }
        return .insufficientData
    }

    /// Reclaimable memory bytes (sum over over-provisioned containers) — for the
    /// "most wasteful" sort.
    var reclaimableMemBytes: Double {
        containers.reduce(0) { acc, r in
            guard r.verdict == .overProvisioned, let req = r.memRequest, let sug = r.suggestedMemRequest, req > sug else { return acc }
            return acc + (req - sug)
        }
    }
}

enum RightSizingSort: String, CaseIterable, Identifiable {
    case attention   // at-risk + unset first, then wasteful
    case wasteful    // most reclaimable memory first
    case name
    var id: String { rawValue }
    var label: String {
        switch self {
        case .attention: return "Needs attention"
        case .wasteful:  return "Most wasteful"
        case .name:      return "Name"
        }
    }
}

@Observable
@MainActor
final class RightSizingViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    private(set) var results: [WorkloadRightSizing] = []
    private(set) var isAnalyzing = false
    var search: String = ""
    var sort: RightSizingSort = .attention

    /// Where history is read from for this context (local SQLite vs Prometheus).
    private(set) var backend: MetricsBackendConfig = .local
    private(set) var contextName: String? = nil

    var error: String? { cache.error }

    /// Prometheus-compatible endpoints found in the cluster, for the picker.
    var detectedBackends: [MetricsBackendConfig] {
        MetricsBackendDetector.detect(in: cache.services)
    }

    /// Load the persisted backend choice for the active context.
    func load(context: String?) {
        contextName = context
        backend = context.map { SessionStore.shared.metricsBackend(for: $0) } ?? .local
    }

    /// Switch source, persist per-context, and re-analyze.
    func setBackend(_ config: MetricsBackendConfig) async {
        backend = config
        if let ctx = contextName { SessionStore.shared.setMetricsBackend(config, for: ctx) }
        await refresh()
    }

    /// Cold start: workloads exist but none has enough history yet, so every row
    /// reads "Gathering data". Drives a top-of-panel explainer banner.
    var isWarmingUp: Bool {
        !results.isEmpty && results.allSatisfy { $0.worst == .insufficientData }
    }

    /// Largest history depth seen so far, for the banner's progress hint.
    var maxHoursCovered: Int {
        results.flatMap { $0.containers }.map { $0.hoursCovered }.max() ?? 0
    }

    var filtered: [WorkloadRightSizing] {
        results
            .filter { cache.namespaceFilter == nil || $0.namespace == cache.namespaceFilter }
            .filter { w in
                if search.isEmpty { return true }
                return w.name.localizedCaseInsensitiveContains(search) || w.namespace.localizedCaseInsensitiveContains(search)
            }
            .sorted(by: sortComparator)
    }

    private func sortComparator(_ a: WorkloadRightSizing, _ b: WorkloadRightSizing) -> Bool {
        switch sort {
        case .name:
            if a.namespace != b.namespace { return a.namespace < b.namespace }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        case .wasteful:
            return a.reclaimableMemBytes > b.reclaimableMemBytes
        case .attention:
            let rank: (RightSizingVerdict) -> Int = { v in
                switch v {
                case .atRisk: return 0
                case .unset: return 1
                case .overProvisioned: return 2
                case .ok: return 3
                case .insufficientData: return 4
                }
            }
            let ra = rank(a.worst), rb = rank(b.worst)
            if ra != rb { return ra < rb }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// Recompute every workload's right-sizing from the configured source
    /// (Prometheus when set for this context, else the local SQLite store).
    func refresh() async {
        isAnalyzing = true
        defer { isAnalyzing = false }

        let promSource = backend.isPrometheus ? PrometheusMetricsSource(backend: backend) : nil

        // Snapshot workload specs on the main actor.
        let specs = workloadSpecs()

        var out: [WorkloadRightSizing] = []
        for spec in specs {
            let stats: [WindowStats]
            if let promSource {
                stats = await promSource.aggregate(via: cache, namespace: spec.namespace, name: spec.name)
            } else if let store = cache.metricsStore {
                stats = (try? await store.aggregate(namespace: spec.namespace, kind: spec.kind, name: spec.name)) ?? []
            } else {
                stats = []
            }
            let statsByContainer = Dictionary(uniqueKeysWithValues: stats.map { ($0.container, $0) })
            let containerResults: [RightSizingResult] = spec.containers.map { cr in
                let ws = statsByContainer[cr.container]
                    ?? WindowStats(container: cr.container, cpuPeak: 0, cpuTypical: 0, memPeak: 0, memTypical: 0, hoursCovered: 0)
                return RightSizing.analyze(current: cr, stats: ws)
            }
            out.append(WorkloadRightSizing(kind: spec.kind, name: spec.name, namespace: spec.namespace, containers: containerResults))
        }
        results = out
    }

    // MARK: - Spec extraction

    private struct WorkloadSpec {
        let kind: String
        let name: String
        let namespace: String
        let containers: [ContainerResources]
    }

    private func workloadSpecs() -> [WorkloadSpec] {
        var out: [WorkloadSpec] = []
        for d in cache.deployments {
            out.append(.init(kind: "deployment", name: d.metadata.name, namespace: d.metadata.namespace ?? "default",
                             containers: containerResources(d.spec?.template)))
        }
        for s in cache.statefulSets {
            out.append(.init(kind: "statefulset", name: s.metadata.name, namespace: s.metadata.namespace ?? "default",
                             containers: containerResources(s.spec?.template)))
        }
        for ds in cache.daemonSets {
            out.append(.init(kind: "daemonset", name: ds.metadata.name, namespace: ds.metadata.namespace ?? "default",
                             containers: containerResources(ds.spec?.template)))
        }
        return out.filter { !$0.containers.isEmpty }
    }

    private func containerResources(_ template: PodTemplate?) -> [ContainerResources] {
        (template?.spec?.containers ?? []).map { c in
            let req = c.resources?.requests
            let lim = c.resources?.limits
            return ContainerResources(
                container: c.name,
                cpuRequest: req?["cpu"].map(ResourceQuantity.cpuCores),
                cpuLimit: lim?["cpu"].map(ResourceQuantity.cpuCores),
                memRequest: req?["memory"].map(ResourceQuantity.bytes),
                memLimit: lim?["memory"].map(ResourceQuantity.bytes)
            )
        }
    }
}
