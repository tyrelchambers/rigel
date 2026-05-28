import Foundation

enum DatabaseSource: Hashable {
    case cnpg
    case deployment
    case statefulset
}

struct DatabaseInstance: Identifiable, Hashable {
    let id: String                         // stable id (uid)
    let kind: DatabaseKind
    let source: DatabaseSource
    let name: String
    let namespace: String
    let image: String?
    let desiredReplicas: Int
    let readyReplicas: Int
    let phaseText: String                  // operator phase OR "Healthy"/"Degraded"
    let isHealthy: Bool
    let cnpgPrimary: String?               // CNPG only
    let labelSelector: [String: String]    // for finding child pods

    /// Sort key: namespace, then name.
    var sortKey: String { "\(namespace)/\(name)" }
}
