import Foundation

enum PanelKind: Hashable, CaseIterable, Identifiable {
    case overview
    case deployments
    case pods
    case nodes
    case ingresses
    case databases
    case secrets
    case catalog
    case events
    case logs

    var id: Self { self }

    var icon: String {
        switch self {
        case .overview:    return "rectangle.grid.2x2.fill"
        case .deployments: return "square.stack.3d.up.fill"
        case .pods:        return "shippingbox.fill"
        case .nodes:       return "server.rack"
        case .ingresses:   return "signpost.right.fill"
        case .databases:   return "cylinder.split.1x2.fill"
        case .secrets:     return "key.fill"
        case .catalog:     return "app.gift.fill"
        case .events:      return "exclamationmark.bubble.fill"
        case .logs:        return "text.alignleft"
        }
    }

    var title: String {
        switch self {
        case .overview:    return "Overview"
        case .deployments: return "Deployments"
        case .pods:        return "Pods"
        case .nodes:       return "Nodes"
        case .ingresses:   return "Ingresses"
        case .databases:   return "Databases"
        case .secrets:     return "Secrets"
        case .catalog:     return "Apps"
        case .events:      return "Events"
        case .logs:        return "Logs"
        }
    }
}
