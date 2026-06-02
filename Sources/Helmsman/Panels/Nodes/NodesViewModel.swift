import Foundation
import Observation

@Observable
final class NodesViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var expanded: Set<String> = []

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }
    var metricsAvailable: Bool { cache.metricsAvailable }

    var nodes: [Node] { cache.nodes }
    var metrics: [String: NodeMetrics] { cache.nodeMetrics }
    var podCounts: [String: Int] { cache.podCountByNode }

    /// Memoized on `cache.dataRevision` so the sort doesn't re-run on every 5s
    /// metrics poll (which bumps `metricsRevision`, not `dataRevision`) — the
    /// node set is stable across polls. `@ObservationIgnored` keeps the cache out
    /// of observation so writing it during a view read doesn't invalidate.
    @ObservationIgnored private var sortedMemo: (rev: Int, nodes: [Node])?

    var sortedNodes: [Node] {
        if let memo = sortedMemo, memo.rev == cache.dataRevision { return memo.nodes }
        let sorted = cache.nodes.sorted { lhs, rhs in
            let lcp = lhs.role == "control-plane"
            let rcp = rhs.role == "control-plane"
            if lcp != rcp { return lcp }
            return lhs.metadata.name.localizedStandardCompare(rhs.metadata.name) == .orderedAscending
        }
        sortedMemo = (cache.dataRevision, sorted)
        return sorted
    }

    func toggleExpansion(_ node: Node) {
        if expanded.contains(node.id) { expanded.remove(node.id) }
        else { expanded.insert(node.id) }
    }

    func isExpanded(_ node: Node) -> Bool { expanded.contains(node.id) }
}
