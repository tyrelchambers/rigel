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

/// Thread-safe reference wrapper around `StreamJsonParser` so it can be captured
/// by a `@Sendable` `FileHandle.readabilityHandler` closure without tripping the
/// Swift 6 "mutation of captured var in concurrently-executing code" error.
/// Mirrors `OutputBox`: a lock guards the mutable parser. Parsing happens under
/// the lock; lines are emitted after unlocking so the caller's `emit` (which may
/// yield to a continuation / spawn a Task) never runs while the lock is held.
final class StreamJsonParserBox: @unchecked Sendable {
    private let lock = NSLock()
    private var parser = StreamJsonParser()

    func feed(_ chunk: Data, emit: (Data) -> Void) {
        lock.lock()
        var lines: [Data] = []
        parser.feed(chunk) { lines.append($0) }
        lock.unlock()
        for line in lines { emit(line) }
    }
}
