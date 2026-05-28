import SwiftUI

struct SecretsPanel: View {
    @Bindable var viewModel: SecretsViewModel
    let onManage: (Secret) -> Void
    let onNew: () -> Void
    let onViewYAML: (String, String, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            namespaceFilterBar

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
                    ForEach(viewModel.filteredSecrets) { s in
                        SecretRow(secret: s, onManage: { onManage(s) }, onViewYAML: {
                            onViewYAML("secret", s.metadata.name, s.metadata.namespace)
                        })
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            }
            .background(Theme.Surface.primary)
        }
        .background(Theme.Surface.primary)
        .background {
            Button("New secret", action: onNew)
                .keyboardShortcut("n", modifiers: .command)
                .hidden()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Secrets")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filteredSecrets.count)")
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
            Button(action: onNew) {
                HStack(spacing: 5) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                    Text("New")
                        .font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(Theme.Foreground.inverse)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Accent.primary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Create a new secret (⌘N)")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var namespaceFilterBar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    SecretsNamespacePill(label: "all", isActive: viewModel.namespaceFilter == nil) {
                        viewModel.namespaceFilter = nil
                    }
                    ForEach(viewModel.availableNamespaces, id: \.self) { ns in
                        SecretsNamespacePill(label: ns, isActive: viewModel.namespaceFilter == ns) {
                            viewModel.namespaceFilter = ns
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                TextField("search", text: $viewModel.search)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .frame(maxWidth: 220)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}

private struct SecretsNamespacePill: View {
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(isActive ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(isActive ? Theme.Accent.primary : Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(isActive ? Color.clear : Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct SecretRow: View {
    let secret: Secret
    let onManage: () -> Void
    let onViewYAML: () -> Void

    private var keyCount: Int { secret.data?.count ?? 0 }

    private var ageString: String? {
        guard let created = secret.metadata.creationTimestamp else { return nil }
        let dt = Date().timeIntervalSince(created)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        if dt < 86400 { return "\(Int(dt/3600))h" }
        return "\(Int(dt/86400))d"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "key.fill")
                .font(.system(size: 10))
                .foregroundStyle(Theme.Accent.primary)
                .frame(width: 12)

            Text(secret.metadata.name)
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
                .lineLimit(1)

            Text(secret.metadata.namespace ?? "—")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

            Text(secret.secretType.displayName)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(Theme.Accent.primary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Accent.primaryDim)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .help(secret.type ?? "Opaque")

            Spacer(minLength: 8)

            Text("\(keyCount) key\(keyCount == 1 ? "" : "s")")
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
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .contentShape(Rectangle())
        .onTapGesture { onManage() }
        .contextMenu {
            Button("Manage…", action: onManage)
            Button("View YAML…", action: onViewYAML)
        }
    }
}
