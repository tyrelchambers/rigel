import Foundation
import Observation

@Observable
final class NamespacesViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredNamespaces: [Namespace] {
        cache.namespaces
            .filter { ns in
                if search.isEmpty { return true }
                return ns.metadata.name.localizedCaseInsensitiveContains(search)
                    || ns.phase.localizedCaseInsensitiveContains(search)
            }
            .sorted { $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending }
    }

    /// Running pod count in a namespace — a cheap "how busy is it" readout.
    func podCount(_ namespace: Namespace) -> Int {
        cache.pods.filter { $0.metadata.namespace == namespace.metadata.name }.count
    }
}
