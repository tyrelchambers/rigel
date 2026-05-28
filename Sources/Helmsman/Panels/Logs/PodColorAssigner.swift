import Foundation

enum PodColorAssigner {
    static let paletteSize = 8

    /// Stable hash of a pod key to a color palette index.
    /// Stable across instances and process restarts.
    static func colorIndex(for key: String) -> Int {
        // FNV-1a 32-bit
        var hash: UInt32 = 2166136261
        for byte in key.utf8 {
            hash ^= UInt32(byte)
            hash &*= 16777619
        }
        return Int(hash % UInt32(paletteSize))
    }
}
