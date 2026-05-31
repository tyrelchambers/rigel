import SwiftUI

struct RBACPanel: View {
    @Bindable var viewModel: RBACViewModel
    let onViewYAML: (_ kind: String, _ name: String, _ namespace: String?) -> Void
    let onDelete: (_ kind: String, _ name: String, _ namespace: String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            kindBar

            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }

            list
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("RBAC")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            PanelSearchField(text: $viewModel.search, maxWidth: 200)
            if viewModel.isLoading {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var kindBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(RBACKind.allCases) { k in
                    RBACPill(label: k.title, isActive: viewModel.kind == k) { viewModel.kind = k }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                switch viewModel.kind {
                case .serviceAccounts:
                    ForEach(viewModel.filteredServiceAccounts) { sa in
                        rbacRow(icon: "person.crop.circle.fill", name: sa.metadata.name, namespace: sa.metadata.namespace,
                                trailing: "\(sa.secretCount) secret\(sa.secretCount == 1 ? "" : "s")", detail: nil)
                            .contextMenu { menu(kind: "serviceaccount", name: sa.metadata.name, namespace: sa.metadata.namespace) }
                    }
                case .roles:
                    ForEach(viewModel.filteredRoles) { role in
                        rbacRow(icon: "lock.fill", name: role.metadata.name, namespace: role.metadata.namespace,
                                trailing: "\(role.ruleCount) rule\(role.ruleCount == 1 ? "" : "s")", detail: nil)
                            .contextMenu { menu(kind: "role", name: role.metadata.name, namespace: role.metadata.namespace) }
                    }
                case .roleBindings:
                    ForEach(viewModel.filteredRoleBindings) { rb in
                        rbacRow(icon: "link", name: rb.metadata.name, namespace: rb.metadata.namespace,
                                trailing: rb.roleRef?.label ?? "—", detail: RBACDisplay.subjectsSummary(rb.subjects))
                            .contextMenu { menu(kind: "rolebinding", name: rb.metadata.name, namespace: rb.metadata.namespace) }
                    }
                case .clusterRoles:
                    ForEach(viewModel.filteredClusterRoles) { cr in
                        rbacRow(icon: "lock.shield.fill", name: cr.metadata.name, namespace: nil,
                                trailing: "\(cr.ruleCount) rule\(cr.ruleCount == 1 ? "" : "s")", detail: nil)
                            .contextMenu { menu(kind: "clusterrole", name: cr.metadata.name, namespace: nil) }
                    }
                case .clusterRoleBindings:
                    ForEach(viewModel.filteredClusterRoleBindings) { crb in
                        rbacRow(icon: "link.badge.plus", name: crb.metadata.name, namespace: nil,
                                trailing: crb.roleRef?.label ?? "—", detail: RBACDisplay.subjectsSummary(crb.subjects))
                            .contextMenu { menu(kind: "clusterrolebinding", name: crb.metadata.name, namespace: nil) }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }

    @ViewBuilder
    private func menu(kind: String, name: String, namespace: String?) -> some View {
        Button("View YAML") { onViewYAML(kind, name, namespace) }
        Divider()
        Button("Delete \(kind)", role: .destructive) { onDelete(kind, name, namespace) }
    }

    private func rbacRow(icon: String, name: String, namespace: String?, trailing: String, detail: String?) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 10)).foregroundStyle(Theme.Accent.primary).frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(name)
                        .font(Theme.Font.mono(12, weight: .medium))
                        .foregroundStyle(Theme.Foreground.primary).lineLimit(1).truncationMode(.middle)
                    if let ns = namespace {
                        Text(ns).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.Surface.elevated).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                }
                if let detail {
                    Text(detail).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Text(trailing)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.secondary)
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 220, alignment: .trailing)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }
}

private struct RBACPill: View {
    let label: String
    let isActive: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(isActive ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(isActive ? Theme.Accent.primary : Theme.Surface.sunken)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(isActive ? Color.clear : Theme.Border.strong, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}
