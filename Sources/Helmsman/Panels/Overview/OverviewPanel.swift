import SwiftUI

struct OverviewPanel: View {
    @Bindable var cache: ClusterCache
    @Bindable var contextManager: ClusterContextManager
    @Bindable var databasesVM: DatabasesViewModel
    @Bindable var rightSizingVM: RightSizingViewModel
    let onInvestigate: () -> Void
    var onPurge: () -> Void = {}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                gaugesRow
                topRow
                middleRow
                eventTimelineCard
                warningsCard
            }
            .padding(16)
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 10) {
            PanelTitle(.overview)
            if let ctx = contextManager.active?.name {
                Text(ctx)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            Spacer()
            Button(action: onPurge) {
                HStack(spacing: 6) {
                    Image(systemName: "trash").font(.system(size: 11))
                    Text("Purge an app")
                        .font(Theme.Font.body(12, weight: .medium))
                }
                .foregroundStyle(Theme.Status.failed)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.Status.failed.opacity(0.10))
                .overlay(Capsule().strokeBorder(Theme.Status.failed.opacity(0.4), lineWidth: 1))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Remove an entire app and its related resources")
            Button(action: onInvestigate) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles").font(.system(size: 11))
                    Text("Investigate cluster")
                        .font(Theme.Font.body(12, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.inverse)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.Accent.primary)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Ask Claude to investigate cluster health")
        }
    }

    // MARK: - Top row: Deployments | Pods | Nodes

    private var topRow: some View {
        HStack(alignment: .top, spacing: 12) {
            deploymentsCard
            podsCard
            nodesCard
        }
    }

    private var deploymentsCard: some View {
        let total = cache.deployments.count
        let unhealthy = cache.deployments.filter { d in
            let ready = d.status?.readyReplicas ?? 0
            let desired = d.spec?.replicas ?? d.status?.replicas ?? 0
            return desired > 0 && ready < desired
        }.count
        return Card(title: "Deployments", icon: "square.stack.3d.up.fill") {
            MetricRow(big: "\(total)", caption: total == 1 ? "deployment" : "deployments")
            HealthLine(label: "Unhealthy", count: unhealthy, color: Theme.Status.failed)
        }
    }

    private var podsCard: some View {
        let counts = phaseBreakdown(cache.pods)
        let total = cache.pods.count
        return Card(title: "Pods", icon: "shippingbox.fill") {
            MetricRow(big: "\(total)", caption: total == 1 ? "pod" : "pods")
            HealthLine(label: "Running", count: counts.running, color: Theme.Status.running)
            HealthLine(label: "Pending", count: counts.pending, color: Theme.Status.pending)
            HealthLine(label: "Failed",  count: counts.failed,  color: Theme.Status.failed)
        }
    }

    private var nodesCard: some View {
        let total = cache.nodes.count
        let ready = cache.nodes.filter { $0.isReady }.count
        let pressureCount = cache.nodes.flatMap { node in
            (node.status?.conditions ?? []).filter { $0.type != "Ready" && $0.status == "True" }
        }.count
        return Card(title: "Nodes", icon: "server.rack") {
            MetricRow(big: "\(ready)/\(total)", caption: "ready")
            HealthLine(label: "Pressure conditions", count: pressureCount, color: Theme.Status.pending)
        }
    }

    // MARK: - Gauges row: Cluster CPU | Cluster Memory | Reclaimable

    private var gaugesRow: some View {
        let totals = Viz.clusterResourceTotals(nodes: cache.nodes, metrics: cache.nodeMetrics)
        let waste = Viz.wasteSummary(rightSizingVM.results)
        return HStack(alignment: .top, spacing: 12) {
            if cache.metricsAvailable && totals.cpuAllocatable > 0 {
                RingGauge(
                    title: "Cluster CPU",
                    fraction: totals.cpuFraction,
                    detail: "\(ResourceQuantity.formatCores(totals.cpuUsed)) / \(ResourceQuantity.formatCores(totals.cpuAllocatable))"
                )
                RingGauge(
                    title: "Cluster Memory",
                    fraction: totals.memFraction,
                    detail: "\(ResourceQuantity.formatBytes(totals.memUsed)) / \(ResourceQuantity.formatBytes(totals.memAllocatable))"
                )
            } else {
                metricsUnavailableCard
            }
            wasteCard(waste)
        }
    }

    private var metricsUnavailableCard: some View {
        Card(title: "Cluster Usage", icon: "gauge.with.dots.needle.bottom.50percent") {
            Text("metrics-server unavailable — install it to see live CPU/memory usage.")
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func wasteCard(_ waste: Viz.WasteSummary) -> some View {
        Card(title: "Reclaimable", icon: "arrow.down.right.circle.fill") {
            if waste.workloadCount > 0 {
                MetricRow(
                    big: ResourceQuantity.formatBytes(waste.reclaimableBytes),
                    caption: "across \(waste.workloadCount) workload\(waste.workloadCount == 1 ? "" : "s")"
                )
                Text("Memory you could give back by right-sizing over-provisioned workloads.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                MetricRow(big: "—", caption: "no data yet")
                Text("Open Right-Sizing to analyze workloads and surface reclaimable memory.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Middle row: Databases | Events count

    private var middleRow: some View {
        HStack(alignment: .top, spacing: 12) {
            databasesCard
            eventsCard
        }
    }

    private var databasesCard: some View {
        let total = databasesVM.instances.count
        let unhealthy = databasesVM.instances.filter { !$0.isHealthy }.count
        return Card(title: "Databases", icon: "cylinder.split.1x2.fill") {
            MetricRow(big: "\(total)", caption: total == 1 ? "instance" : "instances")
            HealthLine(label: "Unhealthy", count: unhealthy, color: Theme.Status.failed)
        }
    }

    private var eventsCard: some View {
        let warnings = cache.events.filter { $0.isWarning }.count
        let total = cache.events.count
        return Card(title: "Events", icon: "exclamationmark.bubble.fill") {
            MetricRow(big: "\(warnings)", caption: "warnings (last 500)")
            HealthLine(label: "Total cached", count: total, color: Theme.Foreground.secondary)
        }
    }

    private var eventTimelineCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "waveform.path.ecg").font(.system(size: 11)).foregroundStyle(Theme.Accent.primary)
                Text("Event activity — last 1h")
                    .font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textCase(.uppercase).tracking(0.5)
                Spacer()
            }
            EventTimeline(buckets: Viz.eventBuckets(cache.events, now: Date(), span: 3600, count: 60), span: 3600, height: 56)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    // MARK: - Recent warnings

    private var warningsCard: some View {
        let recent = cache.events.filter { $0.isWarning }.prefix(10)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Status.failed)
                Text("Recent warnings")
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)

            Divider().background(Theme.Border.subtle)

            if recent.isEmpty {
                Text("No warning events.")
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 1) {
                    ForEach(Array(recent), id: \.id) { evt in
                        warningRow(evt)
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 6)
            }
        }
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    private func warningRow(_ evt: K8sEvent) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Rectangle().fill(Theme.Status.failed).frame(width: 2, height: 12)
            Text(evt.reason ?? "—")
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
                .frame(width: 140, alignment: .leading)
                .lineLimit(1)
            Text(target(for: evt))
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 200, alignment: .leading)
            Text(evt.message ?? "")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(evt.relativeAge())
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
                .frame(width: 36, alignment: .trailing)
                .help(evt.absoluteWhen ?? "Unknown time")
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
    }

    private func target(for evt: K8sEvent) -> String {
        let kind = evt.involvedObject?.kind ?? ""
        let name = evt.involvedObject?.name ?? ""
        let ns = evt.involvedObject?.namespace ?? ""
        return ns.isEmpty ? "\(kind)/\(name)" : "\(kind)/\(name) · \(ns)"
    }

    // MARK: - Helpers

    private struct PhaseCounts { var running = 0, pending = 0, failed = 0, other = 0 }

    private func phaseBreakdown(_ pods: [Pod]) -> PhaseCounts {
        var c = PhaseCounts()
        for p in pods {
            switch p.status?.phase {
            case "Running":   c.running += 1
            case "Pending":   c.pending += 1
            case "Failed":    c.failed  += 1
            case "Succeeded": c.running += 1
            default:          c.other   += 1
            }
        }
        return c
    }
}

// MARK: - Card primitives

private struct Card<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Accent.primary)
                Text(title)
                    .font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }
}

private struct MetricRow: View {
    let big: String
    let caption: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(big)
                .font(Theme.Font.mono(28, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text(caption)
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
            Spacer()
        }
    }
}

private struct HealthLine: View {
    let label: String
    let count: Int
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(label)
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.secondary)
            Spacer()
            Text("\(count)")
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(count > 0 ? color : Theme.Foreground.tertiary)
        }
    }
}
