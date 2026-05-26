import Foundation

enum LogNoiseFilter {
    private static let probeUAPattern = #/kube-probe/#
    private static let probePathPattern = #/(?:GET|HEAD)\s+/(?:healthz|health|readyz|ready|livez|live|ping)(?:\s|\?|"|$)/#

    /// True if the line looks like a kubelet probe / health-check request.
    /// Used to filter out high-frequency noise that's almost never what the user wants.
    static func isProbe(_ line: LogLine) -> Bool {
        if (try? probeUAPattern.firstMatch(in: line.text)) != nil { return true }
        if (try? probePathPattern.firstMatch(in: line.text)) != nil { return true }
        return false
    }
}
