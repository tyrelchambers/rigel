import Foundation

/// Outcome of mapping a `SuggestedAction` onto a runnable `WorkloadAction`.
enum SuggestedActionResolution {
    case action(WorkloadAction)
    /// Couldn't build the action — carries a user-facing reason (missing field,
    /// or the named resource isn't in the live cluster view).
    case unresolved(String)
}

/// Maps a Claude-proposed `SuggestedAction` onto a typed `WorkloadAction` by
/// resolving the named resource against live cluster snapshots. Pure — takes
/// arrays rather than the cache so it's testable.
enum SuggestedActionResolver {
    static func resolve(
        _ s: SuggestedAction,
        deployments: [Deployment],
        pods: [Pod],
        nodes: [Node],
        statefulSets: [StatefulSet] = []
    ) -> SuggestedActionResolution {
        let ns = s.namespace ?? "default"

        func deployment() -> Deployment? {
            guard let name = s.deployment else { return nil }
            return deployments.first { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == ns }
                ?? deployments.first { $0.metadata.name == name }
        }
        func deploymentMiss() -> SuggestedActionResolution {
            guard let name = s.deployment else { return .unresolved("this action needs a deployment name") }
            return .unresolved("deployment \(ns)/\(name) isn't in the live cluster view")
        }

        switch s.kind {
        case .setImage:
            guard let name = s.deployment else { return .unresolved("setImage needs a workload name") }
            guard let container = s.container, let image = s.image else {
                return .unresolved("setImage needs a container and an image")
            }
            // Resolve the workload kind by name: deployment first, then statefulset.
            if deployments.contains(where: { $0.metadata.name == name }) {
                return .action(.setImage(kind: "deployment", name: name, namespace: ns, container: container, image: image))
            }
            if statefulSets.contains(where: { $0.metadata.name == name }) {
                return .action(.setImage(kind: "statefulset", name: name, namespace: ns, container: container, image: image))
            }
            return .unresolved("workload \(ns)/\(name) isn't in the live cluster view")
        case .restart:
            return deployment().map { .action(.restartDeployment($0)) } ?? deploymentMiss()
        case .rollback:
            return deployment().map { .action(.rollbackDeployment($0)) } ?? deploymentMiss()
        case .scale:
            guard let r = s.replicas else { return .unresolved("scale needs a replicas count") }
            return deployment().map { .action(.scaleDeployment($0, to: r)) } ?? deploymentMiss()
        case .setEnv:
            guard let env = s.env, !env.isEmpty else { return .unresolved("setEnv needs one or more env values") }
            return deployment().map { .action(.setDeploymentEnv($0, env: env)) } ?? deploymentMiss()
        case .deletePod:
            guard let name = s.pod else { return .unresolved("this action needs a pod name") }
            guard let pod = pods.first(where: { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == ns }) else {
                return .unresolved("pod \(ns)/\(name) isn't in the live cluster view")
            }
            return .action(.deletePod(pod))
        case .cordon, .uncordon:
            guard let name = s.node else { return .unresolved("this action needs a node name") }
            guard let node = nodes.first(where: { $0.metadata.name == name }) else {
                return .unresolved("node \(name) isn't in the live cluster view")
            }
            return .action(s.kind == .cordon ? .cordonNode(node) : .uncordonNode(node))
        }
    }
}
