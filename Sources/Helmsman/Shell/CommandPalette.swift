import SwiftUI

/// A single executable command in the ⌘K palette.
struct PaletteCommand: Identifiable {
    let id: String
    let label: String
    let subtitle: String?
    let icon: String
    let group: String
    let run: () -> Void
}

/// Builds the flat list of commands available given current cluster state.
struct PaletteIndex {
    static func build(
        cache: ClusterCache,
        catalog: CatalogStore,
        contexts: [KubeContext],
        switchTo: @escaping (PanelKind) -> Void,
        expandDeployment: @escaping (Deployment) -> Void,
        tailLogs: @escaping (Deployment) -> Void,
        switchContext: @escaping (KubeContext) -> Void,
        createSecret: @escaping () -> Void,
        manageSecret: @escaping (Secret) -> Void,
        installApp: @escaping (CatalogApp) -> Void
    ) -> [PaletteCommand] {
        var out: [PaletteCommand] = []

        // Panel jumps
        for kind in PanelKind.allCases {
            out.append(PaletteCommand(
                id: "panel-\(kind)",
                label: "Open \(kind.title)",
                subtitle: nil,
                icon: kind.icon,
                group: "Navigate",
                run: { switchTo(kind) }
            ))
        }

        // Create a new secret
        out.append(PaletteCommand(
            id: "secret-create",
            label: "Create new secret…",
            subtitle: "Opens the secret editor",
            icon: "plus.circle.fill",
            group: "Secrets",
            run: {
                switchTo(.secrets)
                createSecret()
            }
        ))

        // Catalog: install a packaged app
        for app in catalog.apps {
            out.append(PaletteCommand(
                id: "catalog-install-\(app.id)",
                label: "Install \(app.name)…",
                subtitle: app.tagline,
                icon: app.iconSystemName,
                group: "Apps",
                run: {
                    switchTo(.catalog)
                    installApp(app)
                }
            ))
        }

        // Per-secret manage commands
        for s in cache.secrets {
            let ns = s.metadata.namespace ?? "default"
            out.append(PaletteCommand(
                id: "secret-\(s.metadata.uid)",
                label: s.metadata.name,
                subtitle: "Secret · \(ns) · \(s.secretType.displayName)",
                icon: "key.fill",
                group: "Secrets",
                run: {
                    switchTo(.secrets)
                    manageSecret(s)
                }
            ))
        }

        // Contexts
        for ctx in contexts {
            out.append(PaletteCommand(
                id: "ctx-\(ctx.name)",
                label: "Switch to context \(ctx.name)",
                subtitle: ctx.cluster,
                icon: "network",
                group: "Context",
                run: { switchContext(ctx) }
            ))
        }

        // Deployments
        for dep in cache.deployments {
            let ns = dep.metadata.namespace ?? "default"
            out.append(PaletteCommand(
                id: "dep-open-\(dep.metadata.uid)",
                label: dep.metadata.name,
                subtitle: "Deployment · \(ns)",
                icon: "square.stack.3d.up.fill",
                group: "Deployments",
                run: {
                    switchTo(.deployments)
                    expandDeployment(dep)
                }
            ))
            out.append(PaletteCommand(
                id: "dep-logs-\(dep.metadata.uid)",
                label: "Tail logs · \(dep.metadata.name)",
                subtitle: "Deployment · \(ns)",
                icon: "text.alignleft",
                group: "Logs",
                run: {
                    tailLogs(dep)
                    switchTo(.logs)
                }
            ))
        }

        // Pods (just navigate to pods panel for now; pod focus on the panel TBD)
        for pod in cache.pods.prefix(200) {
            let ns = pod.metadata.namespace ?? "default"
            out.append(PaletteCommand(
                id: "pod-\(pod.metadata.uid)",
                label: pod.metadata.name,
                subtitle: "Pod · \(ns)",
                icon: "shippingbox.fill",
                group: "Pods",
                run: { switchTo(.pods) }
            ))
        }

        // Nodes
        for node in cache.nodes {
            out.append(PaletteCommand(
                id: "node-\(node.metadata.uid)",
                label: node.metadata.name,
                subtitle: "Node · \(node.role)",
                icon: "server.rack",
                group: "Nodes",
                run: { switchTo(.nodes) }
            ))
        }

        return out
    }
}

/// Returns a tuple of (filtered + ranked commands).
/// Empty query → returns the input.
/// Otherwise scores each command on substring match against label+subtitle,
/// preferring earlier matches and exact-prefix.
private func filterAndRank(_ commands: [PaletteCommand], query: String, limit: Int = 80) -> [PaletteCommand] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    if q.isEmpty { return Array(commands.prefix(limit)) }

    struct Scored { let cmd: PaletteCommand; let score: Int }
    var scored: [Scored] = []
    for c in commands {
        let label = c.label.lowercased()
        let sub = (c.subtitle ?? "").lowercased()
        var best = -1
        if label == q { best = 1000 }
        else if label.hasPrefix(q) { best = 500 }
        else if let r = label.range(of: q) { best = 200 - label.distance(from: label.startIndex, to: r.lowerBound) }
        else if let r = sub.range(of: q) { best = 80 - sub.distance(from: sub.startIndex, to: r.lowerBound) }
        if best >= 0 { scored.append(Scored(cmd: c, score: best)) }
    }
    scored.sort { $0.score > $1.score }
    return Array(scored.prefix(limit).map(\.cmd))
}

struct CommandPalette: View {
    @Binding var isPresented: Bool
    let commands: [PaletteCommand]

    @State private var query: String = ""
    @State private var selectedIndex: Int = 0
    @FocusState private var inputFocused: Bool

    private var filtered: [PaletteCommand] { filterAndRank(commands, query: query) }

    var body: some View {
        VStack(spacing: 0) {
            inputRow
            Divider().background(Theme.Border.subtle)
            resultsList
        }
        .frame(width: 580, height: 420)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
        .onAppear { inputFocused = true }
        .onChange(of: query) { _, _ in selectedIndex = 0 }
    }

    private var inputRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Foreground.tertiary)
            TextField("Search deployments, pods, nodes, contexts…", text: $query)
                .textFieldStyle(.plain)
                .font(Theme.Font.body(14))
                .foregroundStyle(Theme.Foreground.primary)
                .focused($inputFocused)
                .onSubmit { runSelected() }
                .onKeyPress(.downArrow) {
                    if !filtered.isEmpty { selectedIndex = min(selectedIndex + 1, filtered.count - 1) }
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    selectedIndex = max(selectedIndex - 1, 0)
                    return .handled
                }
                .onKeyPress(.escape) {
                    isPresented = false
                    return .handled
                }
            Text("⌘K")
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }

    private var resultsList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(filtered.enumerated()), id: \.element.id) { idx, cmd in
                        commandRow(cmd: cmd, idx: idx)
                            .id(cmd.id)
                    }
                    if filtered.isEmpty {
                        Text("no matches")
                            .font(Theme.Font.body(12))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .padding(20)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 6)
            }
            .onChange(of: selectedIndex) { _, newValue in
                if filtered.indices.contains(newValue) {
                    proxy.scrollTo(filtered[newValue].id, anchor: .center)
                }
            }
        }
    }

    @ViewBuilder
    private func commandRow(cmd: PaletteCommand, idx: Int) -> some View {
        let isSelected = idx == selectedIndex
        Button {
            selectedIndex = idx
            runSelected()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: cmd.icon)
                    .font(.system(size: 11))
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(cmd.label)
                        .font(Theme.Font.body(13, weight: .medium))
                        .foregroundStyle(isSelected ? Theme.Foreground.inverse : Theme.Foreground.primary)
                        .lineLimit(1)
                    if let sub = cmd.subtitle {
                        Text(sub)
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(isSelected ? Theme.Foreground.inverse.opacity(0.7) : Theme.Foreground.tertiary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(cmd.group)
                    .font(Theme.Font.mono(9, weight: .medium))
                    .textCase(.uppercase)
                    .tracking(0.5)
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse.opacity(0.7) : Theme.Foreground.tertiary)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(isSelected ? Theme.Accent.primary : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private func runSelected() {
        guard filtered.indices.contains(selectedIndex) else { return }
        let cmd = filtered[selectedIndex]
        isPresented = false
        cmd.run()
    }
}
