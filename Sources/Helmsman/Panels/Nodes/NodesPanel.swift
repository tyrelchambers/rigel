import SwiftUI

struct NodesPanel: View {
    @Bindable var viewModel: NodesViewModel
    var onWorkload: (WorkloadAction) -> Void = { _ in }
    var onViewYAML: (String, String, String?) -> Void = { _, _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }

            if !viewModel.metricsAvailable {
                metricsWarning
            }

            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(viewModel.sortedNodes) { node in
                        NodeCard(
                            node: node,
                            metrics: viewModel.metrics[node.metadata.name],
                            podCount: viewModel.podCounts[node.metadata.name] ?? 0,
                            isExpanded: viewModel.isExpanded(node),
                            onToggle: { viewModel.toggleExpansion(node) },
                            onWorkload: onWorkload,
                            onViewYAML: onViewYAML
                        )
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
            }
            .background(Theme.Surface.primary)
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.nodes)
            Text("\(viewModel.nodes.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            if viewModel.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.Accent.primary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var metricsWarning: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10))
            Text("metrics-server unreachable — usage numbers won't render")
                .font(Theme.Font.body(11))
        }
        .foregroundStyle(Theme.Status.pending)
        .padding(.horizontal, 16).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Status.pending.opacity(0.10))
    }
}

private struct NodeCard: View {
    let node: Node
    let metrics: NodeMetrics?
    let podCount: Int
    let isExpanded: Bool
    let onToggle: () -> Void
    let onWorkload: (WorkloadAction) -> Void
    let onViewYAML: (String, String, String?) -> Void

    private var cpuCapacity: Double { ResourceQuantity.cpuCores(node.status?.capacity?["cpu"] ?? "0") }
    private var memCapacity: Double { ResourceQuantity.bytes(node.status?.capacity?["memory"] ?? "0") }
    private var maxPods: Int { Int(node.status?.capacity?["pods"] ?? "0") ?? 0 }

    private var cpuUsage: Double { metrics.map { ResourceQuantity.cpuCores($0.usage.cpu) } ?? 0 }
    private var memUsage: Double { metrics.map { ResourceQuantity.bytes($0.usage.memory) } ?? 0 }

    private var cpuPercent: Double { cpuCapacity > 0 ? cpuUsage / cpuCapacity : 0 }
    private var memPercent: Double { memCapacity > 0 ? memUsage / memCapacity : 0 }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onToggle) {
                VStack(alignment: .leading, spacing: 10) {
                    titleRow
                    metricsRow
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(Theme.Surface.elevated)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("View YAML…") { onViewYAML("node", node.metadata.name, nil) }
                Divider()
                if node.spec?.unschedulable == true {
                    Button("Uncordon node") { onWorkload(.uncordonNode(node)) }
                } else {
                    Button("Cordon node…") { onWorkload(.cordonNode(node)) }
                }
                Button("Drain node…", role: .destructive) { onWorkload(.drainNode(node, options: DrainOptions())) }
            }

            if isExpanded {
                detailsBlock
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isExpanded)
    }

    private var titleRow: some View {
        HStack(spacing: 10) {
            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .frame(width: 12)

            Text(node.metadata.name)
                .font(Theme.Font.mono(13, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)

            RoleChip(role: node.role)

            if node.spec?.unschedulable == true {
                Text("cordoned")
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .foregroundStyle(Theme.Status.pending)
                    .textCase(.uppercase)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Theme.Status.pending.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }

            Spacer()

            StatusPill(
                label: node.isReady ? "Ready" : "NotReady",
                color: node.isReady ? Theme.Status.running : Theme.Status.failed
            )
        }
    }

    private var metricsRow: some View {
        HStack(alignment: .top, spacing: 14) {
            UsageBar(
                title: "CPU",
                percent: cpuPercent,
                primaryText: ResourceQuantity.formatCores(cpuUsage),
                secondaryText: "/ \(ResourceQuantity.formatCores(cpuCapacity)) cores",
                hasMetrics: metrics != nil
            )
            UsageBar(
                title: "Memory",
                percent: memPercent,
                primaryText: ResourceQuantity.formatBytes(memUsage),
                secondaryText: "/ \(ResourceQuantity.formatBytes(memCapacity))",
                hasMetrics: metrics != nil
            )
            PodsBar(used: podCount, total: maxPods)
        }
    }

    private var detailsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            detailRow(label: "OS",          value: node.status?.nodeInfo?.osImage)
            detailRow(label: "Kernel",      value: node.status?.nodeInfo?.kernelVersion)
            detailRow(label: "Runtime",     value: node.status?.nodeInfo?.containerRuntimeVersion)
            detailRow(label: "Kubelet",     value: node.status?.nodeInfo?.kubeletVersion)
            detailRow(label: "Arch",        value: node.status?.nodeInfo?.architecture)
            detailRow(label: "Internal IP", value: node.status?.addresses?.first(where: { $0.type == "InternalIP" })?.address)
            detailRow(label: "Pod CIDR",    value: node.spec?.podCIDR)
            detailRow(
                label: "Free CPU",
                value: "\(ResourceQuantity.formatCores(max(0, cpuCapacity - cpuUsage))) cores"
            )
            detailRow(
                label: "Free Mem",
                value: ResourceQuantity.formatBytes(max(0, memCapacity - memUsage))
            )

            if let conds = node.status?.conditions {
                let active = conds.filter { $0.type != "Ready" && $0.status == "True" }
                if !active.isEmpty {
                    Text("PRESSURE")
                        .font(Theme.Font.body(9, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.Status.pending)
                        .padding(.top, 4)
                    ForEach(active, id: \.type) { c in
                        HStack(alignment: .top, spacing: 6) {
                            Circle().fill(Theme.Status.pending).frame(width: 5, height: 5)
                                .padding(.top, 6)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.type)
                                    .font(Theme.Font.mono(11, weight: .medium))
                                    .foregroundStyle(Theme.Foreground.primary)
                                if let msg = c.message, !msg.isEmpty {
                                    Text(msg)
                                        .font(Theme.Font.body(11))
                                        .foregroundStyle(Theme.Foreground.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .padding(.top, 4)
    }

    private func detailRow(label: String, value: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label)
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .frame(width: 90, alignment: .leading)
            Text(value ?? "—")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.primary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }
}

private struct RoleChip: View {
    let role: String

    var body: some View {
        Text(role)
            .font(Theme.Font.mono(9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var color: Color {
        role == "control-plane" ? Theme.Accent.primary : Theme.Foreground.secondary
    }
}

private struct UsageBar: View {
    let title: String
    let percent: Double          // 0..1
    let primaryText: String
    let secondaryText: String
    let hasMetrics: Bool

    private var barColor: Color {
        if !hasMetrics { return Theme.Border.strong }
        switch percent {
        case ..<0.7:  return Theme.Status.running
        case ..<0.9:  return Theme.Status.pending
        default:      return Theme.Status.failed
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(title)
                    .font(Theme.Font.body(10, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .textCase(.uppercase)
                Spacer()
                Text(hasMetrics ? "\(Int(percent * 100))%" : "—")
                    .font(Theme.Font.mono(10, weight: .medium))
                    .foregroundStyle(hasMetrics ? barColor : Theme.Foreground.tertiary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Theme.Border.subtle)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(barColor)
                        .frame(width: max(0, min(1, percent)) * geo.size.width)
                }
            }
            .frame(height: 6)
            HStack(spacing: 4) {
                Text(primaryText)
                    .font(Theme.Font.mono(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(secondaryText)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PodsBar: View {
    let used: Int
    let total: Int

    private var percent: Double { total > 0 ? Double(used) / Double(total) : 0 }
    private var color: Color {
        switch percent {
        case ..<0.7:  return Theme.Status.running
        case ..<0.9:  return Theme.Status.pending
        default:      return Theme.Status.failed
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("Pods")
                    .font(Theme.Font.body(10, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .textCase(.uppercase)
                Spacer()
                Text(total > 0 ? "\(Int(percent * 100))%" : "—")
                    .font(Theme.Font.mono(10, weight: .medium))
                    .foregroundStyle(total > 0 ? color : Theme.Foreground.tertiary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(Theme.Border.subtle)
                    RoundedRectangle(cornerRadius: 3).fill(color)
                        .frame(width: max(0, min(1, percent)) * geo.size.width)
                }
            }
            .frame(height: 6)
            HStack(spacing: 4) {
                Text("\(used)")
                    .font(Theme.Font.mono(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("/ \(total) pods")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
