import SwiftUI
import Foundation

struct WorkloadsPanel: View {
    @Bindable var viewModel: WorkloadsViewModel
    let onViewYAML: (_ kind: String, _ name: String, _ namespace: String?) -> Void
    let onWorkload: (WorkloadAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            kindBar

            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }

            list
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.workloads)
            Text("\(viewModel.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            PanelSearchField(text: $viewModel.search, maxWidth: 200)
            if viewModel.isLoading {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var kindBar: some View {
        HStack(spacing: 6) {
            ForEach(WorkloadKind.allCases) { k in
                WorkloadPill(label: k.title, isActive: viewModel.kind == k) { viewModel.kind = k }
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                switch viewModel.kind {
                case .statefulSets:
                    ForEach(viewModel.filteredStatefulSets) { sts in
                        WorkloadCard {
                            StatefulSetRowContent(sts: sts)
                        }
                        .contextMenu {
                            let ns = sts.metadata.namespace ?? "default"
                            Button("Restart…") { onWorkload(.restartWorkload(kind: "statefulset", name: sts.metadata.name, namespace: ns)) }
                            Button("Scale…") {
                                let cur = sts.spec?.replicas ?? sts.status?.replicas ?? 1
                                onWorkload(.scaleWorkload(kind: "statefulset", name: sts.metadata.name, namespace: ns, current: cur, to: cur))
                            }
                            Button("View YAML") { onViewYAML("statefulset", sts.metadata.name, sts.metadata.namespace) }
                            Divider()
                            Button("Delete StatefulSet", role: .destructive) {
                                onWorkload(.deleteWorkload(kind: "statefulset", name: sts.metadata.name, namespace: ns))
                            }
                        }
                    }
                case .daemonSets:
                    ForEach(viewModel.filteredDaemonSets) { ds in
                        WorkloadCard {
                            DaemonSetRowContent(ds: ds)
                        }
                        .contextMenu {
                            let ns = ds.metadata.namespace ?? "default"
                            Button("Restart…") { onWorkload(.restartWorkload(kind: "daemonset", name: ds.metadata.name, namespace: ns)) }
                            Button("View YAML") { onViewYAML("daemonset", ds.metadata.name, ds.metadata.namespace) }
                            Divider()
                            Button("Delete DaemonSet", role: .destructive) {
                                onWorkload(.deleteWorkload(kind: "daemonset", name: ds.metadata.name, namespace: ns))
                            }
                        }
                    }
                case .jobs:
                    ForEach(viewModel.filteredJobs) { job in
                        WorkloadCard {
                            JobRowContent(job: job)
                        }
                        .contextMenu {
                            let ns = job.metadata.namespace ?? "default"
                            Button("View YAML") { onViewYAML("job", job.metadata.name, job.metadata.namespace) }
                            Divider()
                            Button("Delete Job", role: .destructive) {
                                onWorkload(.deleteWorkload(kind: "job", name: job.metadata.name, namespace: ns))
                            }
                        }
                    }
                case .cronJobs:
                    ForEach(viewModel.filteredCronJobs) { cj in
                        WorkloadCard {
                            CronJobRowContent(cronJob: cj)
                        }
                        .contextMenu {
                            let ns = cj.metadata.namespace ?? "default"
                            Button("Trigger now…") {
                                onWorkload(.triggerCronJob(name: cj.metadata.name, namespace: ns, jobName: CronJob.manualRunName(for: cj.metadata.name)))
                            }
                            Button(cj.isSuspended ? "Resume…" : "Suspend…") {
                                onWorkload(.setCronJobSuspend(name: cj.metadata.name, namespace: ns, suspend: !cj.isSuspended))
                            }
                            Button("View YAML") { onViewYAML("cronjob", cj.metadata.name, cj.metadata.namespace) }
                            Divider()
                            Button("Delete CronJob", role: .destructive) {
                                onWorkload(.deleteWorkload(kind: "cronjob", name: cj.metadata.name, namespace: ns))
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
}

// MARK: - Shared bits

private struct WorkloadPill: View {
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

private struct WorkloadCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.sunken)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}

private struct NameNs: View {
    let icon: String
    let name: String
    let namespace: String?
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(Theme.Accent.primary).frame(width: 12)
            Text(name).font(Theme.Font.mono(12, weight: .medium)).foregroundStyle(Theme.Foreground.primary).lineLimit(1)
            if let ns = namespace {
                Text(ns).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Theme.Surface.elevated).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }
}

private func readyFraction(_ ready: Int, _ desired: Int) -> some View {
    let healthy = desired > 0 && ready == desired
    return Text("\(ready)/\(desired)")
        .font(Theme.Font.mono(11, weight: .medium))
        .foregroundStyle(healthy ? Theme.Status.running : Theme.Status.failed)
        .padding(.horizontal, 8).padding(.vertical, 2)
        .background((healthy ? Theme.Status.running : Theme.Status.failed).opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
}

private struct WorkloadPhaseBadge: View {
    let phase: String
    private var color: Color {
        switch phase {
        case "Complete":            return Theme.Status.running
        case "Running":             return Theme.Status.running
        case "Failed":              return Theme.Status.failed
        case "Pending", "Suspended": return Theme.Status.pending
        default:                    return Theme.Foreground.tertiary
        }
    }
    var body: some View {
        Text(phase)
            .font(Theme.Font.mono(10, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

// MARK: - Row contents

private struct StatefulSetRowContent: View {
    let sts: StatefulSet
    var body: some View {
        HStack(spacing: 10) {
            NameNs(icon: "square.stack.3d.up.fill", name: sts.metadata.name, namespace: sts.metadata.namespace)
            Spacer(minLength: 8)
            readyFraction(sts.status?.readyReplicas ?? 0, sts.spec?.replicas ?? sts.status?.replicas ?? 0)
        }
    }
}

private struct DaemonSetRowContent: View {
    let ds: DaemonSet
    var body: some View {
        HStack(spacing: 10) {
            NameNs(icon: "square.grid.3x3.fill", name: ds.metadata.name, namespace: ds.metadata.namespace)
            Spacer(minLength: 8)
            readyFraction(ds.ready, ds.desired)
        }
    }
}

private struct JobRowContent: View {
    let job: Job
    var body: some View {
        HStack(spacing: 10) {
            NameNs(icon: "play.square.fill", name: job.metadata.name, namespace: job.metadata.namespace)
            WorkloadPhaseBadge(phase: job.phase)
            Spacer(minLength: 8)
            if let d = job.duration {
                Text(d).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
            }
            Text(job.completionsLabel)
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
        }
    }
}

private struct CronJobRowContent: View {
    let cronJob: CronJob
    var body: some View {
        HStack(spacing: 10) {
            NameNs(icon: "clock.fill", name: cronJob.metadata.name, namespace: cronJob.metadata.namespace)
            Text(cronJob.schedule)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Accent.primary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Accent.primary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            if cronJob.isSuspended {
                WorkloadPhaseBadge(phase: "Suspended")
            }
            Spacer(minLength: 8)
            if cronJob.activeCount > 0 {
                Text("\(cronJob.activeCount) active")
                    .font(Theme.Font.mono(10)).foregroundStyle(Theme.Status.running)
            }
            if let last = cronJob.lastScheduleAgo {
                Text(last).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
            }
        }
    }
}
