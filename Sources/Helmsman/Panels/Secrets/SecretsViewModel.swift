import Foundation
import Observation

@Observable
final class SecretsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredSecrets: [Secret] {
        var base: [Secret]
        if let ns = cache.namespaceFilter {
            base = cache.secrets.filter { $0.metadata.namespace == ns }
        } else {
            base = cache.secrets
        }
        if !search.isEmpty {
            let q = search.lowercased()
            base = base.filter { s in
                if s.metadata.name.lowercased().contains(q) { return true }
                if (s.metadata.namespace ?? "").lowercased().contains(q) { return true }
                if (s.type ?? "").lowercased().contains(q) { return true }
                return false
            }
        }
        return base.sorted {
            $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending
        }
    }
}
