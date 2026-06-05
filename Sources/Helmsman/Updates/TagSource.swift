import Foundation

/// Fetches the list of available tags for one repository from a registry.
/// One implementation per registry API shape. Kept behind a protocol so the
/// resolver can be unit-tested with a stub instead of real network.
protocol TagSource: Sendable {
    func listTags(repository: String) async throws -> [String]

    /// The manifest digest a tag/reference currently resolves to (the registry's
    /// `Docker-Content-Digest`). Used by the moving-tag tier to compare what's
    /// running against the newest release. Default nil ⇒ this source can't
    /// resolve digests (e.g. the GitHub Releases tier), so the resolver routes
    /// such images to assist rather than guessing.
    func resolveDigest(repository: String, reference: String) async throws -> String?
}

extension TagSource {
    func resolveDigest(repository: String, reference: String) async throws -> String? { nil }
}

/// Accept header advertising the manifest media types a digest HEAD may return,
/// so multi-arch (OCI index / Docker manifest list) and single-arch images both
/// resolve to their canonical `Docker-Content-Digest`.
private let ociManifestAccept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
].joined(separator: ", ")

enum TagSourceError: Error, CustomStringConvertible {
    case unsupportedRegistry(String)
    case badResponse(status: Int)
    case decodeFailed

    var description: String {
        switch self {
        case .unsupportedRegistry(let r): return "no tag source for registry \(r)"
        case .badResponse(let s):         return "registry returned HTTP \(s)"
        case .decodeFailed:               return "could not decode registry tag list"
        }
    }
}

/// Picks the right `TagSource` for a registry host, or nil when we have no
/// client for it (the caller routes those images to the Claude fallback).
enum TagSourceFactory {
    static func make(for registry: String, session: URLSession = .shared) -> TagSource? {
        switch registry {
        case "docker.io", "registry-1.docker.io", "index.docker.io":
            return DockerHubTagSource(session: session)
        case "ghcr.io":
            return GHCRTagSource(session: session)
        default:
            return nil
        }
    }
}

/// Docker Hub: `GET hub.docker.com/v2/repositories/<repo>/tags`. Public, no auth.
struct DockerHubTagSource: TagSource {
    let session: URLSession

    func listTags(repository: String) async throws -> [String] {
        var comps = URLComponents(string: "https://hub.docker.com/v2/repositories/\(repository)/tags")!
        comps.queryItems = [
            URLQueryItem(name: "page_size", value: "100"),
            URLQueryItem(name: "ordering", value: "last_updated"),
        ]
        let (data, response) = try await session.data(from: comps.url!)
        try Self.checkStatus(response)
        struct Page: Decodable { struct Tag: Decodable { let name: String }; let results: [Tag] }
        guard let page = try? JSONDecoder().decode(Page.self, from: data) else {
            throw TagSourceError.decodeFailed
        }
        return page.results.map(\.name)
    }

    /// Docker Hub digests come from the OCI distribution API on
    /// `registry-1.docker.io` (the hub.docker.com tags API isn't reliable for
    /// the canonical manifest-list digest), with an anonymous pull token.
    func resolveDigest(repository: String, reference: String) async throws -> String? {
        let token = try await Self.fetchRegistryToken(repository: repository, session: session)
        var req = URLRequest(url: URL(string: "https://registry-1.docker.io/v2/\(repository)/manifests/\(reference)")!)
        req.httpMethod = "HEAD"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(ociManifestAccept, forHTTPHeaderField: "Accept")
        let (_, response) = try await session.data(for: req)
        try Self.checkStatus(response)
        return (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Docker-Content-Digest")
    }

    private static func fetchRegistryToken(repository: String, session: URLSession) async throws -> String {
        let url = URL(string: "https://auth.docker.io/token?service=registry.docker.io&scope=repository:\(repository):pull")!
        let (data, response) = try await session.data(from: url)
        try checkStatus(response)
        struct Token: Decodable { let token: String }
        guard let t = try? JSONDecoder().decode(Token.self, from: data) else { throw TagSourceError.decodeFailed }
        return t.token
    }

    private static func checkStatus(_ response: URLResponse) throws {
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw TagSourceError.badResponse(status: http.statusCode)
        }
    }
}

/// GHCR (OCI distribution API). Public images still require an anonymous
/// bearer token scoped to the repository before `/v2/<repo>/tags/list`.
struct GHCRTagSource: TagSource {
    let session: URLSession

    func listTags(repository: String) async throws -> [String] {
        let token = try await fetchAnonymousToken(repository: repository)
        let base = URL(string: "https://ghcr.io")!
        // GHCR's OCI `/tags/list` is paginated (default 100) and returns tags
        // oldest-first with NO ordering guarantee, so the newest releases sit on
        // the LAST page. We MUST walk every page via the `Link: rel="next"`
        // header — fetching only page 1 silently caps visibility at the ~100
        // oldest tags, which made every >100-tag image (e.g. paperless-ngx) look
        // perpetually up to date. The page cap is a runaway-loop guard, not a
        // truncation: 50×100 covers far more tags than any real image carries.
        var next: URL? = URL(string: "https://ghcr.io/v2/\(repository)/tags/list?n=100")!
        var all: [String] = []
        var pages = 0
        while let url = next, pages < 50 {
            var req = URLRequest(url: url)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw TagSourceError.decodeFailed }
            if !(200...299).contains(http.statusCode) {
                throw TagSourceError.badResponse(status: http.statusCode)
            }
            guard let tags = Self.parseTags(data) else { throw TagSourceError.decodeFailed }
            all.append(contentsOf: tags)
            next = Self.nextPageURL(linkHeader: http.value(forHTTPHeaderField: "Link"), base: base)
            pages += 1
        }
        return all
    }

    /// Decode the `{ "tags": [...] }` body of one tag-list page. nil on malformed
    /// JSON. Pure — unit-tested without a network round-trip.
    static func parseTags(_ data: Data) -> [String]? {
        struct TagList: Decodable { let tags: [String]? }
        guard let list = try? JSONDecoder().decode(TagList.self, from: data) else { return nil }
        return list.tags ?? []
    }

    /// Resolve the `rel="next"` page from an OCI `Link` response header against
    /// `base`, or nil when there is no next page. The registry emits a relative
    /// reference like `</v2/<repo>/tags/list?last=X&n=100>; rel="next"`. Pure.
    static func nextPageURL(linkHeader: String?, base: URL) -> URL? {
        guard let header = linkHeader else { return nil }
        for segment in header.split(separator: ",") {
            let part = segment.trimmingCharacters(in: .whitespaces)
            guard part.range(of: #"rel="?next"?"#, options: .regularExpression) != nil,
                  let lo = part.firstIndex(of: "<"),
                  let hi = part.firstIndex(of: ">"), lo < hi
            else { continue }
            let reference = String(part[part.index(after: lo)..<hi])
            return URL(string: reference, relativeTo: base)?.absoluteURL
        }
        return nil
    }

    /// GHCR digest via an OCI manifest HEAD; the `Docker-Content-Digest` header
    /// is the canonical (manifest-list) digest. Same anonymous bearer token as
    /// the tag list.
    func resolveDigest(repository: String, reference: String) async throws -> String? {
        let token = try await fetchAnonymousToken(repository: repository)
        var req = URLRequest(url: URL(string: "https://ghcr.io/v2/\(repository)/manifests/\(reference)")!)
        req.httpMethod = "HEAD"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(ociManifestAccept, forHTTPHeaderField: "Accept")
        let (_, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw TagSourceError.badResponse(status: http.statusCode)
        }
        return (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Docker-Content-Digest")
    }

    private func fetchAnonymousToken(repository: String) async throws -> String {
        let url = URL(string: "https://ghcr.io/token?scope=repository:\(repository):pull")!
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw TagSourceError.badResponse(status: http.statusCode)
        }
        struct Token: Decodable { let token: String }
        guard let t = try? JSONDecoder().decode(Token.self, from: data) else {
            throw TagSourceError.decodeFailed
        }
        return t.token
    }
}

/// GitHub Releases. `GET api.github.com/repos/<owner>/<repo>/releases/latest`
/// returns the newest release excluding drafts and prereleases. We surface it
/// through `TagSource` as a single-element tag list so the existing
/// `newestStableUpgrade` comparison applies unchanged. Unauthenticated: the
/// 60 req/hr-per-IP limit is ample for a daily catalog sweep, and any failure
/// throws — the resolver then routes the item to the Claude fallback.
struct GitHubReleaseSource: TagSource {
    var session: URLSession = .shared

    /// `repository` is `"owner/repo"` (derived from the app's repoURL).
    func listTags(repository: String) async throws -> [String] {
        let url = URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!
        var req = URLRequest(url: url)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw TagSourceError.badResponse(status: http.statusCode)
        }
        guard let tag = Self.parseTag(data) else { throw TagSourceError.decodeFailed }
        return [tag]
    }

    /// Pull `tag_name` out of a `releases/latest` payload, or nil if absent.
    static func parseTag(_ data: Data) -> String? {
        struct Release: Decodable { let tag_name: String }
        return (try? JSONDecoder().decode(Release.self, from: data))?.tag_name
    }
}
