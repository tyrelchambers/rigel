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
        cache.filtered(cache.secrets, search: search) { s, q in
            (s.type ?? "").localizedCaseInsensitiveContains(q)
        }
    }
}
