@testable import Helmsman

extension Pod {
    /// Build a Pod fixture. The `cnpg.io/cluster` label is derived from the
    /// pod name's prefix before the first "-" ("pg-1" -> "pg", "redis-0" -> "redis")
    /// so `CNPGOperator` can match pods to their cluster.
    static func testInstance(name: String, namespace: String, phase: String,
                             nodeName: String? = nil) -> Pod {
        let cluster = String(name.prefix(while: { $0 != "-" }))
        return Pod(
            metadata: ObjectMeta(
                name: name, namespace: namespace, uid: "uid-\(name)",
                creationTimestamp: nil,
                labels: ["cnpg.io/cluster": cluster, "app": cluster],
                annotations: nil
            ),
            spec: PodSpec(nodeName: nodeName, containers: []),
            status: PodStatus(phase: phase, podIP: nil, containerStatuses: nil)
        )
    }
}
