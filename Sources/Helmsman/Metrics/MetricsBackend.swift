import Foundation

/// Where right-sizing reads usage history from, per kube-context.
/// `.local` = the in-app SQLite store; `.prometheus` = a Prometheus-compatible
/// HTTP endpoint (Prometheus or VictoriaMetrics) reached via the API-server proxy.
struct MetricsBackendConfig: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case local, prometheus }

    var kind: Kind
    var namespace: String?
    var service: String?
    var port: Int?
    /// Assumed scrape interval, used to estimate how many hours of history exist.
    var stepSeconds: Int

    static let local = MetricsBackendConfig(kind: .local, namespace: nil, service: nil, port: nil, stepSeconds: 60)

    static func prometheus(namespace: String, service: String, port: Int, stepSeconds: Int = 60) -> MetricsBackendConfig {
        MetricsBackendConfig(kind: .prometheus, namespace: namespace, service: service, port: port, stepSeconds: stepSeconds)
    }

    var isPrometheus: Bool { kind == .prometheus }

    var displayLabel: String {
        switch kind {
        case .local: return "Local history"
        case .prometheus: return "\(namespace ?? "?")/\(service ?? "?"):\(port ?? 0)"
        }
    }

    /// Short product label for the picker chip. `.prometheus` covers any PromQL
    /// endpoint, so we infer the actual product from its well-known port.
    var flavorLabel: String {
        switch kind {
        case .local: return "Local"
        case .prometheus:
            switch port {
            case 8428, 8481: return "VictoriaMetrics"
            case 9090:       return "Prometheus"
            default:         return "Metrics"
            }
        }
    }

    /// API-server proxy base to the service's HTTP API, e.g.
    /// `/api/v1/namespaces/monitoring/services/prometheus:9090/proxy`.
    var proxyBase: String? {
        guard kind == .prometheus, let namespace, let service, let port else { return nil }
        return "/api/v1/namespaces/\(namespace)/services/\(service):\(port)/proxy"
    }
}

/// Finds Prometheus-compatible backends already running in the cluster by
/// matching well-known service names + ports. Used to pre-populate the picker
/// and to skip the install flow when one already exists.
enum MetricsBackendDetector {
    static func detect(in services: [Service]) -> [MetricsBackendConfig] {
        var out: [MetricsBackendConfig] = []
        for svc in services {
            let name = svc.metadata.name.lowercased()
            let ns = svc.metadata.namespace ?? "default"
            let ports = svc.spec?.ports ?? []

            // Skip obvious non-query services (operators, exporters, alertmanager).
            if name.contains("operator") || name.contains("node-exporter")
                || name.contains("alertmanager") || name.contains("kube-state") {
                continue
            }

            // Prometheus query API → 9090 (or a "web" port).
            if name.contains("prometheus") {
                if let p = ports.first(where: { $0.port == 9090 })
                    ?? ports.first(where: { ($0.name ?? "").contains("web") || ($0.name ?? "") == "http" }) {
                    out.append(.prometheus(namespace: ns, service: svc.metadata.name, port: p.port))
                    continue
                }
            }

            // VictoriaMetrics single-node → 8428; vmselect → 8481.
            if name.contains("victoria") || name.hasPrefix("vmsingle") || name.contains("vmselect") {
                if let p = ports.first(where: { $0.port == 8428 || $0.port == 8481 }) ?? ports.first {
                    out.append(.prometheus(namespace: ns, service: svc.metadata.name, port: p.port))
                }
            }
        }
        // Dedupe by (ns, service, port).
        var seen = Set<String>()
        return out.filter { c in
            let key = "\(c.namespace ?? "")/\(c.service ?? ""):\(c.port ?? 0)"
            return seen.insert(key).inserted
        }
    }
}
