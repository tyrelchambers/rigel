import Foundation

/// A namespaced, identifiable Kubernetes resource the shared panel filter can
/// match by name/namespace and sort by name. Conformance is empty — every
/// resource type already exposes `metadata` and is `Identifiable`.
protocol NamespacedResource: Identifiable {
    var metadata: ObjectMeta { get }
}

extension Deployment: NamespacedResource {}
extension Service: NamespacedResource {}
extension Secret: NamespacedResource {}
extension ConfigMap: NamespacedResource {}
extension Ingress: NamespacedResource {}

extension ClusterCache {
    /// The namespace + search + sort every namespace-scoped panel repeats:
    /// apply the shared `namespaceFilter`, keep rows whose name/namespace (or a
    /// type-specific `matches` field) contains `search`, then sort by name —
    /// grouping by namespace first when `groupByNamespace` is set (the all-rows
    /// view used by Services/Ingresses). `matches` receives the raw search term.
    func filtered<T: NamespacedResource>(
        _ items: [T],
        search: String,
        groupByNamespace: Bool = false,
        matches: (T, String) -> Bool = { _, _ in false }
    ) -> [T] {
        var base = items
        if let ns = namespaceFilter {
            base = base.filter { $0.metadata.namespace == ns }
        }
        if !search.isEmpty {
            base = base.filter { item in
                item.metadata.name.localizedCaseInsensitiveContains(search)
                    || (item.metadata.namespace ?? "").localizedCaseInsensitiveContains(search)
                    || matches(item, search)
            }
        }
        return base.sorted { lhs, rhs in
            if groupByNamespace {
                let lns = lhs.metadata.namespace ?? ""
                let rns = rhs.metadata.namespace ?? ""
                if lns != rns { return lns < rns }
            }
            return lhs.metadata.name.localizedStandardCompare(rhs.metadata.name) == .orderedAscending
        }
    }
}
