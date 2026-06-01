import SwiftUI

/// Shared color mapping for the cluster visualizations, so the treemap,
/// timeline and gauges read consistently against the app `Theme`.
enum ChartTheme {
    static func color(for health: Viz.PodHealth) -> Color {
        switch health {
        case .healthy: return Theme.Status.running
        case .warning: return Theme.Status.pending
        case .failed:  return Theme.Status.failed
        }
    }

    /// Ring/usage tint by load fraction: accent → amber → red as it fills.
    static func loadColor(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.75: return Theme.Accent.primary
        case ..<0.9:  return Theme.Status.pending
        default:      return Theme.Status.failed
        }
    }
}
