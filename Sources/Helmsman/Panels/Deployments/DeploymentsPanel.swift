import SwiftUI

struct DeploymentsPanel: View {
    @Bindable var viewModel: DeploymentsViewModel
    let onAction: (Deployment, [Pod], DeploymentAction) -> Void
    var onWorkload: (WorkloadAction) -> Void = { _ in }
    var onViewYAML: (String, String, String?) -> Void = { _, _, _ in }
    /// Move a deployment (+ related resources) to another namespace — handed
    /// off to Claude by the parent.
    var onMove: (Deployment, String) -> Void = { _, _ in }
    var contextName: String? = nil

    @State private var manageDeployment: Deployment? = nil
    @State private var moveDeployment: Deployment? = nil

    private var namespaceNames: [String] {
        viewModel.cache.namespaces.map(\.metadata.name)
    }

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

            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(viewModel.filteredDeployments) { dep in
                        DeploymentRow(
                            deployment: dep,
                            isExpanded: viewModel.isExpanded(dep),
                            childPods: viewModel.pods(for: dep),
                            onToggle: { viewModel.toggleExpansion(dep) },
                            onAction: { action in
                                onAction(dep, viewModel.pods(for: dep), action)
                            },
                            onWorkload: onWorkload,
                            onViewYAML: onViewYAML,
                            onManage: { manageDeployment = dep },
                            onMove: { moveDeployment = dep }
                        )
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            }
            .background(Theme.Surface.primary)
        }
        .background(Theme.Surface.primary)
        .sheet(item: $manageDeployment) { dep in
            DeploymentManageSheet(
                deployment: dep,
                pods: viewModel.pods(for: dep),
                context: contextName,
                onClose: { manageDeployment = nil },
                onViewYAML: {
                    manageDeployment = nil
                    onViewYAML("deployment", dep.metadata.name, dep.metadata.namespace)
                },
                onWorkload: { action in
                    manageDeployment = nil
                    onWorkload(action)
                }
            )
        }
        .sheet(item: $moveDeployment) { dep in
            DeploymentMoveSheet(
                deployment: dep,
                namespaces: namespaceNames,
                onSubmit: { target in
                    moveDeployment = nil
                    onMove(dep, target)
                },
                onCancel: { moveDeployment = nil }
            )
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.deployments)
            Text("\(viewModel.filteredDeployments.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            PanelSearchField(text: $viewModel.search, maxWidth: 220)
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
}

private struct DeploymentRow: View {
    let deployment: Deployment
    let isExpanded: Bool
    let childPods: [Pod]
    let onToggle: () -> Void
    let onAction: (DeploymentAction) -> Void
    let onWorkload: (WorkloadAction) -> Void
    let onViewYAML: (String, String, String?) -> Void
    let onManage: () -> Void
    let onMove: () -> Void

    private var ready: Int { deployment.status?.readyReplicas ?? 0 }
    private var total: Int { deployment.status?.replicas ?? 0 }
    private var isHealthy: Bool { total > 0 && ready == total }

    private var desired: Int { deployment.spec?.replicas ?? deployment.status?.replicas ?? 0 }

    /// New-template pods brought up so far (the ones coming online).
    private var newUp: Int { deployment.status?.updatedReplicas ?? 0 }
    /// Old-template pods still around — these terminate as the rollout finishes.
    private var oldRemaining: Int { max(0, total - newUp) }
    /// Fraction of new pods brought up, 0...1.
    private var rolloutProgress: Double {
        guard desired > 0 else { return 0 }
        return min(1, Double(newUp) / Double(desired))
    }

    /// A rollout is in flight: desired replicas exist, no pod is in a hard error
    /// state, and the updated/ready counts haven't caught up to desired yet.
    private var isRedeploying: Bool {
        if childPods.contains(where: { $0.errorReason != nil }) { return false }
        guard desired > 0 else { return false }
        return newUp != desired || ready != desired
    }

    /// Color the deployment's name to surface its state at a glance:
    /// - red  : at least one pod is in a known error state (CrashLoop, ImagePull, Failed, …)
    /// - yellow: scaled down to zero replicas (no pods, intentional)
    /// - green: actively rolling out (updated/ready behind desired, but pods aren't erroring)
    /// - default: stable + healthy
    private var labelColor: Color {
        if childPods.contains(where: { $0.errorReason != nil }) {
            return Theme.Status.failed
        }
        if desired == 0 { return Theme.Status.pending }
        if isRedeploying { return Theme.Status.running }
        return Theme.Foreground.primary
    }

    private var fullImage: String? {
        deployment.spec?.template?.spec?.containers.first?.image
    }

    /// The image without its tag/digest — the repository path shown as a row
    /// label. `ghcr.io/foo/bar:1.2` → `ghcr.io/foo/bar`; digest refs drop `@sha…`.
    private var imageRepo: String? {
        guard let image = fullImage else { return nil }
        if let at = image.firstIndex(of: "@") { return String(image[..<at]) }
        let lastSlash = image.lastIndex(of: "/") ?? image.startIndex
        if let colon = image.range(of: ":", options: .backwards), colon.lowerBound > lastSlash {
            return String(image[..<colon.lowerBound])
        }
        return image
    }

    /// Just the tag portion of the first container's image. `postgres:16-alpine` → `16-alpine`.
    /// Digest refs collapse to the short sha; untagged falls back to `latest`.
    private var imageTag: String? {
        guard let image = fullImage else { return nil }
        // Digest form: image@sha256:abc...
        if let at = image.firstIndex(of: "@") {
            let digest = image[image.index(after: at)...]
            if let colon = digest.firstIndex(of: ":") {
                let short = digest[digest.index(after: colon)...].prefix(7)
                return "@\(short)"
            }
        }
        // Tag form: ghcr.io/foo:tag — last ":" only if it's after the final "/"
        let lastSlash = image.lastIndex(of: "/") ?? image.startIndex
        if let colon = image.range(of: ":", options: .backwards),
           colon.lowerBound > lastSlash {
            return String(image[colon.upperBound...])
        }
        return "latest"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button(action: onToggle) {
                    HStack(spacing: 10) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .frame(width: 12)

                        Text(deployment.metadata.name)
                            .font(Theme.Font.mono(12, weight: .medium))
                            .foregroundStyle(labelColor)
                            .lineLimit(1)

                        Text(deployment.metadata.namespace ?? "—")
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.Surface.sunken)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

                        if let repo = imageRepo {
                            Text(repo)
                                .font(Theme.Font.mono(10))
                                .foregroundStyle(Theme.Foreground.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .help(fullImage ?? "")
                                .layoutPriority(-1)
                        }

                        if let tag = imageTag {
                            Text(tag)
                                .font(Theme.Font.mono(10, weight: .medium))
                                .foregroundStyle(Theme.Accent.primary)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.Accent.primaryDim)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                                .help(fullImage ?? "")
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .fixedSize(horizontal: true, vertical: false)
                        }

                        Spacer(minLength: 8)

                        if isRedeploying || oldRemaining > 0 {
                            rolloutChurn
                        }

                        Text("\(ready)/\(total)")
                            .font(Theme.Font.mono(11, weight: .medium))
                            .foregroundStyle(isHealthy ? Theme.Status.running : Theme.Status.failed)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background((isHealthy ? Theme.Status.running : Theme.Status.failed).opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                ActionButtonStrip(
                    actions: DeploymentAction.allCases,
                    label: \.label,
                    systemImage: \.systemImage,
                    kind: \.kind,
                    onTap: onAction
                )
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background {
                (isExpanded ? Theme.Surface.elevated : Theme.Surface.sunken)
                    .overlay {
                        if isRedeploying {
                            LinearGradient(
                                stops: [
                                    .init(color: Theme.Status.running.opacity(0.30), location: 0),
                                    .init(color: .clear, location: 0.6),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        }
                    }
            }
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .overlay(alignment: .bottom) {
                if isRedeploying {
                    RolloutProgressBar(progress: rolloutProgress)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            .contextMenu {
                ForEach(DeploymentAction.allCases) { action in
                    Button("Ask Claude: \(action.label)") { onAction(action) }
                }
                Divider()
                Button("Manage…", action: onManage)
                Button("Move to namespace…", action: onMove)
                Button("View YAML…") {
                    onViewYAML("deployment", deployment.metadata.name, deployment.metadata.namespace)
                }
                Button("Restart…") { onWorkload(.restartDeployment(deployment)) }
                Button("Scale…") {
                    let cur = deployment.spec?.replicas ?? deployment.status?.replicas ?? 1
                    onWorkload(.scaleDeployment(deployment, to: cur))
                }
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    DeploymentSpecBlock(deployment: deployment)
                    Divider().background(Theme.Border.subtle)
                    podsListBlock
                }
                .padding(.leading, 24)
                .padding(.top, 6)
                .padding(.bottom, 6)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isExpanded)
        .animation(.easeInOut(duration: 0.35), value: isRedeploying)
    }

    /// New-up / old-terminating pod counts, shown only while a rollout is live.
    private var rolloutChurn: some View {
        HStack(spacing: 6) {
            if newUp > 0 {
                churnChip(systemImage: "arrow.up", count: newUp, color: Theme.Status.running)
            }
            if oldRemaining > 0 {
                churnChip(systemImage: "arrow.down", count: oldRemaining, color: Theme.Status.pending)
            }
        }
        .help("\(newUp) new pod(s) up · \(oldRemaining) old terminating")
        .transition(.opacity)
    }

    private func churnChip(systemImage: String, count: Int, color: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
            Text("\(count)")
                .font(Theme.Font.mono(10, weight: .medium))
        }
        .foregroundStyle(color)
    }

    private var podsListBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("PODS")
                .font(Theme.Font.body(9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            if childPods.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text("No matching pods")
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                .padding(.vertical, 4)
            } else {
                ForEach(childPods) { pod in
                    PodChildRow(pod: pod)
                }
            }
        }
    }
}

/// Thin determinate bar pinned to a deployment row's bottom edge during a
/// rollout. Fill = fraction of new-template pods brought up.
private struct RolloutProgressBar: View {
    let progress: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(Theme.Border.strong)
                Rectangle()
                    .fill(Theme.Status.running)
                    .frame(width: max(0, min(1, progress)) * geo.size.width)
                    .animation(.easeInOut(duration: 0.4), value: progress)
            }
        }
        .frame(height: 2.5)
    }
}

private struct DeploymentSpecBlock: View {
    let deployment: Deployment

    private var labelLine: String {
        let labels = deployment.spec?.selector?.matchLabels ?? [:]
        return labels.isEmpty
            ? "—"
            : labels.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SPEC")
                .font(Theme.Font.body(9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)

            row("Strategy", deployment.strategyDescription)
            row("Selector", labelLine)
            if let age = ageDescription(deployment.metadata.creationTimestamp) {
                row("Created", age)
            }

            ForEach(deployment.containerSummaries, id: \.containerName) { c in
                containerCard(c)
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.primary)
                .textSelection(.enabled)
                .lineLimit(2)
                .truncationMode(.middle)
        }
    }

    private func containerCard(_ c: ContainerResourceSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "cube.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.Accent.primary)
                Text(c.containerName)
                    .font(Theme.Font.mono(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                if !c.ports.isEmpty {
                    Text(c.ports.map { ":\($0)" }.joined(separator: " "))
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                Spacer()
            }
            if let image = c.image {
                Text(image)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            HStack(spacing: 12) {
                resourcePair(label: "CPU", req: c.cpuRequest, lim: c.cpuLimit)
                resourcePair(label: "Mem", req: c.memRequest, lim: c.memLimit)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private func resourcePair(label: String, req: String?, lim: String?) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(Theme.Font.body(9, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
            Text("req")
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(req ?? "—")
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(req != nil ? Theme.Foreground.primary : Theme.Foreground.tertiary)
            Text("/")
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text("lim")
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(lim ?? "—")
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(lim != nil ? Theme.Foreground.primary : Theme.Foreground.tertiary)
        }
    }

    private func ageDescription(_ created: Date?) -> String? {
        guard let created else { return nil }
        let dt = Date().timeIntervalSince(created)
        if dt < 60 { return "\(Int(dt))s ago" }
        if dt < 3600 { return "\(Int(dt/60))m ago" }
        if dt < 86400 { return "\(Int(dt/3600))h ago" }
        return "\(Int(dt/86400))d ago"
    }
}

private struct PodChildRow: View {
    let pod: Pod

    private var phase: String { pod.status?.phase ?? "—" }
    private var phaseColor: Color {
        switch phase {
        case "Running":   return Theme.Status.running
        case "Pending":   return Theme.Status.pending
        case "Failed":    return Theme.Status.failed
        case "Succeeded": return Theme.Status.running
        default:          return Theme.Foreground.tertiary
        }
    }
    private var restarts: Int {
        pod.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0
    }
    private var readyFrac: String {
        let statuses = pod.status?.containerStatuses ?? []
        let r = statuses.filter { $0.ready }.count
        let t = statuses.count
        return t == 0 ? "—" : "\(r)/\(t)"
    }

    /// "How long this pod has been running." Prefer the earliest container
    /// `running.startedAt` (matches restarts — a freshly-restarted container
    /// resets this) and fall back to pod creation time when no container is
    /// currently running.
    private var ageString: String? {
        let started = pod.status?.containerStatuses?
            .compactMap { $0.state?.running?.startedAt }
            .min()
        guard let since = started ?? pod.metadata.creationTimestamp else { return nil }
        let dt = Date().timeIntervalSince(since)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        if dt < 86400 { return "\(Int(dt/3600))h" }
        return "\(Int(dt/86400))d"
    }

    var body: some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(Theme.Border.strong)
                .frame(width: 1, height: 14)
            Circle()
                .fill(phaseColor)
                .frame(width: 6, height: 6)
            Text(pod.metadata.name)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if restarts > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 8))
                    Text("\(restarts)")
                        .font(Theme.Font.mono(10))
                }
                .foregroundStyle(Theme.Status.pending)
            }
            Text(readyFrac)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
            if let age = ageString {
                Text(age)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(minWidth: 28, alignment: .trailing)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.Surface.sunken.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
