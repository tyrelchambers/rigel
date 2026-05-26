import Foundation

enum PanelKind: Hashable, CaseIterable, Identifiable {
    case pods
    case logs
    // .alerts, .nodes added in follow-up plans

    var id: Self { self }

    var icon: String {
        switch self {
        case .pods: return "shippingbox.fill"
        case .logs: return "text.alignleft"
        }
    }

    var title: String {
        switch self {
        case .pods: return "Pods"
        case .logs: return "Logs"
        }
    }
}
