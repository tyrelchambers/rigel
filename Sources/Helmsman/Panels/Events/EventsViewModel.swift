import Foundation
import Observation

enum EventTypeFilter: String, CaseIterable, Identifiable {
    case all, warning, normal
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all:     return "All"
        case .warning: return "Warning"
        case .normal:  return "Normal"
        }
    }
}

@Observable
final class EventsViewModel {
    let cache: ClusterCache
    init(cache: ClusterCache) { self.cache = cache }

    var typeFilter: EventTypeFilter = .warning
    var namespaceFilter: String? = nil
    var search: String = ""

    var error: String? { cache.error }
    var isLoading: Bool { cache.isLoading }

    var availableNamespaces: [String] {
        Set(cache.events.compactMap { $0.involvedObject?.namespace }).sorted()
    }

    var filteredEvents: [K8sEvent] {
        cache.events.filter { e in
            switch typeFilter {
            case .all: return true
            case .warning: return e.isWarning
            case .normal: return e.type == "Normal"
            }
        }
        .filter { e in
            namespaceFilter == nil || e.involvedObject?.namespace == namespaceFilter
        }
        .filter { e in
            if search.isEmpty { return true }
            let hay = [e.reason, e.message, e.involvedObject?.name].compactMap { $0 }.joined(separator: " ")
            return hay.localizedCaseInsensitiveContains(search)
        }
    }
}
