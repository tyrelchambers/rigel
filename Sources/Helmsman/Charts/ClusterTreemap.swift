import SwiftUI

/// One node's pods laid out as a squarified treemap. Tiles are sized by
/// CPU/mem usage and colored by health; pods with no metrics floor to a small
/// dimmed tile so they still appear. Tapping a tile calls `onSelect`.
struct NodeTreemap: View {
    let node: Viz.TreemapNode
    let metric: Viz.TreemapMetric
    let onSelect: (Viz.TreemapPod) -> Void

    var body: some View {
        GeometryReader { geo in
            let maxV = node.pods.map(\.value).max() ?? 0
            let floorWeight = max(maxV * 0.03, 1)                 // keep zero-usage pods visible
            let weights = node.pods.map { max($0.value, floorWeight) }
            let rects = TreemapLayout.squarify(weights, in: CGRect(origin: .zero, size: geo.size))
            ForEach(Array(node.pods.enumerated()), id: \.element.id) { i, pod in
                let r = rects[i]
                if r != .zero {
                    tile(pod, size: r.size)
                        .frame(width: r.width, height: r.height)
                        .position(x: r.midX, y: r.midY)
                        .onTapGesture { onSelect(pod) }
                        .help("\(pod.namespace)/\(pod.name) — \(formatted(pod.value))")
                }
            }
        }
    }

    private func tile(_ pod: Viz.TreemapPod, size: CGSize) -> some View {
        let dimmed = pod.value <= 0
        return ChartTheme.color(for: pod.health).opacity(dimmed ? 0.35 : 0.85)
            .overlay(Rectangle().strokeBorder(Theme.Surface.primary, lineWidth: 1))
            .overlay(alignment: .topLeading) {
                if size.width > 46 && size.height > 18 {
                    Text(pod.name)
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Foreground.inverse)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(3)
                }
            }
    }

    private func formatted(_ value: Double) -> String {
        metric == .cpu ? ResourceQuantity.formatCores(value) : ResourceQuantity.formatBytes(value)
    }
}

/// A node's treemap framed in a titled card (node name + pod count + total).
struct NodeTreemapCard: View {
    let node: Viz.TreemapNode
    let metric: Viz.TreemapMetric
    let onSelect: (Viz.TreemapPod) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "server.rack").font(.system(size: 11)).foregroundStyle(Theme.Accent.primary)
                Text(node.name).font(Theme.Font.mono(11, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                Spacer()
                Text("\(node.pods.count) pods · \(total)")
                    .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
            }
            NodeTreemap(node: node, metric: metric, onSelect: onSelect)
                .frame(height: 160)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .padding(12)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    private var total: String {
        metric == .cpu ? ResourceQuantity.formatCores(node.total) : ResourceQuantity.formatBytes(node.total)
    }
}
