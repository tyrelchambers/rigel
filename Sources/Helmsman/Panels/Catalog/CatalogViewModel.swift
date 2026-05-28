import Foundation
import Observation

@Observable
final class CatalogViewModel {
    let cache: ClusterCache
    let store: CatalogStore

    var search: String = ""
    var selectedCategory: AppCategory? = nil

    init(cache: ClusterCache, store: CatalogStore) {
        self.cache = cache
        self.store = store
    }

    var availableCategories: [AppCategory] { store.categories }

    var filteredApps: [CatalogApp] {
        store.filtered(query: search, category: selectedCategory)
    }

    /// Cluster-relative fit for the given catalog entry. Reads `cache.nodes`
    /// + `cache.pods` snapshots; recomputes on every access so the result
    /// tracks the watch stream.
    func fit(for app: CatalogApp) -> FitResult {
        nodeFit(app: app, nodes: cache.nodes, pods: cache.pods)
    }
}
