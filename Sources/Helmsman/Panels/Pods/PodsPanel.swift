import SwiftUI

struct PodsPanel: View {
    @Bindable var viewModel: PodsViewModel
    @State private var selection: Pod.ID? = nil
    @State private var execPod: Pod? = nil
    @State private var managePod: Pod? = nil

    let onAction: (Pod, PodAction) -> Void
    var contextName: String? = nil
    var onWorkload: (WorkloadAction) -> Void = { _ in }
    var onViewYAML: (String, String, String?) -> Void = { _, _, _ in }
    var onTailLogsForPod: (Pod) -> Void = { _ in }
    var onForwardPod: (Pod, Int) -> Void = { _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .background(Theme.Status.failed.opacity(0.08))
            }
            table
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Pods")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            countChip
            PanelSearchField(text: $viewModel.search, placeholder: "search name, namespace, label…", maxWidth: 260)
            Spacer()
            if viewModel.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.Accent.primary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var countChip: some View {
        let filtered = viewModel.filteredPods.count
        let total = viewModel.pods.count
        let label = (viewModel.search.isEmpty || filtered == total) ? "\(total)" : "\(filtered) / \(total)"
        return Text(label)
            .font(Theme.Font.mono(11))
            .foregroundStyle(Theme.Foreground.tertiary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.Border.subtle)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var table: some View {
        Table(viewModel.filteredPods, selection: $selection) {
            TableColumn("Namespace") { pod in
                Text(pod.metadata.namespace ?? "—")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            TableColumn("Name") { pod in
                Text(pod.metadata.name)
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            TableColumn("Status") { pod in
                StatusPill(label: pod.status?.phase ?? "—", color: statusColor(pod))
            }
            TableColumn("Ready") { pod in
                Text(readyString(pod))
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            TableColumn("Restarts") { pod in
                let n = pod.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0
                Text("\(n)")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(n > 0 ? Theme.Status.pending : Theme.Foreground.tertiary)
            }
            TableColumn("CPU") { pod in
                MetricCell(samples: samples(for: pod), color: Theme.Pod.palette[0], formatter: ResourceQuantity.formatCores)
            }
            .width(min: 100, ideal: 120)
            TableColumn("Mem") { pod in
                MetricCell(samples: samples(for: pod), color: Theme.Pod.palette[1], formatter: ResourceQuantity.formatBytes, useMem: true)
            }
            .width(min: 110, ideal: 130)
            TableColumn("Node") { pod in
                Text(pod.spec?.nodeName ?? "—")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            TableColumn("Ask Claude") { pod in
                ActionButtonStrip(
                    actions: PodAction.allCases,
                    label: \.label,
                    systemImage: \.systemImage,
                    kind: \.kind,
                    onTap: { action in onAction(pod, action) }
                )
            }
            .width(min: 280, ideal: 320)
        }
        .contextMenu(forSelectionType: Pod.ID.self) { ids in
            if let id = ids.first, let pod = viewModel.filteredPods.first(where: { $0.id == id }) {
                ForEach(PodAction.allCases) { action in
                    Button("Ask Claude: \(action.label)") { onAction(pod, action) }
                }
                Divider()
                Button("Manage…") { managePod = pod }
                Button("View YAML…") { onViewYAML("pod", pod.metadata.name, pod.metadata.namespace) }
                Button("Run command in pod…") { execPod = pod }
                forwardMenu(for: pod)
                Divider()
                Button("Delete pod…", role: .destructive) { onWorkload(.deletePod(pod)) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.Surface.primary)
        .sheet(item: $execPod) { pod in
            PodExecSheet(pod: pod, context: contextName) {
                execPod = nil
            }
        }
        .sheet(item: $managePod) { pod in
            PodManageSheet(
                pod: pod,
                context: contextName,
                onClose: { managePod = nil },
                onViewYAML: {
                    managePod = nil
                    onViewYAML("pod", pod.metadata.name, pod.metadata.namespace)
                },
                onTailLogs: {
                    managePod = nil
                    onTailLogsForPod(pod)
                },
                onExec: {
                    managePod = nil
                    execPod = pod
                },
                onDelete: {
                    managePod = nil
                    onWorkload(.deletePod(pod))
                }
            )
        }
    }

    /// "Forward port" entry — a submenu when the pod declares multiple container
    /// ports, a single item for one, disabled when none are declared.
    @ViewBuilder
    private func forwardMenu(for pod: Pod) -> some View {
        let ports = (pod.spec?.containers ?? []).flatMap { $0.ports ?? [] }
        if ports.isEmpty {
            Button("Forward port…") {}.disabled(true)
        } else if ports.count == 1 {
            Button("Forward port \(ports[0].containerPort)…") { onForwardPod(pod, ports[0].containerPort) }
        } else {
            Menu("Forward port…") {
                ForEach(ports, id: \.self) { p in
                    let label = (p.name.map { "\($0) (\(p.containerPort))" }) ?? "\(p.containerPort)"
                    Button(label) { onForwardPod(pod, p.containerPort) }
                }
            }
        }
    }

    private func samples(for pod: Pod) -> [PodMetricSample] {
        let key = "\(pod.metadata.namespace ?? "default")/\(pod.metadata.name)"
        return viewModel.cache.podMetricsHistory[key] ?? []
    }

    private func readyString(_ pod: Pod) -> String {
        let statuses = pod.status?.containerStatuses ?? []
        let ready = statuses.filter { $0.ready }.count
        let total = statuses.count
        return total == 0 ? "—" : "\(ready)/\(total)"
    }

    private func statusColor(_ pod: Pod) -> Color {
        switch pod.status?.phase {
        case "Running":   return Theme.Status.running
        case "Pending":   return Theme.Status.pending
        case "Failed":    return Theme.Status.failed
        case "Succeeded": return Theme.Status.running
        default:          return Theme.Foreground.tertiary
        }
    }
}

private struct MetricCell: View {
    let samples: [PodMetricSample]
    let color: Color
    let formatter: (Double) -> String
    var useMem: Bool = false

    private var values: [Double] {
        useMem ? samples.map(\.memBytes) : samples.map(\.cpuCores)
    }
    private var current: Double {
        values.last ?? 0
    }

    var body: some View {
        HStack(spacing: 6) {
            Sparkline(samples: values, color: color)
                .frame(width: 50)
            Text(samples.isEmpty ? "—" : formatter(current))
                .font(Theme.Font.mono(11))
                .foregroundStyle(samples.isEmpty ? Theme.Foreground.tertiary : Theme.Foreground.primary)
                .lineLimit(1)
                .frame(minWidth: 50, alignment: .leading)
        }
    }
}
