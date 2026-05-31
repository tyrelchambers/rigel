import Foundation
import Observation

enum WorkloadKind: String, CaseIterable, Identifiable {
    case statefulSets
    case daemonSets
    case jobs
    case cronJobs
    var id: String { rawValue }

    var title: String {
        switch self {
        case .statefulSets: return "StatefulSets"
        case .daemonSets:   return "DaemonSets"
        case .jobs:         return "Jobs"
        case .cronJobs:     return "CronJobs"
        }
    }
}

@Observable
final class WorkloadsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var kind: WorkloadKind = .statefulSets
    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var count: Int {
        switch kind {
        case .statefulSets: return filteredStatefulSets.count
        case .daemonSets:   return filteredDaemonSets.count
        case .jobs:         return filteredJobs.count
        case .cronJobs:     return filteredCronJobs.count
        }
    }

    var filteredStatefulSets: [StatefulSet] {
        cache.statefulSets
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredDaemonSets: [DaemonSet] {
        cache.daemonSets
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredJobs: [Job] {
        cache.jobs
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace, $0.phase]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    var filteredCronJobs: [CronJob] {
        cache.cronJobs
            .filter { passesNamespace($0.metadata) }
            .filter { matches([$0.metadata.name, $0.metadata.namespace, $0.schedule]) }
            .sorted { sortByNamespaceName($0.metadata, $1.metadata) }
    }

    private func passesNamespace(_ meta: ObjectMeta) -> Bool {
        cache.namespaceFilter == nil || meta.namespace == cache.namespaceFilter
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
