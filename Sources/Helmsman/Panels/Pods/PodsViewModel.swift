import Foundation
import Observation

/// Thin presenter over ClusterCache.pods. Kept as a type so future UI state
/// (sort key, filter, etc.) has a home that survives tab switches.
@Observable
final class PodsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""

    var pods: [Pod] { cache.pods }
    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredPods: [Pod] {
        let base = cache.namespaceFilter == nil
            ? pods
            : pods.filter { $0.metadata.namespace == cache.namespaceFilter }
        guard !search.isEmpty else { return base }
        let q = search.lowercased()
        return base.filter { pod in
            if pod.metadata.name.lowercased().contains(q) { return true }
            if (pod.metadata.namespace ?? "").lowercased().contains(q) { return true }
            if let labels = pod.metadata.labels {
                for (k, v) in labels where k.lowercased().contains(q) || v.lowercased().contains(q) {
                    return true
                }
            }
            return false
        }
    }
}
