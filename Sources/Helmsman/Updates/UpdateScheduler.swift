import Foundation
import Observation

/// Drives the daily update check. Owns a background loop that, while the toggle
/// is on, runs a check on launch and again once 24h have elapsed. Writes
/// results into `UpdateCheckStore`. A manual "Check now" runs immediately and
/// independently of the schedule.
@MainActor
@Observable
final class UpdateScheduler {
    let store: UpdateCheckStore
    private let cache: ClusterCache
    private let catalog: CatalogStore

    private var resolver = UpdateResolver()
    private var fallback = ClaudeUpdateFallback()

    @ObservationIgnored private var loopTask: Task<Void, Never>?

    /// Re-evaluate the due condition at this cadence so a toggle flip or a fresh
    /// install is picked up within the hour without an always-hot timer.
    private static let tickInterval: UInt64 = 3_600_000_000_000  // 1 hour
    private static let dayInterval: TimeInterval = 24 * 60 * 60

    init(store: UpdateCheckStore, cache: ClusterCache, catalog: CatalogStore) {
        self.store = store
        self.cache = cache
        self.catalog = catalog
    }

    /// Call once when the app's main window appears.
    func start() {
        if store.dailyChecksEnabled { ensureLoopRunning() }
    }

    /// Toggle the daily checks on or off (persists via the store).
    func setEnabled(_ on: Bool) {
        store.dailyChecksEnabled = on
        if on {
            ensureLoopRunning()
        } else {
            loopTask?.cancel()
            loopTask = nil
        }
    }

    /// Run a check right now regardless of schedule. `appID` nil = the full
    /// "Check now" batch; a value = an on-demand check of just that one app
    /// (the per-app "Check for updates" button).
    func checkNow(appID: String? = nil) async {
        await runCheck(appID: appID)
    }

    // MARK: - Loop

    private func ensureLoopRunning() {
        guard loopTask == nil else { return }
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.isDue { await self.runCheck() }
                try? await Task.sleep(nanoseconds: Self.tickInterval)
            }
        }
    }

    private var isDue: Bool {
        guard let last = store.lastChecked else { return true }
        return Date().timeIntervalSince(last) >= Self.dayInterval
    }

    private func runCheck(appID: String? = nil) async {
        guard !store.isChecking else { return }
        store.isChecking = true
        defer {
            store.isChecking = false
            store.checkPhase = [:]   // back to persisted results once the run ends
        }

        var items = installedImages(
            apps: catalog.apps,
            deployments: cache.deployments,
            statefulSets: cache.statefulSets,
            daemonSets: cache.daemonSets,
            pods: cache.pods
        )
        if let appID { items = items.filter { $0.appID == appID } }

        guard !items.isEmpty else {
            // A full sweep with nothing installed clears results and stamps the
            // schedule; a single-app check of an uninstalled app is a no-op.
            if appID == nil {
                store.results = [:]
                store.lastChecked = Date()
            }
            return
        }

        let resolved = await resolveAndStore(items)

        if appID == nil {
            store.results = resolved   // wholesale replace drops any uninstalled apps
            store.lastChecked = Date()
        } else {
            // Single-app: upsert only this app, leaving other results and the
            // daily `lastChecked` schedule untouched.
            for (id, status) in resolved { store.results[id] = status }
        }
    }

    /// Resolve each item via the registry, routing the rest to the Claude
    /// fallback, while driving each app's `checkPhase` so cards show live
    /// progress. Returns statuses keyed by appID. Shared by the full-batch and
    /// single-app paths.
    private func resolveAndStore(_ items: [InstalledImage]) async -> [String: UpdateStatus] {
        // Seed every app as pending so each card shows a queued state, then
        // walk them one at a time — the current app flips to `checking`,
        // finished apps to `checked` with a live result.
        store.checkPhase = Dictionary(uniqueKeysWithValues: items.map { ($0.appID, .pending) })

        var merged: [String: UpdateStatus] = [:]
        var needsAssist: [InstalledImage] = []

        for item in items {
            store.checkPhase[item.appID] = .checking
            if let status = await resolver.resolveOne(item) {
                merged[item.appID] = status
                store.results[item.appID] = status
                store.checkPhase[item.appID] = .checked
            } else {
                needsAssist.append(item)   // stays `checking` until the fallback answers
            }
        }

        if !needsAssist.isEmpty {
            let assisted = await fallback.resolve(needsAssist)
            for (appID, status) in assisted {
                merged[appID] = status
                store.results[appID] = status
                store.checkPhase[appID] = .checked
            }
        }

        return merged
    }
}
