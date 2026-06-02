import Foundation

/// Locally-generated strong secret values (passwords, signing keys, access keys).
/// Alphanumeric only, to stay safe inside YAML scalars and shell args. Used to
/// pre-fill the install wizard's detected secret placeholders.
enum RandomSecret {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

    static func generate(length: Int = 32) -> String {
        let n = max(1, length)
        var out = ""
        out.reserveCapacity(n)
        for _ in 0..<n {
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return out
    }
}
