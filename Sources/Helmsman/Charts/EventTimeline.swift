import SwiftUI
import Charts

/// Stacked-bar ribbon of event volume over a recent window: normal events in
/// muted grey, warnings in red, one bar per time bucket. Surfaces incident
/// clusters ("everything went red at 2am") at a glance.
struct EventTimeline: View {
    let buckets: [Viz.EventBucket]
    var height: CGFloat = 70

    private var isEmpty: Bool { buckets.allSatisfy { $0.total == 0 } }

    /// One stacked segment (normal or warning) of a bucket. Flattening to a
    /// series dimension lets Swift Charts stack the two colors per bar via
    /// `foregroundStyle(by:)` rather than overlapping two separate marks.
    private struct Slice: Identifiable {
        let id: String
        let start: Date
        let kind: String        // "Warnings" | "Normal"
        let count: Int
    }

    private var slices: [Slice] {
        buckets.flatMap { b in
            [
                Slice(id: "\(b.index)-n", start: b.start, kind: "Normal", count: b.normal),
                Slice(id: "\(b.index)-w", start: b.start, kind: "Warnings", count: b.warnings),
            ]
        }
    }

    var body: some View {
        Group {
            if isEmpty {
                Text("No events in the last 24 hours.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: height)
            } else {
                Chart(slices) { s in
                    BarMark(x: .value("Time", s.start), y: .value("Count", s.count), width: .ratio(0.9))
                        .foregroundStyle(by: .value("Kind", s.kind))
                }
                .chartForegroundStyleScale([
                    "Normal":   Theme.Foreground.tertiary.opacity(0.5),
                    "Warnings": Theme.Status.failed,
                ])
                .chartLegend(.hidden)
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
