import Foundation

/// Line-delimited JSON parser. Each `\n` terminates a value.
struct StreamJsonParser {
    private var buffer = Data()

    mutating func feed(_ chunk: Data, emit: (Data) -> Void) {
        buffer.append(chunk)
        while let newlineIdx = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: 0..<newlineIdx)
            // Re-materialise as a zero-based contiguous copy before removing the subrange
            // so index arithmetic stays valid on the remaining buffer (mirrors KubectlStreamParser
            // pattern for avoiding Data-slice index bugs).
            buffer = Data(buffer[(newlineIdx + 1)...])
            if !line.isEmpty {
                emit(line)
            }
        }
    }
}
