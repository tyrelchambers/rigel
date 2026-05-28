import Foundation
import Observation

/// In-memory catalog of installable apps. Loaded once at startup from the
/// bundled `catalog.json` resource. There is no remote refresh in v1.
@Observable
final class CatalogStore {
    private(set) var apps: [CatalogApp] = []
    private(set) var loadError: String? = nil

    init(bundle: Bundle = .module) {
        load(from: bundle)
    }

    /// Test-only initializer that skips bundle loading and uses a fixed list.
    init(apps: [CatalogApp]) {
        self.apps = apps
    }

    /// Sorted, deduplicated list of every category present in the catalog.
    var categories: [AppCategory] {
        var seen = Set<AppCategory>()
        var ordered: [AppCategory] = []
        for app in apps {
            if seen.insert(app.category).inserted {
                ordered.append(app.category)
            }
        }
        return ordered.sorted { $0.displayName < $1.displayName }
    }

    /// Single search/filter entrypoint. Empty query + nil category = all.
    /// Search matches name, tagline, description, and tags — case-insensitive.
    func filtered(query: String, category: AppCategory? = nil) -> [CatalogApp] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return apps.filter { app in
            if let category, app.category != category { return false }
            guard !q.isEmpty else { return true }
            if app.name.lowercased().contains(q) { return true }
            if app.tagline.lowercased().contains(q) { return true }
            if app.description.lowercased().contains(q) { return true }
            if app.tags.contains(where: { $0.lowercased().contains(q) }) { return true }
            return false
        }
    }

    private func load(from bundle: Bundle) {
        guard let url = bundle.url(forResource: "catalog", withExtension: "json") else {
            loadError = "catalog.json not found in bundle"
            return
        }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            apps = try decoder.decode([CatalogApp].self, from: data)
        } catch {
            loadError = "failed to load catalog.json: \(error)"
        }
    }
}
