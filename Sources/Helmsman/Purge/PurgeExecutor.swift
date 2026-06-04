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

    /// Pure: the `helm` argument vector to uninstall the release, or nil. Returns nil
    /// unless the plan carries a `helmRelease` AND the namespace is purgeable, so a
    /// protected namespace can never produce a `helm uninstall`.
    static func helmUninstallArgs(for plan: PurgePlan) -> [String]? {
        guard let release = plan.helmRelease,
              PurgeGuardrails.isPurgeable(namespace: plan.namespace) else { return nil }
        return ["uninstall", release, "-n", plan.namespace]
    }

    struct Outcome { let resource: String; let ok: Bool; let detail: String }

    /// Run the plan: if Helm-managed, `helm uninstall` the release FIRST (so the chart
    /// tears down what it owns), then sweep any remaining per-resource deletes (e.g.
    /// PVCs Helm leaves behind) via WorkloadCommander. Returns per-step results.
    static func run(_ plan: PurgePlan, context: String?) async -> [Outcome] {
        var results: [Outcome] = []

        if let args = helmUninstallArgs(for: plan) {
            results.append(await runHelmUninstall(args, context: context))
        }

        let commander = WorkloadCommander(context: context)
        for action in actions(for: plan) {
            let r = await commander.run(action)
            results.append(Outcome(resource: action.title, ok: r.ok,
                                   detail: r.ok ? "deleted" : (r.stderr.isEmpty ? "exit \(r.exitCode)" : r.stderr)))
        }
        return results
    }

    /// Invoke the `helm` binary the same way `HelmCommander` does — resolve it on
    /// PATH and append `--kube-context <context>` — via the shared `runProcess` helper.
    private static func runHelmUninstall(_ args: [String], context: String?) async -> Outcome {
        let release = args.count > 1 ? args[1] : "release"
        guard let helm = resolveBinary("helm") else {
            return Outcome(resource: "helm/\(release)", ok: false, detail: "helm not found on PATH")
        }
        var full = args
        if let context, !context.isEmpty { full.append(contentsOf: ["--kube-context", context]) }
        do {
            _ = try await runProcess(helm, args: full)
            return Outcome(resource: "helm/\(release)", ok: true, detail: "uninstalled")
        } catch ProcessError.nonZeroExit(let code, let stderr) {
            return Outcome(resource: "helm/\(release)", ok: false,
                           detail: stderr.isEmpty ? "exit \(code)" : stderr)
        } catch {
            return Outcome(resource: "helm/\(release)", ok: false, detail: "\(error)")
        }
    }
}
