import SwiftUI

struct ConfigMapsPanel: View {
    @Bindable var viewModel: ConfigMapsViewModel
    let onManage: (ConfigMap) -> Void
    let onNew: () -> Void
    let onViewYAML: (String, String, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            filterBar

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
                    ForEach(viewModel.filteredConfigMaps) { c in
                        ConfigMapRow(configMap: c, onManage: { onManage(c) }, onViewYAML: {
                            onViewYAML("configmap", c.metadata.name, c.metadata.namespace)
                        })
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            }
            .background(Theme.Surface.primary)
        }
        .background(Theme.Surface.primary)
        .background {
            Button("New configmap", action: onNew)
                .keyboardShortcut("n", modifiers: .command)
                .hidden()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("ConfigMaps")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filteredConfigMaps.count)")
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
            .help("Create a new configmap (⌘N)")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var filterBar: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            PanelSearchField(text: $viewModel.search, maxWidth: 220)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}

private struct ConfigMapRow: View {
    let configMap: ConfigMap
    let onManage: () -> Void
    let onViewYAML: () -> Void

    private var ageString: String? {
        guard let created = configMap.metadata.creationTimestamp else { return nil }
        let dt = Date().timeIntervalSince(created)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        if dt < 86400 { return "\(Int(dt/3600))h" }
        return "\(Int(dt/86400))d"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.plaintext.fill")
                .font(.system(size: 10))
                .foregroundStyle(Theme.Accent.primary)
                .frame(width: 12)

            Text(configMap.metadata.name)
                .font(Theme.Font.mono(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
                .lineLimit(1)

            Text(configMap.metadata.namespace ?? "—")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

            Spacer(minLength: 8)

            Text("\(configMap.keyCount) key\(configMap.keyCount == 1 ? "" : "s")")
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
