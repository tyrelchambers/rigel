import Foundation
import Observation

/// Persistent state for daily update checks: the on/off toggle, when the last
/// check ran, and the latest per-app results. Backed by `UserDefaults` so a
/// badge survives relaunch and the toggle is remembered. This is the app's
/// first local-prefs store; keep new keys under the `updateChecks.` prefix.
@MainActor
@Observable
final class UpdateCheckStore {
    private let defaults: UserDefaults

    private enum Key {
        static let enabled = "updateChecks.enabled"
        static let lastChecked = "updateChecks.lastChecked"
        static let results = "updateChecks.results"
    }

    /// Per-app progress within an in-flight check. Transient (not persisted);
    /// cleared when a run finishes, after which cards fall back to `results`.
    enum CheckPhase: Hashable {
        /// Queued for this run but not started yet.
        case pending
        /// Registry/Claude lookup in flight.
        case checking
        /// Done this run — see `results` for the outcome.
        case checked
    }

    /// Transient — true while a check is running. Not persisted.
    var isChecking = false

    /// Per-app phase during an active run. Empty between runs.
    var checkPhase: [String: CheckPhase] = [:]

    func phase(for appID: String) -> CheckPhase? { checkPhase[appID] }

    var dailyChecksEnabled: Bool {
        didSet { defaults.set(dailyChecksEnabled, forKey: Key.enabled) }
    }

    var lastChecked: Date? {
        didSet {
            if let lastChecked {
                defaults.set(lastChecked.timeIntervalSince1970, forKey: Key.lastChecked)
            } else {
                defaults.removeObject(forKey: Key.lastChecked)
            }
        }
    }

    /// Latest update status per catalog app id.
    var results: [String: UpdateStatus] {
        didSet { persistResults() }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.dailyChecksEnabled = defaults.bool(forKey: Key.enabled)
        if defaults.object(forKey: Key.lastChecked) != nil {
            self.lastChecked = Date(timeIntervalSince1970: defaults.double(forKey: Key.lastChecked))
        } else {
            self.lastChecked = nil
        }
        if let data = defaults.data(forKey: Key.results),
           let decoded = try? JSONDecoder().decode([String: UpdateStatus].self, from: data) {
            self.results = decoded
        } else {
            self.results = [:]
        }
    }

    func status(for appID: String) -> UpdateStatus? { results[appID] }

    /// Count of apps with an available update — drives the badge on the toggle.
    var updateCount: Int { results.values.filter(\.hasUpdate).count }

    private func persistResults() {
        if let data = try? JSONEncoder().encode(results) {
            defaults.set(data, forKey: Key.results)
        }
    }
}
