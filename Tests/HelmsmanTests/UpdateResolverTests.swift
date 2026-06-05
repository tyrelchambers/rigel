import XCTest
@testable import Helmsman

private struct StubTagSource: TagSource {
    let tags: [String]
    var fail = false
    /// reference (tag) -> digest, for the moving-tag tier. Empty ⇒ no digest
    /// support (mirrors a source whose `resolveDigest` default-returns nil).
    var digests: [String: String] = [:]
    func listTags(repository: String) async throws -> [String] {
        if fail { throw TagSourceError.badResponse(status: 500) }
        return tags
    }
    func resolveDigest(repository: String, reference: String) async throws -> String? {
        if fail { throw TagSourceError.badResponse(status: 500) }
        return digests[reference]
    }
}

final class UpdateResolverTests: XCTestCase {

    private func resolver(tags: [String], fail: Bool = false, hasSource: Bool = true) -> UpdateResolver {
        UpdateResolver(tagSourceFor: { _ in hasSource ? StubTagSource(tags: tags, fail: fail) : nil })
    }

    func test_updateAvailable() async {
        let r = resolver(tags: ["v2.1.4", "v3.2.1", "v3.3.0-rc.1"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "plausible", image: "ghcr.io/plausible/community-edition:v2.1.4")
        ])
        XCTAssertTrue(assist.isEmpty)
        XCTAssertEqual(resolved["plausible"], .updateAvailable(current: "v2.1.4", latest: "v3.2.1"))
    }

    func test_upToDate() async {
        let r = resolver(tags: ["1.20", "1.21", "1.22"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "gitea", image: "gitea/gitea:1.22")
        ])
        XCTAssertTrue(assist.isEmpty)
        XCTAssertEqual(resolved["gitea"], .upToDate(current: "1.22"))
    }

    func test_latestPinnedRoutesToAssist() async {
        let r = resolver(tags: ["1.0", "2.0"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "vaultwarden", image: "vaultwarden/server:latest")
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["vaultwarden"])
    }

    func test_nonSemverTagRoutesToAssist() async {
        let r = resolver(tags: ["a", "b"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "weird", image: "weird/app:stable")
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["weird"])
    }

    func test_unknownRegistryRoutesToAssist() async {
        let r = resolver(tags: [], hasSource: false)
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "x", image: "quay.io/x/y:1.2.3")
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["x"])
    }

    func test_fetchFailureRoutesToAssist() async {
        let r = resolver(tags: ["1.0", "2.0"], fail: true)
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "gitea", image: "gitea/gitea:1.0")
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["gitea"])
    }

    func test_mixedBatch() async {
        let r = resolver(tags: ["1.0", "2.0"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "gitea", image: "gitea/gitea:1.0"),       // -> 2.0
            InstalledImage(appID: "vw", image: "vaultwarden/server:latest"), // -> assist
        ])
        XCTAssertEqual(resolved["gitea"], .updateAvailable(current: "1.0", latest: "2.0"))
        XCTAssertEqual(assist.map(\.appID), ["vw"])
    }

    // MARK: - ownerRepo

    func test_ownerRepo_fromGitHubURL() {
        XCTAssertEqual(
            UpdateResolver.ownerRepo(from: URL(string: "https://github.com/go-gitea/gitea")!),
            "go-gitea/gitea")
    }

    func test_ownerRepo_stripsDotGit() {
        XCTAssertEqual(
            UpdateResolver.ownerRepo(from: URL(string: "https://github.com/dani-garcia/vaultwarden.git")!),
            "dani-garcia/vaultwarden")
    }

    func test_ownerRepo_tooShort_returnsNil() {
        XCTAssertNil(UpdateResolver.ownerRepo(from: URL(string: "https://github.com/onlyowner")!))
    }

    // MARK: - statusFromRelease

    func test_statusFromRelease_semverNewer_updateAvailable() {
        let s = UpdateResolver.statusFromRelease(currentImage: "gitea/gitea:1.22", releaseTag: "v1.23.0")
        XCTAssertEqual(s, .updateAvailable(current: "1.22", latest: "v1.23.0"))
    }

    func test_statusFromRelease_semverEqualOrOlder_upToDate() {
        let s = UpdateResolver.statusFromRelease(currentImage: "gitea/gitea:1.23", releaseTag: "v1.23.0")
        XCTAssertEqual(s, .upToDate(current: "1.23"))
    }

    func test_statusFromRelease_latestPin_returnsNil() {
        // A moving tag can't be judged from a release tag alone — that's the
        // moving-tag digest tier's job, not this one.
        let s = UpdateResolver.statusFromRelease(currentImage: "vaultwarden/server:latest", releaseTag: "1.30.1")
        XCTAssertNil(s)
    }

    func test_statusFromRelease_nonSemverRunningTag_returnsNil() {
        let s = UpdateResolver.statusFromRelease(currentImage: "weird/app:stable", releaseTag: "v2.0.0")
        XCTAssertNil(s)
    }

    func test_statusFromRelease_schemeMismatch_dateVsSemver_returnsNil() {
        let s = UpdateResolver.statusFromRelease(currentImage: "supabase/studio:20240101", releaseTag: "v1.2.3")
        XCTAssertNil(s)
    }

    func test_statusFromRelease_unparseableReleaseTag_returnsNil() {
        let s = UpdateResolver.statusFromRelease(currentImage: "gitea/gitea:1.22", releaseTag: "stable")
        XCTAssertNil(s)
    }

    func test_statusFromRelease_digestOnlyImage_returnsNil() {
        let s = UpdateResolver.statusFromRelease(
            currentImage: "gitea/gitea@sha256:abc", releaseTag: "v1.23.0")
        XCTAssertNil(s)
    }

    // MARK: - GitHub tier routing

    private func githubResolver(
        registryTags: [String], registryFail: Bool = false, hasRegistry: Bool = true,
        githubTag: String?
    ) -> UpdateResolver {
        let gh: TagSource? = githubTag.map { StubTagSource(tags: [$0]) }
        return UpdateResolver(
            tagSourceFor: { _ in hasRegistry ? StubTagSource(tags: registryTags, fail: registryFail) : nil },
            githubSource: gh
        )
    }

    func test_latestPin_noDigestSupport_routesToAssist() async {
        // `:latest` with a GitHub repo but a registry that can't resolve digests
        // (stub has none) can't be judged deterministically → assist. The old
        // behavior of blindly reporting up-to-date for `:latest` is gone.
        let r = githubResolver(registryTags: [], githubTag: "1.30.1")
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "vw", image: "vaultwarden/server:latest",
                           repoURL: URL(string: "https://github.com/dani-garcia/vaultwarden")!)
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["vw"])
    }

    // MARK: - moving-tag digest tier

    private func movingResolver(tags: [String], digests: [String: String]) -> UpdateResolver {
        UpdateResolver(tagSourceFor: { _ in StubTagSource(tags: tags, digests: digests) }, githubSource: nil)
    }

    func test_movingTag_runningDigestBehindNewest_updateAvailable() async {
        // authentik shape: running `:latest` (frozen at an old build) while a
        // newer version tag exists with a different digest.
        let r = movingResolver(tags: ["2025.2.4", "2026.5.2", "latest"],
                               digests: ["2026.5.2": "sha256:NEW", "latest": "sha256:OLD"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "authentik", image: "ghcr.io/goauthentik/server:latest",
                           runningDigest: "sha256:OLD")
        ])
        XCTAssertTrue(assist.isEmpty)
        XCTAssertEqual(resolved["authentik"], .updateAvailable(current: "latest", latest: "2026.5.2"))
    }

    func test_movingTag_runningDigestMatchesNewest_upToDate() async {
        let r = movingResolver(tags: ["2026.5.2", "latest"],
                               digests: ["2026.5.2": "sha256:NEW", "latest": "sha256:NEW"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "authentik", image: "ghcr.io/goauthentik/server:latest",
                           runningDigest: "sha256:NEW")
        ])
        XCTAssertTrue(assist.isEmpty)
        XCTAssertEqual(resolved["authentik"], .upToDate(current: "latest"))
    }

    func test_movingTag_noRunningDigest_fallsBackToRegistryLatestDigest() async {
        // No pod digest available → compare what `:latest` resolves to now
        // against the newest version tag. Here they differ → behind.
        let r = movingResolver(tags: ["2026.5.2", "latest"],
                               digests: ["2026.5.2": "sha256:NEW", "latest": "sha256:OLD"])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "authentik", image: "ghcr.io/goauthentik/server:latest")
        ])
        XCTAssertTrue(assist.isEmpty)
        XCTAssertEqual(resolved["authentik"], .updateAvailable(current: "latest", latest: "2026.5.2"))
    }

    func test_movingTag_newestDigestUnavailable_routesToAssist() async {
        // Tags exist but the newest's digest can't be fetched → assist, never guess.
        let r = movingResolver(tags: ["2026.5.2", "latest"], digests: [:])
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "authentik", image: "ghcr.io/goauthentik/server:latest",
                           runningDigest: "sha256:OLD")
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["authentik"])
    }

    func test_registryFailure_fallsToGitHubTier() async {
        let r = githubResolver(registryTags: ["1.0"], registryFail: true, githubTag: "v1.23.0")
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "gitea", image: "gitea/gitea:1.22",
                           repoURL: URL(string: "https://github.com/go-gitea/gitea")!)
        ])
        XCTAssertTrue(assist.isEmpty)
        XCTAssertEqual(resolved["gitea"], .updateAvailable(current: "1.22", latest: "v1.23.0"))
    }

    func test_registryHit_skipsGitHubTier() async {
        // GitHub source would say "v9.9.9" but registry already resolved → ignored.
        let r = githubResolver(registryTags: ["1.22", "1.23"], githubTag: "v9.9.9")
        let (resolved, _) = await r.resolve([
            InstalledImage(appID: "gitea", image: "gitea/gitea:1.22",
                           repoURL: URL(string: "https://github.com/go-gitea/gitea")!)
        ])
        XCTAssertEqual(resolved["gitea"], .updateAvailable(current: "1.22", latest: "1.23"))
    }

    func test_noRepoURL_skipsGitHubTier_routesToAssist() async {
        let r = githubResolver(registryTags: [], githubTag: "1.30.1")
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "vw", image: "vaultwarden/server:latest")  // repoURL nil
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["vw"])
    }

    func test_nonGitHubRepoURL_skipsGitHubTier() async {
        let r = githubResolver(registryTags: [], githubTag: "1.30.1")
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "x", image: "x/y:latest",
                           repoURL: URL(string: "https://gitlab.com/x/y")!)
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["x"])
    }

    func test_schemeMismatch_routesToAssist() async {
        // Registry can't answer (fetch failure) → falls to the GitHub tier, where
        // the date-vs-semver scheme guard rejects it → Claude.
        let r = githubResolver(registryTags: [], registryFail: true, githubTag: "v1.2.3")
        let (resolved, assist) = await r.resolve([
            InstalledImage(appID: "supabase", image: "supabase/studio:20240101",
                           repoURL: URL(string: "https://github.com/supabase/supabase")!)
        ])
        XCTAssertTrue(resolved.isEmpty)
        XCTAssertEqual(assist.map(\.appID), ["supabase"])
    }
}
