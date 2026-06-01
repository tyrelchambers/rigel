import Foundation

/// Read-only discovery of cert-manager ClusterIssuers on a cluster, so UI can
/// offer the user's real issuers in a dropdown instead of asking them to type a
/// name. Shared by the ingress editor, the catalog install wizard, and Settings.
enum ClusterIssuerLoader {
    enum LoadError: Error {
        /// kubectl isn't on PATH / resolvable — distinct from "cluster has none".
        case kubectlNotFound
    }

    private struct IssuerList: Decodable {
        let items: [Item]
        struct Item: Decodable { let metadata: Meta }
        struct Meta: Decodable { let name: String }
    }

    /// Sorted ClusterIssuer names for `context`. Returns `[]` when cert-manager
    /// is installed but no issuers exist. Throws `LoadError.kubectlNotFound` if
    /// kubectl can't be located, or rethrows the process/decoding error when the
    /// CRD is absent (cert-manager not installed) so callers can distinguish
    /// "none configured" from "couldn't ask".
    static func load(context: String?) async throws -> [String] {
        guard let kubectl = resolveBinary("kubectl") else {
            throw LoadError.kubectlNotFound
        }
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["get", "clusterissuers", "-o", "json"])
        let data = try await runProcess(kubectl, args: args)
        let list = try JSONDecoder().decode(IssuerList.self, from: data)
        return list.items.map(\.metadata.name).sorted()
    }
}
