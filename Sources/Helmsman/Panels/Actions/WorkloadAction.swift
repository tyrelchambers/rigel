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
    /// Create-or-update an ingress via `kubectl apply -f -`. `isNew` only
    /// affects the confirm-sheet copy; apply is idempotent either way.
    case applyIngress(Ingress, isNew: Bool)
    case deleteIngress(name: String, namespace: String)
    /// Create-or-update a service via `kubectl apply -f -`. `isNew` only affects
    /// the confirm-sheet copy; apply is idempotent either way.
    case applyService(Service, isNew: Bool)
    case deleteService(name: String, namespace: String)
    /// Create-or-update a configmap via `kubectl apply -f -`. `isNew` only
    /// affects the confirm-sheet copy; apply is idempotent either way.
    case applyConfigMap(ConfigMap, isNew: Bool)
    case deleteConfigMap(name: String, namespace: String)
    case deletePVC(name: String, namespace: String)
    /// PersistentVolume is cluster-scoped — no namespace.
    case deletePV(name: String)
    /// Generic workload ops keyed by kubectl resource kind ("statefulset",
    /// "daemonset", "job", "cronjob") — shared across the Workloads panel.
    case restartWorkload(kind: String, name: String, namespace: String)
    case scaleWorkload(kind: String, name: String, namespace: String, current: Int, to: Int)
    case deleteWorkload(kind: String, name: String, namespace: String)
    case setCronJobSuspend(name: String, namespace: String, suspend: Bool)
    /// Trigger a manual run of a CronJob. `jobName` is generated at the call site
    /// so the preview and the executed command match.
    case triggerCronJob(name: String, namespace: String, jobName: String)
    case createNamespace(name: String)
    case deleteNamespace(name: String)
    /// Delete an RBAC object. `namespace` is nil for cluster-scoped kinds
    /// (clusterrole/clusterrolebinding). kind = kubectl resource string.
    case deleteRBAC(kind: String, name: String, namespace: String?)
    /// Apply right-sized requests/limits to one container via `kubectl set
    /// resources`. `requests`/`limits` are kubectl quantity lists like
    /// "cpu=250m,memory=512Mi" (empty to leave that side untouched).
    case setResources(kind: String, name: String, namespace: String, container: String, requests: String, limits: String)
    /// Change one container's image via `kubectl set image` — the app-upgrade
    /// apply step. `kind` is a kubectl resource string ("deployment" |
    /// "statefulset"); reversible via `rollbackDeployment` (rollout undo).
    case setImage(kind: String, name: String, namespace: String, container: String, image: String)
    /// Apply an arbitrary manifest YAML (multi-document). Used by the catalog
    /// install wizard; the wizard's Review step is the user confirmation, so
    /// these flow through `WorkloadCommander.run` directly without the
    /// `WorkloadConfirmSheet`.
    case applyManifest(yaml: String, label: String)
    /// CNPG: create an on-demand backup via the kubectl-cnpg plugin.
    case cnpgBackupNow(cluster: String, namespace: String)
    /// CNPG: promote a standby to primary (controlled switchover) via the plugin.
    case cnpgSwitchover(cluster: String, namespace: String, to: String)
    /// CNPG: hibernate (`on`) shuts the cluster down; `off` resumes it. Plugin.
    case cnpgHibernate(cluster: String, namespace: String, on: Bool)
    /// CNPG: scale instances by patching `spec.instances` (pure kubectl).
    case scaleCNPG(cluster: String, namespace: String, current: Int, to: Int)

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
        case .applyIngress(let i, _): return "apply-ingress-\(i.metadata.namespace ?? "default")/\(i.metadata.name)"
        case .deleteIngress(let name, let ns): return "delete-ingress-\(ns)/\(name)"
        case .applyService(let s, _): return "apply-service-\(s.metadata.namespace ?? "default")/\(s.metadata.name)"
        case .deleteService(let name, let ns): return "delete-service-\(ns)/\(name)"
        case .applyConfigMap(let c, _): return "apply-configmap-\(c.metadata.namespace ?? "default")/\(c.metadata.name)"
        case .deleteConfigMap(let name, let ns): return "delete-configmap-\(ns)/\(name)"
        case .deletePVC(let name, let ns): return "delete-pvc-\(ns)/\(name)"
        case .deletePV(let name): return "delete-pv-\(name)"
        case .restartWorkload(let k, let n, let ns): return "restart-\(k)-\(ns)/\(n)"
        case .scaleWorkload(let k, let n, let ns, _, let to): return "scale-\(k)-\(ns)/\(n)-\(to)"
        case .deleteWorkload(let k, let n, let ns): return "delete-\(k)-\(ns)/\(n)"
        case .setCronJobSuspend(let n, let ns, let s): return "suspend-cronjob-\(ns)/\(n)-\(s)"
        case .triggerCronJob(let n, let ns, _): return "trigger-cronjob-\(ns)/\(n)"
        case .createNamespace(let n): return "create-namespace-\(n)"
        case .deleteNamespace(let n): return "delete-namespace-\(n)"
        case .deleteRBAC(let k, let n, let ns): return "delete-\(k)-\(ns ?? "_")/\(n)"
        case .setResources(let k, let n, let ns, let c, _, _): return "setresources-\(k)-\(ns)/\(n)-\(c)"
        case .setImage(let k, let n, let ns, let c, let img): return "setimage-\(k)-\(ns)/\(n)-\(c)-\(img)"
        case .applyManifest(_, let label): return "apply-manifest-\(label)"
        case .cnpgBackupNow(let c, let ns): return "cnpg-backup-\(ns)/\(c)"
        case .cnpgSwitchover(let c, let ns, let to): return "cnpg-switchover-\(ns)/\(c)-\(to)"
        case .cnpgHibernate(let c, let ns, let on): return "cnpg-hibernate-\(ns)/\(c)-\(on)"
        case .scaleCNPG(let c, let ns, _, let to): return "scale-cnpg-\(ns)/\(c)-\(to)"
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
        case .applyIngress(let i, let isNew):
            let ns = i.metadata.namespace ?? "default"
            return "\(isNew ? "Create" : "Apply") ingress \(ns)/\(i.metadata.name)"
        case .deleteIngress(let name, let ns): return "Delete ingress \(ns)/\(name)"
        case .applyService(let s, let isNew):
            let ns = s.metadata.namespace ?? "default"
            return "\(isNew ? "Create" : "Apply") service \(ns)/\(s.metadata.name)"
        case .deleteService(let name, let ns): return "Delete service \(ns)/\(name)"
        case .applyConfigMap(let c, let isNew):
            let ns = c.metadata.namespace ?? "default"
            return "\(isNew ? "Create" : "Apply") configmap \(ns)/\(c.metadata.name)"
        case .deleteConfigMap(let name, let ns): return "Delete configmap \(ns)/\(name)"
        case .deletePVC(let name, let ns): return "Delete PVC \(ns)/\(name)"
        case .deletePV(let name): return "Delete PV \(name)"
        case .restartWorkload(let k, let n, _): return "Restart \(k)/\(n)"
        case .scaleWorkload(let k, let n, _, _, let to): return "Scale \(k)/\(n) → \(to)"
        case .deleteWorkload(let k, let n, let ns): return "Delete \(k) \(ns)/\(n)"
        case .setCronJobSuspend(let n, _, let s): return "\(s ? "Suspend" : "Resume") cronjob \(n)"
        case .triggerCronJob(let n, _, _): return "Trigger cronjob \(n)"
        case .createNamespace(let n): return "Create namespace \(n)"
        case .deleteNamespace(let n): return "Delete namespace \(n)"
        case .deleteRBAC(let k, let n, let ns):
            return "Delete \(k) \(ns.map { "\($0)/" } ?? "")\(n)"
        case .setResources(let k, let n, _, let c, _, _):
            return "Right-size \(k)/\(n) (\(c))"
        case .setImage(let k, let n, _, _, let img):
            return "Upgrade \(k)/\(n) → \(img)"
        case .applyManifest(_, let label):
            return "Apply \(label) manifest"
        case .cnpgBackupNow(let c, _): return "Back up \(c) now"
        case .cnpgSwitchover(let c, _, let to): return "Switch over \(c) → \(to)"
        case .cnpgHibernate(let c, _, let on): return on ? "Hibernate \(c)" : "Resume \(c)"
        case .scaleCNPG(let c, _, _, let to): return "Scale \(c) → \(to)"
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
        case .applyIngress(let i, let isNew):
            let ns = i.metadata.namespace ?? "default"
            let routes = i.routes.count
            return "\(isNew ? "Creates" : "Updates") the ingress in namespace \(ns) with \(routes) route\(routes == 1 ? "" : "s") via `kubectl apply -f -`."
        case .deleteIngress(let name, let ns):
            return "Permanently removes ingress \(ns)/\(name). Traffic routed through it will stop until a replacement exists."
        case .applyService(let s, let isNew):
            let ns = s.metadata.namespace ?? "default"
            let n = s.spec?.ports?.count ?? 0
            return "\(isNew ? "Creates" : "Updates") the \(s.typeLabel) service in namespace \(ns) with \(n) port\(n == 1 ? "" : "s") via `kubectl apply -f -`."
        case .deleteService(let name, let ns):
            return "Permanently removes service \(ns)/\(name). Workloads and ingresses referencing it will lose connectivity until a replacement exists."
        case .applyConfigMap(let c, let isNew):
            let ns = c.metadata.namespace ?? "default"
            let n = c.data?.count ?? 0
            return "\(isNew ? "Creates" : "Updates") the configmap in namespace \(ns) with \(n) key\(n == 1 ? "" : "s") via `kubectl apply -f -`."
        case .deleteConfigMap(let name, let ns):
            return "Permanently removes configmap \(ns)/\(name). Workloads mounting it as env/volume will fail to start or roll out until a replacement exists."
        case .deletePVC(let name, let ns):
            return "Permanently removes PVC \(ns)/\(name). Depending on the StorageClass reclaim policy, the bound volume and its DATA may be deleted. Pods using this claim will fail to mount."
        case .deletePV(let name):
            return "Permanently removes PersistentVolume \(name). If a Delete reclaim policy applies, the underlying storage and its DATA are destroyed."
        case .restartWorkload(let k, let n, let ns):
            return "Triggers a rolling restart of \(k)/\(n) in namespace \(ns). Pods are recreated on the latest template."
        case .scaleWorkload(let k, let n, let ns, let current, let to):
            return "Sets replicas from \(current) → \(to) for \(k)/\(n) in namespace \(ns)."
        case .deleteWorkload(let k, let n, let ns):
            return "Permanently removes \(k) \(ns)/\(n) and the pods it manages."
        case .setCronJobSuspend(let n, let ns, let s):
            return s
                ? "Suspends cronjob \(ns)/\(n). No new jobs will be scheduled until resumed; running jobs continue."
                : "Resumes cronjob \(ns)/\(n). Scheduling restarts on the next matching time."
        case .triggerCronJob(let n, let ns, let jobName):
            return "Creates job \(ns)/\(jobName) from cronjob \(n) to run it once now, outside its schedule."
        case .createNamespace(let n):
            return "Creates namespace \(n)."
        case .deleteNamespace(let n):
            return "Permanently removes namespace \(n) AND every resource inside it — pods, deployments, services, secrets, PVCs, everything. This cascade is irreversible."
        case .deleteRBAC(let k, let n, let ns):
            return "Permanently removes \(k) \(ns.map { "\($0)/" } ?? "")\(n). Subjects relying on it will lose the access it granted — this can lock workloads or users out."
        case .setResources(_, _, let ns, let c, let requests, let limits):
            let parts = [requests.isEmpty ? nil : "requests \(requests)", limits.isEmpty ? nil : "limits \(limits)"].compactMap { $0 }
            return "Sets \(parts.joined(separator: " / ")) on container \(c) in namespace \(ns). Triggers a new rollout."
        case .setImage(let k, let n, let ns, let c, let img):
            return "Sets container \(c) on \(k)/\(n) in namespace \(ns) to \(img). Triggers a new rollout. Reversible with a rollback (rollout undo)."
        case .applyManifest(_, let label):
            return "Creates or updates the resources defined in the \(label) manifest via `kubectl apply -f -`."
        case .cnpgBackupNow(let c, let ns):
            return "Creates an on-demand backup of CNPG cluster \(ns)/\(c) via the kubectl-cnpg plugin. Non-destructive."
        case .cnpgSwitchover(let c, let ns, let to):
            return "Promotes standby \(to) to primary in CNPG cluster \(ns)/\(c). Causes a brief failover; in-flight connections drop."
        case .cnpgHibernate(let c, let ns, let on):
            return on
                ? "Hibernates CNPG cluster \(ns)/\(c): scales it to zero and shuts Postgres down. The database is OFFLINE until resumed."
                : "Resumes hibernated CNPG cluster \(ns)/\(c). Postgres starts back up."
        case .scaleCNPG(let c, let ns, let current, let to):
            return "Sets spec.instances from \(current) → \(to) on CNPG cluster \(ns)/\(c)."
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
             .applyIngress,
             .applyService,
             .applyConfigMap,
             .restartWorkload,
             .scaleWorkload,
             .setCronJobSuspend,
             .triggerCronJob,
             .createNamespace,
             .setResources,
             .applyManifest,
             .cnpgBackupNow:
            return false
        case .scaleCNPG(_, _, let current, let to):
            return to < current     // scaling down is high-risk
        case .cnpgHibernate(_, _, let on):
            return on               // hibernate (offline) is high-risk; resume is not
        default:
            return true
        }
    }

    /// True = require explicit "I understand" acknowledge checkbox.
    var needsAcknowledge: Bool {
        switch self {
        case .deletePod, .drainNode, .deleteSecret, .moveSecret, .deleteIngress, .deleteService, .deleteConfigMap, .deletePVC, .deletePV, .deleteWorkload, .deleteNamespace, .deleteRBAC: return true
        case .cnpgHibernate(_, _, let on):
            return on               // taking the DB offline needs acknowledgement
        case .scaleCNPG(_, _, let current, let to):
            return to < current     // scaling down drops replicas
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
        case .applyIngress(let i, _):
            return [.applyYAML(i.toYAML())]
        case .deleteIngress(let name, let ns):
            return [.args(["delete", "ingress", name, "-n", ns])]
        case .applyService(let s, _):
            return [.applyYAML(s.toYAML())]
        case .deleteService(let name, let ns):
            return [.args(["delete", "service", name, "-n", ns])]
        case .applyConfigMap(let c, _):
            return [.applyYAML(c.toYAML())]
        case .deleteConfigMap(let name, let ns):
            return [.args(["delete", "configmap", name, "-n", ns])]
        case .deletePVC(let name, let ns):
            return [.args(["delete", "pvc", name, "-n", ns])]
        case .deletePV(let name):
            return [.args(["delete", "pv", name])]
        case .restartWorkload(let k, let n, let ns):
            return [.args(["rollout", "restart", "\(k)/\(n)", "-n", ns])]
        case .scaleWorkload(let k, let n, let ns, _, let to):
            return [.args(["scale", "\(k)/\(n)", "--replicas=\(to)", "-n", ns])]
        case .deleteWorkload(let k, let n, let ns):
            return [.args(["delete", k, n, "-n", ns])]
        case .setCronJobSuspend(let n, let ns, let suspend):
            return [.args(["patch", "cronjob", n, "-n", ns, "--type=merge", "-p", "{\"spec\":{\"suspend\":\(suspend)}}"])]
        case .triggerCronJob(let n, let ns, let jobName):
            return [.args(["create", "job", jobName, "--from=cronjob/\(n)", "-n", ns])]
        case .createNamespace(let n):
            return [.args(["create", "namespace", n])]
        case .deleteNamespace(let n):
            return [.args(["delete", "namespace", n])]
        case .deleteRBAC(let k, let n, let ns):
            return [.args(["delete", k, n] + (ns.map { ["-n", $0] } ?? []))]
        case .setResources(let k, let n, let ns, let c, let requests, let limits):
            var args = ["set", "resources", "\(k)/\(n)", "-c", c]
            if !requests.isEmpty { args.append("--requests=\(requests)") }
            if !limits.isEmpty { args.append("--limits=\(limits)") }
            args.append(contentsOf: ["-n", ns])
            return [.args(args)]
        case .setImage(let k, let n, let ns, let c, let img):
            return [.args(["set", "image", "\(k)/\(n)", "\(c)=\(img)", "-n", ns])]
        case .applyManifest(let yaml, _):
            return [.applyYAML(yaml)]
        case .cnpgBackupNow(let c, let ns):
            return [.args(["cnpg", "backup", c, "-n", ns])]
        case .cnpgSwitchover(let c, let ns, let to):
            return [.args(["cnpg", "promote", c, to, "-n", ns])]
        case .cnpgHibernate(let c, let ns, let on):
            return [.args(["cnpg", "hibernate", on ? "on" : "off", c, "-n", ns])]
        case .scaleCNPG(let c, let ns, _, let to):
            return [.args(["patch", "cluster", c, "-n", ns, "--type=merge", "-p", "{\"spec\":{\"instances\":\(to)}}"])]
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
