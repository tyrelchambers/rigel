import SwiftUI

/// Manually bind a catalog app to a running workload. A searchable list of
/// Deployments / StatefulSets / DaemonSets grouped by namespace; picking one
/// (then a container, only when the workload has more than one) hands the
/// selection back to the caller, which opens the `WorkloadConfirmSheet` showing
/// the exact `kubectl annotate …` command. This is just selection — the confirm
/// sheet is the only gate that runs the annotate.
///
/// Built on the `PurgePickerSheet` pattern (NOT a new shell). Unlike purge,
/// linking is a metadata annotate (read-then-annotate, not a delete), so it is
/// NOT scoped to purgeable namespaces — any namespace the user can annotate is
/// eligible.
struct LinkWorkloadPickerSheet: View {
    /// The catalog app being linked — becomes the `catalog-app` annotation value.
    let app: CatalogApp
    @Bindable var cache: ClusterCache
    @State private var query = ""
    /// A picked workload awaiting its container choice (multi-container only).
    @State private var pendingContainer: PickedWorkload? = nil

    /// Resolves to `{ kind, name, namespace, container? }` (container omitted on
    /// single-container workloads).
    let onPick: (_ kind: String, _ name: String, _ namespace: String, _ container: String?) -> Void
    let onCancel: () -> Void

    /// One selectable workload, carrying enough to drive the container step and
    /// surface an existing binding to a different app.
    struct WorkloadRow: Identifiable {
        let kind: String          // deployment | statefulset | daemonset
        let name: String
        let namespace: String
        let containers: [Container]
        /// A catalog-app this workload is ALREADY bound to (other than this app).
        let boundToOther: String?
        var id: String { "\(kind)/\(namespace)/\(name)" }
    }

    private struct PickedWorkload: Identifiable {
        let row: WorkloadRow
        var id: String { row.id }
    }

    /// Every workload across the three controller kinds, matching the search.
    private var allRows: [WorkloadRow] {
        var rows: [WorkloadRow] = []
        for d in cache.deployments {
            rows.append(WorkloadRow(
                kind: "deployment", name: d.metadata.name, namespace: d.metadata.namespace ?? "default",
                containers: d.spec?.template?.spec?.containers ?? [], boundToOther: otherBinding(d.metadata)
            ))
        }
        for s in cache.statefulSets {
            rows.append(WorkloadRow(
                kind: "statefulset", name: s.metadata.name, namespace: s.metadata.namespace ?? "default",
                containers: s.spec?.template?.spec?.containers ?? [], boundToOther: otherBinding(s.metadata)
            ))
        }
        for ds in cache.daemonSets {
            rows.append(WorkloadRow(
                kind: "daemonset", name: ds.metadata.name, namespace: ds.metadata.namespace ?? "default",
                containers: ds.spec?.template?.spec?.containers ?? [], boundToOther: otherBinding(ds.metadata)
            ))
        }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return rows }
        return rows.filter { $0.name.lowercased().contains(q) || $0.namespace.lowercased().contains(q) }
    }

    /// The catalog-app annotation on a workload, unless it's already this app.
    private func otherBinding(_ meta: ObjectMeta) -> String? {
        guard let id = boundAppID(meta), id != app.id else { return nil }
        return id
    }

    /// (namespace, [rows]) groups, namespace-sorted, name-sorted within.
    private var groups: [(namespace: String, rows: [WorkloadRow])] {
        var byNamespace: [String: [WorkloadRow]] = [:]
        for r in allRows { byNamespace[r.namespace, default: []].append(r) }
        return byNamespace
            .map { (namespace: $0.key, rows: $0.value.sorted { $0.name < $1.name }) }
            .sorted { $0.namespace < $1.namespace }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
            if let pending = pendingContainer {
                containerStep(pending.row)
            } else {
                search
                content
            }
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
            Image(systemName: "link")
                .font(.system(size: 16))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(pendingContainer == nil ? "Link \(app.name) to a workload" : "Pick the container")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(pendingContainer == nil
                     ? "Pick the running Deployment, StatefulSet, or DaemonSet that backs this app"
                     : "This workload has several containers — pick the one updates should retag")
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
            TextField("Filter by workload or namespace", text: $query)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .inputChrome()
        .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 4)
    }

    // MARK: - Step 1: workload list

    @ViewBuilder private var content: some View {
        if groups.isEmpty {
            VStack(spacing: 6) {
                Spacer()
                Image(systemName: "square.stack.3d.up.slash")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Text(query.isEmpty ? "No workloads" : "No matches.")
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
                                ForEach(group.rows) { row in
                                    workloadButton(row)
                                }
                            }
                        }
                    }
                }
                .padding(18)
            }
        }
    }

    private func workloadButton(_ row: WorkloadRow) -> some View {
        Button { select(row) } label: {
            HStack(spacing: 8) {
                kindBadge(row.kind)
                Text(row.name)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(1).truncationMode(.middle)
                if let other = row.boundToOther {
                    Text("bound to \(other)")
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Status.pending)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Status.pending.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
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

    private func kindBadge(_ kind: String) -> some View {
        Text(kind)
            .font(Theme.Font.mono(9, weight: .semibold))
            .foregroundStyle(Theme.Accent.primary)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(Theme.Accent.primaryDim)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    // MARK: - Step 2: container choice (multi-container only)

    private func containerStep(_ row: WorkloadRow) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    kindBadge(row.kind)
                    Text("\(row.namespace)/\(row.name)")
                        .font(Theme.Font.mono(11, weight: .medium))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                VStack(spacing: 2) {
                    ForEach(row.containers, id: \.name) { container in
                        Button {
                            onPick(row.kind, row.name, row.namespace, container.name)
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "shippingbox.fill")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.Accent.primary)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(container.name)
                                        .font(Theme.Font.mono(12, weight: .medium))
                                        .foregroundStyle(Theme.Foreground.primary)
                                    if let image = container.image {
                                        Text(image)
                                            .font(Theme.Font.mono(9))
                                            .foregroundStyle(Theme.Foreground.tertiary)
                                            .lineLimit(1).truncationMode(.middle)
                                    }
                                }
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
                }
            }
            .padding(18)
        }
    }

    /// Picking a workload either hands off directly (single container → omit the
    /// container annotation) or advances to the container step (multi-container).
    private func select(_ row: WorkloadRow) {
        if row.containers.count > 1 {
            pendingContainer = PickedWorkload(row: row)
        } else {
            onPick(row.kind, row.name, row.namespace, nil)
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            if pendingContainer != nil {
                Button { pendingContainer = nil } label: {
                    Text("Back")
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
            }
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
