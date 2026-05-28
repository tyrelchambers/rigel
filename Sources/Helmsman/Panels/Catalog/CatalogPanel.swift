import SwiftUI

struct CatalogPanel: View {
    @Bindable var viewModel: CatalogViewModel
    let onSelect: (CatalogApp) -> Void

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
            Text("Apps")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filteredApps.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                TextField("search apps, tags…", text: $viewModel.search)
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
            .frame(maxWidth: 280)
            Spacer()
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
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
        ScrollView {
            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 260, maximum: 360), spacing: 12, alignment: .top)
                ],
                spacing: 12
            ) {
                ForEach(viewModel.filteredApps) { app in
                    CatalogCard(app: app, fit: viewModel.fit(for: app)) {
                        onSelect(app)
                    }
                }
            }
            .padding(16)
        }
        .background(Theme.Surface.primary)
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
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
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
                    Chip(text: app.category.displayName, fg: Theme.Foreground.secondary, bg: Theme.Surface.sunken)
                    Chip(text: app.requirements.cpuRequest, fg: Theme.Foreground.tertiary, bg: Theme.Surface.sunken)
                    Chip(text: app.requirements.memoryRequest, fg: Theme.Foreground.tertiary, bg: Theme.Surface.sunken)
                    if let g = app.requirements.storageGiB {
                        Chip(text: "\(g)Gi", fg: Theme.Foreground.tertiary, bg: Theme.Surface.sunken)
                    }
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
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(app.tagline)
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
            .foregroundStyle(fg)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
