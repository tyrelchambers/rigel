import Foundation
import Observation

enum RBACKind: String, CaseIterable, Identifiable {
    case serviceAccounts
    case roles
    case roleBindings
    case clusterRoles
    case clusterRoleBindings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .serviceAccounts:     return "ServiceAccounts"
        case .roles:               return "Roles"
        case .roleBindings:        return "RoleBindings"
        case .clusterRoles:        return "ClusterRoles"
        case .clusterRoleBindings: return "ClusterRoleBindings"
        }
    }

    /// kubectl resource string for delete.
    var resource: String {
        switch self {
        case .serviceAccounts:     return "serviceaccount"
        case .roles:               return "role"
        case .roleBindings:        return "rolebinding"
        case .clusterRoles:        return "clusterrole"
        case .clusterRoleBindings: return "clusterrolebinding"
        }
    }
}

@Observable
final class RBACViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var kind: RBACKind = .serviceAccounts
    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var count: Int {
        switch kind {
        case .serviceAccounts:     return filteredServiceAccounts.count
        case .roles:               return filteredRoles.count
        case .roleBindings:        return filteredRoleBindings.count
        case .clusterRoles:        return filteredClusterRoles.count
        case .clusterRoleBindings: return filteredClusterRoleBindings.count
        }
    }

    var filteredServiceAccounts: [ServiceAccount] {
        cache.serviceAccounts
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredRoles: [Role] {
        cache.roles
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredRoleBindings: [RoleBinding] {
        cache.roleBindings
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace, $0.roleRef?.name]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredClusterRoles: [ClusterRole] {
        cache.clusterRoles
            .filter { matches([$0.metadata.name]) }
            .sorted { $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending }
    }

    var filteredClusterRoleBindings: [ClusterRoleBinding] {
        cache.clusterRoleBindings
            .filter { matches([$0.metadata.name, $0.roleRef?.name]) }
            .sorted { $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending }
    }

    private func passesNamespace(_ meta: ObjectMeta) -> Bool {
        cache.namespaceFilter == nil || meta.namespace == cache.namespaceFilter
    }

    private func matches(_ fields: [String?]) -> Bool {
        if search.isEmpty { return true }
        let hay = fields.compactMap { $0 }.joined(separator: " ")
        return hay.localizedCaseInsensitiveContains(search)
    }

    private func sortByNamespaceName(_ lhs: ObjectMeta, _ rhs: ObjectMeta) -> Bool {
        let lns = lhs.namespace ?? ""
        let rns = rhs.namespace ?? ""
        if lns != rns { return lns < rns }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
}
