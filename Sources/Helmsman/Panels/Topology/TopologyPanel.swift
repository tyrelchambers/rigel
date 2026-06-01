import SwiftUI

struct TopologyPanel: View {
    @Bindable var cache: ClusterCache
    let onSelectPod: (Viz.TreemapPod) -> Void

    @State private var metric: Viz.TreemapMetric = .cpu

    private var model: [Viz.TreemapNode] {
        Viz.treemapModel(pods: cache.pods, nodes: cache.nodes, history: cache.podMetricsHistory, metric: metric)
    }

    private let columns = [GridItem(.adaptive(minimum: 320), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if model.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(model) { node in
                            NodeTreemapCard(node: node, metric: metric, onSelect: onSelectPod)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.topology)
            Spacer()
            Picker("", selection: $metric) {
                Text("CPU").tag(Viz.TreemapMetric.cpu)
                Text("Memory").tag(Viz.TreemapMetric.memory)
            }
            .pickerStyle(.segmented).frame(width: 160).labelsHidden()
            legend
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var legend: some View {
        HStack(spacing: 10) {
            swatch(.healthy, "Healthy")
            swatch(.warning, "Restarts")
            swatch(.failed, "Failed")
        }
    }

    private func swatch(_ health: Viz.PodHealth, _ label: String) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(ChartTheme.color(for: health)).frame(width: 9, height: 9)
            Text(label).font(Theme.Font.mono(9)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "rectangle.3.group").font(.system(size: 28)).foregroundStyle(Theme.Foreground.tertiary)
            Text("No pods to map yet.").font(Theme.Font.body(13)).foregroundStyle(Theme.Foreground.secondary)
            Text("Tile size reflects live CPU/memory usage from metrics-server.")
                .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
