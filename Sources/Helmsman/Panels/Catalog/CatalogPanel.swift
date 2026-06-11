import SwiftUI

struct CatalogPanel: View {
    @Bindable var viewModel: CatalogViewModel
    let onSelect: (CatalogApp) -> Void
    /// Hand off an app with a newer version to Claude for upgrade.
    var onUpdate: (CatalogApp) -> Void = { _ in }
    /// Run an update check immediately (the "Check now" button).
    var onCheckNow: () -> Void = {}
    /// Check a single installed app for updates (per-app recheck button).
    var onCheckApp: (CatalogApp) -> Void = { _ in }
    /// Open the workload picker to link this app to a running workload —
    /// surfaced only on cards auto-detection marks NOT installed.
    var onLink: (CatalogApp) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            categoryBar
            if let err = viewModel.store.loadError {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }
            grid
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.catalog)
            Text("\(viewModel.filteredApps.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            scopeToggle
            PanelSearchField(text: $viewModel.search, placeholder: "search apps, tags…", maxWidth: 280)
            Spacer()
            updateCheckControl
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var scopeToggle: some View {
        HStack(spacing: 2) {
            ScopeSegment(label: "All", isActive: viewModel.scope == .all) {
                viewModel.scope = .all
            }
            ScopeSegment(
                label: "Installed",
                count: viewModel.installedCount,
                isActive: viewModel.scope == .installed
            ) {
                viewModel.scope = .installed
            }
        }
        .padding(2)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private var updateCheckControl: some View {
        HStack(spacing: 8) {
            if !viewModel.updates.isChecking, let last = viewModel.updates.lastChecked {
                Text("checked \(last.formatted(.relative(presentation: .named)))")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Button(action: onCheckNow) {
                HStack(spacing: 5) {
                    if viewModel.updates.isChecking {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 10, weight: .medium))
                    }
                    Text(viewModel.updates.isChecking ? "Checking…" : "Check for updates")
                        .font(Theme.Font.mono(11, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.updates.isChecking)
            .help("Check all installed apps for newer versions")
        }
    }

    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                CategoryPill(label: "all", isActive: viewModel.selectedCategory == nil) {
                    viewModel.selectedCategory = nil
                }
                ForEach(viewModel.availableCategories, id: \.self) { cat in
                    CategoryPill(label: cat.displayName, isActive: viewModel.selectedCategory == cat) {
                        viewModel.selectedCategory = (viewModel.selectedCategory == cat) ? nil : cat
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var grid: some View {
        // Resolve the installed set once per render rather than per-card.
        let installed = viewModel.installedIDs
        return ScrollView {
            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 260, maximum: 360), spacing: 12, alignment: .top)
                ],
                spacing: 12
            ) {
                ForEach(viewModel.filteredApps) { app in
                    CatalogCard(
                        app: app,
                        fit: viewModel.fit(for: app),
                        isInstalled: installed.contains(app.id),
                        updateStatus: viewModel.updateStatus(for: app),
                        checkPhase: viewModel.checkPhase(for: app),
                        onSelect: { onSelect(app) },
                        onUpdate: { onUpdate(app) },
                        onCheck: { onCheckApp(app) },
                        onLink: { onLink(app) }
                    )
                }
            }
            .padding(16)
        }
        .background(Theme.Surface.primary)
    }
}

private struct ScopeSegment: View {
    let label: String
    var count: Int? = nil
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(label)
                    .font(Theme.Font.mono(11, weight: .medium))
                if let count {
                    Text("\(count)")
                        .font(Theme.Font.mono(10, weight: .medium))
                        .foregroundStyle(isActive ? Theme.Foreground.inverse.opacity(0.8) : Theme.Foreground.tertiary)
                }
            }
            .foregroundStyle(isActive ? Theme.Foreground.inverse : Theme.Foreground.secondary)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(isActive ? Theme.Accent.primary : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct CategoryPill: View {
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

struct CatalogCard: View {
    let app: CatalogApp
    let fit: FitResult
    let isInstalled: Bool
    var updateStatus: UpdateStatus? = nil
    var checkPhase: UpdateCheckStore.CheckPhase? = nil
    let onSelect: () -> Void
    var onUpdate: () -> Void = {}
    var onCheck: () -> Void = {}
    var onLink: () -> Void = {}

    @State private var hovering = false

    var body: some View {
        // A tap-gesture container rather than a Button, so the inner "Update"
        // button receives its own taps instead of being swallowed by an outer
        // Button's hit area.
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: app.iconSystemName)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Theme.Accent.primary)
                    .frame(width: 32, height: 32)
                    .background(Theme.Accent.primaryDim)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name)
                        .font(Theme.Font.body(13, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.primary)
                    Text(app.tagline)
                        .font(Theme.Font.body(11))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                fitDot
            }
            HStack(spacing: 4) {
                if isInstalled {
                    HStack(spacing: 3) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 9, weight: .bold))
                        Text("installed")
                            .font(Theme.Font.mono(10, weight: .medium))
                    }
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundStyle(Theme.Status.running)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.Status.running.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                Chip(text: app.category.displayName, fg: Theme.Foreground.secondary, bg: Theme.Surface.sunken)
                Chip(text: app.requirements.cpuRequest, fg: Theme.Foreground.tertiary, bg: Theme.Surface.sunken)
                Chip(text: app.requirements.memoryRequest, fg: Theme.Foreground.tertiary, bg: Theme.Surface.sunken)
                if let g = app.requirements.storageGiB {
                    Chip(text: "\(g)Gi", fg: Theme.Foreground.tertiary, bg: Theme.Surface.sunken)
                }
            }
            // Per-app update/check state on its own full-width row so it never
            // competes with the chips above (which were wrapping mid-word).
            if isInstalled {
                statusRow
            } else {
                linkAffordance   // "Already installed? Link it…" — not-installed only
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(hovering ? Theme.Accent.primary.opacity(0.4) : Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .contentShape(Rectangle())
        .onTapGesture { onSelect() }
        .onHover { hovering = $0 }
        .help(app.tagline)
    }

    /// A single full-width row for an installed app's update/check state:
    /// queued → checking → then up-to-date / version-unknown, or an
    /// "current → latest" badge with an Update button when a newer version
    /// exists. One row keeps it from crowding the chips above.
    @ViewBuilder private var statusRow: some View {
        switch checkPhase {
        case .pending:
            statusPill("queued", systemImage: "clock", color: Theme.Foreground.tertiary)
        case .checking:
            HStack(spacing: 4) {
                ProgressView().controlSize(.small)
                Text("checking for updates…")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        case .checked, nil:
            HStack(spacing: 6) {
                statusBadge
                Spacer(minLength: 0)
                recheckButton   // check just this app
                if case let .updateAvailable(_, latest) = updateStatus {
                    Button(action: onUpdate) {
                        Text("Update")
                            .font(Theme.Font.mono(10, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.inverse)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Theme.Accent.primary)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .buttonStyle(.plain)
                    .help("Hand off to Claude to upgrade to \(latest)")
                }
            }
        }
    }

    /// Secondary affordance for an app auto-detection missed: bind it to a
    /// running workload by hand (mirror/private registry, fork, DaemonSet, …).
    /// Shown ONLY on not-installed cards.
    private var linkAffordance: some View {
        Button(action: onLink) {
            HStack(spacing: 4) {
                Image(systemName: "link")
                    .font(.system(size: 9, weight: .medium))
                Text("Already installed? Link it…")
                    .font(Theme.Font.mono(10, weight: .medium))
            }
            .foregroundStyle(Theme.Accent.primary)
        }
        .buttonStyle(.plain)
        .help("Bind \(app.name) to a running workload auto-detection missed")
    }

    /// The left-hand status badge for an installed app's latest known result.
    @ViewBuilder private var statusBadge: some View {
        switch updateStatus {
        case let .updateAvailable(current, latest):
            HStack(spacing: 3) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("\(current) → \(latest)")
                    .font(Theme.Font.mono(10, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(Theme.Status.pending)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.Status.pending.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        case .upToDate:
            statusPill("up to date", systemImage: "checkmark.seal.fill", color: Theme.Status.running)
        case .unknown:
            statusPill("version unknown", systemImage: "questionmark.circle", color: Theme.Foreground.tertiary)
        case nil:
            Text("not checked")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    /// Recheck just this app for a newer version, independent of the daily sweep.
    private var recheckButton: some View {
        Button(action: onCheck) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help("Check \(app.name) for updates")
    }

    private func statusPill(_ text: String, systemImage: String, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage).font(.system(size: 9, weight: .bold))
            Text(text).font(Theme.Font.mono(10, weight: .medium)).lineLimit(1)
        }
        .fixedSize()
        .foregroundStyle(color)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(color.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var fitDot: some View {
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
            case .red:    return "no fit"
            }
        }()
        return HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(label)
                .font(Theme.Font.mono(9, weight: .medium))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(color.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct Chip: View {
    let text: String
    let fg: Color
    let bg: Color
    var body: some View {
        Text(text)
            .font(Theme.Font.mono(10))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(fg)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
