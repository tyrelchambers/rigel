import Foundation

/// One unit of update work: an installed catalog app paired with the exact
/// image reference it's running.
struct InstalledImage: Hashable {
    let appID: String
    /// Full running reference, e.g. `ghcr.io/plausible/community-edition:v2.1.4`.
    let image: String
    /// The catalog app's source repo, used by the GitHub Releases tier. nil when
    /// the app has no repo or the item wasn't built from a catalog app.
    var repoURL: URL? = nil
    /// The `sha256:…` digest the running pod actually pulled (from pod status
    /// `imageID`). For a moving tag like `:latest` this is the only way to know
    /// what's truly running. nil when no pod status was available.
    var runningDigest: String? = nil
}

/// Resolves update status by querying registries. Stateless apart from the
/// injected `tagSourceFor`, which maps a registry host to a `TagSource` (or nil
/// for registries we don't have a client for). Injection keeps the resolver
/// unit-testable with a stub source and no network.
struct UpdateResolver {
    /// Maps a registry host to a tag source. Defaults to the real factory.
    var tagSourceFor: (String) -> TagSource? = { TagSourceFactory.make(for: $0) }

    /// Source for the GitHub Releases tier, tried when the registry tier
    /// declines and the app has a `github.com` repoURL. Injectable for tests.
    var githubSource: TagSource? = GitHubReleaseSource()

    /// Pure: decide status from a known tag list. Newer stable tag → update
    /// available; otherwise up to date.
    static func statusFromTags(current: String, tags: [String]) -> UpdateStatus {
        if let latest = newestStableUpgrade(currentTag: current, availableTags: tags) {
            return .updateAvailable(current: current, latest: latest)
        }
        return .upToDate(current: current)
    }

    /// Derive `"owner/repo"` from a GitHub repo URL, or nil when the path
    /// doesn't carry at least an owner and repo. Strips a trailing `.git`.
    static func ownerRepo(from url: URL) -> String? {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 2 else { return nil }
        var repo = parts[1]
        if repo.hasSuffix(".git") { repo = String(repo.dropLast(4)) }
        return "\(parts[0])/\(repo)"
    }

    /// Decide update status from a running image and the newest GitHub release
    /// tag. Returns nil to mean "not trustworthy — fall through to Claude":
    /// the release tag doesn't parse, the running tag is a non-version flavor,
    /// the image is digest-only, or the two version schemes don't line up.
    static func statusFromRelease(currentImage: String, releaseTag: String) -> UpdateStatus? {
        guard let ref = ImageReference(currentImage) else { return nil }
        guard let releaseVer = ReleaseVersion(tag: releaseTag) else { return nil }

        guard let tag = ref.tag else { return nil }   // digest-only → Claude

        // A moving tag (`:latest`, `:stable`) carries no version, so a release
        // tag alone can't tell us whether it's current — `:latest` is routinely
        // frozen behind the newest release (authentik abandoned it at 2025.2.4).
        // Resolving that needs a digest comparison (`resolveViaMovingTag`), not
        // this tier; return nil so we don't falsely claim up-to-date.
        guard let runningVer = ReleaseVersion(tag: tag) else { return nil }
        guard schemesComparable(runningVer, releaseVer) else { return nil }

        if isNewerRelease(releaseVer, than: runningVer) {
            return .updateAvailable(current: tag, latest: releaseTag)
        }
        return .upToDate(current: tag)
    }

    /// Reject clearly-different version schemes (e.g. an 8-digit date tag vs a
    /// 1–2-digit semver major). Heuristic: the leading numeric component's digit
    /// width must be within 1 of each other.
    static func schemesComparable(_ a: ReleaseVersion, _ b: ReleaseVersion) -> Bool {
        let wa = String(a.components[0]).count
        let wb = String(b.components[0]).count
        return abs(wa - wb) <= 1
    }

    /// Strictly-newer test that tolerates pure trailing-zero formatting
    /// differences, because image tags routinely drop them: a running tag of
    /// `1.23` is the *same* release as GitHub's `v1.23.0`, not behind it.
    static func isNewerRelease(_ candidate: ReleaseVersion, than running: ReleaseVersion) -> Bool {
        let a = trimmedTrailingZeros(running.components)
        let b = trimmedTrailingZeros(candidate.components)
        let n = max(a.count, b.count)
        for i in 0..<n {
            let l = i < a.count ? a[i] : 0
            let r = i < b.count ? b[i] : 0
            if l != r { return r > l }
        }
        return false   // identical once normalized → not newer
    }

    private static func trimmedTrailingZeros(_ components: [Int]) -> [Int] {
        var c = components
        while c.count > 1 && c.last == 0 { c.removeLast() }
        return c
    }

    /// Whether an image can even be checked by tag. `:latest`-pinned,
    /// digest-only, non-semver, or unknown-registry images cannot — they route
    /// to the Claude fallback.
    func canResolveByRegistry(_ image: String) -> Bool {
        guard let ref = ImageReference(image), let tag = ref.tag,
              tag != "latest", ReleaseVersion(tag: tag) != nil,
              tagSourceFor(ref.registry) != nil
        else { return false }
        return true
    }

    /// Resolve a single image deterministically. Tries the registry (version
    /// tag), then the moving-tag digest tier (`:latest`/`:stable`), then the
    /// GitHub Releases tier. Returns nil to mean "needs assist" — the caller
    /// routes those to the Claude fallback.
    func resolveOne(_ item: InstalledImage) async -> UpdateStatus? {
        if let status = await resolveViaRegistry(item) { return status }
        if let status = await resolveViaMovingTag(item) { return status }
        return await resolveViaReleases(item)
    }

    /// Tier 1.5: a *moving* tag (`:latest`, `:stable` — anything that doesn't
    /// parse as a version) on a registry we can query. The tag name tells us
    /// nothing, so we compare digests: what we're actually running vs the newest
    /// released artifact.
    ///
    /// "What we're running" prefers the pod's pulled digest (`runningDigest`),
    /// since the registry's `:latest` may have moved since the node last pulled;
    /// when that's unavailable we fall back to what `:latest` resolves to now.
    /// "Newest released" is the digest of the newest stable version tag — so a
    /// frozen/abandoned `:latest` (running an old build, or pointing at one) is
    /// correctly flagged as behind. nil (→ assist) whenever a digest can't be
    /// obtained, rather than guessing.
    private func resolveViaMovingTag(_ item: InstalledImage) async -> UpdateStatus? {
        guard let ref = ImageReference(item.image), let tag = ref.tag,
              ReleaseVersion(tag: tag) == nil,                 // moving / non-version tag
              let source = tagSourceFor(ref.registry)
        else { return nil }

        let newestTag: String
        let newestDigest: String?
        do {
            guard let t = newestStableTag(try await source.listTags(repository: ref.repository)) else { return nil }
            newestTag = t
            newestDigest = try await source.resolveDigest(repository: ref.repository, reference: t)
        } catch {
            return nil
        }
        guard let dNew = newestDigest else { return nil }

        // Prefer the digest the pod actually pulled; else what the moving tag
        // currently points to in the registry.
        var current = item.runningDigest
        if current == nil { current = try? await source.resolveDigest(repository: ref.repository, reference: tag) }
        guard let dCur = current else { return nil }

        return dCur == dNew ? .upToDate(current: tag) : .updateAvailable(current: tag, latest: newestTag)
    }

    /// Tier 1: tag-checkable image on a known registry.
    private func resolveViaRegistry(_ item: InstalledImage) async -> UpdateStatus? {
        guard let ref = ImageReference(item.image), let tag = ref.tag,
              tag != "latest", ReleaseVersion(tag: tag) != nil,
              let source = tagSourceFor(ref.registry)
        else { return nil }
        do {
            let tags = try await source.listTags(repository: ref.repository)
            return Self.statusFromTags(current: tag, tags: tags)
        } catch {
            return nil
        }
    }

    /// Tier 2: newest GitHub release for the app's repo, when the version
    /// schemes are comparable. nil for non-GitHub repos, missing repos, fetch
    /// failures, or scheme mismatches — all fall through to Claude.
    private func resolveViaReleases(_ item: InstalledImage) async -> UpdateStatus? {
        guard let repoURL = item.repoURL, repoURL.host == "github.com",
              let ownerRepo = Self.ownerRepo(from: repoURL),
              let source = githubSource
        else { return nil }
        let releaseTag: String
        do {
            guard let tag = try await source.listTags(repository: ownerRepo).first else { return nil }
            releaseTag = tag
        } catch {
            return nil
        }
        return Self.statusFromRelease(currentImage: item.image, releaseTag: releaseTag)
    }

    /// Resolve every item we can via its registry. Returns resolved statuses
    /// keyed by appID, plus the items that need the Claude fallback.
    func resolve(_ items: [InstalledImage]) async -> (resolved: [String: UpdateStatus], needsAssist: [InstalledImage]) {
        var resolved: [String: UpdateStatus] = [:]
        var needsAssist: [InstalledImage] = []
        for item in items {
            if let status = await resolveOne(item) {
                resolved[item.appID] = status
            } else {
                needsAssist.append(item)
            }
        }
        return (resolved, needsAssist)
    }
}
