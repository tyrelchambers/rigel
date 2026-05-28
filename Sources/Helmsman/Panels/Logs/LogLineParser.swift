import Foundation

enum LogLineParser {
    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// kubectl --prefix prefix: `[pod/<name>/<container>] `
    private static let prefixPattern = #/^\[pod/([^/\]]+)/[^\]]+\]\s+/#

    static func parse(_ raw: String, sourcePod: String, colorIndex: Int) -> LogLine {
        var working = raw
        var effectiveSource = sourcePod
        var effectiveColor = colorIndex

        if let match = try? prefixPattern.firstMatch(in: working) {
            let podName = String(match.output.1)
            effectiveSource = podName
            effectiveColor = PodColorAssigner.colorIndex(for: podName)
            working.removeSubrange(match.range)
        }

        if let spaceIdx = working.firstIndex(of: " ") {
            let timestampPrefix = String(working[..<spaceIdx])
            let rest = String(working[working.index(after: spaceIdx)...])
            if let ts = iso8601.date(from: timestampPrefix) {
                return LogLine(sourcePod: effectiveSource, timestamp: ts, text: rest, colorIndex: effectiveColor)
            }
        }
        return LogLine(sourcePod: effectiveSource, timestamp: nil, text: working, colorIndex: effectiveColor)
    }
}

/// Splits a byte stream into LogLines by newline, buffering partial lines.
struct LogLineStreamParser {
    let sourcePod: String
    let colorIndex: Int
    private var buffer = Data()

    init(sourcePod: String, colorIndex: Int) {
        self.sourcePod = sourcePod
        self.colorIndex = colorIndex
    }

    mutating func feed(_ chunk: Data, emit: (LogLine) -> Void) {
        buffer.append(chunk)
        while let newlineIdx = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<newlineIdx)
            buffer = Data(buffer[(newlineIdx + 1)...])
            if let s = String(data: line, encoding: .utf8), !s.isEmpty {
                emit(LogLineParser.parse(s, sourcePod: sourcePod, colorIndex: colorIndex))
            }
        }
    }
}
