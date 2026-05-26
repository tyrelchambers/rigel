import Foundation

/// Streaming JSON value tokenizer.
/// Splits a byte stream containing zero or more back-to-back JSON values (possibly
/// pretty-printed with embedded whitespace and braces inside strings) into individual
/// `Data` chunks, each of which is a standalone-decodable JSON value.
///
/// Handles:
/// - Pretty-printed objects (whitespace between fields)
/// - Strings containing braces and escaped quotes
/// - Partial input across multiple `feed(_:)` calls
struct KubectlStreamParser {
    /// Always a zero-based, contiguous copy — never a slice — so integer indices
    /// are safe to use directly as subscript arguments.
    private var buffer = Data()
    private var depth = 0
    private var inString = false
    private var escaped = false
    /// Byte offset (from index 0 of `buffer`) where the current in-progress value begins.
    private var valueStart: Int? = nil
    /// How far into `buffer` we have already scanned; the next `feed` resumes here.
    private var scanOffset: Int = 0

    mutating func feed(_ chunk: Data, emit: (Data) -> Void) {
        // Materialise `chunk` as a contiguous zero-based copy before appending so
        // that `buffer` itself never becomes a slice with a non-zero startIndex.
        buffer.append(contentsOf: chunk)

        var i = scanOffset
        while i < buffer.count {
            let b = buffer[i]
            if escaped {
                escaped = false
            } else if inString {
                if b == 0x5C /* \ */ { escaped = true }
                else if b == 0x22 /* " */ { inString = false }
            } else {
                switch b {
                case 0x22: inString = true                              // "
                case 0x7B: // {
                    if depth == 0 { valueStart = i }
                    depth += 1
                case 0x7D: // }
                    depth -= 1
                    if depth == 0, let start = valueStart {
                        let value = buffer.subdata(in: start..<(i + 1))
                        emit(value)
                        valueStart = nil
                    }
                default: break
                }
            }
            i += 1
        }
        scanOffset = i  // resume here next feed

        // Compact: drop everything before the earliest byte we still need.
        if depth == 0 {
            // Between values — safe to throw away the whole buffer.
            buffer = Data()
            scanOffset = 0
            valueStart = nil
        } else if let start = valueStart, start > 0 {
            // In the middle of a value that started at `start`; trim leading bytes.
            // Re-materialise as a zero-based Data so future index arithmetic stays valid.
            buffer = Data(buffer[start...])
            scanOffset -= start
            valueStart = 0
        }
        // If valueStart == 0 we can't compact further; just keep scanning next feed.
    }
}
