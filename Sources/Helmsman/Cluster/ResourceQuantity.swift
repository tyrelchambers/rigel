import Foundation

enum ResourceQuantity {
    /// Parse a Kubernetes CPU quantity into cores (Double).
    /// Accepts plain digits ("4" → 4.0), milli ("1500m" → 1.5), and nano ("1500000n" → 0.0015).
    static func cpuCores(_ value: String) -> Double {
        let s = value.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return 0 }

        if s.hasSuffix("m") {
            let n = Double(s.dropLast()) ?? 0
            return n / 1000.0
        }
        if s.hasSuffix("u") {
            let n = Double(s.dropLast()) ?? 0
            return n / 1_000_000.0
        }
        if s.hasSuffix("n") {
            let n = Double(s.dropLast()) ?? 0
            return n / 1_000_000_000.0
        }
        return Double(s) ?? 0
    }

    /// Parse a Kubernetes memory quantity into bytes (Double).
    /// Handles binary suffixes (Ki, Mi, Gi, Ti, Pi, Ei) and decimal (K, M, G, T, P, E).
    /// Plain digits are treated as bytes.
    static func bytes(_ value: String) -> Double {
        let s = value.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return 0 }

        let binarySuffixes: [(String, Double)] = [
            ("Ki", 1024),
            ("Mi", 1024 * 1024),
            ("Gi", 1024 * 1024 * 1024),
            ("Ti", 1024 * 1024 * 1024 * 1024),
            ("Pi", pow(1024, 5)),
            ("Ei", pow(1024, 6)),
        ]
        for (suf, mult) in binarySuffixes where s.hasSuffix(suf) {
            let n = Double(s.dropLast(suf.count)) ?? 0
            return n * mult
        }

        let decimalSuffixes: [(String, Double)] = [
            ("K", 1_000),
            ("M", 1_000_000),
            ("G", 1_000_000_000),
            ("T", 1_000_000_000_000),
            ("P", 1e15),
            ("E", 1e18),
        ]
        for (suf, mult) in decimalSuffixes where s.hasSuffix(suf) {
            let n = Double(s.dropLast(suf.count)) ?? 0
            return n * mult
        }

        return Double(s) ?? 0
    }

    static func formatBytes(_ b: Double) -> String {
        let units: [(Double, String)] = [
            (1024 * 1024 * 1024 * 1024, "TiB"),
            (1024 * 1024 * 1024, "GiB"),
            (1024 * 1024, "MiB"),
            (1024, "KiB"),
        ]
        for (size, label) in units where b >= size {
            let v = b / size
            return v >= 10 ? String(format: "%.0f %@", v, label) : String(format: "%.1f %@", v, label)
        }
        return "\(Int(b)) B"
    }

    static func formatCores(_ c: Double) -> String {
        if c < 1 { return String(format: "%.0f m", c * 1000) }
        return c >= 10 ? String(format: "%.0f", c) : String(format: "%.2f", c)
    }
}
