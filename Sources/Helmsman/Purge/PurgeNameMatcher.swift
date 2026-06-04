import Foundation

/// Groups the deployments that make up one logical app, tolerant of inconsistent
/// naming (`canada-hires-web` vs `canadahires-api`, `-staging` variants). Loose by
/// design: it over-includes candidates and relies on the human pruning the purge
/// sheet, never on being exactly right.
enum PurgeNameMatcher {
    /// Hyphen/underscore tokens that denote a role or environment, not identity.
    private static let roleTokens: Set<String> = [
        "staging", "stg", "production", "prod", "dev", "test",
        "web", "api", "server", "client", "app", "svc", "service",
        "worker", "deploy", "deployment", "frontend", "backend", "ui", "site",
    ]

    /// Identity core: lowercase, split on -/_, drop role/env tokens, rejoin.
    static func core(_ name: String) -> String {
        let tokens = name.lowercased().split(whereSeparator: { $0 == "-" || $0 == "_" }).map(String.init)
        let kept = tokens.filter { !roleTokens.contains($0) }
        return (kept.isEmpty ? tokens : kept).joined()
    }

    /// Names related to `root` among `among`: a prefix match on identity cores,
    /// guarded by a minimum core length so tiny cores don't over-merge.
    static func relatedNames(root: String, among: [String]) -> [String] {
        let rc = core(root)
        guard rc.count >= 4 else { return [root] }
        return among.filter { name in
            let c = core(name)
            return c.hasPrefix(rc) || rc.hasPrefix(c)
        }
    }
}
