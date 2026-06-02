import Foundation
import Observation

@Observable
final class DeploymentsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""
    var expanded: Set<String> = []

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredDeployments: [Deployment] {
        cache.filtered(cache.deployments, search: search) { d, q in
            (d.spec?.template?.spec?.containers.first?.image ?? "").localizedCaseInsensitiveContains(q)
        }
    }

    func pods(for deployment: Deployment) -> [Pod] {
        let labels = deployment.spec?.selector?.matchLabels ?? [:]
        return cache.pods(matchingLabels: labels, in: deployment.metadata.namespace)
            .sorted { $0.metadata.name < $1.metadata.name }
    }

    func toggleExpansion(_ deployment: Deployment) {
        if expanded.contains(deployment.id) { expanded.remove(deployment.id) }
        else { expanded.insert(deployment.id) }
    }

    func isExpanded(_ deployment: Deployment) -> Bool {
        expanded.contains(deployment.id)
    }
}
