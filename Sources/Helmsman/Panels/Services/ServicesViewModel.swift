import Foundation
import Observation

@Observable
final class ServicesViewModel {
    let cache: ClusterCache
    let portForwards = PortForwardManager()

    init(cache: ClusterCache) { self.cache = cache }

    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var filteredServices: [Service] {
        cache.services
            .filter { cache.namespaceFilter == nil || $0.metadata.namespace == cache.namespaceFilter }
            .filter { svc in
                if search.isEmpty { return true }
                let hay = ([svc.metadata.name, svc.metadata.namespace, svc.typeLabel, svc.spec?.clusterIP]
                    + svc.portSummaries
                    + (svc.spec?.selector?.map { "\($0.key)=\($0.value)" } ?? []))
                    .compactMap { $0 }.joined(separator: " ")
                return hay.localizedCaseInsensitiveContains(search)
            }
            .sorted { lhs, rhs in
                let lns = lhs.metadata.namespace ?? ""
                let rns = rhs.metadata.namespace ?? ""
                if lns != rns { return lns < rns }
                return lhs.metadata.name.localizedStandardCompare(rhs.metadata.name) == .orderedAscending
            }
    }

    /// Number of pods backing this service (its selector → ready pods), used as a
    /// cheap endpoint-health readout. Returns nil for selector-less services
    /// (headless / ExternalName) where the concept doesn't apply.
    func endpointCount(for service: Service) -> Int? {
        guard let selector = service.spec?.selector, !selector.isEmpty else { return nil }
        return cache.pods(matchingLabels: selector, in: service.metadata.namespace).count
    }

    func stopAllForwards() {
        portForwards.stopAll()
    }
}
