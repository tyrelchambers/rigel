import Foundation
import Observation

/// Single source of truth for cluster resource state.
///
/// One watch per resource type — ViewModels read from this rather than spawning
/// their own duplicate streams. Restarted when the active context changes.
@Observable
final class ClusterCache {
    private(set) var pods: [Pod] = []
    private(set) var deployments: [Deployment] = []
    private(set) var statefulSets: [StatefulSet] = []
    private(set) var nodes: [Node] = []
    private(set) var cnpgClusters: [CNPGCluster] = []
    private(set) var scheduledBackups: [CNPGScheduledBackup] = []
    private(set) var events: [K8sEvent] = []
    private(set) var secrets: [Secret] = []
    private(set) var ingresses: [Ingress] = []
    private(set) var services: [Service] = []
    private(set) var configMaps: [ConfigMap] = []
    private(set) var pvcs: [PersistentVolumeClaim] = []
    private(set) var pvs: [PersistentVolume] = []
    private(set) var storageClasses: [StorageClass] = []
    private(set) var jobs: [Job] = []
    private(set) var cronJobs: [CronJob] = []
    private(set) var daemonSets: [DaemonSet] = []
    private(set) var namespaces: [Namespace] = []
    private(set) var serviceAccounts: [ServiceAccount] = []
    private(set) var roles: [Role] = []
    private(set) var roleBindings: [RoleBinding] = []
    private(set) var clusterRoles: [ClusterRole] = []
    private(set) var clusterRoleBindings: [ClusterRoleBinding] = []
    private(set) var nodeMetrics: [String: NodeMetrics] = [:]
    /// Real per-node disk usage from the kubelet Summary API, keyed by node name.
    /// Empty when the Summary API is unreachable (RBAC / proxy disabled).
    private(set) var nodeDisk: [String: NodeDiskUsage] = [:]
    /// Per-pod metrics history. Key = "namespace/name". Newest sample at the end.
    private(set) var podMetricsHistory: [String: [PodMetricSample]] = [:]

    static let podHistoryDepth = 60

    /// Monotonic counter bumped on every resource-watch change (list sync or
    /// event). A cheap O(1) memoization key for derived views so they recompute
    /// only when the underlying resources actually change — crucially NOT on the
    /// 5s metrics poll, which bumps `metricsRevision` instead.
    private(set) var dataRevision = 0
    /// Monotonic counter bumped on every metrics poll (node + pod metrics).
    private(set) var metricsRevision = 0

    var cnpgAvailable = true
    private(set) var cnpgPluginAvailable = false
    var metricsAvailable = true
    var error: String? = nil
    var isLoading = false

    /// Shared namespace filter applied across all namespace-scoped panels
    /// (nil = all namespaces). Loaded from SessionStore when a context starts;
    /// persisted per-context on change.
    var namespaceFilter: String? {
        didSet {
            guard let ctx = activeContext else { return }
            MainActor.assumeIsolated {
                SessionStore.shared.setNamespace(namespaceFilter, for: ctx)
            }
        }
    }

    /// Per-node pod count, kept in sync with the pod watch.
    private(set) var podCountByNode: [String: Int] = [:]
    private var podNodeAssignment: [String: String] = [:]   // uid → nodeName

    private var tasks: [Task<Void, Never>] = []
    private var client: KubectlClient?
    private var activeContext: String?

    /// Rolling on-disk usage history for right-sizing (one DB per context).
    private(set) var metricsStore: MetricsStore?
    private let metricsCollector = MetricsCollector()

    // MARK: - Lifecycle

    @MainActor func start(context: String?) {
        if !tasks.isEmpty && context == activeContext { return }   // already running for this context
        stop()
        activeContext = context
        // Recall this context's last-selected namespace. Re-persists the same
        // value via didSet — harmless (idempotent).
        if let context {
            namespaceFilter = SessionStore.shared.namespace(for: context)
        } else {
            namespaceFilter = nil
        }
        // Open the per-context usage history store (right-sizing). Best-effort:
        // a failure just means no persisted history this session.
        metricsStore = try? MetricsStore(context: context ?? "default")
        do {
            let c = try KubectlClient(context: context)
            self.client = c
            self.isLoading = true
            self.error = nil
            tasks = [
                podsTask(c),
                genericWatch("deployments", c: c, into: \.deployments),
                genericWatch("statefulsets", c: c, into: \.statefulSets),
                genericWatch("nodes", c: c, into: \.nodes),
                watchTask("events", c: c, into: \.events, applyEvent: applyEvent),
                genericWatch("secrets", c: c, into: \.secrets),
                genericWatch("ingresses", c: c, into: \.ingresses),
                genericWatch("services", c: c, into: \.services),
                watchTask("configmaps", c: c, into: \.configMaps, applyEvent: applyConfigMap),
                genericWatch("persistentvolumeclaims", c: c, into: \.pvcs),
                genericWatch("persistentvolumes", c: c, into: \.pvs),
                genericWatch("storageclasses", c: c, into: \.storageClasses),
                genericWatch("jobs", c: c, into: \.jobs),
                genericWatch("cronjobs", c: c, into: \.cronJobs),
                genericWatch("daemonsets", c: c, into: \.daemonSets),
                genericWatch("namespaces", c: c, into: \.namespaces),
                genericWatch("serviceaccounts", c: c, into: \.serviceAccounts),
                genericWatch("roles", c: c, into: \.roles),
                genericWatch("rolebindings", c: c, into: \.roleBindings),
                genericWatch("clusterroles", c: c, into: \.clusterRoles),
                genericWatch("clusterrolebindings", c: c, into: \.clusterRoleBindings),
                cnpgTask(c),
                Task { [weak self] in
                    let available = await CNPGPluginProbe().isAvailable()
                    await MainActor.run { self?.cnpgPluginAvailable = available }
                },
                scheduledBackupTask(c),
                metricsPollTask(c),
                podMetricsPollTask(c),
                nodeDiskPollTask(c),
            ]
        } catch {
            self.error = "\(error)"
        }
    }

    func stop() {
        for t in tasks { t.cancel() }
        tasks.removeAll()
    }

    // MARK: - Lookups

    func pods(matchingLabels labels: [String: String], in namespace: String?) -> [Pod] {
        guard !labels.isEmpty else { return [] }
        return pods
            .filter { $0.metadata.namespace == namespace }
            .filter { pod in
                let pl = pod.metadata.labels ?? [:]
                return labels.allSatisfy { pl[$0.key] == $0.value }
            }
    }

    // MARK: - Watch helper (generic)

    /// Filter out errors caused by our own cancellation (SIGTERM → exit 15).
    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case ProcessError.nonZeroExit(let code, _) = error, code == 15 { return true }
        return false
    }

    /// List, then watch — and keep doing so. When a watch stream drops (network
    /// blip, API server closing a long-lived connection, sleep/wake) we re-list to
    /// resync (dropping anything deleted while we were disconnected) and re-watch.
    /// Backoff doubles on repeated failure up to a cap and resets once a watch
    /// stays connected for a while.
    ///
    /// `onError` is consulted on a list failure; returning false stops the loop
    /// (CNPG uses this to give up when the CRD isn't installed). `hasConnected`
    /// reports whether any earlier list succeeded, so a transient blip on an
    /// already-working watch keeps retrying.
    private func reconnectingWatch<T: Codable & Sendable>(
        _ resource: String,
        c: KubectlClient,
        onSync: @escaping ([T]) -> Void,
        onEvent: @escaping (WatchEvent<T>) -> Void,
        onError: @escaping (Error, _ hasConnected: Bool) -> Bool = { _, _ in true }
    ) -> Task<Void, Never> {
        Task { [weak self] in
            var backoff: UInt64 = 1_000_000_000          // 1s, doubling to a 30s cap
            let maxBackoff: UInt64 = 30_000_000_000
            var hasConnected = false
            while !Task.isCancelled {
                do {
                    let list = try await c.getList(resource, type: T.self)
                    hasConnected = true
                    await MainActor.run { [weak self] in onSync(list.items); self?.dataRevision &+= 1 }
                } catch {
                    if Task.isCancelled || Self.isCancellation(error) { return }
                    let connected = hasConnected
                    let keepGoing = await MainActor.run { onError(error, connected) }
                    if !keepGoing { return }
                    try? await Task.sleep(nanoseconds: backoff)
                    backoff = min(backoff * 2, maxBackoff)
                    continue
                }

                let startedAt = DispatchTime.now().uptimeNanoseconds
                let stream = c.watch(resource, type: T.self)
                do {
                    for try await event in stream {
                        if Task.isCancelled { break }
                        await MainActor.run { [weak self] in onEvent(event); self?.dataRevision &+= 1 }
                    }
                } catch {
                    if Self.isCancellation(error) { return }
                }
                if Task.isCancelled { return }

                // A watch that ran a while was healthy → reconnect promptly.
                // One that drops immediately is flapping → back off.
                let lasted = DispatchTime.now().uptimeNanoseconds - startedAt
                backoff = lasted > 10_000_000_000 ? 1_000_000_000 : min(backoff * 2, maxBackoff)
                try? await Task.sleep(nanoseconds: backoff)
            }
        }
    }

    private func watchTask<T: Codable & Sendable>(
        _ resource: String,
        c: KubectlClient,
        into keyPath: ReferenceWritableKeyPath<ClusterCache, [T]>,
        applyEvent: @escaping (WatchEvent<T>) -> Void
    ) -> Task<Void, Never> {
        reconnectingWatch(
            resource, c: c,
            onSync: { [weak self] items in self?[keyPath: keyPath] = items },
            onEvent: applyEvent
        )
    }

    /// Watch a resource whose only behavior is generic add/modify/delete: list
    /// into `keyPath`, then apply each event via `applyGeneric`. Collapses the
    /// per-type `watchTask(..., applyEvent: applyX)` line plus its boilerplate
    /// `applyX` wrapper into one declarative call. Resources with bespoke handling
    /// (pods, events, configmaps, cnpg) keep their dedicated tasks.
    private func genericWatch<T: Codable & Sendable & Identifiable>(
        _ resource: String,
        c: KubectlClient,
        into keyPath: ReferenceWritableKeyPath<ClusterCache, [T]>
    ) -> Task<Void, Never> where T.ID == String {
        reconnectingWatch(
            resource, c: c,
            onSync: { [weak self] items in self?[keyPath: keyPath] = items },
            onEvent: { [weak self] event in self?.applyGeneric(event, list: keyPath) }
        )
    }

    private func podsTask(_ c: KubectlClient) -> Task<Void, Never> {
        reconnectingWatch(
            "pods", c: c,
            onSync: { [weak self] items in
                self?.pods = items
                self?.recomputePodCounts()
                self?.isLoading = false
                self?.error = nil
            },
            onEvent: { [weak self] event in self?.applyPod(event) },
            onError: { [weak self] error, _ in
                self?.error = "\(error)"
                self?.isLoading = false
                return true
            }
        )
    }

    private func cnpgTask(_ c: KubectlClient) -> Task<Void, Never> {
        reconnectingWatch(
            "clusters.postgresql.cnpg.io", c: c,
            onSync: { [weak self] items in
                self?.cnpgClusters = items
                self?.cnpgAvailable = true
            },
            onEvent: { [weak self] event in self?.applyCNPG(event) },
            onError: { [weak self] _, hasConnected in
                // First-ever list failed → CRD isn't installed, give up. A blip on
                // an already-working watch keeps retrying.
                if !hasConnected { self?.cnpgAvailable = false }
                return hasConnected
            }
        )
    }

    private func scheduledBackupTask(_ c: KubectlClient) -> Task<Void, Never> {
        reconnectingWatch(
            "scheduledbackups.postgresql.cnpg.io", c: c,
            onSync: { [weak self] items in self?.scheduledBackups = items },
            onEvent: { [weak self] event in self?.applyScheduledBackup(event) },
            onError: { _, hasConnected in hasConnected }
        )
    }

    private func podMetricsPollTask(_ c: KubectlClient) -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let list: PodMetricsList? = try await c.getRaw("/apis/metrics.k8s.io/v1beta1/pods")
                    await MainActor.run { [weak self] in
                        guard let self, let list else { return }
                        self.applyPodMetrics(list.items)
                    }
                } catch {
                    // metrics-server unavailable for pods — fine, just no sparklines
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func applyPodMetrics(_ items: [PodMetrics]) {
        var keepKeys = Set<String>()
        for m in items {
            keepKeys.insert(m.key)
            let sample = PodMetricSample(cpuCores: m.totalCPUCores, memBytes: m.totalMemBytes)
            var history = podMetricsHistory[m.key] ?? []
            history.append(sample)
            if history.count > Self.podHistoryDepth {
                history.removeFirst(history.count - Self.podHistoryDepth)
            }
            podMetricsHistory[m.key] = history
        }
        // Drop history for pods that no longer report metrics (deleted pods)
        for k in podMetricsHistory.keys where !keepKeys.contains(k) {
            // give them one grace cycle before removing
            if let h = podMetricsHistory[k], h.count <= Self.podHistoryDepth {
                // mark by removing only if it goes a couple cycles without updates — simplest: just remove
                podMetricsHistory.removeValue(forKey: k)
            }
        }
        metricsRevision &+= 1

        // Feed the right-sizing collector; persist completed hours off-main.
        let completed = metricsCollector.ingest(items) { [weak self] item in
            self?.ownerWorkload(podNamed: item.metadata.name, namespace: item.metadata.namespace ?? "default")
        }
        if !completed.isEmpty, let store = metricsStore {
            Task { try? await store.writeBuckets(completed) }
        }
    }

    /// Run a Prometheus-compatible instant query through the API-server proxy
    /// (path built by `PrometheusMetricsSource`). Returns nil if no client or the
    /// proxy/query fails — callers degrade to the local store.
    func promInstantQuery(path: String) async -> PromQueryResponse? {
        guard let client else { return nil }
        return try? await client.getRaw(path, type: PromQueryResponse.self)
    }

    /// Run a Prometheus-compatible range query (`/api/v1/query_range`) through
    /// the API-server proxy. Returns nil if no client or the query fails.
    func promRangeQuery(path: String) async -> PromRangeResponse? {
        guard let client else { return nil }
        return try? await client.getRaw(path, type: PromRangeResponse.self)
    }

    /// Resolve a pod to its owning long-lived workload by label-matching against
    /// Deployment / StatefulSet / DaemonSet selectors. Returns nil for pods with
    /// no such owner (bare pods, jobs). Deployment selectors match through the
    /// ReplicaSet because the controller's matchLabels are present on the pod.
    private func ownerWorkload(podNamed name: String, namespace: String) -> MetricsCollector.OwnerRef? {
        guard let pod = pods.first(where: { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == namespace }) else {
            return nil
        }
        let labels = pod.metadata.labels ?? [:]
        func matches(_ selector: [String: String]?) -> Bool {
            guard let selector, !selector.isEmpty else { return false }
            return selector.allSatisfy { labels[$0.key] == $0.value }
        }
        if let d = deployments.first(where: { ($0.metadata.namespace ?? "default") == namespace && matches($0.spec?.selector?.matchLabels) }) {
            return .init(kind: "deployment", name: d.metadata.name)
        }
        if let s = statefulSets.first(where: { ($0.metadata.namespace ?? "default") == namespace && matches($0.spec?.selector?.matchLabels) }) {
            return .init(kind: "statefulset", name: s.metadata.name)
        }
        if let ds = daemonSets.first(where: { ($0.metadata.namespace ?? "default") == namespace && matches($0.spec?.selector?.matchLabels) }) {
            return .init(kind: "daemonset", name: ds.metadata.name)
        }
        return nil
    }

    private func metricsPollTask(_ c: KubectlClient) -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let list: NodeMetricsList? = try await c.getRaw("/apis/metrics.k8s.io/v1beta1/nodes")
                    await MainActor.run { [weak self] in
                        guard let self else { return }
                        if let list {
                            self.metricsAvailable = true
                            var map: [String: NodeMetrics] = [:]
                            for m in list.items { map[m.metadata.name] = m }
                            self.nodeMetrics = map
                            self.metricsRevision &+= 1
                        } else {
                            self.metricsAvailable = false
                        }
                    }
                } catch {
                    await MainActor.run { [weak self] in self?.metricsAvailable = false }
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    /// Poll each node's kubelet Summary API for real filesystem usage. One
    /// request per node per cycle (homelab-scale). Best-effort: nodes whose
    /// summary is unreachable are simply omitted; a wholly-empty result leaves
    /// the last good map in place rather than blanking the UI.
    private func nodeDiskPollTask(_ c: KubectlClient) -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                let names = await MainActor.run { [weak self] in self?.nodes.map { $0.metadata.name } ?? [] }
                var collected: [String: NodeDiskUsage] = [:]
                for name in names {
                    let summary: NodeStatsSummary? = try? await c.getRaw("/api/v1/nodes/\(name)/proxy/stats/summary")
                    if let disk = summary?.diskUsage { collected[name] = disk }
                }
                let result = collected
                await MainActor.run { [weak self] in
                    guard let self, !result.isEmpty else { return }
                    self.nodeDisk = result
                    self.metricsRevision &+= 1
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    // MARK: - Event appliers

    private func applyPod(_ event: WatchEvent<Pod>) {
        let uid = event.object.metadata.uid
        switch event.type {
        case .added, .modified:
            if let i = pods.firstIndex(where: { $0.metadata.uid == uid }) {
                pods[i] = event.object
            } else {
                pods.append(event.object)
            }
            if let node = event.object.spec?.nodeName {
                let prev = podNodeAssignment[uid]
                if prev != node {
                    if let prev { podCountByNode[prev, default: 0] -= 1 }
                    podCountByNode[node, default: 0] += 1
                    podNodeAssignment[uid] = node
                }
            }
            ClusterNotifier.shared.notifyIfUnhealthy(pod: event.object)
        case .deleted:
            pods.removeAll { $0.metadata.uid == uid }
            if let prev = podNodeAssignment[uid] {
                podCountByNode[prev, default: 0] -= 1
                podNodeAssignment.removeValue(forKey: uid)
            }
            ClusterNotifier.shared.forgetPod(uid: uid)
        case .error, .bookmark:
            break
        }
    }

    private func recomputePodCounts() {
        var counts: [String: Int] = [:]
        var assign: [String: String] = [:]
        for p in pods {
            guard let node = p.spec?.nodeName else { continue }
            counts[node, default: 0] += 1
            assign[p.metadata.uid] = node
        }
        podCountByNode = counts
        podNodeAssignment = assign
    }

    private static let maxEvents = 500

    private func applyEvent(_ event: WatchEvent<K8sEvent>) {
        switch event.type {
        case .added, .modified:
            if let i = events.firstIndex(where: { $0.metadata.uid == event.object.metadata.uid }) {
                events[i] = event.object
            } else {
                events.append(event.object)
            }
            // Keep newest first, bounded.
            events.sort { ($0.when ?? .distantPast) > ($1.when ?? .distantPast) }
            if events.count > Self.maxEvents { events.removeLast(events.count - Self.maxEvents) }

            // Surface warning events as desktop notifications (deduped by uid).
            if event.type == .added, event.object.isWarning {
                ClusterNotifier.shared.notify(warning: event.object)
            }
        case .deleted:
            events.removeAll { $0.metadata.uid == event.object.metadata.uid }
        case .error, .bookmark:
            break
        }
    }

    private func applyCNPG(_ event: WatchEvent<CNPGCluster>) {
        applyGeneric(event, list: \.cnpgClusters)
    }
    private func applyScheduledBackup(_ event: WatchEvent<CNPGScheduledBackup>) {
        applyGeneric(event, list: \.scheduledBackups)
    }
    private func applyConfigMap(_ event: WatchEvent<ConfigMap>) {
        applyGeneric(event, list: \.configMaps)
        if event.type == .added || event.type == .modified {
            notifyAssistantIfNeeded(event.object)
        }
    }

    // Desktop notifications for the in-cluster Assistant: diff the agent's audit
    // log (in the assistant-state ConfigMap) and notify on new actions/approvals.
    private var lastSeenAssistantAudit: Set<String> = []
    private var assistantAuditPrimed = false

    private func notifyAssistantIfNeeded(_ cm: ConfigMap) {
        guard cm.metadata.name == "assistant-state",
              let raw = cm.data?["state.json"], let data = raw.data(using: .utf8),
              let state = try? JSONDecoder().decode(AssistantClusterState.self, from: data) else { return }
        // Prime on the first sighting so we don't notify for pre-existing history.
        if !assistantAuditPrimed {
            lastSeenAssistantAudit = Set(state.audit.map(\.id))
            assistantAuditPrimed = true
            return
        }
        for e in state.audit where !lastSeenAssistantAudit.contains(e.id) {
            lastSeenAssistantAudit.insert(e.id)
            let verb: String
            switch e.outcome {
            case "success": verb = "✓ fixed"
            case "failure": verb = "✗ action failed"
            case "queued": verb = "needs approval"
            default: continue
            }
            ClusterNotifier.shared.notify(
                title: "Assistant — \(verb)",
                body: e.proposal ?? e.incident,
                id: "assistant-\(e.fingerprint)-\(e.at)"
            )
        }
    }

    private func applyGeneric<T>(_ event: WatchEvent<T>, list keyPath: ReferenceWritableKeyPath<ClusterCache, [T]>) where T: Codable & Identifiable, T.ID == String {
        switch event.type {
        case .added, .modified:
            if let i = self[keyPath: keyPath].firstIndex(where: { $0.id == event.object.id }) {
                self[keyPath: keyPath][i] = event.object
            } else {
                self[keyPath: keyPath].append(event.object)
            }
        case .deleted:
            self[keyPath: keyPath].removeAll { $0.id == event.object.id }
        case .error, .bookmark:
            break
        }
    }
}
