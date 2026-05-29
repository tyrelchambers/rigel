import Foundation

// MARK: - Shared RBAC value types

struct PolicyRule: Codable, Hashable {
    let apiGroups: [String]?
    let resources: [String]?
    let verbs: [String]?
}

struct RoleRef: Codable, Hashable {
    let kind: String?
    let name: String?

    var label: String {
        guard let name else { return "—" }
        return "\(kind ?? "Role")/\(name)"
    }
}

struct Subject: Codable, Hashable {
    let kind: String?       // User | Group | ServiceAccount
    let name: String?
    let namespace: String?
}

// MARK: - ServiceAccount (v1)

struct ServiceAccount: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let secrets: [ObjectRef]?
    var id: String { metadata.uid }

    struct ObjectRef: Codable, Hashable { let name: String? }

    var secretCount: Int { secrets?.count ?? 0 }
}

// MARK: - Roles (rbac.authorization.k8s.io/v1)

struct Role: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let rules: [PolicyRule]?
    var id: String { metadata.uid }
    var ruleCount: Int { rules?.count ?? 0 }
}

struct ClusterRole: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let rules: [PolicyRule]?
    var id: String { metadata.uid }
    var ruleCount: Int { rules?.count ?? 0 }
}

// MARK: - Bindings

struct RoleBinding: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let roleRef: RoleRef?
    let subjects: [Subject]?
    var id: String { metadata.uid }
    var subjectCount: Int { subjects?.count ?? 0 }
}

struct ClusterRoleBinding: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let roleRef: RoleRef?
    let subjects: [Subject]?
    var id: String { metadata.uid }
    var subjectCount: Int { subjects?.count ?? 0 }
}

// MARK: - Display

enum RBACDisplay {
    /// Compact subject summary, e.g. "sa:default/builder, user:alice".
    static func subjectsSummary(_ subjects: [Subject]?) -> String {
        guard let subjects, !subjects.isEmpty else { return "no subjects" }
        return subjects.prefix(3).map { s in
            let kind = (s.kind ?? "?").lowercased().replacingOccurrences(of: "serviceaccount", with: "sa")
            if let ns = s.namespace, !ns.isEmpty {
                return "\(kind):\(ns)/\(s.name ?? "?")"
            }
            return "\(kind):\(s.name ?? "?")"
        }.joined(separator: ", ") + (subjects.count > 3 ? " +\(subjects.count - 3)" : "")
    }
}
