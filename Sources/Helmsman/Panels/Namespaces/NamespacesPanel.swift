import SwiftUI

struct NamespacesPanel: View {
    @Bindable var viewModel: NamespacesViewModel
    let onCreate: () -> Void
    let onDelete: (Namespace) -> Void
    let onViewYAML: (_ kind: String, _ name: String, _ namespace: String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            searchBar

            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }

            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(viewModel.filteredNamespaces) { ns in
                        NamespaceRow(namespace: ns, podCount: viewModel.podCount(ns))
                            .contextMenu {
                                Button("View YAML") { onViewYAML("namespace", ns.metadata.name, nil) }
                                Divider()
                                Button("Delete namespace", role: .destructive) { onDelete(ns) }
                            }
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
            }
        }
        .background(Theme.Surface.primary)
        .background {
            Button("New namespace", action: onCreate)
                .keyboardShortcut("n", modifiers: .command)
                .hidden()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Namespaces")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filteredNamespaces.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            if viewModel.isLoading {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
            Button(action: onCreate) {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 10, weight: .semibold))
                    Text("New").font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(Theme.Foreground.inverse)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Accent.primary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Create a new namespace (⌘N)")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var searchBar: some View {
        PanelSearchField(text: $viewModel.search, maxWidth: 240)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }
}

private struct NamespaceRow: View {
    let namespace: Namespace
    let podCount: Int

    private var phaseColor: Color {
        switch namespace.phase {
        case "Active":      return Theme.Status.running
        case "Terminating": return Theme.Status.pending
        default:            return Theme.Foreground.tertiary
        }
    }

    private var ageString: String? {
        guard let created = namespace.metadata.creationTimestamp else { return nil }
        let dt = Date().timeIntervalSince(created)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        if dt < 86400 { return "\(Int(dt/3600))h" }
        return "\(Int(dt/86400))d"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "square.dashed")
                .font(.system(size: 10)).foregroundStyle(Theme.Accent.primary).frame(width: 12)
            Text(namespace.metadata.name)
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary).lineLimit(1)
            Text(namespace.phase)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(phaseColor)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(phaseColor.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer(minLength: 8)
            Text("\(podCount) pod\(podCount == 1 ? "" : "s")")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
            if let age = ageString {
                Text(age)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(minWidth: 32, alignment: .trailing)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.sunken)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}
