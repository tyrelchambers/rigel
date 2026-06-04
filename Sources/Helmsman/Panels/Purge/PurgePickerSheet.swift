import SwiftUI

/// Overview entry point for purging an app: a searchable list of the user's
/// non-system deployments (filtered through `PurgeGuardrails`), grouped by
/// namespace. Picking one hands its name + namespace back to the caller, which
/// runs discovery and opens the `PurgeSheet`. This is just selection — every
/// destructive gate lives in `PurgeSheet`.
struct PurgePickerSheet: View {
    @Bindable var cache: ClusterCache
    @State private var query = ""

    let onPick: (_ name: String, _ namespace: String) -> Void
    let onCancel: () -> Void

    /// (namespace, [deployment-name]) groups, namespace-sorted, name-sorted within,
    /// limited to purgeable namespaces and matching the search query.
    private var groups: [(namespace: String, names: [String])] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var byNamespace: [String: [String]] = [:]
        for d in cache.deployments {
            let ns = d.metadata.namespace ?? "default"
            guard PurgeGuardrails.isPurgeable(namespace: ns) else { continue }
            let name = d.metadata.name
            if !q.isEmpty, !name.lowercased().contains(q), !ns.lowercased().contains(q) { continue }
            byNamespace[ns, default: []].append(name)
        }
        return byNamespace
            .map { (namespace: $0.key, names: $0.value.sorted()) }
            .sorted { $0.namespace < $1.namespace }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
            search
            content
            footer
        }
        .frame(width: 520, height: 560)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "trash.fill")
                .font(.system(size: 16))
                .foregroundStyle(Theme.Status.failed)
            VStack(alignment: .leading, spacing: 2) {
                Text("Purge an app")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("Pick a deployment — its related resources are gathered for review")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
    }

    // MARK: - Search

    private var search: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(Theme.Foreground.tertiary)
            TextField("Filter by deployment or namespace", text: $query)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .inputChrome()
        .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 4)
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        if groups.isEmpty {
            VStack(spacing: 6) {
                Spacer()
                Image(systemName: "square.stack.3d.up.slash")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Text(query.isEmpty ? "No purgeable deployments." : "No matches.")
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(18)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(groups, id: \.namespace) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(group.namespace.uppercased())
                                .font(Theme.Font.mono(9, weight: .semibold))
                                .tracking(0.5)
                                .foregroundStyle(Theme.Foreground.tertiary)
                                .padding(.horizontal, 4)
                            VStack(spacing: 2) {
                                ForEach(group.names, id: \.self) { name in
                                    row(name: name, namespace: group.namespace)
                                }
                            }
                        }
                    }
                }
                .padding(18)
            }
        }
    }

    private func row(name: String, namespace: String) -> some View {
        Button { onPick(name, namespace) } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Accent.primary)
                Text(name)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Spacer()
            Button(action: onCancel) {
                Text("Cancel")
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .strokeBorder(Theme.Border.strong, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}
