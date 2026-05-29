import SwiftUI

/// Manage sheet for a single pod — structured summary built from what we
/// already have in the cache, a small action row (Tail logs / Run command /
/// Delete), then the live `kubectl describe` output for the long tail.
struct PodManageSheet: View {
    let pod: Pod
    let context: String?
    let onClose: () -> Void
    let onViewYAML: () -> Void
    let onTailLogs: () -> Void
    let onExec: () -> Void
    let onDelete: () -> Void

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
                    describeBlock
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
        }
        .frame(width: 760, height: 640)
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
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(pod.metadata.name)
                    .font(Theme.Font.mono(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("Pod · \(pod.metadata.namespace ?? "default")")
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

    private var controlsBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CONTROLS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            HStack(spacing: 8) {
                actionButton(label: "Tail logs", icon: "text.alignleft", tint: Theme.Accent.primary, action: onTailLogs)
                actionButton(label: "Run command", icon: "terminal", tint: Theme.Foreground.secondary, action: onExec)
                Spacer()
                actionButton(label: "Delete pod", icon: "trash", tint: Theme.Status.failed, action: onDelete)
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
        VStack(alignment: .leading, spacing: 8) {
            Text("STATUS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)

            kvRow("Phase", pod.status?.phase ?? "—", color: phaseColor)
            kvRow("Node", pod.spec?.nodeName ?? "—")
            kvRow("Pod IP", pod.status?.podIP ?? "—")
            kvRow("Restarts", "\(totalRestarts)")
            if let age = ageDescription(pod.metadata.creationTimestamp) {
                kvRow("Age", age)
            }
            if let labels = pod.metadata.labels, !labels.isEmpty {
                kvRow("Labels", labels.sorted(by: { $0.key < $1.key })
                    .map { "\($0.key)=\($0.value)" }.joined(separator: ", "))
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

    private func kvRow(_ key: String, _ value: String, color: Color? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key)
                .font(Theme.Font.body(12, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
                .frame(width: 70, alignment: .leading)
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
            let containers = pod.spec?.containers ?? []
            let statusesByName = Dictionary(
                uniqueKeysWithValues: (pod.status?.containerStatuses ?? []).map { ($0.name, $0) }
            )
            ForEach(containers, id: \.name) { c in
                containerCard(c, status: statusesByName[c.name])
            }
        }
    }

    private func containerCard(_ c: Container, status: ContainerStatus?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle()
                    .fill(status?.ready == true ? Theme.Status.running : Theme.Status.failed)
                    .frame(width: 6, height: 6)
                Text(c.name)
                    .font(Theme.Font.mono(13, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                if let ports = c.ports, !ports.isEmpty {
                    Text(ports.map { ":\($0.containerPort)" }.joined(separator: " "))
                        .font(Theme.Font.mono(12))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                Spacer()
                if let status {
                    Text("restarts \(status.restartCount)")
                        .font(Theme.Font.mono(12))
                        .foregroundStyle(status.restartCount > 0 ? Theme.Status.pending : Theme.Foreground.tertiary)
                }
            }
            if let image = c.image {
                Text(image)
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let state = status?.state {
                stateLine(state)
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

    @ViewBuilder
    private func stateLine(_ state: ContainerState) -> some View {
        if let w = state.waiting {
            Text("waiting · \(w.reason ?? "?")\(w.message.map { ": \($0)" } ?? "")")
                .font(Theme.Font.mono(12))
                .foregroundStyle(Theme.Status.pending)
                .textSelection(.enabled)
        } else if state.running != nil {
            Text("running")
                .font(Theme.Font.mono(12))
                .foregroundStyle(Theme.Status.running)
                .textSelection(.enabled)
        } else if let t = state.terminated {
            Text("terminated · \(t.reason ?? "?")\(t.exitCode.map { " (exit \($0))" } ?? "")")
                .font(Theme.Font.mono(12))
                .foregroundStyle(Theme.Status.failed)
                .textSelection(.enabled)
        }
    }

    private func resourcePair(_ label: String, req: String?, lim: String?) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
            Text("req")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(req ?? "—")
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(req != nil ? Theme.Foreground.primary : Theme.Foreground.tertiary)
            Text("/").font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.tertiary)
            Text("lim")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(lim ?? "—")
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(lim != nil ? Theme.Foreground.primary : Theme.Foreground.tertiary)
        }
    }

    // MARK: - describe (raw)

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

    private var totalRestarts: Int {
        (pod.status?.containerStatuses ?? []).map(\.restartCount).reduce(0, +)
    }

    private var phaseColor: Color {
        switch pod.status?.phase {
        case "Running":   return Theme.Status.running
        case "Pending":   return Theme.Status.pending
        case "Failed":    return Theme.Status.failed
        case "Succeeded": return Theme.Status.running
        default:          return Theme.Foreground.tertiary
        }
    }

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
        args.append(contentsOf: ["describe", "pod", pod.metadata.name])
        if let ns = pod.metadata.namespace { args.append(contentsOf: ["-n", ns]) }
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
