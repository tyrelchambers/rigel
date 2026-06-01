import SwiftUI
import Charts

/// Stacked-bar ribbon of event volume over a recent window: normal events in
/// muted grey, warnings in red, one bar per time bucket. Surfaces incident
/// clusters ("everything went red at 2am") at a glance.
struct EventTimeline: View {
    let buckets: [Viz.EventBucket]
    var height: CGFloat = 70

    private var isEmpty: Bool { buckets.allSatisfy { $0.total == 0 } }

    var body: some View {
        Group {
            if isEmpty {
                Text("No events in the last 24 hours.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: height)
            } else {
                Chart(buckets) { b in
                    BarMark(x: .value("Time", b.start), y: .value("Normal", b.normal), width: .ratio(0.9))
                        .foregroundStyle(Theme.Foreground.tertiary.opacity(0.5))
                    BarMark(x: .value("Time", b.start), y: .value("Warnings", b.warnings), width: .ratio(0.9))
                        .foregroundStyle(Theme.Status.failed)
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                        AxisGridLine().foregroundStyle(Theme.Border.subtle)
                        AxisValueLabel(format: .dateTime.hour())
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisGridLine().foregroundStyle(Theme.Border.subtle)
                        AxisValueLabel()
                    }
                }
                .frame(height: height)
            }
        }
    }
}
