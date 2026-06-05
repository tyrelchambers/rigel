import Foundation

/// Normalize a container image reference down to its repo path — the part
/// that identifies *what* the image is, independent of where it's pulled
/// from or which version is pinned. Drops any `@sha256:…` digest and the
/// `:tag`, keeping the registry host (if present) and the path.
///
///     "docker.io/vaultwarden/server:latest" -> "docker.io/vaultwarden/server"
///     "ghcr.io/plausible/community-edition:v2.1.4" -> "ghcr.io/plausible/community-edition"
///     "nextcloud:29-apache" -> "nextcloud"
func imageRepoPath(_ image: String) -> String {
    var s = image
    // Drop a digest suffix first: everything from `@` onward.
    if let at = s.firstIndex(of: "@") {
        s = String(s[..<at])
    }
    // Drop the tag. The tag separator is the `:` that follows the last `/`
    // (a `:` before the last `/` is a registry host port, not a tag).
    if let slash = s.lastIndex(of: "/") {
        let afterSlash = s.index(after: slash)
        if let colon = s[afterSlash...].firstIndex(of: ":") {
            s = String(s[..<colon])
        }
    } else if let colon = s.firstIndex(of: ":") {
        s = String(s[..<colon])
    }
    return s
}

/// Canonicalize a repo path for matching: drop a leading registry-host segment
/// (the first segment when it looks like a host — contains a `.`/`:` or is
/// `localhost`) and a leading Docker Hub `library/`. So `docker.io/library/
/// nextcloud`, `library/nextcloud`, and `nextcloud` all canonicalize equal.
private func canonicalRepoPath(_ path: String) -> String {
    var p = path
    if let slash = p.firstIndex(of: "/") {
        let first = p[..<slash]
        if first == "localhost" || first.contains(".") || first.contains(":") {
            p = String(p[p.index(after: slash)...])
        }
    }
    if p.hasPrefix("library/") { p = String(p.dropFirst("library/".count)) }
    return p
}

/// True when `running` (a normalized repo path) refers to the same image as
/// `candidate`. Compares the canonical repo path on both sides, so only a
/// differing/absent *registry host* (or `library/`) is tolerated — NOT a
/// differing org/namespace segment. This is what keeps `supabase/postgres`
/// from matching a standalone `postgres`, while `docker.io/vaultwarden/server`
/// still matches `vaultwarden/server`.
func repoPathsMatch(_ running: String, _ candidate: String) -> Bool {
    canonicalRepoPath(running) == canonicalRepoPath(candidate)
}

/// Set of catalog-app `id`s whose `matchImages` are found running in the
/// cluster. Scans container images across Deployments, StatefulSets, and
/// loose Pods. Pure — no side effects on the cache; recompute freely so the
/// result tracks the watch stream.
///
/// Matching is host- and tag-insensitive (see `imageRepoPath`). An app is
/// considered installed when *any* of its `matchImages` matches *any* running
/// container image, so multi-service apps only need one distinctive image to
/// be detected.
func installedAppIDs(
    apps: [CatalogApp],
    deployments: [Deployment],
    statefulSets: [StatefulSet],
    pods: [Pod]
) -> Set<String> {
    // Collect every running container image, normalized to a repo path and
    // deduplicated.
    var runningRepos = Set<String>()
    for d in deployments {
        for c in d.spec?.template?.spec?.containers ?? [] {
            if let image = c.image { runningRepos.insert(imageRepoPath(image)) }
        }
    }
    for s in statefulSets {
        for c in s.spec?.template?.spec?.containers ?? [] {
            if let image = c.image { runningRepos.insert(imageRepoPath(image)) }
        }
    }
    for p in pods {
        for c in p.spec?.containers ?? [] {
            if let image = c.image { runningRepos.insert(imageRepoPath(image)) }
        }
    }

    var installed = Set<String>()
    for app in apps {
        let isInstalled = app.matchImages.contains { raw in
            let candidate = imageRepoPath(raw)
            return runningRepos.contains { repoPathsMatch($0, candidate) }
        }
        if isInstalled { installed.insert(app.id) }
    }
    return installed
}

/// The `sha256:…` digest a container actually pulled, extracted from a pod
/// status `imageID`. Handles the common forms: `ghcr.io/x/y@sha256:…`,
/// `docker-pullable://x/y@sha256:…`, and a bare `sha256:…`. nil when no digest
/// is embedded.
func runningImageDigest(_ imageID: String?) -> String? {
    guard let id = imageID, let r = id.range(of: "sha256:") else { return nil }
    return String(id[r.lowerBound...])
}

/// For each installed catalog app, the exact image reference it's running —
/// the full string (registry + repo + tag) of the first container that matched
/// one of the app's `matchImages`. This is what the update check needs: the
/// running *tag*, not just the repo path. Apps with no matching container are
/// omitted (i.e. not installed).
func installedImages(
    apps: [CatalogApp],
    deployments: [Deployment],
    statefulSets: [StatefulSet],
    pods: [Pod]
) -> [InstalledImage] {
    // (normalized repo path, full image ref) for every running container.
    var running: [(repo: String, full: String)] = []
    func collect(_ image: String?) {
        if let image { running.append((imageRepoPath(image), image)) }
    }
    for d in deployments { for c in d.spec?.template?.spec?.containers ?? [] { collect(c.image) } }
    for s in statefulSets { for c in s.spec?.template?.spec?.containers ?? [] { collect(c.image) } }
    for p in pods { for c in p.spec?.containers ?? [] { collect(c.image) } }

    // (normalized repo path, running digest) from pod *status* — the only place
    // the actually-pulled sha lives. Match a pod's spec container to its status
    // by name so we attribute the digest to the right image.
    var podDigests: [(repo: String, digest: String)] = []
    for p in pods {
        var idByName: [String: String] = [:]
        for cs in p.status?.containerStatuses ?? [] { if let id = cs.imageID { idByName[cs.name] = id } }
        for c in p.spec?.containers ?? [] {
            guard let image = c.image, let digest = runningImageDigest(idByName[c.name]) else { continue }
            podDigests.append((imageRepoPath(image), digest))
        }
    }

    var out: [InstalledImage] = []
    for app in apps {
        for raw in app.matchImages {
            let candidate = imageRepoPath(raw)
            if let hit = running.first(where: { repoPathsMatch($0.repo, candidate) }) {
                let digest = podDigests.first { repoPathsMatch($0.repo, candidate) }?.digest
                out.append(InstalledImage(appID: app.id, image: hit.full, repoURL: app.repoURL, runningDigest: digest))
                break
            }
        }
    }
    return out
}
