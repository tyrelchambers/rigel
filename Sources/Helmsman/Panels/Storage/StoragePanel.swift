import SwiftUI

struct StoragePanel: View {
    @Bindable var viewModel: StorageViewModel
    let onViewYAML: (_ kind: String, _ name: String, _ namespace: String?) -> Void
    let onDeletePVC: (PersistentVolumeClaim) -> Void
    let onDeletePV: (PersistentVolume) -> Void

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
            Text("Storage")
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
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var kindBar: some View {
        HStack(spacing: 6) {
            ForEach(StorageKind.allCases) { k in
                StoragePill(label: k.title, isActive: viewModel.kind == k) {
                    viewModel.kind = k
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                switch viewModel.kind {
                case .pvcs:
                    ForEach(viewModel.filteredPVCs) { pvc in
                        PVCRow(pvc: pvc)
                            .contextMenu {
                                Button("View YAML") { onViewYAML("pvc", pvc.metadata.name, pvc.metadata.namespace) }
                                Divider()
                                Button("Delete PVC", role: .destructive) { onDeletePVC(pvc) }
                            }
                    }
                case .pvs:
                    ForEach(viewModel.filteredPVs) { pv in
                        PVRow(pv: pv)
                            .contextMenu {
                                Button("View YAML") { onViewYAML("pv", pv.metadata.name, nil) }
                                Divider()
                                Button("Delete PV", role: .destructive) { onDeletePV(pv) }
                            }
                    }
                case .storageClasses:
                    ForEach(viewModel.filteredStorageClasses) { sc in
                        StorageClassRow(sc: sc)
                            .contextMenu {
                                Button("View YAML") { onViewYAML("storageclass", sc.metadata.name, nil) }
                            }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
}

// MARK: - Shared bits

/// Bound/Available are healthy; Pending is in-flight; Lost/Failed/Released are bad.
func storagePhaseColor(_ phase: String) -> Color {
    switch phase {
    case "Bound", "Available": return Theme.Status.running
    case "Pending":            return Theme.Status.pending
    case "Lost", "Failed":     return Theme.Status.failed
    default:                   return Theme.Foreground.tertiary
    }
}

private struct StoragePill: View {
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
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(isActive ? Color.clear : Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct PhaseBadge: View {
    let phase: String
    var body: some View {
        Text(phase)
            .font(Theme.Font.mono(10, weight: .medium))
            .foregroundStyle(storagePhaseColor(phase))
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(storagePhaseColor(phase).opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct MetaChip: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Theme.Font.mono(10))
            .foregroundStyle(Theme.Foreground.tertiary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Theme.Surface.sunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private func storageCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    content()
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
}

// MARK: - Rows

private struct PVCRow: View {
    let pvc: PersistentVolumeClaim

    var body: some View {
        storageCard {
            HStack(spacing: 10) {
                Image(systemName: "externaldrive.fill")
                    .font(.system(size: 10)).foregroundStyle(Theme.Accent.primary).frame(width: 12)
                Text(pvc.metadata.name)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary).lineLimit(1)
                MetaChip(text: pvc.metadata.namespace ?? "—")
                PhaseBadge(phase: pvc.phase)
                Spacer(minLength: 8)
                if !pvc.accessModeLabels.isEmpty {
                    Text(pvc.accessModeLabels.joined(separator: ","))
                        .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                }
                if let sc = pvc.spec?.storageClassName { MetaChip(text: sc) }
                Text(pvc.capacity)
                    .font(Theme.Font.mono(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .frame(minWidth: 48, alignment: .trailing)
            }
        }
    }
}

private struct PVRow: View {
    let pv: PersistentVolume

    var body: some View {
        storageCard {
            HStack(spacing: 10) {
                Image(systemName: "internaldrive.fill")
                    .font(.system(size: 10)).foregroundStyle(Theme.Accent.primary).frame(width: 12)
                Text(pv.metadata.name)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary).lineLimit(1).truncationMode(.middle)
                PhaseBadge(phase: pv.phase)
                if let claim = pv.claim {
                    HStack(spacing: 3) {
                        Image(systemName: "arrow.right").font(.system(size: 7)).foregroundStyle(Theme.Foreground.tertiary)
                        Text(claim).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                    }
                    .lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                MetaChip(text: pv.reclaimPolicy)
                if let sc = pv.spec?.storageClassName, !sc.isEmpty { MetaChip(text: sc) }
                Text(pv.capacity)
                    .font(Theme.Font.mono(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .frame(minWidth: 48, alignment: .trailing)
            }
        }
    }
}

private struct StorageClassRow: View {
    let sc: StorageClass

    var body: some View {
        storageCard {
            HStack(spacing: 10) {
                Image(systemName: "shippingbox.circle.fill")
                    .font(.system(size: 10)).foregroundStyle(Theme.Accent.primary).frame(width: 12)
                Text(sc.metadata.name)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary).lineLimit(1)
                if sc.isDefault {
                    Text("default")
                        .font(Theme.Font.mono(9, weight: .semibold))
                        .foregroundStyle(Theme.Status.running)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Status.running.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                Spacer(minLength: 8)
                if let mode = sc.volumeBindingMode { MetaChip(text: mode) }
                if let policy = sc.reclaimPolicy { MetaChip(text: policy) }
                Text(sc.provisioner ?? "—")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 220, alignment: .trailing)
            }
        }
    }
}
