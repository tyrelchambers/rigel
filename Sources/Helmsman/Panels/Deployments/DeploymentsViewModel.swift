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
        var base: [Deployment]
        if let ns = cache.namespaceFilter {
            base = cache.deployments.filter { $0.metadata.namespace == ns }
        } else {
            base = cache.deployments
        }
        if !search.isEmpty {
            let q = search.lowercased()
            base = base.filter { d in
                if d.metadata.name.lowercased().contains(q) { return true }
                if (d.metadata.namespace ?? "").lowercased().contains(q) { return true }
                if let img = d.spec?.template?.spec?.containers.first?.image,
                   img.lowercased().contains(q) { return true }
                return false
            }
        }
        return base.sorted { $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending }
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
