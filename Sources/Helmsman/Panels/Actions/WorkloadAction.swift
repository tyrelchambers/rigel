import Foundation

struct DrainOptions: Equatable {
    /// Pod termination grace period in seconds. -1 = use the pod's terminationGracePeriodSeconds.
    var gracePeriodSeconds: Int = -1
    /// kubectl drain --timeout. "0s" = no timeout.
    var timeout: String = "0s"
    /// Skip pods managed by DaemonSets (almost always wanted).
    var ignoreDaemonSets: Bool = true
    /// Allow deletion of pods using emptyDir volumes.
    var deleteEmptyDirData: Bool = true
    /// Allow deletion of pods not managed by a controller.
    var force: Bool = false
    /// Use plain delete instead of eviction (bypasses PodDisruptionBudgets).
    var disableEviction: Bool = false
}

/// Describes a destructive operation against a cluster resource. Pure value
/// type — turning a `WorkloadAction` into an actual kubectl invocation is
/// `WorkloadCommander`'s job, gated by `WorkloadConfirmSheet` user approval.
enum WorkloadAction: Identifiable {
    case restartDeployment(Deployment)
    case scaleDeployment(Deployment, to: Int)
    case setDeploymentEnv(Deployment, env: [String: String])
    case rollbackDeployment(Deployment)
    case pauseDeployment(Deployment)
    case resumeDeployment(Deployment)
    case deletePod(Pod)
    case cordonNode(Node)
    case uncordonNode(Node)
    case drainNode(Node, options: DrainOptions)
    /// Create-or-update via `kubectl apply -f -`. Used for both new secrets
    /// (uid empty) and edits (uid populated; apply is idempotent).
    case applySecret(Secret)
    case deleteSecret(name: String, namespace: String)
    case moveSecret(original: Secret, newName: String, newNamespace: String)
    /// Apply an arbitrary manifest YAML (multi-document). Used by the catalog
    /// install wizard; the wizard's Review step is the user confirmation, so
    /// these flow through `WorkloadCommander.run` directly without the
    /// `WorkloadConfirmSheet`.
    case applyManifest(yaml: String, label: String)

    var id: String {
        switch self {
        case .restartDeployment(let d): return "restart-\(d.id)"
        case .scaleDeployment(let d, let n): return "scale-\(d.id)-\(n)"
        case .setDeploymentEnv(let d, let env): return "setenv-\(d.id)-\(env.keys.sorted().joined(separator: ","))"
        case .rollbackDeployment(let d): return "rollback-\(d.id)"
        case .pauseDeployment(let d): return "pause-\(d.id)"
        case .resumeDeployment(let d): return "resume-\(d.id)"
        case .deletePod(let p): return "delete-\(p.id)"
        case .cordonNode(let n): return "cordon-\(n.id)"
        case .uncordonNode(let n): return "uncordon-\(n.id)"
        case .drainNode(let n, _): return "drain-\(n.id)"
        case .applySecret(let s): return "apply-secret-\(s.metadata.namespace ?? "default")/\(s.metadata.name)"
        case .deleteSecret(let name, let ns): return "delete-secret-\(ns)/\(name)"
        case .moveSecret(let o, let n, let ns): return "move-secret-\(o.id)-to-\(ns)/\(n)"
        case .applyManifest(_, let label): return "apply-manifest-\(label)"
        }
    }

    var title: String {
        switch self {
        case .restartDeployment(let d): return "Restart \(d.metadata.name)"
        case .scaleDeployment(let d, let n): return "Scale \(d.metadata.name) → \(n)"
        case .setDeploymentEnv(let d, _): return "Set env on \(d.metadata.name)"
        case .rollbackDeployment(let d): return "Rollback \(d.metadata.name)"
        case .pauseDeployment(let d): return "Pause rollout of \(d.metadata.name)"
        case .resumeDeployment(let d): return "Resume rollout of \(d.metadata.name)"
        case .deletePod(let p): return "Delete pod \(p.metadata.name)"
        case .cordonNode(let n): return "Cordon \(n.metadata.name)"
        case .uncordonNode(let n): return "Uncordon \(n.metadata.name)"
        case .drainNode(let n, _): return "Drain \(n.metadata.name)"
        case .applySecret(let s):
            let ns = s.metadata.namespace ?? "default"
            return "Apply secret \(ns)/\(s.metadata.name)"
        case .deleteSecret(let name, let ns): return "Delete secret \(ns)/\(name)"
        case .moveSecret(let o, let newName, let newNs):
            return "Move secret \(o.metadata.namespace ?? "default")/\(o.metadata.name) → \(newNs)/\(newName)"
        case .applyManifest(_, let label):
            return "Apply \(label) manifest"
        }
    }

    var subtitle: String {
        switch self {
        case .restartDeployment(let d):
            return "Triggers a rolling restart of all pods in namespace \(d.metadata.namespace ?? "default")."
        case .scaleDeployment(let d, let n):
            let cur = d.spec?.replicas ?? d.status?.replicas ?? 0
            return "Sets replicas from \(cur) → \(n) in namespace \(d.metadata.namespace ?? "default")."
        case .setDeploymentEnv(let d, let env):
            let pairs = env.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: ", ")
            return "Sets \(pairs) on \(d.metadata.name) in namespace \(d.metadata.namespace ?? "default"). Triggers a new rollout."
        case .rollbackDeployment(let d):
            return "Rolls \(d.metadata.name) back to the previous revision (kubectl rollout undo). Triggers a new rollout."
        case .pauseDeployment(let d):
            return "Pauses the rollout controller for \(d.metadata.name). Changes to pod template stop reconciling until resumed."
        case .resumeDeployment(let d):
            return "Resumes rollout for \(d.metadata.name). Any pending template changes start rolling out."
        case .deletePod(let p):
            return "Pod will be removed. If managed by a workload controller, a replacement will be created."
        case .cordonNode(let n):
            return "Marks \(n.metadata.name) unschedulable. Existing pods continue running."
        case .uncordonNode(let n):
            return "Allows the scheduler to place new pods on \(n.metadata.name) again."
        case .drainNode(let n, let opts):
            var flags: [String] = []
            if opts.ignoreDaemonSets { flags.append("DaemonSets skipped") }
            if opts.deleteEmptyDirData { flags.append("emptyDir deleted") }
            if opts.force { flags.append("force") }
            if opts.disableEviction { flags.append("delete (no eviction)") }
            let tail = flags.isEmpty ? "" : " — \(flags.joined(separator: ", "))"
            return "Cordons \(n.metadata.name) and evicts all pods.\(tail)"
        case .applySecret(let s):
            let n = s.data?.count ?? 0
            return "Creates or updates the \(s.secretType.displayName) secret with \(n) key\(n == 1 ? "" : "s") via `kubectl apply -f -`."
        case .deleteSecret(let name, let ns):
            return "Permanently removes secret \(ns)/\(name). Workloads referencing it will fail to start or roll out until a replacement exists."
        case .moveSecret(let o, let newName, let newNs):
            let oldNs = o.metadata.namespace ?? "default"
            let scope: String
            if newNs == oldNs { scope = "rename within \(oldNs)" }
            else if newName == o.metadata.name { scope = "copy to \(newNs), delete from \(oldNs)" }
            else { scope = "create \(newNs)/\(newName), delete \(oldNs)/\(o.metadata.name)" }
            return "Copy-and-delete (\(scope)). Workloads still referencing the old name/namespace will lose access."
        case .applyManifest(_, let label):
            return "Creates or updates the resources defined in the \(label) manifest via `kubectl apply -f -`."
        }
    }

    /// True = destructive enough that the confirm modal turns red.
    /// Rollout restart / pause / resume / uncordon / apply-secret are all
    /// reversible state changes — they get the neutral accent dialog.
    var isHighRisk: Bool {
        switch self {
        case .uncordonNode,
             .pauseDeployment,
             .resumeDeployment,
             .restartDeployment,
             .setDeploymentEnv,
             .applySecret,
             .applyManifest:
            return false
        default:
            return true
        }
    }

    /// True = require explicit "I understand" acknowledge checkbox.
    var needsAcknowledge: Bool {
        switch self {
        case .deletePod, .drainNode, .deleteSecret, .moveSecret: return true
        default: return false
        }
    }

    /// Sequence of kubectl invocations to run. Most actions produce a single
    /// invocation; chained ops (like secret move = apply-new + delete-old)
    /// produce multiple. Caller prepends `--context X` to each.
    func kubectlInvocations() -> [KubectlInvocation] {
        switch self {
        case .restartDeployment(let d):
            return [.args(["rollout", "restart", "deployment/\(d.metadata.name)", "-n", d.metadata.namespace ?? "default"])]
        case .scaleDeployment(let d, let n):
            return [.args(["scale", "deployment/\(d.metadata.name)", "--replicas=\(n)", "-n", d.metadata.namespace ?? "default"])]
        case .setDeploymentEnv(let d, let env):
            let pairs = env.map { "\($0.key)=\($0.value)" }.sorted()
            return [.args(["set", "env", "deployment/\(d.metadata.name)", "-n", d.metadata.namespace ?? "default"] + pairs)]
        case .rollbackDeployment(let d):
            return [.args(["rollout", "undo", "deployment/\(d.metadata.name)", "-n", d.metadata.namespace ?? "default"])]
        case .pauseDeployment(let d):
            return [.args(["rollout", "pause", "deployment/\(d.metadata.name)", "-n", d.metadata.namespace ?? "default"])]
        case .resumeDeployment(let d):
            return [.args(["rollout", "resume", "deployment/\(d.metadata.name)", "-n", d.metadata.namespace ?? "default"])]
        case .deletePod(let p):
            return [.args(["delete", "pod", p.metadata.name, "-n", p.metadata.namespace ?? "default"])]
        case .cordonNode(let n):
            return [.args(["cordon", n.metadata.name])]
        case .uncordonNode(let n):
            return [.args(["uncordon", n.metadata.name])]
        case .drainNode(let n, let opts):
            var args = ["drain", n.metadata.name]
            if opts.gracePeriodSeconds >= 0 { args.append("--grace-period=\(opts.gracePeriodSeconds)") }
            if !opts.timeout.isEmpty && opts.timeout != "0s" { args.append("--timeout=\(opts.timeout)") }
            if opts.ignoreDaemonSets { args.append("--ignore-daemonsets") }
            if opts.deleteEmptyDirData { args.append("--delete-emptydir-data") }
            if opts.force { args.append("--force") }
            if opts.disableEviction { args.append("--disable-eviction") }
            return [.args(args)]
        case .applySecret(let s):
            return [.applyYAML(s.toYAML())]
        case .deleteSecret(let name, let ns):
            return [.args(["delete", "secret", name, "-n", ns])]
        case .moveSecret(let original, let newName, let newNs):
            let oldName = original.metadata.name
            let oldNs = original.metadata.namespace ?? "default"
            if newName == oldName && newNs == oldNs { return [] }
            let moved = Secret.draft(
                name: newName,
                namespace: newNs,
                type: original.secretType,
                decodedData: original.data?.mapValues { String(data: Data(base64Encoded: $0) ?? Data(), encoding: .utf8) ?? "" } ?? [:],
                labels: original.metadata.labels
            )
            return [
                .applyYAML(moved.toYAML()),
                .args(["delete", "secret", oldName, "-n", oldNs])
            ]
        case .applyManifest(let yaml, _):
            return [.applyYAML(yaml)]
        }
    }

    /// Human-readable command preview shown in the confirm modal. Multi-invocation
    /// actions render as one line per step, separated by ` && \`.
    func previewCommand(context: String?) -> String {
        let invs = kubectlInvocations()
        let lines = invs.map { inv -> String in
            var parts = ["kubectl"]
            if let context { parts.append(contentsOf: ["--context", context]) }
            parts.append(contentsOf: inv.args)
            var line = parts.joined(separator: " ")
            if inv.stdin != nil {
                line += " <<< (YAML payload)"
            }
            return line
        }
        return lines.joined(separator: " && \\\n  ")
    }
}

/// One kubectl invocation. `stdin` is non-nil for `kubectl apply -f -` style
/// commands that need a YAML payload piped in.
struct KubectlInvocation: Equatable {
    let args: [String]
    let stdin: Data?

    static func args(_ args: [String]) -> KubectlInvocation {
        KubectlInvocation(args: args, stdin: nil)
    }

    /// Convenience: apply YAML from stdin.
    static func applyYAML(_ yaml: String) -> KubectlInvocation {
        KubectlInvocation(args: ["apply", "-f", "-"], stdin: Data(yaml.utf8))
    }
}
