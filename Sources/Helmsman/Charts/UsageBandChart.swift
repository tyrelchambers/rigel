import SwiftUI
import Charts

/// Usage-over-time area with request/limit reference lines. Pure presentation —
/// the series and reference values are passed in.
struct UsageBandChart: View {
    let points: [UsagePoint]
    let request: Double?
    let limit: Double?
    let format: (Double) -> String

    var body: some View {
        Chart {
            ForEach(points) { p in
                AreaMark(x: .value("Time", p.date), y: .value("Usage", p.value))
                    .foregroundStyle(.linearGradient(
                        colors: [Theme.Accent.primary.opacity(0.35), Theme.Accent.primary.opacity(0.02)],
                        startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Time", p.date), y: .value("Usage", p.value))
                    .foregroundStyle(Theme.Accent.primary)
                    .interpolationMethod(.monotone)
            }
            if let request {
                RuleMark(y: .value("Request", request))
                    .foregroundStyle(Theme.Status.running)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("request \(format(request))").font(Theme.Font.mono(9)).foregroundStyle(Theme.Status.running)
                    }
            }
            if let limit {
                RuleMark(y: .value("Limit", limit))
                    .foregroundStyle(Theme.Status.failed)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("limit \(format(limit))").font(Theme.Font.mono(9)).foregroundStyle(Theme.Status.failed)
                    }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) { v in
                AxisGridLine().foregroundStyle(Theme.Border.subtle)
                AxisValueLabel {
                    if let d = v.as(Double.self) { Text(format(d)).font(Theme.Font.mono(9)) }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                AxisGridLine().foregroundStyle(Theme.Border.subtle)
                AxisValueLabel(format: .dateTime.hour())
            }
        }
        .frame(height: 150)
    }
}

/// Self-contained 24h usage panel for one workload: a CPU/Memory toggle, the
/// chart, and the Prometheus-only empty state. Fetches via `UsageSeriesSource`
/// whenever the metric or workload changes; renders the empty state when the
/// configured backend isn't Prometheus.
struct WorkloadUsageBands: View {
    @Bindable var cache: ClusterCache
    let backend: MetricsBackendConfig
    let workload: WorkloadRightSizing

    @State private var metric: UsageSeriesSource.Metric = .cpu
    @State private var points: [UsagePoint] = []
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Usage — last 24h")
                    .font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textCase(.uppercase).tracking(0.5)
                Spacer()
                Picker("", selection: $metric) {
                    Text("CPU").tag(UsageSeriesSource.Metric.cpu)
                    Text("Memory").tag(UsageSeriesSource.Metric.memory)
                }
                .pickerStyle(.segmented).frame(width: 160).labelsHidden()
                .disabled(!backend.isPrometheus)
            }

            content
        }
        .task(id: reloadKey) { await load() }
    }

    private var reloadKey: String {
        // backend.hashValue (not just isPrometheus) so switching between two
        // Prometheus endpoints refetches instead of showing the stale series.
        "\(workload.id)|\(metric == .cpu ? "cpu" : "mem")|\(backend.hashValue)"
    }

    @ViewBuilder private var content: some View {
        if !backend.isPrometheus {
            emptyState(
                icon: "chart.xyaxis.line",
                title: "Connect a metrics backend for usage history",
                detail: "Pick a Prometheus or VictoriaMetrics source in the picker above to see 24-hour usage bands."
            )
        } else if loading && points.isEmpty {
            ProgressView().controlSize(.small).frame(maxWidth: .infinity).frame(height: 150)
        } else if points.isEmpty {
            emptyState(
                icon: "questionmark.circle",
                title: "No usage data for the last 24h",
                detail: "The metrics backend returned no samples for this workload."
            )
        } else {
            UsageBandChart(points: points, request: requestLine, limit: limitLine, format: formatter)
        }
    }

    private func emptyState(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 20)).foregroundStyle(Theme.Foreground.tertiary)
            Text(title).font(Theme.Font.body(12, weight: .medium)).foregroundStyle(Theme.Foreground.secondary)
            Text(detail).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity).frame(height: 150)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var formatter: (Double) -> String {
        metric == .cpu ? ResourceQuantity.formatCores : ResourceQuantity.formatBytes
    }

    // Reference lines = sum of present per-container requests/limits for the
    // selected metric (matches the summed PromQL series). nil when none set.
    private var requestLine: Double? {
        let vals = workload.containers.compactMap { metric == .cpu ? $0.cpuRequest : $0.memRequest }
        return vals.isEmpty ? nil : vals.reduce(0, +)
    }
    private var limitLine: Double? {
        let vals = workload.containers.compactMap { metric == .cpu ? $0.cpuLimit : $0.memLimit }
        return vals.isEmpty ? nil : vals.reduce(0, +)
    }

    private func load() async {
        points = []                       // drop stale series before refetch (avoids a flash on switch)
        guard backend.isPrometheus else { return }
        loading = true
        defer { loading = false }
        let source = UsageSeriesSource(backend: backend)
        points = await source.series(via: cache, namespace: workload.namespace, name: workload.name, metric: metric)
    }
}
