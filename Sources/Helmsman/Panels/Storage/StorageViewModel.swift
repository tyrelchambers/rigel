import Foundation
import Observation

enum StorageKind: String, CaseIterable, Identifiable {
    case pvcs
    case pvs
    case storageClasses
    var id: String { rawValue }

    var title: String {
        switch self {
        case .pvcs:           return "Claims"
        case .pvs:            return "Volumes"
        case .storageClasses: return "Classes"
        }
    }
}

@Observable
final class StorageViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var kind: StorageKind = .pvcs
    var namespaceFilter: String? = nil   // applies to PVCs only (PVs/SCs are cluster-scoped)
    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    /// Namespaces present among PVCs — drives the filter bar (PVCs only).
    var availableNamespaces: [String] {
        Set(cache.pvcs.compactMap { $0.metadata.namespace }).sorted()
    }

    /// Count for the currently-selected kind (after filtering), for the header.
    var count: Int {
        switch kind {
        case .pvcs:           return filteredPVCs.count
        case .pvs:            return filteredPVs.count
        case .storageClasses: return filteredStorageClasses.count
        }
    }

    var filteredPVCs: [PersistentVolumeClaim] {
        cache.pvcs
            .filter { namespaceFilter == nil || $0.metadata.namespace == namespaceFilter }
            .filter { matches([$0.metadata.name, $0.metadata.namespace, $0.spec?.storageClassName, $0.spec?.volumeName, $0.phase]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredPVs: [PersistentVolume] {
        cache.pvs
            .filter { matches([$0.metadata.name, $0.spec?.storageClassName, $0.claim, $0.phase, $0.reclaimPolicy]) }
            .sorted { $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending }
    }

    var filteredStorageClasses: [StorageClass] {
        cache.storageClasses
            .filter { matches([$0.metadata.name, $0.provisioner, $0.reclaimPolicy, $0.volumeBindingMode]) }
            .sorted { $0.metadata.name.localizedStandardCompare($1.metadata.name) == .orderedAscending }
    }

    private func matches(_ fields: [String?]) -> Bool {
        if search.isEmpty { return true }
        let hay = fields.compactMap { $0 }.joined(separator: " ")
        return hay.localizedCaseInsensitiveContains(search)
    }

    private func sortByNamespaceName(_ lhs: ObjectMeta, _ rhs: ObjectMeta) -> Bool {
        let lns = lhs.namespace ?? ""
        let rns = rhs.namespace ?? ""
        if lns != rns { return lns < rns }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
}
