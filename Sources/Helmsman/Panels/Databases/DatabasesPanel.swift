import SwiftUI

struct DatabasesPanel: View {
    @Bindable var viewModel: DatabasesViewModel
    let onAction: (WorkloadAction) -> Void
    let onPortForward: (ConnectionInfo) -> Void
    let onRevealCredentials: (_ secretName: String, _ namespace: String) -> Void
    let onCopyDSN: (String) -> Void

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

            if !viewModel.cnpgAvailable && viewModel.instances.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.databases)
            Text("\(viewModel.instances.count)")
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

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "cylinder.split.1x2")
                .font(.system(size: 28))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text("No databases detected")
                .font(Theme.Font.body(13, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
            Text("Nothing matched a known database operator CRD\nor a recognized database image.")
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(viewModel.instances) { inst in
                    DatabaseRow(
                        instance: inst,
                        capabilities: viewModel.capabilities(for: inst),
                        isExpanded: viewModel.isExpanded(inst),
                        nodes: viewModel.nodes(for: inst),
                        childPods: viewModel.isExpanded(inst) ? viewModel.pods(for: inst) : [],
                        pluginMissing: inst.source == .cnpg && !viewModel.cnpgPluginAvailable,
                        installingPlugin: viewModel.installingPlugin,
                        onInstallPlugin: { Task { await viewModel.installCNPGPlugin() } },
                        onToggle: { viewModel.toggleExpansion(inst) },
                        onAction: onAction,
                        onPortForward: onPortForward,
                        onRevealCredentials: onRevealCredentials,
                        onCopyDSN: onCopyDSN
                    )
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
}

private struct DatabaseRow: View {
    let instance: DatabaseInstance
    let capabilities: DatabaseCapabilities
    let isExpanded: Bool
    let nodes: [String]
    let childPods: [Pod]
    /// CNPG instance whose `kubectl-cnpg` plugin isn't installed → offer install.
    let pluginMissing: Bool
    let installingPlugin: Bool
    let onInstallPlugin: () -> Void
    let onToggle: () -> Void
    let onAction: (WorkloadAction) -> Void
    let onPortForward: (ConnectionInfo) -> Void
    let onRevealCredentials: (_ secretName: String, _ namespace: String) -> Void
    let onCopyDSN: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .frame(width: 12)

                    KindChip(kind: instance.kind)

                    Text(instance.name)
                        .font(Theme.Font.mono(12, weight: .medium))
                        .foregroundStyle(Theme.Foreground.primary)
                        .lineLimit(1)

                    Text(instance.namespace)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Surface.sunken)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

                    SourceBadge(source: instance.source)

                    Spacer(minLength: 8)

                    if let primary = instance.cnpgPrimary {
                        Text("primary: \(primary)")
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Accent.primary)
                    }

                    if !nodes.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "server.rack")
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.Foreground.tertiary)
                            Text(nodes.joined(separator: ", "))
                                .font(Theme.Font.mono(10))
                                .foregroundStyle(Theme.Foreground.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .help(nodes.count == 1 ? "Node: \(nodes[0])" : "Nodes: \(nodes.joined(separator: ", "))")
                    }

                    Text("\(instance.readyReplicas)/\(instance.desiredReplicas)")
                        .font(Theme.Font.mono(11, weight: .medium))
                        .foregroundStyle(instance.isHealthy ? Theme.Status.running : Theme.Status.failed)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background((instance.isHealthy ? Theme.Status.running : Theme.Status.failed).opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(isExpanded ? Theme.Surface.elevated : Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)

            if isExpanded {
                expandedDetails
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isExpanded)
    }

    @ViewBuilder private var installPluginButton: some View {
        Button(action: onInstallPlugin) {
            HStack(spacing: 4) {
                if installingPlugin {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.down.circle")
                }
                Text(installingPlugin ? "Installing…" : "Install kubectl-cnpg")
                    .font(Theme.Font.body(11, weight: .medium))
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.Accent.primary.opacity(0.15))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm)
            .strokeBorder(Theme.Accent.primary.opacity(0.4), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .foregroundStyle(Theme.Accent.primary)
        .disabled(installingPlugin)
        .help("Install the kubectl-cnpg plugin to enable CNPG actions")
    }

    @ViewBuilder private var actionBar: some View {
        if pluginMissing || !capabilities.actions.isEmpty {
            HStack(spacing: 6) {
                if pluginMissing { installPluginButton }
                ForEach(capabilities.actions) { item in
                    Button { perform(item.action) } label: {
                        Label(item.action.label, systemImage: item.action.systemImage)
                            .font(Theme.Font.body(11, weight: .medium))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Theme.Surface.elevated)
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .foregroundStyle(item.enabled ? Theme.Foreground.primary : Theme.Foreground.tertiary)
                    .disabled(!item.enabled)
                    .help(item.disabledReason ?? item.action.label)
                }
            }
            .padding(.bottom, 4)
        }
    }

    @ViewBuilder private var connectionSection: some View {
        if let conn = capabilities.connection {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("CONNECT")
                    .font(Theme.Font.body(9, weight: .semibold)).tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary).frame(width: 60, alignment: .leading)
                // Match the real in-cluster DNS: services resolve at <name>.<ns>.svc.
                Text("\(conn.targetName).\(conn.namespace)\(conn.targetKind == "svc" ? ".svc" : ""):\(conn.port)")
                    .font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.primary)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private var backupSection: some View {
        if let b = capabilities.backupInfo {
            VStack(alignment: .leading, spacing: 4) {
                Text("BACKUPS & HEALTH")
                    .font(Theme.Font.body(9, weight: .semibold)).tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary).padding(.top, 4)
                kv("Last backup", b.lastBackup ?? "never")
                kv("Schedule", b.schedule ?? "none configured")
                HStack(spacing: 6) {
                    Text("WAL archiving")
                        .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                        .frame(width: 90, alignment: .leading)
                    let healthy = b.walArchivingHealthy
                    Circle().fill(healthy == true ? Theme.Status.running
                                  : healthy == false ? Theme.Status.failed : Theme.Foreground.tertiary)
                        .frame(width: 6, height: 6)
                    Text(healthy == true ? "healthy" : healthy == false ? "failing" : "unknown")
                        .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.secondary)
                }
            }
        }
    }

    private func kv(_ k: String, _ v: String) -> some View {
        HStack(spacing: 6) {
            Text(k).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                .frame(width: 90, alignment: .leading)
            Text(v).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.primary)
        }
    }

    private func perform(_ action: DatabaseAction) {
        let ns = instance.namespace
        switch action {
        case .backupNow:
            onAction(.cnpgBackupNow(cluster: instance.name, namespace: ns))
        case .switchover(let to):
            guard !to.isEmpty else { return }
            onAction(.cnpgSwitchover(cluster: instance.name, namespace: ns, to: to))
        case .hibernate:
            onAction(.cnpgHibernate(cluster: instance.name, namespace: ns, on: true))
        case .resume:
            onAction(.cnpgHibernate(cluster: instance.name, namespace: ns, on: false))
        case .scale(let current, _):
            if instance.source == .cnpg {
                onAction(.scaleCNPG(cluster: instance.name, namespace: ns, current: current, to: current))
            } else {
                let kind = instance.source == .statefulset ? "statefulset" : "deployment"
                onAction(.scaleWorkload(kind: kind, name: instance.name, namespace: ns, current: current, to: current))
            }
        case .portForward:
            if let c = capabilities.connection { onPortForward(c) }
        case .revealCredentials:
            if let c = capabilities.connection, let s = c.secretName { onRevealCredentials(s, c.namespace) }
        case .copyDSN:
            if let c = capabilities.connection { onCopyDSN(DatabasesViewModel.dsn(for: c)) }
        }
    }

    private var expandedDetails: some View {
        VStack(alignment: .leading, spacing: 6) {
            actionBar
            if let image = instance.image {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("IMAGE")
                        .font(Theme.Font.body(9, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .frame(width: 60, alignment: .leading)
                    Text(image)
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Foreground.primary)
                        .textSelection(.enabled)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("STATUS")
                    .font(Theme.Font.body(9, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 60, alignment: .leading)
                Text(instance.phaseText)
                    .font(Theme.Font.body(12))
                    .foregroundStyle(instance.isHealthy ? Theme.Status.running : Theme.Foreground.primary)
            }

            if !childPods.isEmpty {
                Text("PODS")
                    .font(Theme.Font.body(9, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(.top, 4)
                VStack(spacing: 2) {
                    ForEach(childPods) { pod in
                        PodChildRow(pod: pod, primary: pod.metadata.name == instance.cnpgPrimary)
                    }
                }
            } else {
                Text("No matching pods")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(.top, 4)
            }
            connectionSection
            backupSection
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .padding(.top, 4)
    }
}

private struct KindChip: View {
    let kind: DatabaseKind
    var body: some View {
        Text(kind.displayName)
            .font(Theme.Font.mono(9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(kind.accent)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(kind.accent.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct SourceBadge: View {
    let source: DatabaseSource

    var body: some View {
        Text(label)
            .font(Theme.Font.mono(9))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(Theme.Foreground.tertiary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.strong, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var label: String {
        switch source {
        case .cnpg:        return "CNPG"
        case .deployment:  return "Deploy"
        case .statefulset: return "STS"
        }
    }
}

private struct PodChildRow: View {
    let pod: Pod
    let primary: Bool

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

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.Border.strong).frame(width: 1, height: 14)
            Circle().fill(phaseColor).frame(width: 6, height: 6)
            Text(pod.metadata.name)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.secondary)
            if primary {
                Text("primary")
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .foregroundStyle(Theme.Accent.primary)
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Theme.Accent.primary.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            Spacer()
            if let node = pod.spec?.nodeName {
                HStack(spacing: 4) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text(node)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .lineLimit(1)
                }
            }
            Text(phase)
                .font(Theme.Font.mono(10))
                .foregroundStyle(phaseColor)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
    }
}
