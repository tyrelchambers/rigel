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
        cache.filtered(cache.configMaps, search: search) { c, q in
            c.keysSorted.contains { $0.localizedCaseInsensitiveContains(q) }
        }
    }
}
