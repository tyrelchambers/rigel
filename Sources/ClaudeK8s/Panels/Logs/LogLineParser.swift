import Foundation

enum LogLineParser {
    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parse(_ raw: String, sourcePod: String, colorIndex: Int) -> LogLine {
        if let spaceIdx = raw.firstIndex(of: " ") {
            let prefix = String(raw[..<spaceIdx])
            let rest = String(raw[raw.index(after: spaceIdx)...])
            if let ts = iso8601.date(from: prefix) {
                return LogLine(sourcePod: sourcePod, timestamp: ts, text: rest, colorIndex: colorIndex)
            }
        }
        return LogLine(sourcePod: sourcePod, timestamp: nil, text: raw, colorIndex: colorIndex)
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
