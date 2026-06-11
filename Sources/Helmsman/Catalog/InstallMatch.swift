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

/// Set of catalog-app `id`s detected as installed in the cluster. Two passes:
///
/// 1. **Annotation (definitive).** Any Deployment, StatefulSet, or DaemonSet
///    carrying `helmsman.dev/catalog-app=<id>` marks `<id>` installed —
///    unconditionally, image not consulted. The annotation wins over image
///    match (see `docs/parity/catalog-link-workload.md` §3.2).
/// 2. **Image (fallback, existing logic).** Scans container images across
///    Deployments, StatefulSets, DaemonSets, and loose Pods; host- and
///    tag-insensitive (see `imageRepoPath`). An app is installed when *any* of
///    its `matchImages` matches *any* running container image, so multi-service
///    apps only need one distinctive image to be detected.
///
/// Pure — no side effects on the cache; recompute freely so the result tracks
/// the watch stream.
func installedAppIDs(
    apps: [CatalogApp],
    deployments: [Deployment],
    statefulSets: [StatefulSet],
    daemonSets: [DaemonSet] = [],
    pods: [Pod]
) -> Set<String> {
    var installed = Set<String>()

    // Pass 1 — annotation. A workload's catalog-app annotation is a first-class
    // match regardless of image. An annotation pointing at an id not in the
    // catalog is added verbatim; it harmlessly corresponds to no card.
    for d in deployments { if let id = boundAppID(d.metadata) { installed.insert(id) } }
    for s in statefulSets { if let id = boundAppID(s.metadata) { installed.insert(id) } }
    for ds in daemonSets { if let id = boundAppID(ds.metadata) { installed.insert(id) } }

    // Pass 2 — image. Collect every running container image, normalized to a
    // repo path and deduplicated, then match each not-yet-installed app.
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
    for ds in daemonSets {
        for c in ds.spec?.template?.spec?.containers ?? [] {
            if let image = c.image { runningRepos.insert(imageRepoPath(image)) }
        }
    }
    for p in pods {
        for c in p.spec?.containers ?? [] {
            if let image = c.image { runningRepos.insert(imageRepoPath(image)) }
        }
    }

    for app in apps where !installed.contains(app.id) {
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
/// the full string (registry + repo + tag). This is what the update check
/// needs: the running *tag*, not just the repo path. Apps with no bound or
/// matching container are omitted (i.e. not installed).
///
/// Annotation-first, mirroring `installedAppIDs`/`updateTargets`: a workload
/// carrying `helmsman.dev/catalog-app=<id>` is the definitive source for that
/// app's `current` image (the container picked per §3.3 container-selection),
/// over any image-matched candidate. Apps with no annotated workload fall back
/// to image match, now also scanning DaemonSets.
func installedImages(
    apps: [CatalogApp],
    deployments: [Deployment],
    statefulSets: [StatefulSet],
    daemonSets: [DaemonSet] = [],
    pods: [Pod]
) -> [InstalledImage] {
    // (normalized repo path, full image ref) for every running container.
    var running: [(repo: String, full: String)] = []
    func collect(_ image: String?) {
        if let image { running.append((imageRepoPath(image), image)) }
    }
    for d in deployments { for c in d.spec?.template?.spec?.containers ?? [] { collect(c.image) } }
    for s in statefulSets { for c in s.spec?.template?.spec?.containers ?? [] { collect(c.image) } }
    for ds in daemonSets { for c in ds.spec?.template?.spec?.containers ?? [] { collect(c.image) } }
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

    func digest(for repo: String) -> String? {
        podDigests.first { repoPathsMatch($0.repo, repo) }?.digest
    }

    // Annotation targets resolve the bound workload + container directly.
    let targets = updateTargets(
        apps: apps,
        deployments: deployments,
        statefulSets: statefulSets,
        daemonSets: daemonSets,
        pods: pods
    )
    let targetByID = Dictionary(targets.map { ($0.appID, $0) }, uniquingKeysWith: { first, _ in first })

    var out: [InstalledImage] = []
    for app in apps {
        // Annotation-first: a bound workload IS the install/update source.
        if let t = targetByID[app.id] {
            out.append(InstalledImage(
                appID: app.id,
                image: t.image,
                repoURL: app.repoURL,
                runningDigest: digest(for: imageRepoPath(t.image))
            ))
            continue
        }
        // Fallback — first container whose image matches one of `matchImages`.
        for raw in app.matchImages {
            let candidate = imageRepoPath(raw)
            if let hit = running.first(where: { repoPathsMatch($0.repo, candidate) }) {
                out.append(InstalledImage(appID: app.id, image: hit.full, repoURL: app.repoURL, runningDigest: digest(for: candidate)))
                break
            }
        }
    }
    return out
}

/// The concrete workload + container an app's update (`kubectl set image`)
/// should target. Annotation-first, DaemonSets scanned — mirrors the web
/// `updateTargets` (`apps/web/src/panels/catalog/updateTargets.ts`) and
/// `docs/parity/catalog-link-workload.md` §3.3. Pure.
struct UpdateTarget: Equatable {
    let appID: String
    /// "deployment" | "statefulset" | "daemonset" — a kubectl resource string.
    let workloadKind: String
    let workloadName: String
    let namespace: String
    let container: String
    /// The container's full running image ref (registry + repo + tag).
    let image: String
}

/// Per app, resolve the update target:
///
/// 1. **Annotated workload (definitive).** If any Deployment/StatefulSet/
///    DaemonSet carries `helmsman.dev/catalog-app=<app.id>`, that workload IS
///    the target — regardless of image. Multiple bound workloads → first in
///    scan order (deployments, then statefulSets, then daemonSets).
///    Container selection: the `catalog-container` annotation if it names an
///    existing container; else the sole container; else the first container
///    whose image `repoPathsMatch`es a `matchImage`, else the first container.
/// 2. **Image match (fallback).** No annotated workload → derive by image, now
///    also scanning DaemonSets as a controller source.
func updateTargets(
    apps: [CatalogApp],
    deployments: [Deployment],
    statefulSets: [StatefulSet],
    daemonSets: [DaemonSet] = [],
    pods: [Pod]
) -> [UpdateTarget] {
    // One controller in scan order: (kind, meta, containers). Deployments →
    // statefulSets → daemonSets — the deterministic precedence for both the
    // annotation pass and any image fallback that walks controllers.
    struct Workload { let kind: String; let meta: ObjectMeta; let containers: [Container] }
    var workloads: [Workload] = []
    for d in deployments {
        workloads.append(Workload(kind: "deployment", meta: d.metadata, containers: d.spec?.template?.spec?.containers ?? []))
    }
    for s in statefulSets {
        workloads.append(Workload(kind: "statefulset", meta: s.metadata, containers: s.spec?.template?.spec?.containers ?? []))
    }
    for ds in daemonSets {
        workloads.append(Workload(kind: "daemonset", meta: ds.metadata, containers: ds.spec?.template?.spec?.containers ?? []))
    }

    // Pick the container the update should retag for a bound workload.
    func selectContainer(_ w: Workload, app: CatalogApp) -> Container? {
        let containers = w.containers
        guard !containers.isEmpty else { return nil }
        // Explicit annotation, when it names an existing container.
        if let name = boundContainer(w.meta), let hit = containers.first(where: { $0.name == name }) {
            return hit
        }
        // Single container — unambiguous.
        if containers.count == 1 { return containers[0] }
        // Multi-container, no (valid) annotation: first matchImage-matching, else first.
        if let hit = containers.first(where: { c in
            guard let image = c.image else { return false }
            let repo = imageRepoPath(image)
            return app.matchImages.contains { repoPathsMatch(repo, imageRepoPath($0)) }
        }) { return hit }
        return containers[0]
    }

    var out: [UpdateTarget] = []
    for app in apps {
        // Pass 1 — annotation. First bound workload in scan order wins.
        if let w = workloads.first(where: { boundAppID($0.meta) == app.id }),
           let c = selectContainer(w, app: app), let image = c.image {
            out.append(UpdateTarget(
                appID: app.id,
                workloadKind: w.kind,
                workloadName: w.meta.name,
                namespace: w.meta.namespace ?? "default",
                container: c.name,
                image: image
            ))
            continue
        }
        // Pass 2 — image match. First container (across controllers in scan
        // order) whose image matches one of the app's `matchImages`.
        outer: for w in workloads {
            for c in w.containers {
                guard let image = c.image else { continue }
                let repo = imageRepoPath(image)
                if app.matchImages.contains(where: { repoPathsMatch(repo, imageRepoPath($0)) }) {
                    out.append(UpdateTarget(
                        appID: app.id,
                        workloadKind: w.kind,
                        workloadName: w.meta.name,
                        namespace: w.meta.namespace ?? "default",
                        container: c.name,
                        image: image
                    ))
                    break outer
                }
            }
        }
    }
    return out
}
