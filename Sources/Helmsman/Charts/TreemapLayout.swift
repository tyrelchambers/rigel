import CoreGraphics

/// Squarified treemap layout. Maps positive weights to rects (same order)
/// packed into `rect` to keep tiles close to square. Each rect's area equals
/// its share of the total area exactly; zero/negative weights get `.zero`.
enum TreemapLayout {
    static func squarify(_ weights: [Double], in rect: CGRect) -> [CGRect] {
        var result = [CGRect](repeating: .zero, count: weights.count)
        let total = weights.reduce(0, +)
        guard total > 0, rect.width > 0, rect.height > 0 else { return result }

        let scale = Double(rect.width * rect.height) / total
        let items = weights.enumerated()
            .filter { $0.element > 0 }
            .map { (index: $0.offset, area: $0.element * scale) }

        var free = rect
        var i = 0
        while i < items.count {
            let side = Double(min(free.width, free.height))
            var row = [items[i]]
            var j = i + 1
            while j < items.count {
                let next = row + [items[j]]
                if worstRatio(next, side: side) <= worstRatio(row, side: side) {
                    row = next; j += 1
                } else { break }
            }
            free = layoutRow(row, in: free, into: &result)
            i = j
        }
        return result
    }

    private static func worstRatio(_ row: [(index: Int, area: Double)], side: Double) -> Double {
        let sum = row.reduce(0) { $0 + $1.area }
        guard sum > 0, side > 0 else { return .greatestFiniteMagnitude }
        let maxA = row.map(\.area).max() ?? 0
        let minA = row.map(\.area).min() ?? 0
        guard minA > 0 else { return .greatestFiniteMagnitude }
        let s2 = side * side, sum2 = sum * sum
        return max((s2 * maxA) / sum2, sum2 / (s2 * minA))
    }

    /// Lay a row along the shorter dimension of `free`; return the remaining
    /// rect. Each tile's area equals its `area` value exactly.
    private static func layoutRow(_ row: [(index: Int, area: Double)], in free: CGRect, into result: inout [CGRect]) -> CGRect {
        let sum = row.reduce(0) { $0 + $1.area }
        guard sum > 0 else { return free }
        if free.width >= free.height {
            let rowW = CGFloat(sum) / free.height
            var y = free.minY
            for item in row {
                let h = CGFloat(item.area) / CGFloat(sum) * free.height
                result[item.index] = CGRect(x: free.minX, y: y, width: rowW, height: h)
                y += h
            }
            return CGRect(x: free.minX + rowW, y: free.minY, width: free.width - rowW, height: free.height)
        } else {
            let rowH = CGFloat(sum) / free.width
            var x = free.minX
            for item in row {
                let w = CGFloat(item.area) / CGFloat(sum) * free.width
                result[item.index] = CGRect(x: x, y: free.minY, width: w, height: rowH)
                x += w
            }
            return CGRect(x: free.minX, y: free.minY + rowH, width: free.width, height: free.height - rowH)
        }
    }
}
