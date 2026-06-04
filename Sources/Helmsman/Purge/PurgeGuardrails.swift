import Foundation

/// Hard deny rules enforced at every stage of purge — discovery never proposes,
/// and the executor never deletes, anything these reject, regardless of UI state.
enum PurgeGuardrails {
    /// Namespaces that hold cluster/system infrastructure and are never purgeable.
    static let protectedNamespaces: Set<String> = [
        "kube-system", "kube-public", "kube-node-lease", "default-system",
        "cert-manager", "cnpg-system",
    ]
    /// Namespace prefixes that are system-owned (e.g. Rancher's cattle-*).
    static let protectedNamespacePrefixes: [String] = ["cattle-", "kube-", "fleet-", "tigera-", "calico-"]

    /// Workload names that are shared database SERVERS — never deletable (only an
    /// app's logical DB inside them may be dropped, and only opt-in).
    static let sharedInfraNames: Set<String> = ["postgres", "mysql", "mariadb", "redis", "postgres-pooler"]

    static func isPurgeable(namespace ns: String) -> Bool {
        if protectedNamespaces.contains(ns) { return false }
        if protectedNamespacePrefixes.contains(where: { ns.hasPrefix($0) }) { return false }
        return true
    }

    static func isSharedInfraWorkload(name: String, namespace: String) -> Bool {
        sharedInfraNames.contains(name)
    }
}
