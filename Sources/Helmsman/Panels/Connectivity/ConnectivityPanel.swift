import SwiftUI

struct ConnectivityPanel: View {
    @Bindable var cache: ClusterCache
    let onSelectService: (_ name: String, _ namespace: String) -> Void
    let onSelectPods: (Connectivity.Flow) -> Void

    private var flows: [Connectivity.Flow] {
        Connectivity.flows(ingresses: cache.ingresses, services: cache.services, pods: cache.pods)
    }
    private var external: [Connectivity.Flow] { flows.filter { $0.isExternal } }
    private var internalFlows: [Connectivity.Flow] { flows.filter { !$0.isExternal } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if flows.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if !external.isEmpty { section("External", "globe", external) }
                        if !internalFlows.isEmpty { section("Internal", "lock.fill", internalFlows) }
                    }
                    .padding(16)
                }
            }
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.connectivity)
            Spacer()
            legend
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var legend: some View {
        HStack(spacing: 10) {
            swatch(.ok, "Reachable")
            swatch(.warn, "Degraded")
            swatch(.broken, "Broken")
        }
    }

    private func swatch(_ h: Connectivity.Health, _ label: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(ChartTheme.color(for: h)).frame(width: 8, height: 8)
            Text(label).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private func section(_ title: String, _ icon: String, _ rows: [Connectivity.Flow]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 11)).foregroundStyle(Theme.Accent.primary)
                Text(title).font(Theme.Font.body(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.secondary).textCase(.uppercase).tracking(0.5)
                Text("\(rows.count)").font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
            }
            VStack(spacing: 6) {
                ForEach(rows) { flow in
                    FlowRow(flow: flow, onSelectService: onSelectService, onSelectPods: onSelectPods)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 28)).foregroundStyle(Theme.Foreground.tertiary)
            Text("No services to map yet.").font(Theme.Font.body(13)).foregroundStyle(Theme.Foreground.secondary)
            Text("Connectivity traces ingress → service → pods so you can spot unreachable apps.")
                .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct FlowRow: View {
    let flow: Connectivity.Flow
    let onSelectService: (_ name: String, _ namespace: String) -> Void
    let onSelectPods: (Connectivity.Flow) -> Void

    private var tint: Color { ChartTheme.color(for: flow.health) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Rectangle().fill(tint).frame(width: 3, height: 16)
                if flow.isExternal {
                    chip(flow.hosts.isEmpty ? "(no host)" : flow.hosts.joined(separator: ", "), system: "globe", color: Theme.Foreground.secondary)
                    arrow
                    chip(flow.ingressNames.joined(separator: ", "), system: "signpost.right.fill", color: Theme.Foreground.secondary)
                    arrow
                } else {
                    chip("cluster", system: "lock.fill", color: Theme.Foreground.tertiary)
                    arrow
                }
                Button { onSelectService(flow.serviceName, flow.namespace) } label: {
                    chip("svc/\(flow.serviceName)", system: "network",
                         color: flow.serviceExists ? Theme.Foreground.primary : Theme.Status.failed)
                }.buttonStyle(.plain)
                arrow
                Button { onSelectPods(flow) } label: { podsChip }.buttonStyle(.plain)
                    .disabled(flow.totalPods == 0)
                Spacer()
                Text(flow.namespace).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
            }
            if !flow.issues.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9)).foregroundStyle(tint)
                    Text(flow.issues.joined(separator: " · ")).font(Theme.Font.mono(10)).foregroundStyle(tint)
                }
                .padding(.leading, 9)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var arrow: some View {
        Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(Theme.Foreground.tertiary)
    }

    private var podsChip: some View {
        chip(flow.serviceExists ? "\(flow.readyPods)/\(flow.totalPods) pods" : "no service",
             system: "shippingbox.fill", color: tint)
    }

    private func chip(_ text: String, system: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: system).font(.system(size: 9))
            Text(text).font(Theme.Font.mono(10)).lineLimit(1).truncationMode(.middle)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
