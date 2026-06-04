import Foundation

enum PurgeExecutor {
    /// Pure: confirmed plan → ordered delete actions, re-checking guardrails so a
    /// protected namespace or shared-infra workload can never produce a delete.
    static func actions(for plan: PurgePlan) -> [WorkloadAction] {
        guard PurgeGuardrails.isPurgeable(namespace: plan.namespace) else { return [] }
        return plan.resources.filter(\.selected).compactMap { r in
            if PurgeGuardrails.isSharedInfraWorkload(name: r.name, namespace: r.namespace) { return nil }
            switch r.kind {
            case .deployment:  return .deleteWorkload(kind: "deployment", name: r.name, namespace: r.namespace)
            case .statefulSet: return .deleteWorkload(kind: "statefulset", name: r.name, namespace: r.namespace)
            case .service:     return .deleteService(name: r.name, namespace: r.namespace)
            case .ingress:     return .deleteIngress(name: r.name, namespace: r.namespace)
            case .secret:      return .deleteSecret(name: r.name, namespace: r.namespace)
            case .configMap:   return .deleteConfigMap(name: r.name, namespace: r.namespace)
            case .pvc:         return .deletePVC(name: r.name, namespace: r.namespace)
            }
        }
    }

    struct Outcome { let resource: String; let ok: Bool; let detail: String }

    /// Run the plan: each delete via WorkloadCommander; returns per-resource results.
    static func run(_ plan: PurgePlan, context: String?) async -> [Outcome] {
        let commander = WorkloadCommander(context: context)
        var results: [Outcome] = []
        for action in actions(for: plan) {
            let r = await commander.run(action)
            results.append(Outcome(resource: action.title, ok: r.ok,
                                   detail: r.ok ? "deleted" : (r.stderr.isEmpty ? "exit \(r.exitCode)" : r.stderr)))
        }
        return results
    }
}
