import Foundation

/// Resolves the cluster's request paths — ingress → service → pods — into flat
/// rows for the Connectivity panel, flagging where traffic can't actually land.
/// Pure: selector→pod matching and health classification live here so they can
/// be unit-tested without the live cache.
enum Connectivity {
    enum Health: Equatable { case ok, warn, broken }

    struct Flow: Identifiable, Equatable {
        let id: String
        let hosts: [String]            // ingress hosts routing here; empty = internal
        let ingressNames: [String]
        let serviceName: String
        let namespace: String
        let serviceType: String        // "ClusterIP" etc; "—" when the service is missing
        let serviceExists: Bool
        let readyPods: Int
        let totalPods: Int
        let podNames: [String]
        let isExternal: Bool
        let issues: [String]

        /// External reachability problems are hard failures; internal ones warn.
        var health: Health {
            guard issues.isEmpty else { return isExternal ? .broken : .warn }
            return .ok
        }
    }

    static func flows(ingresses: [Ingress], services: [Service], pods: [Pod]) -> [Flow] {
        // 1. Map each "namespace/service-name" target to the hosts + ingress names fronting it.
        struct Front { var hosts: Set<String> = []; var ingresses: Set<String> = [] }
        var fronts: [String: Front] = [:]
        for ing in ingresses {
            let ns = ing.metadata.namespace ?? "default"
            for route in ing.routes where route.service != "—" {
                let key = "\(ns)/\(route.service)"
                var f = fronts[key] ?? Front()
                if route.host != "*" { f.hosts.insert(route.host) }
                f.ingresses.insert(ing.metadata.name)
                fronts[key] = f
            }
        }

        let serviceKeys = Set(services.map { "\($0.metadata.namespace ?? "default")/\($0.metadata.name)" })
        var flows: [Flow] = []

        // 2. One flow per service.
        for svc in services {
            let ns = svc.metadata.namespace ?? "default"
            let key = "\(ns)/\(svc.metadata.name)"
            let front = fronts[key]
            let isExternal = !(front?.ingresses.isEmpty ?? true)

            let selector = svc.spec?.selector ?? [:]
            let matched = selector.isEmpty ? [] : pods.filter { pod in
                (pod.metadata.namespace ?? "default") == ns &&
                selector.allSatisfy { (pod.metadata.labels ?? [:])[$0.key] == $0.value }
            }
            let ready = matched.filter(isPodReady).count

            var issues: [String] = []
            if !selector.isEmpty {
                if matched.isEmpty {
                    issues.append("Selector matches no pods")
                } else if ready == 0 {
                    issues.append("\(matched.count) pod\(matched.count == 1 ? "" : "s"), 0 ready")
                }
            }

            flows.append(Flow(
                id: key,
                hosts: front?.hosts.sorted() ?? [],
                ingressNames: front?.ingresses.sorted() ?? [],
                serviceName: svc.metadata.name,
                namespace: ns,
                serviceType: svc.typeLabel,
                serviceExists: true,
                readyPods: ready,
                totalPods: matched.count,
                podNames: matched.map { $0.metadata.name }.sorted(),
                isExternal: isExternal,
                issues: issues
            ))
        }

        // 3. Dangling ingress routes — point at a service that doesn't exist.
        for (key, front) in fronts where !serviceKeys.contains(key) {
            let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
            let ns = parts.first ?? "default"
            let name = parts.count > 1 ? parts[1] : key
            flows.append(Flow(
                id: key,
                hosts: front.hosts.sorted(),
                ingressNames: front.ingresses.sorted(),
                serviceName: name,
                namespace: ns,
                serviceType: "—",
                serviceExists: false,
                readyPods: 0,
                totalPods: 0,
                podNames: [],
                isExternal: true,
                issues: ["Ingress points to a service that doesn't exist"]
            ))
        }

        // 4. Sort: broken → warn → ok, then namespace/name.
        func rank(_ h: Health) -> Int { h == .broken ? 0 : (h == .warn ? 1 : 2) }
        return flows.sorted {
            if rank($0.health) != rank($1.health) { return rank($0.health) < rank($1.health) }
            if $0.namespace != $1.namespace { return $0.namespace < $1.namespace }
            return $0.serviceName < $1.serviceName
        }
    }

    /// A pod is a ready endpoint when it's Running with all containers ready.
    static func isPodReady(_ pod: Pod) -> Bool {
        guard pod.status?.phase == "Running" else { return false }
        let cs = pod.status?.containerStatuses ?? []
        return !cs.isEmpty && cs.allSatisfy { $0.ready }
    }
}
