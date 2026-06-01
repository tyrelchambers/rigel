import Foundation
import Observation

@Observable
final class DatabasesViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var expanded: Set<String> = []

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }
    var cnpgAvailable: Bool { cache.cnpgAvailable }

    var instances: [DatabaseInstance] {
        var result: [DatabaseInstance] = []
        result.append(contentsOf: cnpgInstances())
        result.append(contentsOf: imageDetectedFromDeployments())
        result.append(contentsOf: imageDetectedFromStatefulSets())
        return result.sorted {
            "\($0.namespace)/\($0.name)".localizedStandardCompare("\($1.namespace)/\($1.name)") == .orderedAscending
        }
    }

    func pods(for instance: DatabaseInstance) -> [Pod] {
        cache.pods(matchingLabels: instance.labelSelector, in: instance.namespace)
            .sorted { $0.metadata.name < $1.metadata.name }
    }

    /// Distinct node names hosting this database's pods, sorted for stable display.
    func nodes(for instance: DatabaseInstance) -> [String] {
        let names = pods(for: instance).compactMap { $0.spec?.nodeName }
        return Set(names).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    func toggleExpansion(_ instance: DatabaseInstance) {
        if expanded.contains(instance.id) { expanded.remove(instance.id) }
        else { expanded.insert(instance.id) }
    }

    func isExpanded(_ instance: DatabaseInstance) -> Bool {
        expanded.contains(instance.id)
    }

    // MARK: - Capabilities & DSN

    private let registry = DatabaseOperatorRegistry()

    /// Live snapshot for operator capability computation.
    private var databaseContext: DatabaseContext {
        DatabaseContext(
            cnpgPluginAvailable: cache.cnpgPluginAvailable,
            scheduledBackups: cache.scheduledBackups,
            cnpgClusters: cache.cnpgClusters,
            secrets: cache.secrets,
            pods: cache.pods
        )
    }

    func capabilities(for instance: DatabaseInstance) -> DatabaseCapabilities {
        var caps = registry.capabilities(for: instance, context: databaseContext)
        // Fill the CNPG username from the -app secret if present.
        if var conn = caps.connection, conn.username == nil, let secretName = conn.secretName,
           let user = username(fromSecret: secretName, namespace: conn.namespace) {
            conn = ConnectionInfo(targetKind: conn.targetKind, targetName: conn.targetName,
                                  namespace: conn.namespace, port: conn.port, scheme: conn.scheme,
                                  secretName: conn.secretName, username: user, dbName: conn.dbName)
            caps.connection = conn
        }
        return caps
    }

    /// Decodes the `username` key from a secret in the cache, if present.
    private func username(fromSecret name: String, namespace: String) -> String? {
        guard let secret = cache.secrets.first(where: {
            $0.metadata.name == name && ($0.metadata.namespace ?? "default") == namespace
        }), let b64 = secret.data?["username"], let data = Data(base64Encoded: b64) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Builds a connection string. `user`/`db` are omitted when nil.
    static func dsn(for c: ConnectionInfo) -> String {
        let hostSuffix = c.targetKind == "svc" ? ".\(c.namespace).svc" : ".\(c.namespace)"
        var s = "\(c.scheme)://"
        if let u = c.username { s += "\(u)@" }
        s += "\(c.targetName)\(hostSuffix):\(c.port)"
        if let db = c.dbName { s += "/\(db)" }
        return s
    }

    // MARK: - Builders

    private func cnpgInstances() -> [DatabaseInstance] {
        cache.cnpgClusters.map { c in
            let ready = c.status?.readyInstances ?? 0
            let desired = c.spec?.instances ?? c.status?.instances ?? 0
            let phase = c.status?.phase ?? "Unknown"
            let healthy = (ready == desired) && desired > 0
            return DatabaseInstance(
                id: c.metadata.uid,
                kind: .postgres,
                source: .cnpg,
                name: c.metadata.name,
                namespace: c.metadata.namespace ?? "default",
                image: c.spec?.imageName,
                desiredReplicas: desired,
                readyReplicas: ready,
                phaseText: phase,
                isHealthy: healthy,
                cnpgPrimary: c.status?.currentPrimary,
                labelSelector: ["cnpg.io/cluster": c.metadata.name]
            )
        }
    }

    private func imageDetectedFromDeployments() -> [DatabaseInstance] {
        cache.deployments.compactMap { d -> DatabaseInstance? in
            if (d.metadata.labels?["cnpg.io/cluster"]) != nil { return nil }
            let containers = d.spec?.template?.spec?.containers ?? []
            for ct in containers {
                guard let image = ct.image, let kind = DatabaseDetector.detect(image: image) else { continue }
                let ready = d.status?.readyReplicas ?? 0
                let desired = d.spec?.replicas ?? d.status?.replicas ?? 0
                return DatabaseInstance(
                    id: d.metadata.uid, kind: kind, source: .deployment,
                    name: d.metadata.name, namespace: d.metadata.namespace ?? "default",
                    image: image,
                    desiredReplicas: desired, readyReplicas: ready,
                    phaseText: ready == desired && desired > 0 ? "Healthy" : "Degraded",
                    isHealthy: ready == desired && desired > 0,
                    cnpgPrimary: nil,
                    labelSelector: d.spec?.selector?.matchLabels ?? [:]
                )
            }
            return nil
        }
    }

    private func imageDetectedFromStatefulSets() -> [DatabaseInstance] {
        cache.statefulSets.compactMap { s -> DatabaseInstance? in
            if (s.metadata.labels?["cnpg.io/cluster"]) != nil { return nil }
            let containers = s.spec?.template?.spec?.containers ?? []
            for ct in containers {
                guard let image = ct.image, let kind = DatabaseDetector.detect(image: image) else { continue }
                let ready = s.status?.readyReplicas ?? 0
                let desired = s.spec?.replicas ?? s.status?.replicas ?? 0
                return DatabaseInstance(
                    id: s.metadata.uid, kind: kind, source: .statefulset,
                    name: s.metadata.name, namespace: s.metadata.namespace ?? "default",
                    image: image,
                    desiredReplicas: desired, readyReplicas: ready,
                    phaseText: ready == desired && desired > 0 ? "Healthy" : "Degraded",
                    isHealthy: ready == desired && desired > 0,
                    cnpgPrimary: nil,
                    labelSelector: s.spec?.selector?.matchLabels ?? [:]
                )
            }
            return nil
        }
    }
}
