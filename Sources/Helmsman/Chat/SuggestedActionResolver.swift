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
        statefulSets: [StatefulSet] = [],
        daemonSets: [DaemonSet] = [],
        jobs: [Job] = [],
        cronJobs: [CronJob] = [],
        namespaces: [Namespace] = []
    ) -> SuggestedActionResolution {
        let ns = s.namespace ?? "default"

        // The generic controller/cronjob target name (prefers `name`, falls back
        // to the legacy `deployment` field).
        func deployment() -> Deployment? {
            guard let name = s.target else { return nil }
            return deployments.first { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == ns }
                ?? deployments.first { $0.metadata.name == name }
        }
        func deploymentMiss() -> SuggestedActionResolution {
            guard let name = s.target else { return .unresolved("this action needs a deployment name") }
            return .unresolved("deployment \(ns)/\(name) isn't in the live cluster view")
        }
        func cronJobExists(_ name: String) -> Bool {
            cronJobs.contains { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == ns }
        }

        switch s.kind {
        case .setImage:
            guard let name = s.target else { return .unresolved("setImage needs a workload name") }
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
        case .setResources:
            guard let name = s.target else { return .unresolved("setResources needs a workload name") }
            guard let container = s.container else { return .unresolved("setResources needs a container name") }
            let requests = s.requests ?? ""
            let limits = s.limits ?? ""
            guard !requests.isEmpty || !limits.isEmpty else {
                return .unresolved("setResources needs requests and/or limits")
            }
            // Resolve the workload kind by name: deployment, then statefulset, then daemonset.
            if deployments.contains(where: { $0.metadata.name == name }) {
                return .action(.setResources(kind: "deployment", name: name, namespace: ns, container: container, requests: requests, limits: limits))
            }
            if statefulSets.contains(where: { $0.metadata.name == name }) {
                return .action(.setResources(kind: "statefulset", name: name, namespace: ns, container: container, requests: requests, limits: limits))
            }
            if daemonSets.contains(where: { $0.metadata.name == name }) {
                return .action(.setResources(kind: "daemonset", name: name, namespace: ns, container: container, requests: requests, limits: limits))
            }
            return .unresolved("workload \(ns)/\(name) isn't in the live cluster view")
        case .restart:
            // Deployment uses the dedicated action; statefulset/daemonset use the generic one.
            if let d = deployment() { return .action(.restartDeployment(d)) }
            guard let name = s.target else { return .unresolved("restart needs a workload name") }
            if statefulSets.contains(where: { $0.metadata.name == name }) {
                return .action(.restartWorkload(kind: "statefulset", name: name, namespace: ns))
            }
            if daemonSets.contains(where: { $0.metadata.name == name }) {
                return .action(.restartWorkload(kind: "daemonset", name: name, namespace: ns))
            }
            return .unresolved("workload \(ns)/\(name) isn't in the live cluster view")
        case .rollback:
            return deployment().map { .action(.rollbackDeployment($0)) } ?? deploymentMiss()
        case .scale:
            guard let r = s.replicas else { return .unresolved("scale needs a replicas count") }
            if let d = deployment() { return .action(.scaleDeployment(d, to: r)) }
            guard let name = s.target else { return .unresolved("scale needs a workload name") }
            if let ss = statefulSets.first(where: { $0.metadata.name == name }) {
                return .action(.scaleWorkload(kind: "statefulset", name: name, namespace: ns, current: ss.spec?.replicas ?? 0, to: r))
            }
            if daemonSets.contains(where: { $0.metadata.name == name }) {
                return .unresolved("\(ns)/\(name) is a daemonset — it runs one pod per node and can't be scaled by replicas")
            }
            return .unresolved("workload \(ns)/\(name) isn't in the live cluster view")
        case .pause:
            return deployment().map { .action(.pauseDeployment($0)) } ?? deploymentMiss()
        case .resume:
            return deployment().map { .action(.resumeDeployment($0)) } ?? deploymentMiss()
        case .setEnv:
            guard let env = s.env, !env.isEmpty else { return .unresolved("setEnv needs one or more env values") }
            return deployment().map { .action(.setDeploymentEnv($0, env: env)) } ?? deploymentMiss()
        case .deletePod:
            guard let name = s.pod else { return .unresolved("this action needs a pod name") }
            guard let pod = pods.first(where: { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == ns }) else {
                return .unresolved("pod \(ns)/\(name) isn't in the live cluster view")
            }
            return .action(.deletePod(pod))
        case .deleteWorkload:
            guard let name = s.target else { return .unresolved("delete needs a workload name") }
            let kinds: [(String, Bool)] = [
                ("deployment", deployments.contains { $0.metadata.name == name }),
                ("statefulset", statefulSets.contains { $0.metadata.name == name }),
                ("daemonset", daemonSets.contains { $0.metadata.name == name }),
                ("job", jobs.contains { $0.metadata.name == name }),
                ("cronjob", cronJobs.contains { $0.metadata.name == name }),
            ]
            guard let kind = kinds.first(where: { $0.1 })?.0 else {
                return .unresolved("workload \(ns)/\(name) isn't in the live cluster view")
            }
            return .action(.deleteWorkload(kind: kind, name: name, namespace: ns))
        case .cordon, .uncordon, .drain:
            guard let name = s.node else { return .unresolved("this action needs a node name") }
            guard let node = nodes.first(where: { $0.metadata.name == name }) else {
                return .unresolved("node \(name) isn't in the live cluster view")
            }
            switch s.kind {
            case .cordon:   return .action(.cordonNode(node))
            case .uncordon: return .action(.uncordonNode(node))
            default:        return .action(.drainNode(node, options: DrainOptions()))
            }
        case .suspendCronJob, .resumeCronJob:
            guard let name = s.target else { return .unresolved("this action needs a cronjob name") }
            guard cronJobExists(name) else { return .unresolved("cronjob \(ns)/\(name) isn't in the live cluster view") }
            return .action(.setCronJobSuspend(name: name, namespace: ns, suspend: s.kind == .suspendCronJob))
        case .triggerCronJob:
            guard let name = s.target else { return .unresolved("this action needs a cronjob name") }
            guard cronJobExists(name) else { return .unresolved("cronjob \(ns)/\(name) isn't in the live cluster view") }
            return .action(.triggerCronJob(name: name, namespace: ns, jobName: CronJob.manualRunName(for: name)))
        case .createNamespace:
            guard let name = s.target else { return .unresolved("createNamespace needs a name") }
            guard !namespaces.contains(where: { $0.metadata.name == name }) else {
                return .unresolved("namespace \(name) already exists")
            }
            return .action(.createNamespace(name: name))
        case .deleteNamespace:
            guard let name = s.target else { return .unresolved("deleteNamespace needs a name") }
            guard namespaces.contains(where: { $0.metadata.name == name }) else {
                return .unresolved("namespace \(name) isn't in the live cluster view")
            }
            return .action(.deleteNamespace(name: name))
        case .deleteResource:
            guard let name = s.target else { return .unresolved("deleteResource needs a name") }
            guard let rk = s.resourceKind?.lowercased() else { return .unresolved("deleteResource needs a resourceKind") }
            return resolveDelete(resourceKind: rk, name: name, namespace: ns)
        case .command:
            let args = (s.args ?? []).filter { !$0.isEmpty }
            guard !args.isEmpty else { return .unresolved("command needs kubectl args") }
            // The destructive floor is the app's, not Claude's: a destructive verb
            // in the args forces the red confirm + acknowledge even if Claude said
            // otherwise. Claude can only escalate (destructive: true), never relax.
            let destructive = isDestructive(args) || (s.destructive == true)
            return .action(.command(args: args, label: s.label, destructive: destructive))
        case .purge:
            // Purge is handled upstream (MainWindow opens the typed-name purge
            // confirm sheet); it has no WorkloadAction mapping and must never
            // resolve into the generic confirm/execute path.
            return .unresolved("purge is handled by the dedicated app-removal sheet")
        }
    }

    /// Destructive kubectl verbs that force the red confirm sheet + acknowledge
    /// checkbox for a generic `command` action, regardless of Claude's hint.
    private static let destructiveVerbs: Set<String> = ["delete", "destroy", "drain", "prune", "purge", "remove"]

    /// True when any argument is a known destructive verb (e.g. `delete`,
    /// `cnpg destroy`). Over-matching only adds caution, so this scans every arg.
    private static func isDestructive(_ args: [String]) -> Bool {
        args.contains { destructiveVerbs.contains($0.lowercased()) }
    }

    /// Map a `deleteResource` kind string to the matching delete `WorkloadAction`.
    /// Object existence isn't re-checked against the cache here — the assistant
    /// only proposes deleting resources it just observed, and the confirm sheet
    /// (with its destructive-acknowledgement checkbox) is the real gate.
    private static func resolveDelete(resourceKind rk: String, name: String, namespace ns: String) -> SuggestedActionResolution {
        switch rk {
        case "service", "svc":                       return .action(.deleteService(name: name, namespace: ns))
        case "ingress", "ing":                        return .action(.deleteIngress(name: name, namespace: ns))
        case "configmap", "cm":                       return .action(.deleteConfigMap(name: name, namespace: ns))
        case "secret":                                return .action(.deleteSecret(name: name, namespace: ns))
        case "pvc", "persistentvolumeclaim":          return .action(.deletePVC(name: name, namespace: ns))
        case "pv", "persistentvolume":                return .action(.deletePV(name: name))
        case "role", "rolebinding":                   return .action(.deleteRBAC(kind: rk, name: name, namespace: ns))
        case "clusterrole", "clusterrolebinding":     return .action(.deleteRBAC(kind: rk, name: name, namespace: nil))
        default:                                      return .unresolved("don't know how to delete resource kind '\(rk)'")
        }
    }
}
