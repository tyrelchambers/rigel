import Foundation

/// Decoded Prometheus/VictoriaMetrics instant-query response
/// (`/api/v1/query`). Both backends share this wire format.
struct PromQueryResponse: Decodable, Sendable {
    let status: String
    let data: Data

    struct Data: Decodable, Sendable {
        let resultType: String
        let result: [Series]
    }

    struct Series: Decodable, Sendable {
        let metric: [String: String]
        let value: Sample
    }

    /// `[<unix seconds, Double>, "<value, String>"]`.
    struct Sample: Decodable, Sendable {
        let time: Double
        let value: Double
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            time = (try? c.decode(Double.self)) ?? 0
            let s = (try? c.decode(String.self)) ?? ""
            value = Double(s) ?? .nan
        }
    }
}

/// Right-sizing source backed by a Prometheus-compatible endpoint, queried over
/// a 30-day window. Produces the same `WindowStats` the local SQLite store does,
/// so the analysis engine and panel are unchanged.
struct PrometheusMetricsSource {
    let backend: MetricsBackendConfig
    static let windowDays = 30

    /// Per-container stats for one workload. Pods are matched by the
    /// `<name>-…` naming convention (covers Deployment/StatefulSet/DaemonSet).
    func aggregate(via cache: ClusterCache, namespace: String, name: String) async -> [WindowStats] {
        guard backend.proxyBase != nil else { return [] }
        let sel = #"namespace="\#(namespace)",pod=~"\#(name)-.*",container!="",container!="POD""#
        let w = "\(Self.windowDays)d"

        async let memPeak = query("max by (container) (max_over_time(container_memory_working_set_bytes{\(sel)}[\(w)]))", via: cache)
        async let memTyp  = query("max by (container) (quantile_over_time(0.95, container_memory_working_set_bytes{\(sel)}[\(w)]))", via: cache)
        async let cpuPeak = query("max by (container) (max_over_time(rate(container_cpu_usage_seconds_total{\(sel)}[5m])[\(w):5m]))", via: cache)
        async let cpuTyp  = query("max by (container) (quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{\(sel)}[5m])[\(w):5m]))", via: cache)
        async let counts  = query("max by (container) (count_over_time(container_memory_working_set_bytes{\(sel)}[\(w)]))", via: cache)

        let (mp, mt, cp, ct, cn) = await (memPeak, memTyp, cpuPeak, cpuTyp, counts)
        let containers = Set(mp.keys).union(cp.keys).union(mt.keys).union(ct.keys)

        return containers.sorted().map { c in
            // Estimate hours of history from sample count × scrape interval.
            let hours = Int(((cn[c] ?? 0) * Double(backend.stepSeconds)) / 3600.0)
            return WindowStats(
                container: c,
                cpuPeak: cp[c] ?? 0, cpuTypical: ct[c] ?? 0,
                memPeak: mp[c] ?? 0, memTypical: mt[c] ?? 0,
                hoursCovered: hours
            )
        }
    }

    /// Run one instant query, return container→value. Empty on any failure.
    private func query(_ promql: String, via cache: ClusterCache) async -> [String: Double] {
        guard let base = backend.proxyBase,
              // Encode aggressively (PromQL is full of reserved chars) — only
              // alphanumerics pass through unescaped.
              let encoded = promql.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return [:] }
        let path = "\(base)/api/v1/query?query=\(encoded)"
        guard let resp = await cache.promInstantQuery(path: path), resp.status == "success" else { return [:] }
        var out: [String: Double] = [:]
        for s in resp.data.result {
            guard let container = s.metric["container"], s.value.value.isFinite else { continue }
            out[container] = s.value.value
        }
        return out
    }
}
