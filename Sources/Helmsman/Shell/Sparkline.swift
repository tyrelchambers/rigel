import SwiftUI

/// A compact line chart of a recent sample buffer. Auto-scales to the max
/// observed value in the window so quiet pods don't render as flat zeros.
struct Sparkline: View {
    let samples: [Double]
    let color: Color

    var body: some View {
        Canvas { ctx, size in
            guard samples.count > 1 else { return }
            let maxV = max(samples.max() ?? 0, 1e-9)

            var path = Path()
            for (i, v) in samples.enumerated() {
                let x = CGFloat(i) / CGFloat(samples.count - 1) * size.width
                let y = size.height - (CGFloat(v / maxV) * (size.height - 2)) - 1
                if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                else { path.addLine(to: CGPoint(x: x, y: y)) }
            }

            // Subtle gradient fill below the line.
            var fillPath = path
            fillPath.addLine(to: CGPoint(x: size.width, y: size.height))
            fillPath.addLine(to: CGPoint(x: 0, y: size.height))
            fillPath.closeSubpath()
            ctx.fill(fillPath, with: .color(color.opacity(0.12)))

            ctx.stroke(path, with: .color(color), lineWidth: 1.2)
        }
        .frame(minHeight: 14)
    }
}
