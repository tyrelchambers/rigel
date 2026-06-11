import SwiftUI
import AppKit

struct CatalogDetailSheet: View {
    let app: CatalogApp
    let fit: FitResult
    /// Running-instance details when this app is installed; nil otherwise.
    var installed: CatalogViewModel.InstalledAppInfo? = nil
    /// The workload this app is explicitly bound to (catalog-app annotation), or
    /// nil when unbound. Reflects live cluster state; updates on the next tick.
    var binding: WorkloadBinding? = nil
    let onClose: () -> Void
    /// Hands off the app plus the node the user pinned it to (nil = let the
    /// recommendation stand / Kubernetes schedule freely).
    let onInstall: (CatalogApp, String?) -> Void
    /// Open the workload picker to bind this app to a running workload.
    var onLink: (CatalogApp) -> Void = { _ in }
    /// Remove the binding (routes through the confirm gate for the unlink command).
    var onUnlink: (CatalogApp, WorkloadBinding) -> Void = { _, _ in }

    /// Node the user picked in the NODE FIT panel. nil = "Any".
    @State private var selectedNode: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            HStack(alignment: .top, spacing: 0) {
                leftColumn
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider().background(Theme.Border.subtle)
                rightColumn
                    .frame(width: 380, alignment: .topLeading)
            }
            Divider().background(Theme.Border.subtle)
            footer
        }
        .frame(width: 840, height: 620)
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: app.iconSystemName)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(Theme.Accent.primary)
                .frame(width: 44, height: 44)
                .background(Theme.Accent.primaryDim)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            VStack(alignment: .leading, spacing: 4) {
                Text(app.name)
                    .font(Theme.Font.body(18, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(app.tagline)
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 28, height: 28)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.escape, modifiers: [])
            .help("Close")
        }
        .padding(.horizontal, 20).padding(.vertical, 16)
        .background(Theme.Surface.elevated)
    }

    private var leftColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                installedBlock
                bindingBlock
                if !app.description.isEmpty {
                    Text(app.description)
                        .font(Theme.Font.body(12))
                        .foregroundStyle(Theme.Foreground.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                if let notes = app.notes, !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("NOTES")
                            .font(Theme.Font.mono(9, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .tracking(0.5)
                        Text(notes)
                            .font(Theme.Font.body(11))
                            .foregroundStyle(Theme.Foreground.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.Status.pending.opacity(0.08))
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                    .strokeBorder(Theme.Status.pending.opacity(0.3), lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                }
                if !app.tags.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("TAGS")
                            .font(Theme.Font.mono(9, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .tracking(0.5)
                        FlowRow(spacing: 4) {
                            ForEach(app.tags, id: \.self) { tag in
                                Text(tag)
                                    .font(Theme.Font.mono(10))
                                    .foregroundStyle(Theme.Foreground.secondary)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Theme.Surface.sunken)
                                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                            }
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("LINKS")
                        .font(Theme.Font.mono(9, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .tracking(0.5)
                    HStack(spacing: 6) {
                        LinkButton(label: "Docs", systemImage: "book.fill", url: app.docsURL)
                        if let repo = app.repoURL {
                            LinkButton(label: "Repo", systemImage: "chevron.left.forwardslash.chevron.right", url: repo)
                        }
                        if let home = app.homepageURL {
                            LinkButton(label: "Homepage", systemImage: "house.fill", url: home)
                        }
                    }
                }
                requirementsBlock
                Spacer(minLength: 0)
            }
            .padding(20)
        }
    }

    /// Running-instance summary shown only when the app is installed: version,
    /// update status, and the full image reference. Tinted green to read as
    /// "this is live in your cluster".
    @ViewBuilder private var installedBlock: some View {
        if let installed {
            VStack(alignment: .leading, spacing: 6) {
                Text("INSTALLED")
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .tracking(0.5)
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 24) {
                        labeledValue("VERSION") {
                            Text(installed.version)
                                .font(Theme.Font.mono(12, weight: .semibold))
                                .foregroundStyle(Theme.Foreground.primary)
                        }
                        labeledValue("STATUS") {
                            installedStatusLine(installed.status)
                        }
                        Spacer(minLength: 0)
                    }
                    labeledValue("IMAGE") {
                        Text(installed.imageRef)
                            .font(Theme.Font.mono(11))
                            .foregroundStyle(Theme.Foreground.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(installed.imageRef)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Status.running.opacity(0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Status.running.opacity(0.25), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    /// Link / Unlink section, shown for EVERY app. When unbound: a Link button
    /// that opens the workload picker. When bound: the bound kind/name (+
    /// container) and an Unlink button. Reflects live cluster state — after a
    /// link/unlink annotate the displayed binding flips on the next watch tick.
    @ViewBuilder private var bindingBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WORKLOAD LINK")
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
            if let binding {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(binding.kind)
                            .font(Theme.Font.mono(9, weight: .semibold))
                            .foregroundStyle(Theme.Accent.primary)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Theme.Accent.primaryDim)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        Text("\(binding.namespace)/\(binding.name)")
                            .font(Theme.Font.mono(11, weight: .medium))
                            .foregroundStyle(Theme.Foreground.primary)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    if let container = binding.container {
                        Text("container: \(container)")
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Foreground.secondary)
                    }
                    Button { onUnlink(app, binding) } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "link.badge.plus").font(.system(size: 10, weight: .medium))
                            Text("Unlink").font(Theme.Font.body(11, weight: .medium))
                        }
                        .foregroundStyle(Theme.Status.failed)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Theme.Status.failed.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .buttonStyle(.plain)
                    .help("Remove the catalog binding from \(binding.kind)/\(binding.name)")
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Auto-detection matches this app by image. If it runs under a mirror/private registry, a fork, or an unusual kind, bind it to the workload by hand.")
                        .font(Theme.Font.body(11))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button { onLink(app) } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "link").font(.system(size: 10, weight: .medium))
                            Text("Link a workload").font(Theme.Font.body(11, weight: .medium))
                        }
                        .foregroundStyle(Theme.Accent.primary)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Theme.Accent.primaryDim)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .buttonStyle(.plain)
                    .help("Bind \(app.name) to a running workload")
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    private func labeledValue<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
            value()
        }
    }

    /// Mirrors the catalog card's update-status badge so the sheet and card
    /// read the same.
    @ViewBuilder private func installedStatusLine(_ status: UpdateStatus?) -> some View {
        switch status {
        case let .updateAvailable(current, latest):
            statusLine("\(current) → \(latest)", systemImage: "arrow.up.circle.fill", color: Theme.Status.pending)
        case .upToDate:
            statusLine("up to date", systemImage: "checkmark.seal.fill", color: Theme.Status.running)
        case .unknown:
            statusLine("version unknown", systemImage: "questionmark.circle", color: Theme.Foreground.tertiary)
        case nil:
            Text("not checked")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private func statusLine(_ text: String, systemImage: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).font(.system(size: 10, weight: .bold))
            Text(text).font(Theme.Font.mono(11, weight: .medium)).lineLimit(1)
        }
        .foregroundStyle(color)
    }

    private var requirementsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("REQUIREMENTS")
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
            HStack(spacing: 16) {
                ReqCell(title: "CPU", value: "\(app.requirements.cpuRequest)" + (app.requirements.cpuLimit.map { " / \($0)" } ?? ""))
                ReqCell(title: "Memory", value: "\(app.requirements.memoryRequest)" + (app.requirements.memoryLimit.map { " / \($0)" } ?? ""))
                ReqCell(title: "Storage", value: app.requirements.storageGiB.map { "\($0) GiB" } ?? "—")
                ReqCell(title: "Ingress", value: app.exposesIngress ? "Yes" : "—")
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.sunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
    }

    private var rightColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("NODE FIT")
                        .font(Theme.Font.mono(9, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .tracking(0.5)
                    Spacer()
                    fitSummary
                }
                if fit.perNode.isEmpty {
                    Text("No nodes visible — is the cluster reachable?")
                        .font(Theme.Font.body(11))
                        .foregroundStyle(Theme.Foreground.tertiary)
                } else {
                    Text("Pick a node to pin this app to, or leave it on Any to let the recommendation stand.")
                        .font(Theme.Font.body(11))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    AnyNodeRow(
                        recommendedName: fit.recommended?.node.metadata.name,
                        isSelected: selectedNode == nil,
                        onSelect: { selectedNode = nil }
                    )
                    ForEach(fit.perNode) { nf in
                        NodeFitCard(
                            fit: nf,
                            isRecommended: nf == fit.recommended,
                            isSelected: selectedNode == nf.node.metadata.name,
                            app: app,
                            onSelect: nf.eligible
                                ? { selectedNode = nf.node.metadata.name }
                                : nil
                        )
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .background(Theme.Surface.primary)
    }

    private var fitSummary: some View {
        let color: Color = {
            switch fit.dot {
            case .green:  return Theme.Status.running
            case .yellow: return Theme.Status.pending
            case .red:    return Theme.Status.failed
            }
        }()
        let label: String = {
            switch fit.dot {
            case .green:  return "fits"
            case .yellow: return "tight"
            case .red:    return "no node fits"
            }
        }()
        return HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(label).font(Theme.Font.mono(10, weight: .medium)).foregroundStyle(color)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            Button("Cancel", action: onClose)
                .buttonStyle(.plain)
                .font(Theme.Font.body(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Button {
                onInstall(app, selectedNode)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.app.fill")
                        .font(.system(size: 11, weight: .semibold))
                    Text(selectedNode.map { "Install on \($0)" } ?? "Install on cluster")
                        .font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(fit.anyFits ? Theme.Foreground.inverse : Theme.Foreground.tertiary)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(fit.anyFits ? Theme.Accent.primary : Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(!fit.anyFits)
            .help(fit.anyFits ? "Start the install wizard" : "No node has enough capacity for this app")
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
    }
}

private struct ReqCell: View {
    let title: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased())
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
            Text(value)
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
        }
    }
}

private struct LinkButton: View {
    let label: String
    let systemImage: String
    let url: URL
    var body: some View {
        Button {
            NSWorkspace.shared.open(url)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: systemImage).font(.system(size: 10))
                Text(label).font(Theme.Font.body(11, weight: .medium))
            }
            .foregroundStyle(Theme.Accent.primary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Accent.primaryDim)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help(url.absoluteString)
    }
}

/// Selectable "Any" option sitting above the node cards. Picking it clears
/// any node pin so the wizard's recommendation stands.
private struct AnyNodeRow: View {
    let recommendedName: String?
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 6) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 11))
                    .foregroundStyle(isSelected ? Theme.Accent.primary : Theme.Foreground.tertiary)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Any node")
                        .font(Theme.Font.mono(11, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.primary)
                    Text(recommendedName.map { "recommended: \($0)" } ?? "no node currently fits")
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                Spacer()
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(isSelected ? Theme.Accent.primary : Theme.Border.subtle, lineWidth: isSelected ? 1.5 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct NodeFitCard: View {
    let fit: NodeFit
    let isRecommended: Bool
    let isSelected: Bool
    let app: CatalogApp
    /// nil when the node can't host the app — the card renders as a
    /// non-interactive, dimmed row in that case.
    let onSelect: (() -> Void)?

    private var ineligibleReason: String? {
        if !fit.node.isReady { return "not ready" }
        if fit.cordoned       { return "cordoned" }
        if fit.tainted        { return "tainted (NoSchedule)" }
        if !fit.canHost       { return "insufficient capacity" }
        return nil
    }

    var body: some View {
        if let onSelect {
            Button(action: onSelect) { card }
                .buttonStyle(.plain)
        } else {
            card.opacity(0.55)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: selectionIcon)
                    .font(.system(size: 11))
                    .foregroundStyle(isSelected ? Theme.Accent.primary : Theme.Foreground.tertiary)
                Text(fit.node.metadata.name)
                    .font(Theme.Font.mono(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
                if isRecommended {
                    Text("recommended")
                        .font(Theme.Font.mono(9, weight: .semibold))
                        .foregroundStyle(Theme.Accent.primary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Accent.primaryDim)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                } else if let reason = ineligibleReason {
                    Text(reason)
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
            }
            ResourceBar(
                label: "CPU",
                used: fit.allocatableCPU - fit.freeCPU,
                free: fit.freeCPU,
                requested: ResourceQuantity.cpuCores(app.requirements.cpuRequest),
                formatter: ResourceQuantity.formatCores
            )
            ResourceBar(
                label: "Mem",
                used: fit.allocatableMemoryBytes - fit.freeMemoryBytes,
                free: fit.freeMemoryBytes,
                requested: ResourceQuantity.bytes(app.requirements.memoryRequest),
                formatter: ResourceQuantity.formatBytes
            )
            if fit.allocatableDiskBytes > 0 {
                ResourceBar(
                    label: "Disk",
                    used: max(0, fit.allocatableDiskBytes - fit.freeDiskBytes),
                    free: fit.freeDiskBytes,
                    requested: Double(app.requirements.storageGiB ?? 0) * 1024 * 1024 * 1024,
                    formatter: ResourceQuantity.formatBytes
                )
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(borderColor, lineWidth: isSelected ? 1.5 : 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var selectionIcon: String {
        guard onSelect != nil else { return "slash.circle" }
        return isSelected ? "checkmark.circle.fill" : "circle"
    }

    private var borderColor: Color {
        if isSelected { return Theme.Accent.primary }
        if isRecommended { return Theme.Accent.primary.opacity(0.5) }
        return Theme.Border.subtle
    }
}

private struct ResourceBar: View {
    let label: String
    let used: Double
    let free: Double
    let requested: Double
    let formatter: (Double) -> String

    private var total: Double { used + free }
    private var usedFrac: Double { total > 0 ? min(1, used / total) : 0 }
    private var requestedFrac: Double { total > 0 ? min(1, requested / total) : 0 }
    private var requestFits: Bool { requested <= free }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label)
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 30, alignment: .leading)
                Text("\(formatter(free)) free / \(formatter(total))")
                    .font(Theme.Font.mono(9))
                    .foregroundStyle(Theme.Foreground.secondary)
                Spacer()
                Text("needs \(formatter(requested))")
                    .font(Theme.Font.mono(9))
                    .foregroundStyle(requestFits ? Theme.Status.running : Theme.Status.failed)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Theme.Surface.sunken)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Theme.Foreground.tertiary.opacity(0.6))
                        .frame(width: geo.size.width * usedFrac)
                    // Requested overlay starts at the right edge of existing usage,
                    // shaded by whether it fits.
                    RoundedRectangle(cornerRadius: 2)
                        .fill((requestFits ? Theme.Accent.primary : Theme.Status.failed).opacity(0.7))
                        .frame(width: geo.size.width * requestedFrac)
                        .offset(x: geo.size.width * usedFrac)
                }
            }
            .frame(height: 6)
        }
    }
}

/// Minimal flowing wrap layout for tag chips.
private struct FlowRow<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder let content: () -> Content
    var body: some View {
        // SwiftUI on macOS 14 doesn't ship a stock flow layout; use a simple
        // wrapper that lets HStack wrap via `.fixedSize` + LazyVGrid columns.
        // For our needs (a handful of short tags), an HStack with truncation
        // wrapped in a ScrollView is acceptable.
        HStack(spacing: spacing) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
