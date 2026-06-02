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
        cache.filtered(cache.services, search: search, groupByNamespace: true) { svc, q in
            let extras = [svc.typeLabel, svc.spec?.clusterIP].compactMap { $0 }
                + svc.portSummaries
                + (svc.spec?.selector?.map { "\($0.key)=\($0.value)" } ?? [])
            return extras.contains { $0.localizedCaseInsensitiveContains(q) }
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
