import Foundation

/// Outcome of an update check for one installed app. `Codable` so the latest
/// results persist across launches (badges survive a restart).
enum UpdateStatus: Codable, Hashable {
    /// Running the newest stable tag we could find.
    case upToDate(current: String)
    /// A newer stable tag exists.
    case updateAvailable(current: String, latest: String)
    /// Couldn't determine by tag (e.g. `:latest`-pinned, unknown registry,
    /// fetch failed, or Claude was unavailable). `reason` is for tooltips.
    case unknown(reason: String)

    var hasUpdate: Bool {
        if case .updateAvailable = self { return true }
        return false
    }

    /// The tag a hand-off should upgrade *to*, when known.
    var latestTag: String? {
        if case let .updateAvailable(_, latest) = self { return latest }
        return nil
    }

    var currentTag: String? {
        switch self {
        case let .upToDate(current), let .updateAvailable(current, _): return current
        case .unknown: return nil
        }
    }
}
