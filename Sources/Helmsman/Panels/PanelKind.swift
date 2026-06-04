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
    case connectivity
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
    case accounts

    var id: Self { self }

    /// A labelled cluster of panels in the sidebar. A `nil` title renders the
    /// panels pinned at the very top with no header.
    struct NavGroup: Identifiable {
        let title: String?
        let panels: [PanelKind]
        var id: String { title ?? "_pinned" }
    }

    /// Sidebar layout: ordered top-to-bottom, most frequently used first.
    /// Every case appears exactly once (asserted by `PanelKind.navGroups`
    /// coverage test).
    static let navGroups: [NavGroup] = [
        NavGroup(title: nil, panels: [.overview, .assistant]),
        NavGroup(title: "Workloads", panels: [.deployments, .pods, .workloads, .rightSizing]),
        NavGroup(title: "Networking", panels: [.services, .ingresses]),
        NavGroup(title: "Config & Storage", panels: [.configMaps, .secrets, .storage, .databases]),
        NavGroup(title: "Cluster", panels: [.namespaces, .nodes, .connectivity, .rbac]),
        NavGroup(title: "Observability", panels: [.events, .logs]),
        NavGroup(title: "Self-host", panels: [.catalog]),
        NavGroup(title: "System", panels: [.accounts, .settings]),
    ]

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
        case .connectivity: return "arrow.triangle.branch"
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
        case .accounts:    return "person.badge.key.fill"
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
        case .connectivity: return "Connectivity"
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
        case .accounts:    return "Accounts"
        }
    }

    /// One-line descriptor shown beneath the title in the sidebar.
    var subtitle: String {
        switch self {
        case .overview:    return "Health at a glance"
        case .assistant:   return "AI cluster operator"
        case .namespaces:  return "Logical partitions"
        case .deployments: return "Rollouts & replicas"
        case .pods:        return "Running containers"
        case .workloads:   return "All controllers"
        case .rightSizing: return "Resource tuning"
        case .nodes:       return "Cluster machines"
        case .connectivity: return "Traffic & reachability"
        case .ingresses:   return "External routing"
        case .services:    return "Internal networking"
        case .databases:   return "Stateful stores"
        case .secrets:     return "Sensitive config"
        case .configMaps:  return "App configuration"
        case .storage:     return "Volumes & claims"
        case .rbac:        return "Access control"
        case .catalog:     return "Install apps"
        case .events:      return "Recent activity"
        case .logs:        return "Container output"
        case .settings:    return "Preferences"
        case .accounts:    return "Registry credentials"
        }
    }

    /// Tabs whose first render builds a potentially large table/list. These are
    /// deferred one runloop tick on tab switch (see `DeferredView`) so the switch
    /// paints instantly instead of blocking on the list's first layout. Lighter
    /// panels (overview cards, settings, the logs stream) render immediately.
    var hasHeavyList: Bool {
        switch self {
        case .deployments, .pods, .workloads, .rightSizing, .services, .ingresses,
             .secrets, .configMaps, .storage, .rbac, .events, .databases, .nodes, .connectivity:
            return true
        case .overview, .assistant, .namespaces, .catalog, .logs, .settings, .accounts:
            return false
        }
    }

    /// Tabs that list namespaced resources and honor the shared namespace
    /// filter. Drives whether `NamespaceBar` is shown.
    var isNamespaceScoped: Bool {
        switch self {
        case .deployments, .pods, .workloads, .rightSizing, .ingresses,
             .services, .secrets, .configMaps, .storage, .rbac, .events:
            return true
        case .overview, .assistant, .namespaces, .nodes, .connectivity, .databases,
             .catalog, .logs, .settings, .accounts:
            return false
        }
    }
}
