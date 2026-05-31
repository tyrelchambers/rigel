import Foundation
import Observation

@Observable
final class IngressesViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredIngresses: [Ingress] {
        cache.ingresses
            .filter { cache.namespaceFilter == nil || $0.metadata.namespace == cache.namespaceFilter }
            .filter { ing in
                if search.isEmpty { return true }
                let hay = ([ing.metadata.name, ing.metadata.namespace, ing.className]
                    + ing.hosts
                    + ing.routes.map(\.service)).compactMap { $0 }.joined(separator: " ")
                return hay.localizedCaseInsensitiveContains(search)
            }
            .sorted { lhs, rhs in
                let lns = lhs.metadata.namespace ?? ""
                let rns = rhs.metadata.namespace ?? ""
                if lns != rns { return lns < rns }
                return lhs.metadata.name.localizedStandardCompare(rhs.metadata.name) == .orderedAscending
            }
    }
}
