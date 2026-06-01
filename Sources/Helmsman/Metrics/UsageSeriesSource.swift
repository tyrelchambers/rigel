import Foundation

/// Decoded Prometheus/VictoriaMetrics range-query response
/// (`/api/v1/query_range`). Mirrors `PromQueryResponse` but with a values array.
struct PromRangeResponse: Decodable, Sendable {
    let status: String
    let data: Data

    struct Data: Decodable, Sendable {
        let resultType: String
        let result: [Series]
    }

    struct Series: Decodable, Sendable {
        let metric: [String: String]
        let values: [Point]
    }

    /// `[<unix seconds, Double>, "<value, String>"]`.
    struct Point: Decodable, Sendable {
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

/// One point on a usage-over-time series.
struct UsagePoint: Identifiable, Equatable {
    let date: Date
    let value: Double      // cpu cores or mem bytes
    var id: Date { date }
}

/// Pulls a workload's aggregate usage time series from a Prometheus-compatible
/// backend via the API-server proxy. Returns [] when the backend isn't
/// Prometheus or the query fails — the panel renders its empty state.
struct UsageSeriesSource {
    let backend: MetricsBackendConfig
    enum Metric { case cpu, memory }

    static let windowSeconds = 24 * 3600
    static let stepSeconds = 300

    func series(via cache: ClusterCache, namespace: String, name: String, metric: Metric, now: Date = Date()) async -> [UsagePoint] {
        guard let base = backend.proxyBase else { return [] }
        let sel = #"namespace="\#(namespace)",pod=~"\#(name)-.*",container!="",container!="POD""#
        let promql: String
        switch metric {
        case .cpu:    promql = "sum(rate(container_cpu_usage_seconds_total{\(sel)}[5m]))"
        case .memory: promql = "sum(container_memory_working_set_bytes{\(sel)})"
        }
        let end = Int(now.timeIntervalSince1970)
        let start = end - Self.windowSeconds
        guard let q = promql.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return [] }
        let path = "\(base)/api/v1/query_range?query=\(q)&start=\(start)&end=\(end)&step=\(Self.stepSeconds)"

        // The PromQL wraps everything in `sum(...)`, so the response is always a
        // single series — `.first` is the whole result, not a truncation.
        guard let resp = await cache.promRangeQuery(path: path),
              resp.status == "success",
              let series = resp.data.result.first else { return [] }
        return series.values
            .filter { $0.value.isFinite }
            .map { UsagePoint(date: Date(timeIntervalSince1970: $0.time), value: $0.value) }
    }
}
