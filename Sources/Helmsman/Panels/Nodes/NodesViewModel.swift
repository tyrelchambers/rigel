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

    var sortedNodes: [Node] {
        cache.nodes.sorted { lhs, rhs in
            let lcp = lhs.role == "control-plane"
            let rcp = rhs.role == "control-plane"
            if lcp != rcp { return lcp }
            return lhs.metadata.name.localizedStandardCompare(rhs.metadata.name) == .orderedAscending
        }
    }

    func toggleExpansion(_ node: Node) {
        if expanded.contains(node.id) { expanded.remove(node.id) }
        else { expanded.insert(node.id) }
    }

    func isExpanded(_ node: Node) -> Bool { expanded.contains(node.id) }
}
