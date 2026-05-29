import SwiftUI
import AppKit

struct RightSizingPanel: View {
    @Bindable var viewModel: RightSizingViewModel
    let onApply: (WorkloadAction) -> Void
    let onAskClaude: (WorkloadRightSizing) -> Void

    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            controlBar
            if viewModel.isWarmingUp {
                warmingBanner
            }
            if viewModel.filtered.isEmpty {
                empty
            } else {
                list
            }
        }
        .background(Theme.Surface.primary)
        .task { await viewModel.refresh() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Right-sizing")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filtered.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            if viewModel.isAnalyzing {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
            Button { Task { await viewModel.refresh() } } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .frame(width: 24, height: 24)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Re-analyze from history")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var controlBar: some View {
        HStack(spacing: 8) {
            ForEach(RightSizingSort.allCases) { s in
                RSPill(label: s.label, isActive: viewModel.sort == s) { viewModel.sort = s }
            }
            Divider().frame(height: 16)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    RSPill(label: "all ns", isActive: viewModel.namespaceFilter == nil) { viewModel.namespaceFilter = nil }
                    ForEach(viewModel.availableNamespaces, id: \.self) { ns in
                        RSPill(label: ns, isActive: viewModel.namespaceFilter == ns) { viewModel.namespaceFilter = ns }
                    }
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 10)).foregroundStyle(Theme.Foreground.tertiary)
                TextField("search", text: $viewModel.search)
                    .textFieldStyle(.plain).font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.primary)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Surface.sunken)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .frame(maxWidth: 180)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var warmingBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "hourglass")
                .font(.system(size: 12)).foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 1) {
                Text("Collecting usage history — recommendations need ~\(RightSizing.minHours)h of data")
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("Usage is sampled while Helmsman runs and rolled up hourly to a local store. So far: \(viewModel.maxHoursCovered)h of \(RightSizing.minHours)h. Verdicts appear automatically once there's enough.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Accent.primary.opacity(0.08))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                .font(.system(size: 28)).foregroundStyle(Theme.Foreground.tertiary)
            Text(viewModel.isAnalyzing ? "Analyzing…" : "No workloads to analyze yet")
                .font(Theme.Font.mono(12)).foregroundStyle(Theme.Foreground.tertiary)
            Text("Usage history builds hourly; confident verdicts need ~24h of data.")
                .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).padding(40)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(viewModel.filtered) { w in
                    WorkloadRow(
                        workload: w,
                        isExpanded: expanded.contains(w.id),
                        onToggle: { toggle(w.id) },
                        onApply: onApply,
                        onAskClaude: { onAskClaude(w) }
                    )
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }

    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }
}

// MARK: - Verdict badge

func rightSizingVerdictColor(_ v: RightSizingVerdict) -> Color {
    switch v {
    case .ok: return Theme.Status.running
    case .overProvisioned: return Theme.Status.pending
    case .atRisk: return Theme.Status.failed
    case .unset: return Theme.Status.failed
    case .insufficientData: return Theme.Foreground.tertiary
    }
}

private struct VerdictBadge: View {
    let verdict: RightSizingVerdict
    var body: some View {
        let c = rightSizingVerdictColor(verdict)
        Text(verdict.label)
            .font(Theme.Font.mono(9, weight: .semibold))
            .foregroundStyle(c)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(c.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct RSPill: View {
    let label: String
    let isActive: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(isActive ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(isActive ? Theme.Accent.primary : Theme.Surface.sunken)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(isActive ? Color.clear : Theme.Border.strong, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Workload row

private struct WorkloadRow: View {
    let workload: WorkloadRightSizing
    let isExpanded: Bool
    let onToggle: () -> Void
    let onApply: (WorkloadAction) -> Void
    let onAskClaude: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.Foreground.tertiary).frame(width: 12)
                    Text(workload.kind.prefix(3).uppercased())
                        .font(Theme.Font.mono(9, weight: .semibold)).foregroundStyle(Theme.Accent.primary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Accent.primary.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    Text(workload.name).font(Theme.Font.mono(12, weight: .medium)).foregroundStyle(Theme.Foreground.primary).lineLimit(1)
                    Text(workload.namespace).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                    VerdictBadge(verdict: workload.worst)
                    Spacer(minLength: 8)
                    if workload.reclaimableMemBytes > 0 {
                        Text("reclaim ~\(ResourceQuantity.formatBytes(workload.reclaimableMemBytes))")
                            .font(Theme.Font.mono(10)).foregroundStyle(Theme.Status.pending)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(Theme.Surface.sunken)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(spacing: 6) {
                    ForEach(workload.containers, id: \.container) { r in
                        ContainerDetail(workload: workload, result: r, onApply: onApply, onAskClaude: onAskClaude)
                    }
                }
                .padding(.top, 6)
            }
        }
    }
}

private struct ContainerDetail: View {
    let workload: WorkloadRightSizing
    let result: RightSizingResult
    let onApply: (WorkloadAction) -> Void
    let onAskClaude: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(result.container).font(Theme.Font.mono(11, weight: .medium)).foregroundStyle(Theme.Foreground.primary)
                VerdictBadge(verdict: result.verdict)
                Spacer()
                Text(result.verdict == .insufficientData ? "\(result.hoursCovered)h/\(RightSizing.minHours)h" : "\(result.hoursCovered)h history")
                    .font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
            }

            Text(result.rationale).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)

            if result.hasSuggestion {
                resourceLine("CPU", current: ResourceQuantity.formatCores(result.cpuRequest ?? 0) + (result.cpuRequest == nil ? " (unset)" : "") + " / " + (result.cpuLimit.map(ResourceQuantity.formatCores) ?? "unset"),
                             suggested: ResourceQuantity.formatCores(result.suggestedCpuRequest ?? 0) + " / " + ResourceQuantity.formatCores(result.suggestedCpuLimit ?? 0),
                             observed: "peak \(ResourceQuantity.formatCores(result.cpuPeak)) · typ \(ResourceQuantity.formatCores(result.cpuTypical))")
                resourceLine("MEM", current: (result.memRequest.map(ResourceQuantity.formatBytes) ?? "unset") + " / " + (result.memLimit.map(ResourceQuantity.formatBytes) ?? "unset"),
                             suggested: ResourceQuantity.formatBytes(result.suggestedMemRequest ?? 0) + " / " + ResourceQuantity.formatBytes(result.suggestedMemLimit ?? 0),
                             observed: "peak \(ResourceQuantity.formatBytes(result.memPeak)) · typ \(ResourceQuantity.formatBytes(result.memTypical))")

                HStack(spacing: 8) {
                    Spacer()
                    actionButton("Copy", icon: "doc.on.doc", tint: Theme.Foreground.secondary) { copySnippet() }
                    actionButton("Ask Claude", icon: "bubble.left.and.bubble.right", tint: Theme.Accent.primary) { onAskClaude() }
                    actionButton("Apply", icon: "checkmark.circle", tint: Theme.Accent.primary) { onApply(applyAction()) }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func resourceLine(_ label: String, current: String, suggested: String, observed: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(Theme.Font.body(9, weight: .semibold)).tracking(0.5).foregroundStyle(Theme.Foreground.tertiary).frame(width: 34, alignment: .leading)
            Text(current).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.secondary)
            Image(systemName: "arrow.right").font(.system(size: 8)).foregroundStyle(Theme.Foreground.tertiary)
            Text(suggested).font(Theme.Font.mono(10, weight: .medium)).foregroundStyle(Theme.Accent.primary)
            Spacer()
            Text(observed).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private func actionButton(_ label: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 9))
                Text(label).font(Theme.Font.body(11, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private var requestsArg: String {
        "cpu=\(ResourceQuantity.cpuQuantityString(result.suggestedCpuRequest ?? 0)),memory=\(ResourceQuantity.memQuantityString(result.suggestedMemRequest ?? 0))"
    }
    private var limitsArg: String {
        "cpu=\(ResourceQuantity.cpuQuantityString(result.suggestedCpuLimit ?? 0)),memory=\(ResourceQuantity.memQuantityString(result.suggestedMemLimit ?? 0))"
    }

    private func applyAction() -> WorkloadAction {
        .setResources(kind: workload.kind, name: workload.name, namespace: workload.namespace,
                      container: result.container, requests: requestsArg, limits: limitsArg)
    }

    private func copySnippet() {
        let snippet = """
        resources:
          requests:
            cpu: \(ResourceQuantity.cpuQuantityString(result.suggestedCpuRequest ?? 0))
            memory: \(ResourceQuantity.memQuantityString(result.suggestedMemRequest ?? 0))
          limits:
            cpu: \(ResourceQuantity.cpuQuantityString(result.suggestedCpuLimit ?? 0))
            memory: \(ResourceQuantity.memQuantityString(result.suggestedMemLimit ?? 0))
        """
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(snippet, forType: .string)
    }
}
