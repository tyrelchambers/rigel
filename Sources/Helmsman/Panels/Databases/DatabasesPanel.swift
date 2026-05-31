import SwiftUI

struct DatabasesPanel: View {
    @Bindable var viewModel: DatabasesViewModel

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
                        isExpanded: viewModel.isExpanded(inst),
                        nodes: viewModel.nodes(for: inst),
                        childPods: viewModel.isExpanded(inst) ? viewModel.pods(for: inst) : [],
                        onToggle: { viewModel.toggleExpansion(inst) }
                    )
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
}

private struct DatabaseRow: View {
    let instance: DatabaseInstance
    let isExpanded: Bool
    let nodes: [String]
    let childPods: [Pod]
    let onToggle: () -> Void

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

    private var expandedDetails: some View {
        VStack(alignment: .leading, spacing: 6) {
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
