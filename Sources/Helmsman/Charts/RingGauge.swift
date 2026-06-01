import SwiftUI

/// Circular usage gauge: an arc filled to `fraction`, a percentage in the
/// middle, a title and a detail caption. Native SwiftUI shapes (no Charts).
struct RingGauge: View {
    let title: String
    let fraction: Double      // 0...1
    let detail: String        // e.g. "3 / 8 cores"

    private var clamped: Double { min(max(fraction, 0), 1) }

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().stroke(Theme.Surface.sunken, lineWidth: 10)
                Circle()
                    .trim(from: 0, to: clamped)
                    .stroke(ChartTheme.loadColor(clamped), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.4), value: clamped)
                Text("\(Int((clamped * 100).rounded()))%")
                    .font(Theme.Font.mono(18, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            .frame(width: 84, height: 84)
            Text(title)
                .font(Theme.Font.body(11, weight: .semibold))
                .foregroundStyle(Theme.Foreground.secondary)
                .textCase(.uppercase).tracking(0.5)
            Text(detail)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(14)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }
}
