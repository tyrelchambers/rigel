import Foundation

/// Locally-generated strong secret values (passwords, signing keys, access keys).
/// Alphanumeric only, to stay safe inside YAML scalars and shell args. Used to
/// pre-fill the install wizard's detected secret placeholders.
enum RandomSecret {
    /// Character set a generated value is drawn from. `alphanumeric` is the safe
    /// default; `hex` is needed by apps that validate a value as hex-encoded
    /// (e.g. Outline's `SECRET_KEY`, which must be `openssl rand -hex 32`).
    enum Format: String, Codable, Hashable { case alphanumeric, hex }

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
    private static let hexAlphabet = Array("0123456789abcdef")

    static func generate(length: Int = 32, format: Format = .alphanumeric) -> String {
        let n = max(1, length)
        let chars = format == .hex ? hexAlphabet : alphabet
        var out = ""
        out.reserveCapacity(n)
        for _ in 0..<n {
            out.append(chars[Int.random(in: 0..<chars.count)])
        }
        return out
    }
}
