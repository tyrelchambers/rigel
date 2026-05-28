import Foundation
import Observation

@Observable
final class IngressesViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var namespaceFilter: String? = nil
    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var availableNamespaces: [String] {
        Set(cache.ingresses.compactMap { $0.metadata.namespace }).sorted()
    }

    var filteredIngresses: [Ingress] {
        cache.ingresses
            .filter { namespaceFilter == nil || $0.metadata.namespace == namespaceFilter }
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
