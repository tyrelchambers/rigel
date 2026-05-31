import Foundation
import Observation

@MainActor
@Observable
final class CatalogViewModel {
    /// Top-level catalog scope: browse everything, or only what's already
    /// running in the cluster.
    enum Scope: Hashable { case all, installed }

    let cache: ClusterCache
    let store: CatalogStore
    let updates: UpdateCheckStore

    var search: String = ""
    var selectedCategory: AppCategory? = nil
    var scope: Scope = .all

    init(cache: ClusterCache, store: CatalogStore, updates: UpdateCheckStore) {
        self.cache = cache
        self.store = store
        self.updates = updates
    }

    /// Latest update-check result for an app, or nil if never checked.
    func updateStatus(for app: CatalogApp) -> UpdateStatus? {
        updates.status(for: app.id)
    }

    /// Per-app progress during an active check (pending/checking/checked), or
    /// nil between runs.
    func checkPhase(for app: CatalogApp) -> UpdateCheckStore.CheckPhase? {
        updates.phase(for: app.id)
    }

    var availableCategories: [AppCategory] { store.categories }

    /// IDs of catalog apps detected as installed, matched by container image
    /// against the live cluster. Reads `cache` snapshots and recomputes on
    /// every access so the result tracks the watch stream (same contract as
    /// `fit(for:)`).
    var installedIDs: Set<String> {
        installedAppIDs(
            apps: store.apps,
            deployments: cache.deployments,
            statefulSets: cache.statefulSets,
            pods: cache.pods
        )
    }

    /// Count shown on the "Installed" scope toggle.
    var installedCount: Int { installedIDs.count }

    func isInstalled(_ app: CatalogApp) -> Bool {
        installedIDs.contains(app.id)
    }

    var filteredApps: [CatalogApp] {
        let base = store.filtered(query: search, category: selectedCategory)
        guard scope == .installed else { return base }
        let installed = installedIDs
        return base.filter { installed.contains($0.id) }
    }

    /// Cluster-relative fit for the given catalog entry. Reads `cache.nodes`
    /// + `cache.pods` snapshots; recomputes on every access so the result
    /// tracks the watch stream.
    func fit(for app: CatalogApp) -> FitResult {
        nodeFit(app: app, nodes: cache.nodes, pods: cache.pods)
    }

    /// Snapshot of an installed app's running instance, for the detail sheet.
    /// nil when the app isn't currently running in the cluster.
    struct InstalledAppInfo: Equatable {
        /// Full running reference, e.g. `ghcr.io/plausible/community-edition:v2.1.4`.
        let imageRef: String
        /// The running tag, or `—` for a digest-only pin.
        let version: String
        /// Latest update-check result, or nil if never checked.
        let status: UpdateStatus?
    }

    /// Running-instance details for an installed app, or nil if not installed.
    /// Reuses the shared `installedImages` matcher (scoped to this one app) so
    /// there's a single source of truth for what counts as "running".
    func installedInfo(for app: CatalogApp) -> InstalledAppInfo? {
        guard let item = installedImages(
            apps: [app],
            deployments: cache.deployments,
            statefulSets: cache.statefulSets,
            pods: cache.pods
        ).first else { return nil }
        return InstalledAppInfo(
            imageRef: item.image,
            version: ImageReference(item.image)?.tag ?? "—",
            status: updateStatus(for: app)
        )
    }
}
