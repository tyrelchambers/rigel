import Foundation

struct LogLine: Identifiable, Hashable {
    let id = UUID()
    let sourcePod: String        // "namespace/podName"
    let timestamp: Date?          // parsed from kubectl logs --timestamps
    let text: String
    let colorIndex: Int           // 0-7, stable per pod via PodColorAssigner
}
