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
        cache.filtered(cache.ingresses, search: search, groupByNamespace: true) { ing, q in
            let extras = [ing.className].compactMap { $0 } + ing.hosts + ing.routes.map(\.service)
            return extras.contains { $0.localizedCaseInsensitiveContains(q) }
        }
    }
}
