import Foundation
import Observation

@Observable
final class ConfigMapsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredConfigMaps: [ConfigMap] {
        var base: [ConfigMap]
        if let ns = cache.namespaceFilter {
            base = cache.configMaps.filter { $0.metadata.namespace == ns }
        } else {
            base = cache.configMaps
        }
        if !search.isEmpty {
            let q = search.lowercased()
            base = base.filter { c in
                if c.metadata.name.lowercased().contains(q) { return true }
                if (c.metadata.namespace ?? "").lowercased().contains(q) { return true }
                if c.keysSorted.contains(where: { $0.lowercased().contains(q) }) { return true }
                return false
            }
        }
        return base.sorted {
            $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending
        }
    }
}
