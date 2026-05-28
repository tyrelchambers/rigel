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

    func toggleExpansion(_ instance: DatabaseInstance) {
        if expanded.contains(instance.id) { expanded.remove(instance.id) }
        else { expanded.insert(instance.id) }
    }

    func isExpanded(_ instance: DatabaseInstance) -> Bool {
        expanded.contains(instance.id)
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
