import SwiftUI

struct IngressesPanel: View {
    @Bindable var viewModel: IngressesViewModel
    let onViewYAML: (_ kind: String, _ name: String, _ namespace: String?) -> Void
    let onAskClaude: (Ingress) -> Void

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

            if viewModel.filteredIngresses.isEmpty {
                empty
            } else {
                list
            }
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Ingresses")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filteredIngresses.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
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

    private var filterBar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    FilterPill(label: "all ns", isActive: viewModel.namespaceFilter == nil) {
                        viewModel.namespaceFilter = nil
                    }
                    ForEach(viewModel.availableNamespaces, id: \.self) { ns in
                        FilterPill(label: ns, isActive: viewModel.namespaceFilter == ns) {
                            viewModel.namespaceFilter = ns
                        }
                    }
                }
            }
            Spacer(minLength: 4)
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
            .frame(maxWidth: 200)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "signpost.right")
                .font(.system(size: 28))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(viewModel.isLoading ? "Loading ingresses…" : "No ingresses found")
                .font(Theme.Font.mono(12))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(viewModel.filteredIngresses) { ingress in
                    IngressRow(ingress: ingress)
                        .contextMenu {
                            Button("Ask Claude about this ingress") { onAskClaude(ingress) }
                            Button("View YAML") {
                                onViewYAML("ingress", ingress.metadata.name, ingress.metadata.namespace)
                            }
                        }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
        }
    }
}

private struct FilterPill: View {
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

private struct IngressRow: View {
    let ingress: Ingress

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle().fill(Theme.Accent.primary).frame(width: 2).frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 6) {
                titleLine
                if ingress.routes.isEmpty {
                    Text("no rules")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                } else {
                    ForEach(ingress.routes, id: \.self) { route in
                        RouteLine(route: route)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let address = ingress.address {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("address")
                        .font(Theme.Font.mono(8))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text(address)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: 140, alignment: .trailing)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var titleLine: some View {
        HStack(spacing: 8) {
            Text(ingress.metadata.name)
                .font(Theme.Font.mono(12, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            if let ns = ingress.metadata.namespace {
                Text(ns)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Badge(text: ingress.className, color: Theme.Accent.primary)
            if ingress.isTLS {
                HStack(spacing: 2) {
                    Image(systemName: "lock.fill").font(.system(size: 8))
                    Text("TLS")
                }
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Status.running)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Status.running.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }
}

private struct RouteLine: View {
    let route: IngressRoute

    var body: some View {
        HStack(spacing: 6) {
            Text(route.host)
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
            Text(route.path)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.secondary)
            Image(systemName: "arrow.right")
                .font(.system(size: 8))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(route.port.isEmpty ? route.service : "\(route.service):\(route.port)")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Accent.primary)
        }
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

private struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(Theme.Font.mono(9, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
