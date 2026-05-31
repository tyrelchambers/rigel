import Foundation

/// A parsed, comparable version extracted from a container image tag.
///
/// Tags in the wild are messy: `v3.2.1`, `1.22`, `0.22`, `15.1.0.147`,
/// `v3.0.0-rc.4`, `latest`, `latest-alpine`, `stable`, `24.3-alpine`. This type
/// keeps only what's needed to answer "is tag B newer than tag A": an ordered
/// list of numeric components and whether the tag is a pre-release.
///
/// Ordering is component-wise numeric (`1.22` < `1.100`), shorter-but-equal
/// prefixes rank lower (`1.2` < `1.2.1`), and a stable release outranks a
/// pre-release of the same numbers (`3.0.0-rc.1` < `3.0.0`).
struct ReleaseVersion: Comparable, Hashable {
    let components: [Int]
    let isPrerelease: Bool

    /// Pre-release markers we recognize after the numeric part.
    private static let prereleaseMarkers = ["rc", "alpha", "beta", "pre", "dev", "snapshot", "nightly", "canary"]

    /// Parse a tag into a version, or nil when the tag carries no usable
    /// numeric version (`latest`, `stable`, `main`, empty).
    init?(tag: String) {
        var s = tag.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !s.isEmpty else { return nil }
        if s.hasPrefix("v") { s = String(s.dropFirst()) }

        // Separate the numeric core from any suffix. The core is the leading
        // run of digit-and-dot characters; everything after is the suffix
        // (`-rc.4`, `-alpine`, `_ce`, etc.).
        let coreChars = s.prefix { $0.isNumber || $0 == "." }
        let core = String(coreChars)
        let suffix = String(s.dropFirst(core.count))

        let parts = core.split(separator: ".").compactMap { Int($0) }
        guard !parts.isEmpty else { return nil }

        self.components = parts
        // Pre-release iff the suffix names a known pre-release marker. A plain
        // variant suffix like `-alpine` is NOT a pre-release; it's a different
        // flavor of the same release and is treated as stable.
        let lowerSuffix = suffix.trimmingCharacters(in: CharacterSet(charactersIn: "-_."))
        self.isPrerelease = Self.prereleaseMarkers.contains { lowerSuffix.hasPrefix($0) }
    }

    static func < (lhs: ReleaseVersion, rhs: ReleaseVersion) -> Bool {
        let count = max(lhs.components.count, rhs.components.count)
        for i in 0..<count {
            let l = i < lhs.components.count ? lhs.components[i] : 0
            let r = i < rhs.components.count ? rhs.components[i] : 0
            if l != r { return l < r }
        }
        // Equal numbers: a pre-release is older than the matching stable.
        if lhs.isPrerelease != rhs.isPrerelease { return lhs.isPrerelease }
        // Fully equal numbers + same prerelease flag: fewer components ranks
        // lower so `1.2` < `1.2.0` stays a strict, stable ordering.
        return lhs.components.count < rhs.components.count
    }
}

/// Given the running tag and every tag a registry reports, find the newest
/// *stable* release strictly newer than what's running. Returns nil when
/// nothing is newer (or the running tag isn't a parseable version — that case
/// is handled upstream by routing to the Claude fallback).
func newestStableUpgrade(currentTag: String, availableTags: [String]) -> String? {
    guard let current = ReleaseVersion(tag: currentTag) else { return nil }

    var best: (tag: String, version: ReleaseVersion)? = nil
    for tag in availableTags {
        guard let v = ReleaseVersion(tag: tag), !v.isPrerelease else { continue }
        guard current < v else { continue }
        if best == nil || best!.version < v {
            best = (tag, v)
        }
    }
    return best?.tag
}
