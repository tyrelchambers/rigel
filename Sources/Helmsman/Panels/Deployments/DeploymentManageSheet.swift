import SwiftUI

/// Manage sheet for a single deployment. Rancher-style: structured summary
/// from cache state, a control bar (Restart / Pause-Resume / Rollback), an
/// inline scale row with Apply, then live `kubectl describe` for the long
/// tail (rollout history, conditions, recent events).
struct DeploymentManageSheet: View {
    let deployment: Deployment
    let pods: [Pod]
    let context: String?
    let onClose: () -> Void
    let onViewYAML: () -> Void
    let onWorkload: (WorkloadAction) -> Void

    @State private var desiredReplicas: Int

    init(
        deployment: Deployment,
        pods: [Pod],
        context: String?,
        onClose: @escaping () -> Void,
        onViewYAML: @escaping () -> Void,
        onWorkload: @escaping (WorkloadAction) -> Void
    ) {
        self.deployment = deployment
        self.pods = pods
        self.context = context
        self.onClose = onClose
        self.onViewYAML = onViewYAML
        self.onWorkload = onWorkload
        _desiredReplicas = State(initialValue: deployment.spec?.replicas ?? deployment.status?.replicas ?? 0)
    }

    @State private var describe: String = ""
    @State private var isLoadingDescribe = true
    @State private var describeError: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    controlsBlock
                    summary
                    containersBlock
                    podsBlock
                    describeBlock
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
        }
        .frame(width: 760, height: 660)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
        .task { await loadDescribe() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "square.stack.3d.up.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(deployment.metadata.name)
                    .font(Theme.Font.mono(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("Deployment · \(deployment.metadata.namespace ?? "default")")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Spacer()
            Button(action: onViewYAML) {
                HStack(spacing: 5) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 10))
                    Text("YAML")
                        .font(Theme.Font.body(13, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 22, height: 22)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    // MARK: - Controls

    private var isPaused: Bool { deployment.spec?.paused == true }
    private var currentReplicas: Int { deployment.spec?.replicas ?? deployment.status?.replicas ?? 0 }

    private var controlsBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CONTROLS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)

            // Scale row with stepper + Apply
            HStack(spacing: 10) {
                Text("Replicas")
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .frame(width: 80, alignment: .leading)
                Text("\(currentReplicas)")
                    .font(Theme.Font.mono(13))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Image(systemName: "arrow.right")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Stepper(value: $desiredReplicas, in: 0...50) {
                    Text("\(desiredReplicas)")
                        .font(Theme.Font.mono(13, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.primary)
                        .frame(minWidth: 24, alignment: .leading)
                }
                .labelsHidden()
                Spacer()
                Button {
                    onWorkload(.scaleDeployment(deployment, to: desiredReplicas))
                } label: {
                    Text("Apply scale")
                        .font(Theme.Font.body(12, weight: .semibold))
                        .foregroundStyle(desiredReplicas == currentReplicas ? Theme.Foreground.tertiary : Theme.Foreground.inverse)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(desiredReplicas == currentReplicas ? Theme.Surface.sunken : Theme.Accent.primary)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
                .disabled(desiredReplicas == currentReplicas)
            }
            .padding(10)
            .background(Theme.Surface.sunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

            // Action buttons row
            HStack(spacing: 8) {
                actionButton(label: "Restart", icon: "arrow.clockwise", tint: Theme.Accent.primary) {
                    onWorkload(.restartDeployment(deployment))
                }
                if isPaused {
                    actionButton(label: "Resume rollout", icon: "play.fill", tint: Theme.Status.running) {
                        onWorkload(.resumeDeployment(deployment))
                    }
                } else {
                    actionButton(label: "Pause rollout", icon: "pause.fill", tint: Theme.Status.pending) {
                        onWorkload(.pauseDeployment(deployment))
                    }
                }
                actionButton(label: "Rollback", icon: "arrow.uturn.backward", tint: Theme.Status.failed) {
                    onWorkload(.rollbackDeployment(deployment))
                }
                Spacer()
                if isPaused {
                    HStack(spacing: 4) {
                        Image(systemName: "pause.circle.fill").font(.system(size: 10))
                        Text("ROLLOUT PAUSED")
                            .font(Theme.Font.body(10, weight: .semibold))
                            .tracking(0.5)
                    }
                    .foregroundStyle(Theme.Status.pending)
                }
            }
        }
        .padding(12)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func actionButton(label: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 10))
                Text(label).font(Theme.Font.body(12, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(tint.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(tint.opacity(0.3), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Summary card

    private var summary: some View {
        let ready = deployment.status?.readyReplicas ?? 0
        let desired = deployment.spec?.replicas ?? deployment.status?.replicas ?? 0
        let available = deployment.status?.availableReplicas ?? 0
        let updated = deployment.status?.updatedReplicas ?? 0
        let healthy = desired > 0 && ready == desired
        return VStack(alignment: .leading, spacing: 8) {
            Text("STATUS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            kvRow("Replicas", "\(ready) / \(desired) ready",
                  color: healthy ? Theme.Status.running : Theme.Status.failed)
            kvRow("Available", "\(available)")
            kvRow("Updated", "\(updated)")
            kvRow("Strategy", deployment.strategyDescription)
            kvRow("Selector", selectorString)
            if let age = ageDescription(deployment.metadata.creationTimestamp) {
                kvRow("Age", age)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private var selectorString: String {
        let labels = deployment.spec?.selector?.matchLabels ?? [:]
        return labels.isEmpty
            ? "—"
            : labels.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
    }

    private func kvRow(_ key: String, _ value: String, color: Color? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key)
                .font(Theme.Font.body(12, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(Theme.Font.mono(13))
                .foregroundStyle(color ?? Theme.Foreground.primary)
                .textSelection(.enabled)
                .lineLimit(3)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Containers

    private var containersBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CONTAINERS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            let containers = deployment.spec?.template?.spec?.containers ?? []
            if containers.isEmpty {
                Text("No containers in pod template")
                    .font(Theme.Font.mono(13))
                    .foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(containers, id: \.name) { c in
                    containerCard(c)
                }
            }
        }
    }

    private func containerCard(_ c: Container) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "cube.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.Accent.primary)
                Text(c.name)
                    .font(Theme.Font.mono(13, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                if let ports = c.ports, !ports.isEmpty {
                    Text(ports.map { ":\($0.containerPort)" }.joined(separator: " "))
                        .font(Theme.Font.mono(12))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                Spacer()
            }
            if let image = c.image {
                Text(image)
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            HStack(spacing: 12) {
                resourcePair("CPU", req: c.resources?.requests?["cpu"], lim: c.resources?.limits?["cpu"])
                resourcePair("Mem", req: c.resources?.requests?["memory"], lim: c.resources?.limits?["memory"])
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private func resourcePair(_ label: String, req: String?, lim: String?) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
            Text("req").font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.tertiary)
            Text(req ?? "—")
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(req != nil ? Theme.Foreground.primary : Theme.Foreground.tertiary)
            Text("/").font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.tertiary)
            Text("lim").font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.tertiary)
            Text(lim ?? "—")
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(lim != nil ? Theme.Foreground.primary : Theme.Foreground.tertiary)
        }
    }

    // MARK: - Pods owned

    private var podsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PODS (\(pods.count))")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            if pods.isEmpty {
                Text("No pods match this deployment's selector")
                    .font(Theme.Font.mono(13))
                    .foregroundStyle(Theme.Foreground.tertiary)
            } else {
                VStack(spacing: 2) {
                    ForEach(pods) { pod in
                        podRow(pod)
                    }
                }
            }
        }
    }

    private func podRow(_ pod: Pod) -> some View {
        let phase = pod.status?.phase ?? "—"
        let restarts = pod.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0
        return HStack(spacing: 10) {
            Circle().fill(phaseColor(phase)).frame(width: 6, height: 6)
            Text(pod.metadata.name)
                .font(Theme.Font.mono(13))
                .foregroundStyle(Theme.Foreground.primary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if restarts > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.clockwise").font(.system(size: 8))
                    Text("\(restarts)").font(Theme.Font.mono(12))
                }
                .foregroundStyle(Theme.Status.pending)
            }
            Text(phase)
                .font(Theme.Font.mono(12))
                .foregroundStyle(phaseColor(phase))
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private func phaseColor(_ phase: String) -> Color {
        switch phase {
        case "Running":   return Theme.Status.running
        case "Pending":   return Theme.Status.pending
        case "Failed":    return Theme.Status.failed
        case "Succeeded": return Theme.Status.running
        default:          return Theme.Foreground.tertiary
        }
    }

    // MARK: - kubectl describe

    private var describeBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("KUBECTL DESCRIBE")
                    .font(Theme.Font.body(11, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                if isLoadingDescribe {
                    ProgressView().controlSize(.mini).tint(Theme.Accent.primary)
                }
                Spacer()
            }
            if let describeError {
                Text(describeError)
                    .font(Theme.Font.mono(13))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            } else if !describe.isEmpty {
                Text(describe)
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Theme.Surface.elevated)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm)
                            .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    // MARK: - Helpers

    private func ageDescription(_ created: Date?) -> String? {
        guard let created else { return nil }
        let dt = Date().timeIntervalSince(created)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        if dt < 86400 { return "\(Int(dt/3600))h" }
        return "\(Int(dt/86400))d"
    }

    private func loadDescribe() async {
        guard let kubectl = resolveBinary("kubectl") else {
            await MainActor.run { describeError = "kubectl not found"; isLoadingDescribe = false }
            return
        }
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["describe", "deployment", deployment.metadata.name])
        if let ns = deployment.metadata.namespace { args.append(contentsOf: ["-n", ns]) }
        do {
            let data = try await runProcess(kubectl, args: args)
            await MainActor.run {
                describe = String(data: data, encoding: .utf8) ?? ""
                isLoadingDescribe = false
            }
        } catch ProcessError.nonZeroExit(let code, let stderr) {
            await MainActor.run {
                describeError = "kubectl exited \(code):\n\(stderr)"
                isLoadingDescribe = false
            }
        } catch {
            await MainActor.run {
                describeError = "\(error)"
                isLoadingDescribe = false
            }
        }
    }
}
