import Foundation

enum PanelKind: Hashable, CaseIterable, Identifiable {
    case overview
    case assistant
    case namespaces
    case deployments
    case pods
    case workloads
    case rightSizing
    case nodes
    case ingresses
    case services
    case databases
    case secrets
    case configMaps
    case storage
    case rbac
    case catalog
    case events
    case logs
    case settings

    var id: Self { self }

    var icon: String {
        switch self {
        case .overview:    return "rectangle.grid.2x2.fill"
        case .assistant:   return "sparkles"
        case .namespaces:  return "square.dashed"
        case .deployments: return "square.stack.3d.up.fill"
        case .pods:        return "shippingbox.fill"
        case .workloads:   return "rectangle.stack.fill"
        case .rightSizing: return "gauge.with.dots.needle.bottom.50percent"
        case .nodes:       return "server.rack"
        case .ingresses:   return "signpost.right.fill"
        case .services:    return "network"
        case .databases:   return "cylinder.split.1x2.fill"
        case .secrets:     return "key.fill"
        case .configMaps:  return "doc.plaintext.fill"
        case .storage:     return "externaldrive.fill"
        case .rbac:        return "lock.shield.fill"
        case .catalog:     return "app.gift.fill"
        case .events:      return "exclamationmark.bubble.fill"
        case .logs:        return "text.alignleft"
        case .settings:    return "gearshape.fill"
        }
    }

    var title: String {
        switch self {
        case .overview:    return "Overview"
        case .assistant:   return "Assistant"
        case .namespaces:  return "Namespaces"
        case .deployments: return "Deployments"
        case .pods:        return "Pods"
        case .workloads:   return "Workloads"
        case .rightSizing: return "Right-sizing"
        case .nodes:       return "Nodes"
        case .ingresses:   return "Ingresses"
        case .services:    return "Services"
        case .databases:   return "Databases"
        case .secrets:     return "Secrets"
        case .configMaps:  return "ConfigMaps"
        case .storage:     return "Storage"
        case .rbac:        return "RBAC"
        case .catalog:     return "Apps"
        case .events:      return "Events"
        case .logs:        return "Logs"
        case .settings:    return "Settings"
        }
    }
}
