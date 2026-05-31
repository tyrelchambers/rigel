import Foundation

/// A container image reference split into the parts an update check needs:
/// where it's pulled from (`registry`), what it is (`repository`), and which
/// version is running (`tag`). The digest, if any, is dropped — update checks
/// compare tags, not digests.
///
///     "ghcr.io/plausible/community-edition:v2.1.4"
///       -> registry "ghcr.io", repository "plausible/community-edition", tag "v2.1.4"
///     "vaultwarden/server:latest"
///       -> registry "docker.io", repository "vaultwarden/server", tag "latest"
///     "nextcloud:29-apache"
///       -> registry "docker.io", repository "library/nextcloud", tag "29-apache"
struct ImageReference: Hashable {
    /// Registry host, e.g. `docker.io`, `ghcr.io`. Defaults to `docker.io`
    /// when the reference carries no host.
    let registry: String
    /// Repository path within the registry. Docker Hub single-name official
    /// images are normalized to the `library/` prefix the API expects.
    let repository: String
    /// The running tag, or `nil` when the reference pins a digest only.
    let tag: String?

    /// Parse a raw image string from a running container spec. Returns nil
    /// only for an empty/whitespace string.
    init?(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Strip a digest (`@sha256:…`) first; we never compare digests.
        var s = trimmed
        if let at = s.firstIndex(of: "@") { s = String(s[..<at]) }

        // Split off the registry host. The first path segment is a host iff it
        // contains a `.` or `:` (a port), or is exactly "localhost" — matching
        // Docker's own reference grammar.
        var host = "docker.io"
        var remainder = s
        if let slash = s.firstIndex(of: "/") {
            let first = String(s[..<slash])
            if first == "localhost" || first.contains(".") || first.contains(":") {
                host = first
                remainder = String(s[s.index(after: slash)...])
            }
        }

        // Split the tag off the remainder: the `:` after the last `/`.
        var repo = remainder
        var parsedTag: String? = nil
        if let slash = remainder.lastIndex(of: "/") {
            let afterSlash = remainder.index(after: slash)
            if let colon = remainder[afterSlash...].firstIndex(of: ":") {
                repo = String(remainder[..<colon])
                parsedTag = String(remainder[remainder.index(after: colon)...])
            }
        } else if let colon = remainder.firstIndex(of: ":") {
            repo = String(remainder[..<colon])
            parsedTag = String(remainder[remainder.index(after: colon)...])
        }

        // Docker Hub official images ("nextcloud", "postgres") live under
        // `library/` in the registry API.
        if host == "docker.io" && !repo.contains("/") {
            repo = "library/" + repo
        }

        self.registry = host
        self.repository = repo
        self.tag = (parsedTag?.isEmpty == false) ? parsedTag : nil
    }
}
